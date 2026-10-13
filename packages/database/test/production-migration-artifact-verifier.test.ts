import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionMigrationArtifactVerifier, measureProductionMigrationLiveCatalog,
  productionMigrationArtifactCanonicalJson as canonical, productionMigrationArtifactPolicyPayload,
  productionMigrationMeasurementPayload, productionMigrationLosslessRowsDigest as rowsDigest,
  readProtectedMigrationArtifactFile,
  type MigrationArtifactInputPin, type MigrationArtifactCheckReport, type MigrationLosslessRow,
  type ProductionMigrationArtifactPolicy, type ProductionMigrationMeasurementReceipt,
} from "../src/production-migration-artifact-verifier.js";
import { evaluateProductionMigrationReadiness, productionMigrationArtifactClaimsDigest,
  type MigrationArtifactCheck, type ProductionMigrationReadinessManifest } from "../src/production-migration-readiness.js";
import type { PostgresTransaction } from "../src/postgres-unit-of-work.js";

const now = "2026-10-04T04:00:00.000Z", start = "2026-10-04T03:59:00.000Z", end = "2026-10-04T04:01:00.000Z";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const key = () => {
  const pair = generateKeyPairSync("ed25519");
  return { ...pair, base64: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
const owners = [...new Set([0, process.getuid!()])];
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

// Real local files and independent test keys. No fixture represents production evidence.
function fixture(check: MigrationArtifactCheck = "immutable-snapshot", derivation = "snapshot-bytes-v1") {
  const root = mkdtempSync(join(process.cwd(), ".migration-artifact-test-")); directories.push(root); chmodSync(root, 0o700);
  const reviewer = key(), collector = key(), approval = key();
  function file(path: string, value: Uint8Array | string) {
    const full = join(root, path);
    try { chmodSync(full, 0o600); } catch { /* Newly created test file. */ }
    writeFileSync(full, value, { mode: 0o600 }); chmodSync(full, 0o444);
    return { path, sha256: sha(value), size: String(Buffer.byteLength(value)) };
  }
  const snapshot = file("snapshot.sqlite", "SQLite format 3\0saved offline snapshot bytes");
  const sourceSchema = file("source.sql", "CREATE TABLE facts(id INTEGER,value BLOB);"), targetSchema = file("target.sql", "CREATE TABLE history(id bigint,value bytea);");
  const release = file("release.bin", "independently reviewed release bytes");
  const identity = { snapshotId: "snapshot-1", snapshotSha256: snapshot.sha256, sourceId: "source-1", sourceSchemaSha256: sourceSchema.sha256,
    targetId: "target-1", targetSchemaSha256: targetSchema.sha256, generation: "gen-1", releaseSha256: release.sha256 };
  const cohortId = "cohort-1", snapshotWatermark = "source-w1", watermark = "target-w2";
  const catalog = (side: string) => ({ version: 1, side, identity, cohortId, snapshotWatermark, watermark, measuredAt: start,
    tables: [{ name: side === "source" ? "facts" : "history", columns: ["id", "value"] }] });
  const sourceCatalog = file("source-catalog.json", canonical(catalog("source"), 32)), targetCatalog = file("target-catalog.json", canonical(catalog("target"), 32));
  const binding = { identity, cohortId, snapshotWatermark, watermark, liveCatalogSha256: targetCatalog.sha256,
    target: { database: "business", schema: "business_v2", serverAddress: "127.0.0.1", serverPort: 5432, systemIdentifier: "123456789" },
    maintenanceWindow: { start, end } };
  const rowA: MigrationLosslessRow = { id: { storage: "integer", decimal: "9007199254740993" }, value: { storage: "blob", bytesBase64: "AAH/" } };
  const rowB: MigrationLosslessRow = { id: { storage: "integer", decimal: "-9223372036854775808" }, value: { storage: "null" } };
  const rows = [rowA, rowB];
  const manifest = { version: 1, createdAt: start, expiresAt: end, identity,
    scope: { cohortId, snapshotWatermark, watermark, rollbackTarget: "rollback-release", maintenanceWindow: { start, end } },
    safety: { deliveryEnabled: false, fomoCaptureEnabled: false, historicalMiningEnabled: false, automaticOwnerMergeEnabled: false },
    tables: { reviewedSourceTables: ["facts"], entries: [{ table: "facts", destination: "history", sourceRows: "2", preservedRows: "1", quarantinedRows: "1",
      sourceSha256: rowsDigest(rows, 32), retainedSha256: rowsDigest(rows, 32), quarantineLossless: true, retrievalTestPassed: true }] },
    retention: { nonDestructiveImport: true, protectedEvidenceRetained: true, rawHotDays: 15, purchaseProofDays: 30, purgeJobsExcluded: true, purgeRequested: false },
    evidence: {}, approvals: [], roles: [], capacity: {}, writerFence: {}, finalBoundary: {}, rollback: {}, business: {},
  } as unknown as ProductionMigrationReadinessManifest;
  const inputs: MigrationArtifactInputPin[] = [
    { role: "snapshot", ...snapshot }, { role: "source-schema", ...sourceSchema }, { role: "target-schema", ...targetSchema },
    { role: "release", ...release }, { role: "source-catalog", ...sourceCatalog }, { role: "target-catalog", ...targetCatalog },
  ];
  function records(side: "source" | "retained" | "quarantine", values: MigrationLosslessRow[]) {
    return { version: 1, side, identity, cohortId, snapshotWatermark, watermark,
      tables: [{ table: "facts", destination: side === "source" ? "facts" : "history", rows: values }] };
  }
  if (derivation === "lossless-table-records-v1") {
    for (const [side, values] of [["source", rows], ["retained", [rowA]], ["quarantine", [rowB]]] as const) {
      inputs.push({ role: `${side}-records`, ...file(`${side}-records.json`, canonical(records(side, [...values]), 32)) });
    }
  }
  if (derivation === "backup-roundtrip-v1") {
    inputs.push({ role: "backup", ...file("backup.sqlite", "saved-backup") }, { role: "restored", ...file("restored.sqlite", "saved-backup") });
  }
  const claimsSha256 = productionMigrationArtifactClaimsDigest(manifest, check);
  const receipt: ProductionMigrationMeasurementReceipt = {
    version: 1, scope: "independent-artifact-measurement", collectorId: "independent-capture", keyId: "capture-key", collectorReleaseSha256: "c".repeat(64),
    check, claimsSha256, identity, binding, observedAt: now,
    test: { name: `independent:${check}`, status: "passed", executedAt: now, skipped: false },
    measurement: { startedAt: start, completedAt: now, derivation, inputs, snapshotScope: "preservation-snapshot",
      backupRehearsal: derivation === "backup-roundtrip-v1" ? { backupStartedAt: start, backupCompletedAt: start, restoreStartedAt: start, restoreCompletedAt: now } : null },
    signatureBase64: "",
  };
  const policy: ProductionMigrationArtifactPolicy = {
    version: 1, scope: "independent-artifact-review", policyId: "review-1", verifierId: "offline-byte-verifier", reviewer: "external-reviewer", keyId: "review-key",
    issuedAt: start, expiresAt: end,
    expected: { observedAt: start, identity, sourceTables: ["facts"], writerInventory: (["services", "timers", "operators", "deploy", "usercron", "externalInputs"] as const)
      .map(kind => ({ kind, members: [`pinned-${kind}`] })) }, binding,
    limits: { maxFiles: 20, maxFileBytes: "1048576", maxTotalBytes: "20971520", maxJsonBytes: 1048576,
      maxRows: 100, maxTables: 10, maxColumns: 10, maxJsonDepth: 32, maxPathDepth: 32, maxReadMs: 2000 },
    collectors: [{ collectorId: receipt.collectorId, keyId: receipt.keyId, publicKeyBase64: collector.base64,
      collectorReleaseSha256: receipt.collectorReleaseSha256, derivations: [derivation] }], artifacts: [], signatureBase64: "",
  };
  function resealReceipt() {
    receipt.signatureBase64 = sign(null, Buffer.from(productionMigrationMeasurementPayload(receipt, 32)), collector.privateKey).toString("base64");
    const artifact = file("measurement.json", canonical(receipt, 32));
    policy.artifacts = [{ check, artifact, claimsSha256: receipt.claimsSha256, testName: receipt.test.name,
      collectorId: receipt.collectorId, keyId: receipt.keyId, derivation, inputs }];
    manifest.evidence[check] = { status: "passed", owner: "external-capture", identity, observedAt: receipt.observedAt, test: receipt.test, artifactSha256: artifact.sha256 };
  }
  function options(clock: () => string = () => now) {
    policy.signatureBase64 = sign(null, Buffer.from(productionMigrationArtifactPolicyPayload(policy, 32)), reviewer.privateKey).toString("base64");
    const policyBytes = Buffer.from(canonical(policy, 32));
    return { policyBytes, policySha256: sha(policyBytes), manifest, artifactRoot: root,
      trustedReviewers: [{ reviewer: policy.reviewer, keyId: policy.keyId, publicKeyBase64: reviewer.base64 }],
      manifestApprovalPublicKeys: [approval.base64], trustedOwnerUids: owners, maxJsonDepth: 32,
      maxBootstrapBytes: 1048576, maxReadMs: 2000, maxEvidenceAgeMs: 300000, clock };
  }
  resealReceipt();
  return { root, file, manifest, policy, receipt, reviewer, collector, approval, inputs, records, rows, options, resealReceipt,
    request: () => ({ check, artifactSha256: policy.artifacts[0]!.artifact.sha256, claimsSha256: receipt.claimsSha256, identity }) };
}
const report = (verifier: Awaited<ReturnType<typeof createProductionMigrationArtifactVerifier>>, check: MigrationArtifactCheck): MigrationArtifactCheckReport => verifier.report.checks.find(c => c.check === check)!;

describe("independent signed scope and measured offline bytes", () => {
  it("measures immutable byte hashes and size but never authorizes production or unmeasured gates", async () => {
    const f = fixture(), verifier = await createProductionMigrationArtifactVerifier(f.options());
    expect(report(verifier, "immutable-snapshot").status).toBe("verified");
    expect(report(verifier, "immutable-snapshot").measured).toContain("READONLY_SNAPSHOT_BYTES");
    const checked = verifier.externalTrust.verifyArtifact(f.request());
    expect(checked?.assertionsPassed).toBe(true); expect(sha(checked!.bytes)).toBe(f.request().artifactSha256);
    expect(verifier.productionAuthorized).toBe(false); expect(verifier.validationOnly).toBe(true);
    expect(report(verifier, "complete-writer-fence").status).toBe("unknown");
    expect(evaluateProductionMigrationReadiness(f.manifest, { now, maxEvidenceAgeMs: 300000, trustedReviewers: [], externalTrust: verifier.externalTrust }).ready).toBe(false);
  });
  it("recomputes lossless typed multisets without pretending exports were independently replayed from SQLite", async () => {
    const f = fixture("lossless-all-tables", "lossless-table-records-v1"), verifier = await createProductionMigrationArtifactVerifier(f.options());
    const result = report(verifier, "lossless-all-tables");
    expect(result.measured).toContain("ALL_TABLE_ROW_COUNTS_AND_DIGESTS"); expect(result.status).toBe("unknown");
    expect(result.pending).toContain("SOURCE_SNAPSHOT_TO_TYPED_EXPORT_NOT_INDEPENDENTLY_REPLAYED");
    expect(verifier.externalTrust.verifyArtifact(f.request())).toBeNull();
  });
  it("does not turn a signed fenced snapshot scope into backup rehearsal or fencing proof", async () => {
    const f = fixture(); f.receipt.measurement.snapshotScope = "fenced-snapshot"; f.resealReceipt();
    const verifier = await createProductionMigrationArtifactVerifier(f.options());
    expect(report(verifier, "immutable-snapshot").status).toBe("verified");
    expect(report(verifier, "safe-online-backup").status).toBe("unknown"); expect(report(verifier, "complete-writer-fence").status).toBe("unknown");
  });
  it("measures completed backup byte roundtrip but leaves actual online backup and SQLite integrity unknown", async () => {
    const f = fixture("safe-online-backup", "backup-roundtrip-v1"), verifier = await createProductionMigrationArtifactVerifier(f.options());
    const result = report(verifier, "safe-online-backup");
    expect(result.measured).toContain("BACKUP_RESTORE_BYTE_ROUNDTRIP"); expect(result.status).toBe("unknown");
    expect(verifier.externalTrust.verifyArtifact(f.request())).toBeNull();
  });
  it("rejects missing backup completion instead of substituting a fenced snapshot", async () => {
    const f = fixture("safe-online-backup", "backup-roundtrip-v1"); f.receipt.measurement.backupRehearsal = null; f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "safe-online-backup").status).toBe("blocked");
  });
  it("rejects a mismatched actual restored file even with fresh signatures", async () => {
    const f = fixture("safe-online-backup", "backup-roundtrip-v1"); Object.assign(f.inputs.find(i => i.role === "restored")!, f.file("restored.sqlite", "different")); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "safe-online-backup").pending).toContain("RESTORE_BYTE_ROUNDTRIP_MISMATCH");
  });
  it.each(["snapshotSha256", "sourceSchemaSha256", "targetSchemaSha256", "releaseSha256"] as const)("rejects signed identity %s that differs from actual bytes", async field => {
    const f = fixture(); f.policy.expected.identity[field] = "a".repeat(64);
    f.receipt.claimsSha256 = productionMigrationArtifactClaimsDigest(f.manifest, "immutable-snapshot"); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("INDEPENDENT_IDENTITY_BYTES_MISMATCH");
  });
  it.each(["cohortId", "watermark", "snapshotWatermark"] as const)("rejects signed target catalog %s mismatch", async field => {
    const f = fixture(); const value = { version: 1, side: "target", identity: f.receipt.identity, cohortId: "cohort-1", snapshotWatermark: "source-w1", watermark: "target-w2",
      measuredAt: start, tables: [{ name: "history", columns: ["id", "value"] }], [field]: "forged" };
    const pin = f.file("target-catalog.json", canonical(value, 32)); Object.assign(f.inputs.find(i => i.role === "target-catalog")!, pin);
    f.policy.binding.liveCatalogSha256 = pin.sha256; f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("CATALOG_SCOPE_OR_TIME_MISMATCH");
  });
  it("rejects catalog measured after receipt completion even if fresh and signed", async () => {
    const f = fixture(); const value = { version: 1, side: "target", identity: f.receipt.identity, cohortId: "cohort-1", snapshotWatermark: "source-w1", watermark: "target-w2",
      measuredAt: "2026-10-04T03:59:59.000Z", tables: [{ name: "history", columns: ["id", "value"] }] };
    f.receipt.measurement.completedAt = "2026-10-04T03:59:30.000Z";
    const pin = f.file("target-catalog.json", canonical(value, 32)); Object.assign(f.inputs.find(i => i.role === "target-catalog")!, pin);
    f.policy.binding.liveCatalogSha256 = pin.sha256; f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").status).toBe("blocked");
  });
  it("does not accept signed self-reported success fields", async () => {
    const f = fixture(); Object.assign(f.receipt.measurement, { success: true, fencingProved: true }); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("UNKNOWN_OR_MISSING_FIELDS");
  });
  it.each(["cohortId", "watermark"] as const)("binds manifest %s rather than trusting policy in isolation", async field => {
    const f = fixture(); f.manifest.scope[field] = "other"; f.receipt.claimsSha256 = productionMigrationArtifactClaimsDigest(f.manifest, "immutable-snapshot"); f.resealReceipt();
    await expect(createProductionMigrationArtifactVerifier(f.options())).rejects.toThrow("MANIFEST_SCOPE_MISMATCH");
  });
  it.each(["sourceRows", "preservedRows", "quarantinedRows", "sourceSha256", "retainedSha256"] as const)("derives %s from files, not signed claims", async field => {
    const f = fixture("lossless-all-tables", "lossless-table-records-v1"); f.manifest.tables.entries[0]![field] = field.endsWith("Sha256") ? "a".repeat(64) : "9";
    f.receipt.claimsSha256 = productionMigrationArtifactClaimsDigest(f.manifest, "lossless-all-tables"); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "lossless-all-tables").pending).toContain("DERIVED_ALL_TABLE_ACCOUNTING_MISMATCH");
  });
  it("preserves duplicate row multiplicity, blobs, nulls and i64 values without JS rounding", () => {
    const f = fixture(); expect(rowsDigest(f.rows, 32)).toBe(rowsDigest([...f.rows].reverse(), 32));
    expect(rowsDigest([f.rows[0]!], 32)).not.toBe(rowsDigest([f.rows[0]!, f.rows[0]!], 32));
    expect(() => rowsDigest([{ id: { storage: "integer", decimal: "9223372036854775808" } }], 32)).toThrow("INVALID_LOSSLESS_CELL");
  });
  it("blocks missing typed columns and dropped rows independently of signed metadata", async () => {
    const f = fixture("lossless-all-tables", "lossless-table-records-v1"); const doc = f.records("retained", [{ id: { storage: "integer", decimal: "9007199254740993" } }]);
    Object.assign(f.inputs.find(i => i.role === "retained-records")!, f.file("retained-records.json", canonical(doc, 32))); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "lossless-all-tables").pending).toContain("LOSSLESS_COLUMNS_REQUIRED");
  });
  it("rejects actual file changes against signed content pins", async () => {
    const f = fixture(); f.file("snapshot.sqlite", "tampered bytes");
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("FILE_CONTENT_PIN_MISMATCH");
  });
  it("requires the out-of-band policy byte digest", async () => {
    const f = fixture(); const options = f.options(); options.policySha256 = "a".repeat(64);
    await expect(createProductionMigrationArtifactVerifier(options)).rejects.toThrow("INVALID_POLICY_PIN_OR_BUDGET");
  });
  it("requires distinct approval, review and collector Ed25519 keys", async () => {
    const f = fixture(); const options = f.options(); options.manifestApprovalPublicKeys = [f.reviewer.base64];
    await expect(createProductionMigrationArtifactVerifier(options)).rejects.toThrow("INDEPENDENT_REVIEW_KEY_REQUIRED");
    f.policy.collectors[0]!.publicKeyBase64 = f.approval.base64;
    await expect(createProductionMigrationArtifactVerifier(f.options())).rejects.toThrow("INDEPENDENT_COLLECTOR_REQUIRED");
  });
  it("rejects alternate DER encodings of a shared key instead of treating text differences as independence", async () => {
    const f = fixture(), options = f.options();
    options.manifestApprovalPublicKeys = [Buffer.concat([Buffer.from(f.reviewer.base64, "base64"), Buffer.from([0])]).toString("base64")];
    await expect(createProductionMigrationArtifactVerifier(options)).rejects.toThrow("INVALID_PINNED_KEY");
  });
  it("does not accept an unpinned reviewer or forged collector signature", async () => {
    const f = fixture(); const options = f.options(); options.trustedReviewers[0]!.publicKeyBase64 = key().base64;
    await expect(createProductionMigrationArtifactVerifier(options)).rejects.toThrow("INVALID_SCOPED_SIGNATURE");
    f.receipt.signatureBase64 = Buffer.alloc(64).toString("base64");
    const pin = f.file("measurement.json", canonical(f.receipt, 32)); f.policy.artifacts[0]!.artifact = pin;
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("INVALID_SCOPED_SIGNATURE");
  });
  it.each(["2026-10-04T03:00:00.000Z", "2026-10-04T04:00:01.000Z"])("rejects signed stale/future measurements %s", async observedAt => {
    const f = fixture(); f.receipt.observedAt = observedAt; f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").status).toBe("blocked");
  });
  it("does not return late verified claims after policy expiration", async () => {
    const f = fixture(); let clock = now;
    const verifier = await createProductionMigrationArtifactVerifier(f.options(() => clock)); clock = end;
    expect(verifier.externalTrust.verifyArtifact(f.request())).toBeNull();
  });
  it("requires exact callback digest and identity, not any registered signed artifact", async () => {
    const f = fixture(), verifier = await createProductionMigrationArtifactVerifier(f.options());
    expect(verifier.externalTrust.verifyArtifact({ ...f.request(), claimsSha256: "f".repeat(64) })).toBeNull();
    expect(verifier.externalTrust.verifyArtifact({ ...f.request(), identity: { ...f.request().identity, generation: "another" } })).toBeNull();
  });
  it.each(["maxFiles", "maxRows", "maxColumns"] as const)("enforces explicit %s budgets", async field => {
    const f = fixture("lossless-all-tables", "lossless-table-records-v1"); f.policy.limits[field] = 1;
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "lossless-all-tables").status).toBe("blocked");
  });
  it("bounds actual catalog table cardinality", async () => {
    const f = fixture(); f.policy.limits.maxTables = 1;
    const pin = f.file("target-catalog.json", canonical({ version: 1, side: "target", identity: f.receipt.identity, cohortId: "cohort-1", snapshotWatermark: "source-w1", watermark: "target-w2",
      measuredAt: start, tables: [{ name: "history", columns: ["id", "value"] }, { name: "unknown", columns: ["id"] }] }, 32));
    Object.assign(f.inputs.find(i => i.role === "target-catalog")!, pin); f.policy.binding.liveCatalogSha256 = pin.sha256; f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("CATALOG_SCOPE_OR_TIME_MISMATCH");
  });
  it("rejects unknown or array derivation and skips without calling them evidence", async () => {
    const f = fixture(); Object.assign(f.receipt.measurement, { derivation: ["snapshot-bytes-v1"] }); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").status).toBe("blocked");
    const unknown = fixture("immutable-snapshot", "unknown-derivation");
    expect(report(await createProductionMigrationArtifactVerifier(unknown.options()), "immutable-snapshot").pending).toContain("UNSUPPORTED_CHECK_DERIVATION");
    const skipped = fixture(); Object.assign(skipped.receipt.test, { skipped: true }); skipped.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(skipped.options()), "immutable-snapshot").pending).toContain("INVALID_DERIVATION_TEST_METADATA");
  });
  it("rejects stale external expected context and a future reviewed policy", async () => {
    const f = fixture(); f.policy.expected.observedAt = "2026-10-04T03:00:00.000Z";
    await expect(createProductionMigrationArtifactVerifier(f.options())).rejects.toThrow("STALE_EXPECTED_CONTEXT");
    f.policy.expected.observedAt = start; f.policy.issuedAt = "2026-10-04T04:00:01.000Z";
    await expect(createProductionMigrationArtifactVerifier(f.options())).rejects.toThrow("STALE_POLICY_REVIEW");
  });
  it("rejects declared size and aggregate byte budgets, not only digests", async () => {
    const f = fixture(); f.policy.artifacts[0]!.artifact.size = "1";
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "immutable-snapshot").pending).toContain("FILE_CONTENT_PIN_MISMATCH");
    const budget = fixture(); budget.policy.limits.maxFileBytes = "4000"; budget.policy.limits.maxTotalBytes = "4000";
    expect(report(await createProductionMigrationArtifactVerifier(budget.options()), "immutable-snapshot").pending).toContain("TOTAL_READ_BUDGET_EXCEEDED");
  });
  it("rejects silently missing table accounting despite fresh collector and reviewer signatures", async () => {
    const f = fixture("lossless-all-tables", "lossless-table-records-v1"); f.manifest.tables.entries = [];
    f.receipt.claimsSha256 = productionMigrationArtifactClaimsDigest(f.manifest, "lossless-all-tables"); f.resealReceipt();
    expect(report(await createProductionMigrationArtifactVerifier(f.options()), "lossless-all-tables").pending).toContain("EXACT_MANIFEST_ACCOUNTING_REQUIRED");
  });
});

