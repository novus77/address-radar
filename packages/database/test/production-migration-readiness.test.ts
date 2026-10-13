import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createPostgresBusinessProvisioningPlan, postgresBusinessResourcePolicyFingerprint,
  type PostgresBusinessProvisioningResources } from "../src/postgres-business-provisioning.js";
import {
  evaluateProductionMigrationReadiness,
  productionMigrationManifestDigest,
  productionMigrationApprovalPayload,
  productionMigrationArtifactClaimsDigest,
  PRODUCTION_MIGRATION_REQUIREMENTS,
  EXPECTED_PRODUCTION_SERVICES,
  EXPECTED_PRODUCTION_TIMERS,
  EXPECTED_PRODUCTION_INPUT_SERVICES,
  PRODUCTION_MIGRATION_SERVICE_IDS,
  type ProductionMigrationReadinessManifest,
  type ReadinessEvaluationOptions,
  type MigrationApproval,
  type MigrationExpectedContext,
  type MigrationArtifactCheck,
} from "../src/production-migration-readiness.js";

const now = "2026-10-04T04:00:00.000Z";
const earlier = "2026-10-04T03:50:00.000Z";
const later = "2026-10-04T04:10:00.000Z";
const hash = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const expectedIdentity = {
  snapshotId: "snapshot", snapshotSha256: hash, sourceId: "source", sourceSchemaSha256: hash,
  targetId: "dedicated-business", targetSchemaSha256: hash, generation: "generation-2", releaseSha256: hash,
};
const expectedTables = Array.from({ length: 141 }, (_, i) => `table_${i}`);
const expectedWriters: MigrationExpectedContext["writerInventory"] = [
  { kind: "services", members: [...EXPECTED_PRODUCTION_SERVICES, ...EXPECTED_PRODUCTION_INPUT_SERVICES] },
  { kind: "timers", members: [...EXPECTED_PRODUCTION_TIMERS] },
  ...(["operators", "deploy", "usercron", "externalInputs"] as const).map(kind => ({ kind, members: [`known-${kind}`] })),
];
const independentlyCheckedArtifacts = new Map<string, Buffer>();
const expectedContext: MigrationExpectedContext = {
  observedAt: now, identity: expectedIdentity, sourceTables: expectedTables, writerInventory: expectedWriters,
};
const options: ReadinessEvaluationOptions = {
  now, maxEvidenceAgeMs: 3_600_000,
  trustedReviewers: [{ keyId: "review-key", reviewer: "reviewer", publicKeyBase64: publicKey }],
  externalTrust: {
    expected: expectedContext, trustedArtifactVerifierIds: ["independent-test-verifier"],
    verifyArtifact(request) {
      const bytes = independentlyCheckedArtifacts.get(request.artifactSha256);
      return bytes ? { bytes, verifierId: "independent-test-verifier", verifiedAt: now, assertionsPassed: true } : null;
    },
  },
};

// Synthetic verifier output is explicitly outside the manifest. These are
// checker fixtures, not claims of production test execution.
function publishVerifiedFixtureArtifacts(manifest: ProductionMigrationReadinessManifest) {
  for (const check of [...PRODUCTION_MIGRATION_REQUIREMENTS.map(requirement => requirement.check), "purge-dry-run"] as MigrationArtifactCheck[]) {
    const test = { name: `test:${check}`, status: "passed" as const, executedAt: now, skipped: false };
    const bytes = Buffer.from(JSON.stringify({ check, identity: manifest.identity, observedAt: now, test,
      claimsSha256: productionMigrationArtifactClaimsDigest(manifest, check) }));
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    independentlyCheckedArtifacts.set(artifactSha256, bytes);
    manifest.evidence[check] = { status: "passed", owner: "evidence-owner", artifactSha256,
      identity: { ...manifest.identity }, observedAt: now, test };
  }
  manifest.rollback.beforeWrites.artifactSha256 = manifest.evidence["rollback-before-writes"]!.artifactSha256;
  manifest.rollback.afterWrites.artifactSha256 = manifest.evidence["rollback-after-writes"]!.artifactSha256;
  manifest.purgeScope!.dryRunArtifactSha256 = manifest.evidence["purge-dry-run"]!.artifactSha256;
}

function approve(manifest: ProductionMigrationReadinessManifest, includePurge = false) {
  manifest.approvals = [];
  const manifestSha256 = productionMigrationManifestDigest(manifest);
  const scopes: MigrationApproval["scope"][] = ["preservation", "operationalCutover", "businessActivation"];
  if (includePurge) scopes.push("purge");
  for (const scope of scopes) {
    const approval: MigrationApproval = {
      scope, manifestSha256, reviewer: "reviewer", keyId: "review-key", decision: "approved",
      issuedAt: now, expiresAt: later, signatureBase64: "",
    };
    approval.signatureBase64 = sign(null, Buffer.from(productionMigrationApprovalPayload(approval)), keys.privateKey).toString("base64");
    manifest.approvals.push(approval);
  }
  return manifest;
}