describe("protected bounded regular file reads and strict JSON", () => {
  const read = (f: ReturnType<typeof fixture>, path = "snapshot.sqlite", maxBytes = "1048576") => readProtectedMigrationArtifactFile({ path: join(f.root, path),
    trustedOwnerUids: owners, maxBytes, retainBytes: true, maxRetainedBytes: 1048576, maxReadMs: 2000, maxPathDepth: 32 });
  it.each(["symlink", "hardlink", "directory", "writable-ancestor", "writable-file"])("rejects %s instead of following or trusting it", async kind => {
    const f = fixture();
    if (kind === "symlink") symlinkSync(join(f.root, "snapshot.sqlite"), join(f.root, "unsafe"));
    if (kind === "hardlink") linkSync(join(f.root, "snapshot.sqlite"), join(f.root, "unsafe"));
    if (kind === "directory") mkdirSync(join(f.root, "unsafe"), 0o700);
    if (kind === "writable-ancestor") { mkdirSync(join(f.root, "unsafe"), 0o777); chmodSync(join(f.root, "unsafe"), 0o777); writeFileSync(join(f.root, "unsafe", "child"), "x", { mode: 0o444 }); }
    if (kind === "writable-file") { writeFileSync(join(f.root, "unsafe"), "x"); chmodSync(join(f.root, "unsafe"), 0o666); }
    await expect(read(f, kind === "writable-ancestor" ? "unsafe/child" : "unsafe")).rejects.toThrow();
  });
  it("streams binary files under byte budget without retaining them", async () => {
    const f = fixture(); f.file("large.bin", Buffer.alloc(200000, 17));
    const result = await readProtectedMigrationArtifactFile({ path: join(f.root, "large.bin"), trustedOwnerUids: owners, maxBytes: "200000",
      retainBytes: false, maxRetainedBytes: 1, maxReadMs: 2000, maxPathDepth: 32 });
    expect(result.bytes).toBeNull(); expect(result.size).toBe("200000"); expect(result.sha256).toBe(sha(Buffer.alloc(200000, 17)));
    await expect(read(f, "large.bin", "199999")).rejects.toThrow("UNSAFE_ARTIFACT_FILE");
  });
  it("rejects ancestor symlinks, owner mismatch and path-depth exhaustion", async () => {
    const f = fixture(); symlinkSync(f.root, join(f.root, "alias")); await expect(read(f, "alias/snapshot.sqlite")).rejects.toThrow();
    await expect(readProtectedMigrationArtifactFile({ path: join(f.root, "snapshot.sqlite"), trustedOwnerUids: [999999], maxBytes: "10000",
      retainBytes: true, maxRetainedBytes: 10000, maxReadMs: 2000, maxPathDepth: 32 })).rejects.toThrow();
    await expect(readProtectedMigrationArtifactFile({ path: join(f.root, "snapshot.sqlite"), trustedOwnerUids: owners, maxBytes: "10000",
      retainBytes: true, maxRetainedBytes: 10000, maxReadMs: 2000, maxPathDepth: 1 })).rejects.toThrow("PATH_DEPTH_BUDGET_EXCEEDED");
  });
  it("rejects getter/toJSON, prototypes, array holes, lossy numbers and invalid Unicode before signing", () => {
    let invoked = false;
    for (const value of [Object.defineProperty({}, "x", { enumerable: true, get() { invoked = true; return true; } }),
      { toJSON() { invoked = true; return {}; } }, new Date(), new Array(1), Number.MAX_SAFE_INTEGER + 1, -0, "\ud800"]) {
      expect(() => canonical(value, 32)).toThrow();
    }
    expect(invoked).toBe(false); expect(() => canonical({ a: { b: true } }, 1)).toThrow("JSON_DEPTH_BUDGET_EXCEEDED");
  });
  it("rejects duplicate keys and noncanonical policy bytes even with matching outer hash", async () => {
    const f = fixture(); const options = f.options(); options.policyBytes = Buffer.from('{"version":1,"version":1}'); options.policySha256 = sha(options.policyBytes);
    await expect(createProductionMigrationArtifactVerifier(options)).rejects.toThrow("NON_CANONICAL_JSON_BYTES");
  });
  it("rejects row getters before the public digest inspects cells", () => {
    let invoked = false;
    const row: MigrationLosslessRow = Object.defineProperty({}, "id", { enumerable: true, get() { invoked = true; return { storage: "integer", decimal: "1" }; } });
    expect(() => rowsDigest([row], 32)).toThrow("NON_PLAIN_JSON"); expect(invoked).toBe(false);
  });
  it("rejects nonenumerable JSON object fields instead of silently differing from JSON serialization", () => {
    const value = Object.defineProperty({}, "hidden", { value: true });
    expect(() => canonical(value, 32)).toThrow("NON_PLAIN_JSON");
  });
});

describe("reusable existing runtime catalog measurement", () => {
  it("uses one caller-owned read-only UOW and reports missing independent facts explicitly", async () => {
    const queries: string[] = []; let runs = 0;
    const tx: PostgresTransaction = { async query(sql) {
      queries.push(sql);
      return { rowCount: 1, rows: sql.startsWith("SET") ? [] : sql.includes("current_database") ? [{ database: "business", schema_name: "business_v2",
        generation_id: "gen-1", fingerprint: "a".repeat(64), server_address: "127.0.0.1", server_port: 5432, system_identifier: "123" }] : [{ name: "facts" }] };
    } };
    const runtime = { async run<T>(operation: (tx: PostgresTransaction) => Promise<T>) { runs++; return operation(tx); } };
    const result = await measureProductionMigrationLiveCatalog({ runtime, schema: "business_v2", maxTables: 10, maxReadMs: 1000, clock: () => now });
    expect(runs).toBe(1); expect(queries[0]).toBe("SET TRANSACTION READ ONLY"); expect(queries.slice(1).every(q => q.startsWith("SELECT"))).toBe(true);
    expect(result.readiness).toBe("unknown"); expect(result.cohortId).toBeNull(); expect(result.pending).toContain("FENCING_NOT_MEASURED");
    expect(result.catalogSha256).toBeNull(); expect(result.tableNamesSha256).toBe(sha(canonical(["facts"], 1)));
  });
  it("fails closed on permission/identity failures and timeout without a late receipt", async () => {
    await expect(measureProductionMigrationLiveCatalog({ runtime: { async run() { throw new Error("permission denied"); } }, schema: "business_v2", maxTables: 10, maxReadMs: 1000, clock: () => now })).rejects.toThrow();
    await expect(measureProductionMigrationLiveCatalog({ runtime: { run: () => new Promise(() => {}) }, schema: "business_v2", maxTables: 10, maxReadMs: 1, clock: () => now })).rejects.toThrow("LIVE_MEASUREMENT_DEADLINE");
  });
});