function fixture(): ProductionMigrationReadinessManifest {
  const identity = { ...expectedIdentity };
  const sourceTables = [...expectedTables];
  const manifest: ProductionMigrationReadinessManifest = {
    version: 1, createdAt: now, expiresAt: later, identity,
    scope: { cohortId: "reviewed-cohort", snapshotWatermark: "watermark-1", watermark: "watermark-2", rollbackTarget: "rollback-release",
      maintenanceWindow: { start: earlier, end: later } },
    safety: { deliveryEnabled: false, fomoCaptureEnabled: false, historicalMiningEnabled: false, automaticOwnerMergeEnabled: false },
    evidence: {},
    tables: { reviewedSourceTables: sourceTables, entries: sourceTables.map(table => ({
      table, destination: "history", sourceRows: "9007199254740993", preservedRows: "9007199254740992", quarantinedRows: "1",
      sourceSha256: hash, retainedSha256: hash, quarantineLossless: true, retrievalTestPassed: true,
    })) },
    roles: [
      { access: "migration", service: null, name: "business_migration", connectionLimit: 1, superuser: false, leastPrivilegeProved: true },
      ...PRODUCTION_MIGRATION_SERVICE_IDS.map(service => ({ access: service === "console" ? "read" as const : "runtime" as const,
        service, name: `business_${service.replaceAll("-", "_")}`, connectionLimit: 1, superuser: false, leastPrivilegeProved: true })),
    ],
    capacity: {
      pools: PRODUCTION_MIGRATION_SERVICE_IDS.map(service => ({ service, instances: 1, maxPerInstance: 1 })),
      migrationConnections: 1, operatorConnections: 1, backupConnections: 1, postgresReservedConnections: 1, postgresMaxConnections: 10,
      databaseConnectionLimit: 9, otherHostConnections: 0,
      availableRamBytes: "1000", measuredPeakRamBytes: "500", ramReserveBytes: "100",
      availableDiskBytes: "2000", measuredPeakDiskBytes: "500", measuredPeakWalBytes: "100", measuredPeakTempBytes: "100", diskReserveBytes: "100",
      pressureAcceptancePassed: true,
    },
    writerFence: {
      generation: identity.generation, sourceId: identity.sourceId, enforcedAt: earlier, validUntil: later,
      mechanism: "generation-rejection-and-input-barrier", staleWriteRejected: true, newWriterAdmissionBlocked: true,
      inventory: expectedWriters.map(group => ({ ...group, members: [...group.members], complete: true, fenced: true })),
    },
    finalBoundary: {
      mode: "full-fenced-snapshot", snapshotId: identity.snapshotId, snapshotSha256: identity.snapshotSha256,
      generation: identity.generation, completedAt: now, watermark: "watermark-2", allTables: sourceTables, gapFree: true,
    },
    rollback: {
      target: "rollback-release", generation: identity.generation, strategy: "reverse-delta", journalStartedAt: earlier,
      durable: true, continuous: true, retainedInputAndMutations: true, firstNewWriteAt: "2026-10-04T03:55:00.000Z",
      beforeWrites: { testedAt: earlier, artifactSha256: hash, parityPassed: true, commitUnknownReconciled: true },
      afterWrites: { testedAt: now, artifactSha256: hash, parityPassed: true, commitUnknownReconciled: true, newWritesRecovered: true },
    },
    business: {
      cohortId: "reviewed-cohort", watermark: "watermark-2", explicitlySelected: true, oldMarketProofComplete: true,
      coverageIntervalsProved: true, scopeExcludesFomo: true, realEventIds: ["real-event"], naturalTwoTraderCase: true,
      committedConsumerReceipts: true, confirmedPolicyPassed: true,
    },
    retention: { nonDestructiveImport: true, protectedEvidenceRetained: true, rawHotDays: 15, purchaseProofDays: 30,
      purgeJobsExcluded: true, purgeRequested: false },
    approvals: [],
    purgeScope: {
      operationId: "exact-raw-archive-purge", targetId: identity.targetId, generation: identity.generation,
      snapshotSha256: identity.snapshotSha256, protectedExclusionSha256: hash, dryRunArtifactSha256: hash,
      selectors: [{ table: sourceTables[0]!, partitionId: "raw-2026-09-01", cutoffExclusive: "2026-09-01T00:00:00.000Z", expectedRows: "1", selectionSha256: hash }],
    },
  };
  publishVerifiedFixtureArtifacts(manifest);
  expectedContext.purgeScope = structuredClone(manifest.purgeScope!);
  return approve(manifest);
}