describe("readiness CLI external verifier wiring", () => {
  it("only validates saved protected artifacts, emits safe unknown output and never grants production authorization", () => {
    const f = fixture(); const options = f.options(); const policy = f.file("policy.json", options.policyBytes), manifest = f.file("manifest.json", canonical(f.manifest, 32));
    const args = ["--manifest", join(f.root, manifest.path), "--trusted-reviewer", "manifest-reviewer", "--trusted-key-id", "manifest-key", "--trusted-public-key-base64", f.approval.base64,
      "--max-age-ms", "300000", "--max-manifest-bytes", "1048576", "--max-json-depth", "32", "--max-read-ms", "2000", "--max-path-depth", "32", "--trusted-file-owner-uids", owners.join(","),
      "--artifact-policy", join(f.root, policy.path), "--artifact-policy-sha256", policy.sha256, "--artifact-root", f.root,
      "--trusted-artifact-reviewer", f.policy.reviewer, "--trusted-artifact-key-id", f.policy.keyId, "--trusted-artifact-public-key-base64", f.reviewer.base64, "--max-policy-bytes", "1048576"];
    // Fresh relative to the real CLI clock, not a mocked validation environment.
    const current = Date.now(), iso = (offset: number) => new Date(current + offset).toISOString();
    f.policy.issuedAt = f.policy.expected.observedAt = iso(-1000); f.policy.expiresAt = iso(60000);
    f.policy.binding.maintenanceWindow = { start: iso(-2000), end: iso(60000) };
    f.receipt.observedAt = f.receipt.test.executedAt = iso(0); f.receipt.measurement.startedAt = iso(-2000); f.receipt.measurement.completedAt = iso(-500);
    f.manifest.createdAt = iso(-1000); f.manifest.expiresAt = iso(60000); f.manifest.scope.maintenanceWindow = f.policy.binding.maintenanceWindow;
    f.receipt.claimsSha256 = productionMigrationArtifactClaimsDigest(f.manifest, "immutable-snapshot");
    for (const side of ["source", "target"] as const) {
      const pin = f.file(`${side}-catalog.json`, canonical({ version: 1, side, identity: f.receipt.identity, cohortId: "cohort-1", snapshotWatermark: "source-w1", watermark: "target-w2",
        measuredAt: iso(-1500), tables: [{ name: side === "source" ? "facts" : "history", columns: ["id", "value"] }] }, 32));
      Object.assign(f.inputs.find(i => i.role === `${side}-catalog`)!, pin); if (side === "target") f.policy.binding.liveCatalogSha256 = pin.sha256;
    }
    f.resealReceipt(); const fresh = f.options(); f.file("policy.json", fresh.policyBytes); f.file("manifest.json", canonical(f.manifest, 32));
    args[args.indexOf("--artifact-policy-sha256") + 1] = fresh.policySha256;
    const run = (values: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/check-production-migration-readiness.ts", ...values], { encoding: "utf8", timeout: 10000 });
    const child = run(args); expect(child.status).toBe(1); const output = JSON.parse(child.stdout);
    expect(output.validationOnly).toBe(true); expect(output.productionAuthorized).toBe(false); expect(output.ready).toBe(false);
    expect(output.artifacts.checks.find((c: MigrationArtifactCheckReport) => c.check === "immutable-snapshot").status).toBe("verified");
    expect(child.stdout + child.stderr).not.toContain(f.root); expect(child.stdout + child.stderr).not.toContain(f.reviewer.base64);
    const partial = args.slice(0, -2); const bad = run(partial); expect(bad.status).toBe(2); expect(JSON.parse(bad.stdout).error).toBe("INVALID_INPUT");
  });
});