function result(manifest: unknown) { return evaluateProductionMigrationReadiness(manifest, options); }
function checkBlocked(manifest: ProductionMigrationReadinessManifest, gate: "preservation" | "operationalCutover" | "businessActivation") {
  expect(result(approve(manifest)).gates[gate].ready).toBe(false);
}

describe("production migration readiness", () => {
  it("passes all three gates with explicit signed evidence, without purge approval", () => {
    const r = result(fixture());
    expect(r.ready).toBe(true);
    expect(r.gates.preservation.ready).toBe(true);
    expect(r.gates.operationalCutover.ready).toBe(true);
    expect(r.gates.businessActivation.ready).toBe(true);
    expect(r.purge.ready).toBe(false);
    expect(new Set(r.checks.map(check => check.gateId)).size).toBe(23);
  });

  it.each(PRODUCTION_MIGRATION_REQUIREMENTS)("fails closed for absent evidence $check", ({ check, acceptance }) => {
    const manifest = fixture();
    delete manifest.evidence[check];
    checkBlocked(manifest, acceptance);
  });

  it.each([null, {}, [], "ready", { version: 1, ready: true }])("rejects malformed or incomplete manifests (%j)", manifest => {
    expect(result(manifest).ready).toBe(false);
  });

  it.each(["unknown", "blocked", "skipped", "false"])("rejects non-passing status %s", status => {
    const manifest = fixture();
    Object.assign(manifest.evidence["exact-ddl"]!, { status });
    checkBlocked(manifest, "preservation");
  });

  it("rejects untrusted, forged, absent, expired and differently scoped approvals", () => {
    const a = fixture(); a.approvals = []; expect(result(a).ready).toBe(false);
    const b = fixture(); b.approvals[0]!.signatureBase64 = Buffer.alloc(64).toString("base64"); expect(result(b).gates.preservation.ready).toBe(false);
    const c = fixture(); c.approvals[0]!.keyId = "untrusted"; expect(result(c).gates.preservation.ready).toBe(false);
    const d = fixture(); d.approvals[0]!.expiresAt = earlier; expect(result(d).gates.preservation.ready).toBe(false);
    const e = fixture(); e.approvals[0]!.scope = "purge"; expect(result(e).gates.preservation.ready).toBe(false);
    const f = fixture(); f.evidence["exact-ddl"]!.artifactSha256 = "b".repeat(64); expect(result(f).gates.preservation.ready).toBe(false);
  });

  it.each(Object.keys(fixture().identity))("rejects inconsistent receipt identity %s", field => {
    const manifest = fixture();
    Object.assign(manifest.evidence["exact-ddl"]!.identity, { [field]: field.endsWith("Sha256") ? "b".repeat(64) : "different" });
    checkBlocked(manifest, "preservation");
  });

  it.each(["2026-10-03T00:00:00.000Z", "2026-10-04T04:01:00.000Z", "not-a-time", "2026-02-30T00:00:00.000Z"])("rejects invalid/stale/future receipt timestamp %s", time => {
    const manifest = fixture(); manifest.evidence["exact-ddl"]!.observedAt = time; checkBlocked(manifest, "preservation");
  });

  it("requires freshness of manifest, tests, approvals and explicit evaluation policy", () => {
    const m = fixture(); m.createdAt = "2026-10-03T00:00:00.000Z"; checkBlocked(m, "preservation");
    const n = fixture(); n.evidence["exact-ddl"]!.test.executedAt = "2026-10-03T00:00:00.000Z"; checkBlocked(n, "preservation");
    const p = fixture(); p.evidence["exact-ddl"]!.test.skipped = true; checkBlocked(p, "preservation");
    expect(evaluateProductionMigrationReadiness(fixture(), { ...options, maxEvidenceAgeMs: 0 }).ready).toBe(false);
    expect(evaluateProductionMigrationReadiness(fixture(), { ...options, trustedReviewers: [] }).ready).toBe(false);
  });

  it("preserves legacy market gaps without activating the affected sample", () => {
    const m = fixture(); delete m.evidence["active-market-proof"]; m.business.oldMarketProofComplete = false;
    const r = result(approve(m));
    expect(r.gates.preservation.ready).toBe(true); expect(r.gates.operationalCutover.ready).toBe(true);
    expect(r.gates.businessActivation.ready).toBe(false);
  });

  it("allows preservation-only approval without operational budgets or activation scope", () => {
    const m = fixture();
    for (const key of ["cohortId", "watermark", "rollbackTarget", "maintenanceWindow"]) delete (m.scope as unknown as Record<string, unknown>)[key];
    for (const key of ["capacity", "roles", "business"]) delete (m as unknown as Record<string, unknown>)[key];
    approve(m);
    m.approvals = m.approvals.filter(approval => approval.scope === "preservation");
    const r = result(m);
    expect(r.gates.preservation.ready).toBe(true);
    expect(r.gates.operationalCutover.ready).toBe(false);
    expect(r.gates.businessActivation.ready).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("needs deletion approval only for purge and protects 30-day proof", () => {
    const m = fixture(); m.retention.purgeRequested = true;
    expect(result(approve(m)).ready).toBe(true); expect(result(m).purge.ready).toBe(false);
    expect(result(approve(m, true)).purge.ready).toBe(true);
    m.retention.purchaseProofDays = 15; checkBlocked(m, "preservation");
  });

  it("accounts for all tables and large integer row counts exactly", () => {
    const m = fixture(); m.tables.entries.pop(); checkBlocked(m, "preservation");
    const n = fixture(); n.tables.entries[0]!.preservedRows = "9007199254740991"; checkBlocked(n, "preservation");
    const p = fixture(); p.tables.entries[0]!.retainedSha256 = "b".repeat(64); checkBlocked(p, "preservation");
    const q = fixture(); q.tables.entries[1]!.table = q.tables.entries[0]!.table; checkBlocked(q, "preservation");
    const s = fixture(); s.tables.entries[0]!.quarantineLossless = false; checkBlocked(s, "preservation");
  });

  it.each([...EXPECTED_PRODUCTION_SERVICES, ...EXPECTED_PRODUCTION_INPUT_SERVICES, ...EXPECTED_PRODUCTION_TIMERS, "operators", "deploy", "usercron", "externalInputs"])("requires fence inventory member/category %s", name => {
    const m = fixture();
    m.writerFence.inventory = m.writerFence.inventory.filter(group => group.kind !== name);
    for (const group of m.writerFence.inventory) group.members = group.members.filter(member => member !== name);
    checkBlocked(m, "operationalCutover");
  });

  it("rejects PID census, stale generations, unfenced extra inputs and future-writer admission", () => {
    const m = fixture(); Object.assign(m.writerFence, { mechanism: "pid-census" }); checkBlocked(m, "operationalCutover");
    const n = fixture(); n.writerFence.generation = "old"; checkBlocked(n, "operationalCutover");
    const p = fixture(); p.writerFence.newWriterAdmissionBlocked = false; checkBlocked(p, "operationalCutover");
    const q = fixture(); q.writerFence.inventory.push({ kind: "externalInputs", members: ["bridge"], complete: true, fenced: false }); checkBlocked(q, "operationalCutover");
  });

  it("requires least privilege, six pools, global reserves, and measured capacity", () => {
    const m = fixture(); m.capacity.postgresMaxConnections = 9; checkBlocked(m, "operationalCutover");
    const n = fixture(); n.roles[0]!.connectionLimit = 5; checkBlocked(n, "operationalCutover");
    const p = fixture(); p.capacity.pools.pop(); checkBlocked(p, "operationalCutover");
    const q = fixture(); q.roles[0]!.superuser = true; checkBlocked(q, "operationalCutover");
    const s = fixture(); s.capacity.availableDiskBytes = "700"; checkBlocked(s, "operationalCutover");
    const t = fixture(); delete (t.capacity as unknown as Record<string, unknown>).measuredPeakRamBytes; checkBlocked(t, "operationalCutover");
  });

  it("requires final fenced snapshot or a continuous complete delta", () => {
    const m = fixture(); m.finalBoundary.completedAt = "2026-10-04T03:49:00.000Z"; checkBlocked(m, "operationalCutover");
    const n = fixture(); n.finalBoundary.allTables.pop(); checkBlocked(n, "operationalCutover");
    const p = fixture(); p.finalBoundary.mode = "delta"; checkBlocked(p, "operationalCutover");
    p.finalBoundary.delta = { fromWatermark: "watermark-1", toWatermark: "watermark-2", continuous: true, allMutationKindsIncluded: true };
    publishVerifiedFixtureArtifacts(p);
    expect(result(approve(p)).gates.operationalCutover.ready).toBe(true);
    p.finalBoundary.delta.continuous = false; checkBlocked(p, "operationalCutover");
    p.finalBoundary.delta.continuous = true;
    p.finalBoundary.delta.fromWatermark = "unrelated-snapshot-watermark"; checkBlocked(p, "operationalCutover");
  });

  it.each(["beforeWrites", "afterWrites"] as const)("requires rollback rehearsal %s even before cutover", phase => {
    const m = fixture(); delete (m.rollback as unknown as Record<string, unknown>)[phase]; checkBlocked(m, "operationalCutover");
  });

  it("rejects journal gaps, unrecovered new writes and commit-unknown blindness", () => {
    const m = fixture(); m.rollback.journalStartedAt = now; checkBlocked(m, "operationalCutover");
    const n = fixture(); n.rollback.afterWrites.newWritesRecovered = false; checkBlocked(n, "operationalCutover");
    const p = fixture(); p.rollback.afterWrites.commitUnknownReconciled = false; checkBlocked(p, "operationalCutover");
    const q = fixture(); q.rollback.afterWrites.artifactSha256 = "b".repeat(64); checkBlocked(q, "operationalCutover");
  });

  it.each(["deliveryEnabled", "fomoCaptureEnabled", "historicalMiningEnabled", "automaticOwnerMergeEnabled"])("rejects unsafe activation flag %s", flag => {
    const m = fixture(); Object.assign(m.safety, { [flag]: true }); checkBlocked(m, "preservation");
  });

  it("does not expose untrusted paths, credentials or evidence in machine output", () => {
    const secret = "postgres://secret:password@host/private-source";
    const m = fixture(); m.identity.sourceId = secret;
    expect(JSON.stringify(result(m))).not.toContain(secret);
  });

  it("CLI emits sanitized JSON with nonzero exit for saved unready and malformed manifests", () => {
    const directory = mkdtempSync(join(process.cwd(), ".readiness-cli-test-"));
    try {
      const path = join(directory, "manifest.json");
      const args = ["--manifest", path, "--trusted-reviewer", "reviewer", "--trusted-key-id", "review-key", "--trusted-public-key-base64", publicKey, "--max-age-ms", "3600000",
        "--max-manifest-bytes", "1048576", "--max-json-depth", "32", "--max-read-ms", "2000", "--max-path-depth", "32", "--trusted-file-owner-uids", [...new Set([0, process.getuid!()])].join(",")];
      writeFileSync(path, JSON.stringify({ secret: "must-not-leak" }));
      const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-production-migration-readiness.ts", ...args], { encoding: "utf8" });
      expect(cli.status).toBe(1); expect(JSON.parse(cli.stdout).ready).toBe(false);
      expect(JSON.parse(cli.stdout).validationOnly).toBe(true);
      expect(JSON.parse(cli.stdout).productionAuthorized).toBe(false);
      expect(cli.stdout + cli.stderr).not.toContain("must-not-leak");
      writeFileSync(path, "not JSON password");
      const bad = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-production-migration-readiness.ts", ...args], { encoding: "utf8" });
      expect(bad.status).toBe(2); expect(JSON.parse(bad.stdout).error).toBe("INVALID_INPUT");
      expect(bad.stdout + bad.stderr).not.toContain("password");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("independent trust and reviewer safety regressions", () => {
  it("rejects signed passed booleans without external context and verified artifacts", () => {
    const m = fixture();
    const r = evaluateProductionMigrationReadiness(m, { now, maxEvidenceAgeMs: options.maxEvidenceAgeMs, trustedReviewers: options.trustedReviewers });
    expect(r.ready).toBe(false);
    expect(r.gates.preservation.ready).toBe(false);
    expect(r.validationOnly).toBe(true);
    expect(r.productionAuthorized).toBe(false);
  });

  it.each(Object.keys(expectedIdentity))("requires independently pinned identity field %s even after coherent re-signing", field => {
    const m = fixture();
    Object.assign(m.identity, { [field]: field.endsWith("Sha256") ? "b".repeat(64) : "coherent-but-unexpected" });
    for (const receipt of Object.values(m.evidence)) receipt!.identity = { ...m.identity };
    const r = result(approve(m));
    expect(r.gates.preservation.blockers.some(blocker => blocker.code === "TRUSTED_EXTERNAL_CONTEXT_AND_VERIFIER_REQUIRED")).toBe(true);
  });

  it("rejects a self-consistent replacement catalog of exactly 141 fake tables", () => {
    const m = fixture();
    m.tables.reviewedSourceTables = m.tables.reviewedSourceTables.map(name => `fake_${name}`);
    m.tables.entries.forEach(entry => { entry.table = `fake_${entry.table}`; });
    m.finalBoundary.allTables = [...m.tables.reviewedSourceTables];
    const r = result(approve(m));
    expect(r.gates.preservation.blockers.some(blocker => blocker.code === "LOSSLESS_ALL_TABLE_ACCOUNTING_REQUIRED")).toBe(true);
  });

  it.each(["operators", "deploy", "usercron", "externalInputs"])("rejects signed empty inventory for independently known %s", kind => {
    const m = fixture();
    m.writerFence.inventory.find(group => group.kind === kind)!.members = [];
    const r = result(approve(m));
    expect(r.gates.operationalCutover.blockers.some(blocker => blocker.code === "PROVED_COMPLETE_WRITER_FENCE_REQUIRED")).toBe(true);
  });

  it("rejects missing or stale external expectations and an unlisted extra writer", () => {
    const m = fixture(), external = options.externalTrust!;
    const stale = { ...external.expected, observedAt: "2026-10-03T00:00:00.000Z" };
    expect(evaluateProductionMigrationReadiness(m, { ...options, externalTrust: { ...external, expected: stale } }).ready).toBe(false);
    const absent = structuredClone(external.expected);
    delete (absent as unknown as Record<string, unknown>).writerInventory;
    expect(evaluateProductionMigrationReadiness(m, { ...options, externalTrust: { ...external, expected: absent } }).gates.operationalCutover.ready).toBe(false);
    m.writerFence.inventory.find(group => group.kind === "externalInputs")!.members.push("unreviewed-collector");
    expect(result(approve(m)).gates.operationalCutover.ready).toBe(false);
  });

  it.each(["missing", "failed-assertions", "untrusted-verifier", "stale", "wrong-bytes", "throws"])("rejects external artifact verification %s", failure => {
    const m = fixture(), external = options.externalTrust!;
    const changed = { ...external, verifyArtifact: (request: Parameters<typeof external.verifyArtifact>[0]) => {
      if (failure === "throws") throw new Error("private failure details");
      if (failure === "missing") return null;
      const original = external.verifyArtifact(request)!;
      return { ...original,
        assertionsPassed: failure !== "failed-assertions",
        verifierId: failure === "untrusted-verifier" ? "manifest-selected" : original.verifierId,
        verifiedAt: failure === "stale" ? "2026-10-03T00:00:00.000Z" : original.verifiedAt,
        bytes: failure === "wrong-bytes" ? Buffer.from("substituted private artifact") : original.bytes,
      };
    } };
    const r = evaluateProductionMigrationReadiness(m, { ...options, externalTrust: changed });
    expect(r.gates.preservation.ready).toBe(false);
    expect(JSON.stringify(r)).not.toContain("private");
  });

  it.each(["check", "claimsSha256", "identity", "observedAt", "test"])("checks actual artifact content binding %s even with a matching byte digest", field => {
    const m = fixture(), receipt = m.evidence["exact-ddl"]!;
    const body = JSON.parse(independentlyCheckedArtifacts.get(receipt.artifactSha256)!.toString());
    body[field] = field === "identity" ? { ...expectedIdentity, targetId: "wrong-target" } : field === "test" ? { ...body.test, skipped: true } : "different";
    const bytes = Buffer.from(JSON.stringify(body));
    receipt.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    approve(m);
    const external = options.externalTrust!;
    const r = evaluateProductionMigrationReadiness(m, { ...options, externalTrust: { ...external,
      verifyArtifact(request) {
        return request.check === "exact-ddl" ? { bytes, verifierId: "independent-test-verifier", verifiedAt: now, assertionsPassed: true } : external.verifyArtifact(request);
      },
    } });
    expect(r.gates.preservation.ready).toBe(false);
  });

  it("binds independently verified claims despite valid approval signatures", () => {
    const m = fixture();
    m.capacity.availableRamBytes = "5000";
    m.business.confirmedPolicyPassed = true;
    m.business.realEventIds = ["invented-replacement-event"];
    const r = result(approve(m));
    expect(r.gates.preservation.ready).toBe(true);
    expect(r.gates.operationalCutover.ready).toBe(false);
    expect(r.gates.businessActivation.ready).toBe(false);
  });

  it("rejects array discriminants without skipping mode-specific checks", () => {
    const m = fixture(); Object.assign(m.finalBoundary, { mode: ["delta"] });
    expect(result(approve(m)).gates.operationalCutover.blockers.some(blocker => blocker.code === "FINAL_FENCED_BOUNDARY_REQUIRED")).toBe(true);
    const n = fixture(); Object.assign(n.rollback, { strategy: ["compatible-postgres-release"] });
    expect(result(approve(n)).gates.operationalCutover.blockers.some(blocker => blocker.code === "DURABLE_JOURNAL_AND_BOTH_ROLLBACK_REHEARSALS_REQUIRED")).toBe(true);
  });

  it("rejects toJSON and getters before invoking either during hashing or evaluation", () => {
    const m = fixture(); let calls = 0;
    Object.defineProperty(m, "toJSON", { enumerable: true, value() { calls += 1; return fixture(); } });
    expect(() => productionMigrationManifestDigest(m)).toThrow();
    expect(result(m).ready).toBe(false); expect(calls).toBe(0);
    const n = fixture();
    Object.defineProperty(n.identity, "targetId", { enumerable: true, get() { calls += 1; return "dedicated-business"; } });
    expect(() => productionMigrationManifestDigest(n)).toThrow();
    expect(result(n).ready).toBe(false); expect(calls).toBe(0);
  });

  it.each([undefined, NaN, Infinity, -0, 1n, new Date(now), new String("delta"), Symbol("private"), () => true])("rejects non-JSON nested values (%s)", value => {
    const m = fixture(); Object.assign(m, { injected: value });
    expect(() => productionMigrationManifestDigest(m)).toThrow(); expect(result(m).ready).toBe(false);
  });

  it("rejects cycles, sparse/extended arrays and custom prototypes", () => {
    const m = fixture(); Object.assign(m, { cycle: m }); expect(() => productionMigrationManifestDigest(m)).toThrow(); expect(result(m).ready).toBe(false);
    const n = fixture(); Object.assign(n, { injected: Array(2) }); expect(result(n).ready).toBe(false);
    const p = fixture(); Object.assign(p.finalBoundary.allTables, { additional: "hidden" }); expect(result(p).ready).toBe(false);
    const q = fixture(); Object.setPrototypeOf(q.identity, { inherited: true }); expect(result(q).ready).toBe(false);
    const s = fixture(); Object.defineProperty(s, Symbol("hidden"), { value: "private" }); expect(result(s).ready).toBe(false);
    expect(() => productionMigrationManifestDigest([])).toThrow();
  });

  it.each(["writerFence", "capacity", "finalBoundary", "rollback"])("blocks approved purge without operational write safety %s", field => {
    const m = fixture(); m.retention.purgeRequested = true;
    delete (m as unknown as Record<string, unknown>)[field];
    const r = result(approve(m, true));
    expect(r.gates.preservation.ready).toBe(true); expect(r.purge.ready).toBe(false);
    expect(r.purge.blockers.some(blocker => blocker.code === "OPERATIONAL_WRITE_SAFETY_NOT_READY")).toBe(true);
  });

  it.each(["missing-scope", "wrong-target", "wildcard", "wrong-count", "unknown-table", "recent-cutoff", "missing-selectors", "wrong-protection"])("rejects signed purge with inexact scope %s", failure => {
    const m = fixture(); m.retention.purgeRequested = true;
    const scope = m.purgeScope!, selector = scope.selectors[0]!;
    if (failure === "missing-scope") delete m.purgeScope;
    if (failure === "wrong-target") scope.targetId = "different-target";
    if (failure === "wildcard") selector.partitionId = "*";
    if (failure === "wrong-count") selector.expectedRows = "2";
    if (failure === "unknown-table") selector.table = "unreviewed-table";
    if (failure === "recent-cutoff") selector.cutoffExclusive = now;
    if (failure === "missing-selectors") scope.selectors = [];
    if (failure === "wrong-protection") scope.protectedExclusionSha256 = "b".repeat(64);
    const r = result(approve(m, true));
    expect(r.gates.preservation.ready).toBe(true); expect(r.gates.operationalCutover.ready).toBe(true);
    expect(r.purge.ready).toBe(false);
  });

  it("requires externally pinned purge selectors and an independently verified dry run", () => {
    const m = fixture(); m.retention.purgeRequested = true; approve(m, true);
    const external = options.externalTrust!, expected = structuredClone(external.expected);
    delete expected.purgeScope;
    expect(evaluateProductionMigrationReadiness(m, { ...options, externalTrust: { ...external, expected } }).purge.ready).toBe(false);
    const r = evaluateProductionMigrationReadiness(m, { ...options, externalTrust: { ...external,
      verifyArtifact(request) { return request.check === "purge-dry-run" ? null : external.verifyArtifact(request); },
    } });
    expect(r.ready).toBe(true); expect(r.purge.ready).toBe(false);
  });
});

describe("dedicated service-role provisioning compatibility", () => {
  const services = ["scanner", "automation", "wallet-monitor", "wallet-analysis", "historical-backfill", "console"] as const;
  function provisionedFixture() {
    const m = fixture();
    const resources: PostgresBusinessProvisioningResources = {
      pools: Object.fromEntries(services.map(service => [service, { instances: 1, maximumConnections: 1 }])) as PostgresBusinessProvisioningResources["pools"],
      serverMaximumConnections: 10, postgresReservedConnections: 1, otherHostConnections: 0,
      migrationConnections: 1, operatorConnections: 1, backupConnections: 1,
      maximumPendingOperations: 0, connectionTimeoutMs: 1000, idleTimeoutMs: 1000,
      statementTimeoutMs: 1000, lockTimeoutMs: 500, idleTransactionTimeoutMs: 1000,
      shutdownTimeoutMs: 1000, workMemKb: 64, maximumMeasurementAgeMs: 3_600_000,
    };
    const plan = createPostgresBusinessProvisioningPlan({
      database: "radar_business", schema: "business_v1", generation: "generation-2", migratorRole: "business_migration",
      serviceRoles: Object.fromEntries(services.map(service => [service, `business_${service.replaceAll("-", "_")}`])) as Record<typeof services[number], string>,
      resources, now,
      capacity: { status: "measured", hostId: "fixture-host", measurementRef: "fixture-pressure",
        resourcePolicyFingerprint: postgresBusinessResourcePolicyFingerprint(resources), measuredAt: earlier, validUntil: later,
        availableRamBytes: "1000", measuredPeakRamBytes: "500", ramMarginBytes: "100",
        availableDiskBytes: "2000", measuredPeakDiskBytes: "500", measuredPeakWalBytes: "100", measuredPeakTempBytes: "100", diskMarginBytes: "100" },
    });
    Object.assign(m, { roles: plan.roles.map(role => ({ ...role, superuser: false, leastPrivilegeProved: true })) });
    Object.assign(m.capacity, {
      pools: services.map(service => ({ service, instances: resources.pools[service].instances, maxPerInstance: resources.pools[service].maximumConnections })),
      databaseConnectionLimit: plan.connections.databaseConnectionLimit, otherHostConnections: resources.otherHostConnections,
    });
    publishVerifiedFixtureArtifacts(m);
    return approve(m);
  }

  it("accepts seven dedicated provisioning roles, including a console-only read pool", () => {
    const m = provisionedFixture();
    expect(m.roles).toHaveLength(7);
    expect(result(m).gates.operationalCutover.ready).toBe(true);
    expect(result(m).productionAuthorized).toBe(false);
  });

  it.each(services)("requires exactly one dedicated role for %s", service => {
    const m = provisionedFixture();
    Object.assign(m, { roles: m.roles.filter(role => (role as unknown as Record<string, unknown>).service !== service) });
    checkBlocked(m, "operationalCutover");
  });

  it.each(["duplicate-service", "shared-role", "unknown-service", "console-runtime", "writer-read", "migration-associated", "extra-migration", "old-shared-runtime"])("rejects incorrect role ownership/access %s", fault => {
    const m = provisionedFixture();
    if (fault === "duplicate-service") Object.assign(m.roles[2]!, { service: "scanner" });
    if (fault === "shared-role") m.roles[2]!.name = m.roles[1]!.name;
    if (fault === "unknown-service") Object.assign(m.roles[1]!, { service: "unknown" });
    if (fault === "console-runtime") Object.assign(m.roles[6]!, { access: "runtime" });
    if (fault === "writer-read") Object.assign(m.roles[1]!, { access: "read" });
    if (fault === "migration-associated") Object.assign(m.roles[0]!, { service: "scanner" });
    if (fault === "extra-migration") m.roles.push({ ...m.roles[0]!, name: "extra_migrator" });
    if (fault === "old-shared-runtime") Object.assign(m, { roles: [
      { kind: "runtime", name: "shared_runtime", connectionLimit: 6, superuser: false, leastPrivilegeProved: true },
      { kind: "migration", name: "shared_migration", connectionLimit: 1, superuser: false, leastPrivilegeProved: true },
      { kind: "read", name: "shared_read", connectionLimit: 2, superuser: false, leastPrivilegeProved: true },
    ] });
    const r = result(approve(m));
    expect(r.gates.operationalCutover.blockers.some(blocker => blocker.code === "DEDICATED_LEAST_PRIVILEGE_ROLES_REQUIRED")).toBe(true);
  });

  it("cannot borrow another service's spare role capacity", () => {
    const m = provisionedFixture(); m.roles[1]!.connectionLimit = 2; m.roles[2]!.connectionLimit = 1;
    m.capacity.pools[1]!.maxPerInstance = 2;
    const r = result(approve(m));
    expect(r.gates.operationalCutover.blockers.some(blocker => blocker.code === "MEASURED_GLOBAL_CAPACITY_BUDGET_REQUIRED")).toBe(true);
  });

  it("accepts exact multi-instance role allocation and rejects per-instance underallocation", () => {
    const m = provisionedFixture(); m.capacity.pools[0]!.instances = 2; m.roles[1]!.connectionLimit = 2;
    Object.assign(m.capacity, { databaseConnectionLimit: 10, postgresMaxConnections: 11 });
    publishVerifiedFixtureArtifacts(m);
    expect(result(approve(m)).gates.operationalCutover.ready).toBe(true);
    m.roles[1]!.connectionLimit = 1; checkBlocked(m, "operationalCutover");
  });

  it.each(["migration-limit", "database-limit", "host-reserve", "missing-other-host", "duplicate-pool", "unknown-pool", "zero-role-limit"])("rejects inconsistent role/global budgets %s", fault => {
    const m = provisionedFixture();
    if (fault === "migration-limit") m.roles[0]!.connectionLimit = 2;
    if (fault === "database-limit") Object.assign(m.capacity, { databaseConnectionLimit: 8 });
    if (fault === "host-reserve") Object.assign(m.capacity, { otherHostConnections: 1 });
    if (fault === "missing-other-host") delete (m.capacity as unknown as Record<string, unknown>).otherHostConnections;
    if (fault === "duplicate-pool") m.capacity.pools[1]!.service = m.capacity.pools[0]!.service;
    if (fault === "unknown-pool") Object.assign(m.capacity.pools[0]!, { service: "unknown" });
    if (fault === "zero-role-limit") m.roles[1]!.connectionLimit = 0;
    checkBlocked(m, "operationalCutover");
  });
});
