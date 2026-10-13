import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createPostgresMigrationRuntime, type PostgresMigrationTarget } from "../../../packages/database/src/postgres-migration-runtime.js";
import { PostgresCommitUncertainError, type PostgresClient, type PostgresTransaction, type PostgresResult } from "../../../packages/database/src/postgres-unit-of-work.js";
import { CENSUS_METHODS, CUTOVER_SERVICES, CUTOVER_TIMERS, WRITER_KINDS, PREPARATION_OBSERVATIONS,
  migrationCutoverCanonicalJson, migrationCutoverDigest, migrationCutoverPlanDigest, migrationCutoverObservationPayload,
  migrationCompatiblePostgresRollbackPayload, POSTGRES_COMPATIBILITY_GUARD_CHECKS,
  fenceClosureSigningMessage, fenceClosureEvidenceSha256, verifyCommittedPostgresWriterStartup,
  migrationCutoverAuthorizationPayload, evaluateMigrationWriterFence, createMigrationCutoverCoordinator,
  createMigrationRuntimeCutoverTransitionStore, CutoverCommitUnknownError,
  type WriterFencePolicy, type WriterFenceBundle, type CutoverObservation, type CutoverCommand,
  type CutoverAction, type DurableCutoverState, type FirstPostgresWriteReceipt, type CutoverTransitionStore,
  type CompatiblePostgresReleaseProof, type FenceClosureScope, type FenceClosureSigned, type FirstPostgresWriteMarkerV2,
} from "../../../packages/database/src/migration-cutover-coordinator.js";
import { createPostgresServiceSchema } from "../src/postgres-service-schema.js";
import { POSTGRES_BUSINESS_SCHEMA_MODULES } from "../../../packages/database/src/postgres-business-schema.js";
import type { MigrationProjectionCrosswalk } from "../../../packages/database/src/migration-projection-crosswalk.js";
import { createReviewedPostgresCohortImportPlan, createReviewedPostgresProviderBudgetSeedPlan,
  applyReviewedPostgresCohortImportPlanInTransaction, applyReviewedPostgresProviderBudgetSeedPlanInTransaction,
  postgresCohortImportFingerprint, postgresCohortImportSchemaContract,
  type PostgresCohortReview, type PostgresProviderBudgetReview, type PostgresCohortTransactionApplyOptions,
} from "../src/postgres-cohort-import.js";

// These keys, hosts, measurements and artifacts are injected protocol fixtures, never production proof.
const keys = generateKeyPairSync("ed25519");
const independentKeys = generateKeyPairSync("ed25519");
const serviceSchemaV2 = createPostgresServiceSchema({ protocolVersion: 2 });
const postgresTables = [...new Set(["business_schema_identity", "business_schema_ledger",
  ...[...POSTGRES_BUSINESS_SCHEMA_MODULES, ...serviceSchemaV2.trustedModules]
    .flatMap(module => [...module.sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/g)]
      .map(match => match[1]!))])].sort();
const keyBase64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const epoch = Date.now();
const at = (offset = 0) => new Date(epoch + offset).toISOString();
const hash = (character = "a") => character.repeat(64);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const firstWrite: FirstPostgresWriteReceipt = { writeId: "fixture-first-write", receiptSha256: hash("b"), providerGuardSha256: hash("c"), deliveryGuardSha256: hash("d") };
function protocolFixture(migrationTarget: PostgresMigrationTarget, nonce: string) {
  const target = { database: migrationTarget.database, schema: migrationTarget.schema, schemaSha256: migrationTarget.schemaFingerprint, releaseSha256: hash("f"), generation: migrationTarget.generation, serverAddress: migrationTarget.serverAddress, serverPort: migrationTarget.serverPort, systemIdentifier: migrationTarget.systemIdentifier };
  const sourcePath = "/fixture/" + nonce + ".sqlite";
  const policy: WriterFencePolicy = {
    version: 2, evidenceMode: "injected-protocol-fixture", hostId: "fixture-host", bootId: "fixture-boot", challengeId: "fixture-fence",
    binding: { source: { id: "fixture-source", canonicalPath: sourcePath, device: "1", inode: "2", schemaSha256: hash() },
      sourceGeneration: "sqlite-generation-1", generation: target.generation, watermark: String(epoch - 1000), cohortId: "fixture-cohort", snapshot: { id: "fixture-snapshot", sha256: hash() },
      target, rollbackTarget: { ...target, releaseSha256: hash("b") } },
    writers: [...CUTOVER_SERVICES.map(id => ({ id, kind: "services" as const, executableSha256: hash() })),
      ...CUTOVER_TIMERS.map(id => ({ id, kind: "timers" as const, executableSha256: hash() })),
      { id: "fixture-operator", kind: "operators", executableSha256: hash() },
      { id: "fixture-deploy", kind: "deploy", executableSha256: hash() },
      { id: "fixture-usercron", kind: "usercron", executableSha256: hash() },
      { id: "fixture-bridge", kind: "externalInputs", executableSha256: hash() },
      { id: "fixture-external-input", kind: "externalInputs", executableSha256: hash() }],
    catalog: ["fixture_trades", "fixture_provider_guards", "fixture_delivery_guards"],
    postgresRollbackCatalog: postgresTables.map(table => ({ table, operations: ["insert", "update", "delete"] })),
    postgresRollbackVerifier: { issuerId: "fixture-independent", keyId: "fixture-independent-key" },
    guards: [{ id: "fixture-provider", kind: "provider", rows: "2", sha256: hash("c") }, { id: "fixture-delivery", kind: "delivery", rows: "3", sha256: hash("d") }],
    collectors: [{ issuerId: "fixture-collector", keyId: "fixture-collector-key", publicKeyBase64: keyBase64, collectorSha256: hash(), kinds: [...PREPARATION_OBSERVATIONS, "rollback"] },
      { issuerId: "fixture-independent", keyId: "fixture-independent-key",
        publicKeyBase64: independentKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        collectorSha256: hash("9"), kinds: ["rehearsal"] }],
    reviewers: [{ issuerId: "fixture-reviewer", keyId: "fixture-reviewer-key", publicKeyBase64: keyBase64, actions: ["prepare", "select-postgres", "first-postgres-write", "rollback", "abort"] }],
    deadlines: { windowStart: at(-30_000), windowEnd: at(50_000), maximumEvidenceAgeMs: 60_000, maximumOperationMs: 10_000, maximumLockMs: 1000 },
    budgets: { connections: [], migrationConnections: 1, operatorConnections: 1, backupConnections: 1, reservedConnections: 2, maximumConnections: 32,
      availableRamBytes: "2000", peakRamBytes: "500", reserveRamBytes: "100", availableDiskBytes: "5000", peakDiskBytes: "1000", peakWalBytes: "500", peakTempBytes: "0", reserveDiskBytes: "100",
      maximumTransitions: 16, maximumSqlStatements: 1000 },
  };
  policy.budgets.connections = policy.writers.map(w => ({ writerId: w.id, instances: 1, maximumEach: w.kind === "services" ? 1 : 0 }));
  const signObservation = (observation: CutoverObservation): CutoverObservation => {
    observation.signatureBase64 = sign(null, Buffer.from(migrationCutoverObservationPayload(observation)), keys.privateKey).toString("base64");
    return observation;
  };
  const report = (kind: CutoverObservation["kind"], body: Record<string, unknown>, observedAt = at(-5000)): CutoverObservation => signObservation({
    version: 2, kind, issuerId: "fixture-collector", keyId: "fixture-collector-key", evidenceMode: policy.evidenceMode,
    binding: clone(policy.binding), observedAt, expiresAt: at(30_000),
    provenance: { hostId: policy.hostId, bootId: policy.bootId, collectorSha256: hash(), runId: `fixture-run-${kind}`, sequence: "1", challengeId: policy.challengeId },
    body, signatureBase64: "",
  });
  const sourceTables = policy.catalog.map(table => ({ table, rows: "9007199254740993", sha256: hash() }));
  const parityTables = sourceTables.map(t => ({ table: t.table, sourceRows: t.rows, preservedRows: "9007199254740992", quarantinedRows: "1", sourceSha256: t.sha256, retainedSha256: t.sha256 }));
  const parity = { snapshotSha256: policy.binding.snapshot.sha256, watermark: policy.binding.watermark, tables: parityTables };
  const compatibilityProof = syntheticCompatibleProof(policy);
  const bundle: WriterFenceBundle = { version: 2, activation: { delivery: false, fomo: false, history: false, ownerMerge: false }, observations: {
    fence: report("fence", { fenceId: policy.challengeId, enforcedAt: at(-20_000), validUntil: at(30_000), deniedGenerations: [policy.binding.sourceGeneration],
      barriers: policy.writers.map(w => ({ writerId: w.id, admission: "denied", input: "blocked", rejection: { attemptId: `fixture-rejection-${w.id}`, generation: policy.binding.sourceGeneration, result: "generation-rejected" } })) }),
    snapshot: report("snapshot", { mode: "full-fenced-snapshot", fenceId: policy.challengeId, snapshotId: policy.binding.snapshot.id, snapshotSha256: policy.binding.snapshot.sha256,
      watermark: policy.binding.watermark, startedAt: at(-17_000), completedAt: at(-15_000), catalogSha256: migrationCutoverDigest(policy.catalog), tables: sourceTables }),
    census: report("census", { fenceId: policy.challengeId, snapshotSha256: policy.binding.snapshot.sha256, startedAt: at(-10_000), completedAt: at(-8000), methods: [...CENSUS_METHODS],
      groups: WRITER_KINDS.map(kind => ({ kind, writerIds: policy.writers.filter(w => w.kind === kind).map(w => w.id) })), writers: clone(policy.writers),
      scannedPaths: [sourcePath, sourcePath + "-wal", sourcePath + "-shm"],
      files: [{ canonicalPath: sourcePath, device: "1", inode: "2" }, { canonicalPath: sourcePath + "-wal", device: null, inode: null }, { canonicalPath: sourcePath + "-shm", device: null, inode: null }], processes: [], fileHolders: [] }),
    parity: report("parity", parity),
    target: report("target", { current: clone(policy.binding.target), compatible: clone(policy.binding.rollbackTarget), probeSha256: hash() }),
    guards: report("guards", { baseline: clone(policy.guards), retained: clone(policy.guards), probeSha256: hash() }),
    capacity: report("capacity", { budgetSha256: migrationCutoverDigest(policy.budgets), measurementId: "fixture-measurement", traceSha256: hash(), startedAt: at(-25_000), completedAt: at(-10_000),
      peakRamBytes: "500", peakDiskBytes: "1000", peakWalBytes: "500", peakTempBytes: "0", connectionPeak: 11 }),
    rehearsal: report("rehearsal", { compatibleRelease: compatibilityProof, before: { target: "source-only", snapshotSha256: policy.binding.snapshot.sha256, paritySha256: migrationCutoverDigest(parity), guardsSha256: migrationCutoverDigest(policy.guards), receiptSha256: hash(), testedAt: at(-12_000) },
      after: { target: clone(policy.binding.rollbackTarget), writeReceiptSha256: hash(), retainedMutationsSha256: hash(), recoveredMutationsSha256: hash(), guardsSha256: migrationCutoverDigest(policy.guards), receiptSha256: hash(), startedAt: at(-12_000), firstWriteAt: at(-11_000), completedAt: at(-9000) } }),
  } };
  const evaluation = () => evaluateMigrationWriterFence(bundle, policy, at());
  const resignAll = () => {
    refreshSyntheticClosure(policy, bundle);
    Object.values(bundle.observations).forEach(signObservation);
  };
  resignAll();
  const authorize = (command: CutoverCommand) => {
    command.authorization.signatureBase64 = sign(null, Buffer.from(migrationCutoverAuthorizationPayload(command)), keys.privateKey).toString("base64");
    return command;
  };
  const command = (action: CutoverAction, revision: number, operationId = `fixture-${action}`): CutoverCommand => authorize({
    version: 2, operationId, action, expectedRevision: revision, planSha256: migrationCutoverPlanDigest(policy, bundle), deadline: at(10_000),
    writeId: action === "first-postgres-write" ? firstWrite.writeId : null, recovery: null,
    authorization: { issuerId: "fixture-reviewer", keyId: "fixture-reviewer-key", issuedAt: at(), expiresAt: at(10_000), signatureBase64: "" },
  });
  const recovery = (c: CutoverCommand, state: DurableCutoverState) => {
    c.recovery = report("rollback", { operationId: c.operationId, stateRevision: state.revision, planSha256: state.planSha256,
      target: state.firstPostgresWrite ? clone(policy.binding.rollbackTarget) : "source-only", snapshotSha256: policy.binding.snapshot.sha256,
      watermark: state.firstPostgresWrite ? String(epoch - 999) : policy.binding.watermark, firstWriteReceiptSha256: state.firstPostgresWrite?.receiptSha256 ?? null,
      tables: clone(parityTables), guards: clone(policy.guards),
      providerGuardSha256: state.firstPostgresWrite?.providerGuardSha256 ?? migrationCutoverDigest(policy.guards.filter(g => g.kind === "provider")),
      deliveryGuardSha256: state.firstPostgresWrite?.deliveryGuardSha256 ?? migrationCutoverDigest(policy.guards.filter(g => g.kind === "delivery")),
      retainedMutationsSha256: state.firstPostgresWrite ? hash() : null, recoveredMutationsSha256: state.firstPostgresWrite ? hash() : null }, at());
    return authorize(c);
  };
  return { policy, bundle, compatibilityProof, evaluation, resignAll, signObservation, authorize, command, recovery };
}


function syntheticCompatibleProof(policy: WriterFencePolicy): CompatiblePostgresReleaseProof {
  const catalog = policy.postgresRollbackCatalog, verifier = policy.postgresRollbackVerifier;
  if (!catalog || !verifier) throw new Error("Synthetic fixture requires explicit compatibility catalog/verifier");
  const proof: CompatiblePostgresReleaseProof = {
    version: 2, binding: clone(policy.binding), strategy: "compatible-postgres-release",
    recoveryMode: "retain-live-postgres-data", backend: "postgres",
    candidate: clone(policy.binding.target), compatible: clone(policy.binding.rollbackTarget),
    candidateArtifactSha256: policy.binding.target.releaseSha256,
    compatibleArtifactSha256: policy.binding.rollbackTarget.releaseSha256,
    catalogSha256: migrationCutoverDigest(catalog), schemaProbeSha256: hash(), mutationTraceSha256: hash(),
    parentTransactionRollbackReceiptSha256: hash(), commitUnknownReconciliationReceiptSha256: hash(),
    providerGuardSha256: migrationCutoverDigest(policy.guards.filter(guard => guard.kind === "provider")),
    deliveryGuardSha256: migrationCutoverDigest(policy.guards.filter(guard => guard.kind === "delivery")),
    startedAt: at(-14_000), firstWriteAt: at(-13_000), completedAt: at(-7000),
    tableChecks: catalog.map(entry => ({ table: entry.table, retainedRows: "9007199254740993", recoveredRows: "9007199254740993",
      retainedSha256: hash(), recoveredSha256: hash(), cases: entry.operations.map(operation => ({ operation,
        committedReceiptSha256: hash(), compatibleReadReceiptSha256: hash(), compatibleWriteReceiptSha256: hash() })) })),
    guardChecks: POSTGRES_COMPATIBILITY_GUARD_CHECKS.map(check => ({ check, receiptSha256: hash() })),
    attestation: { ...verifier, observedAt: at(-6000), expiresAt: at(30_000),
      provenance: { hostId: policy.hostId, bootId: policy.bootId, challengeId: policy.challengeId,
        collectorSha256: hash("9"), runId: "fixture-independent-run", sequence: "1" }, signatureBase64: "" },
  };
  proof.attestation.signatureBase64 = sign(null, Buffer.from(migrationCompatiblePostgresRollbackPayload(proof)), independentKeys.privateKey).toString("base64");
  return proof;
}
function syntheticSeal<T>(kind: "authorization" | "census" | "snapshot" | "rollback", payload: T): FenceClosureSigned<T> {
  return { payload, signatureBase64: sign(null, fenceClosureSigningMessage(kind, payload),
    kind === "rollback" ? independentKeys.privateKey : keys.privateKey).toString("base64") };
}
function fixtureString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Synthetic evidence requires a literal string");
  return value;
}
function refreshSyntheticClosure(policy: WriterFencePolicy, bundle: WriterFenceBundle): void {
  const scopes: FenceClosureScope[] = policy.writers.map(writer => ({ id: writer.id,
    kind: writer.kind === "services" ? "service" : writer.kind === "timers" ? "timer" : writer.kind === "operators" ? "operator"
      : writer.kind === "usercron" ? "cron" : writer.kind === "deploy" ? "deploy" : writer.id === "fixture-bridge" ? "bridge" : "external-input",
    paths: writer.id === "fixture-bridge" ? ["/fixture/input", "/fixture/output"] : [policy.binding.source.canonicalPath],
    directions: writer.id === "fixture-bridge" ? ["source-to-input", "output-to-source"] : [],
  }));
  const binding = { sourcePath: policy.binding.source.canonicalPath, sourceDevice: policy.binding.source.device,
    sourceInode: policy.binding.source.inode, generation: policy.binding.generation, watermark: policy.binding.watermark,
    cluster: policy.binding.target.systemIdentifier, schemaSha256: policy.binding.target.schemaSha256,
    release: policy.binding.target.releaseSha256, artifactSha256: policy.binding.target.releaseSha256,
    cohortSha256: migrationCutoverDigest({ cohortId: policy.binding.cohortId }, 2),
    providerGuardSha256: migrationCutoverDigest(policy.guards.filter(guard => guard.kind === "provider")),
    deliveryGuardSha256: migrationCutoverDigest(policy.guards.filter(guard => guard.kind === "delivery")) };
  const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  policy.closureTrust = { authorizationPublicKeyPem: pem, observerPublicKeyPem: pem, snapshotPublicKeyPem: pem,
    independentCompatibilityPublicKeyPem: independentKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    expectedBinding: binding, expectedScopesSha256: fenceClosureEvidenceSha256(scopes), expectedTableNames: [...policy.catalog],
    expectedRollbackRelease: policy.binding.rollbackTarget.releaseSha256,
    expectedRollbackArtifactSha256: policy.binding.rollbackTarget.releaseSha256,
    maximumEvidenceAgeMs: policy.deadlines.maximumEvidenceAgeMs,
    maximumMaintenanceWindowMs: Date.parse(policy.deadlines.windowEnd) - Date.parse(policy.deadlines.windowStart) };
  const authorization = { binding, scopes, windowStart: policy.deadlines.windowStart, windowEnd: policy.deadlines.windowEnd,
    maximumSqlStatements: policy.budgets.maximumSqlStatements, maximumTransactionMs: policy.deadlines.maximumOperationMs };
  const census = { authorizationSha256: fenceClosureEvidenceSha256(authorization), observedAt: bundle.observations.census.observedAt,
    fencedAt: fixtureString(bundle.observations.fence.body.enforcedAt), scopes: scopes.map(scope => ({ id: scope.id,
      admission: "closed" as const, controlReceiptSha256: hash(), closedUntil: policy.deadlines.windowEnd, processIds: [],
      timer: scope.kind === "timer" ? "disabled-no-pending-trigger" as const : "not-applicable" as const,
      bridgeDirections: [...scope.directions], cursorReceiptSha256: scope.kind === "bridge" ? hash() : null })),
    processes: [], discoveredScopeIds: scopes.map(scope => scope.id), sourceDevice: binding.sourceDevice,
    sourceInode: binding.sourceInode, sourcePath: binding.sourcePath, generation: binding.generation, watermark: binding.watermark };
  const rawTables = bundle.observations.snapshot.body.tables;
  if (!Array.isArray(rawTables)) throw new Error("Synthetic snapshot tables required");
  const tables = rawTables.map((entry: Record<string, unknown>) => ({ name: fixtureString(entry.table),
    rowCount: fixtureString(entry.rows), sha256: fixtureString(entry.sha256) }));
  const parity = migrationCutoverDigest(bundle.observations.parity.body);
  const snapshot = { authorizationSha256: fenceClosureEvidenceSha256(authorization), censusSha256: fenceClosureEvidenceSha256(census),
    binding, kind: "final-full-fenced" as const, startedAt: fixtureString(bundle.observations.snapshot.body.startedAt),
    completedAt: fixtureString(bundle.observations.snapshot.body.completedAt), tableCensusSha256: fenceClosureEvidenceSha256(tables),
    tables, parityReceiptSha256: parity, restoreReceiptSha256: hash() };
  const proof = bundle.observations.rehearsal.body.compatibleRelease;
  if (proof === undefined || typeof proof !== "object" || proof === null) throw new Error("Synthetic independent compatibility proof required");
  const rollback = { authorizationSha256: fenceClosureEvidenceSha256(authorization), binding,
    route: "compatible-postgres-release" as const, completedAt: fixtureString((proof as Record<string, unknown>).completedAt),
    parityReceiptSha256: parity, rollbackRelease: policy.binding.rollbackTarget.releaseSha256,
    rollbackArtifactSha256: policy.binding.rollbackTarget.releaseSha256, compatibilityTestReceiptSha256: migrationCutoverDigest(proof, 2),
    preservedProviderGuardSha256: binding.providerGuardSha256, preservedDeliveryGuardSha256: binding.deliveryGuardSha256 };
  bundle.closure = { authorization: syntheticSeal("authorization", authorization), census: syntheticSeal("census", census),
    snapshot: syntheticSeal("snapshot", snapshot), rollback: syntheticSeal("rollback", rollback) };
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type Row = Record<string, unknown>;
const schema = "radar_rehearsal_0123456789abcdef_cohort";
const migrationTarget: PostgresMigrationTarget = { database: "radar_rehearsal_0123456789abcdef", username: "radar_cohort_migrator",
  schema, generation: "fixture-cohort-generation", service: "migration", schemaVersion: serviceSchemaV2.plan.version, schemaFingerprint: serviceSchemaV2.plan.fingerprint,
  serverAddress: "127.0.0.1", serverPort: 5433, systemIdentifier: "7333333333333333333" };
const text = (value: string) => ({ storage: "text" as const, encoding: "base64" as const, value: Buffer.from(value).toString("base64") });
function projectionPlans(target: PostgresMigrationTarget, nonce: string, profileCount = 1, enabledCount = 0, providerCount = 1) {
  const entityId = "fixture-owner-" + nonce, accountId = "fixture-account-" + nonce;
  const address = "0x" + createHash("sha256").update(nonce).digest("hex").slice(0, 40);
  const row = (table: string, values: MigrationProjectionCrosswalk["rows"][number]["values"]): Mutable<MigrationProjectionCrosswalk["rows"][number]> =>
    ({ table, rowOrdinal: 0, values, rowBodySha256: hash(), targetRoute: "identity_review", primaryKey: null,
      references: [], status: "historical", grantsBusinessEligibility: false });
  const crosswalk: Mutable<MigrationProjectionCrosswalk> = { operationId: "fixture-source-" + nonce, snapshotSha256: hash(),
    catalogFingerprint: hash(), reviewedRoutingSha256: hash(), historicalOnly: true, grantsBusinessEligibility: false, sourceWrites: false, databaseWrites: false,
    rows: [row("entity_accounts", { entity_id: text(entityId), account_id: text(accountId), confidence: text("confirmed"), source: text("fixture-registry") }),
      row("wallet_identities", { account_id: text(accountId), chain_family: text("evm"), address: text(address), confidence: text("confirmed"), source: text("fixture-registry") }),
      row("trader_profiles", { entity_id: text(entityId), monitoring_enabled: { storage: "integer", value: "0" },
        fomo_monitoring_enabled: { storage: "integer", value: "1" }, onchain_monitoring_enabled: { storage: "integer", value: "0" } })],
    identityCohorts: [{ entityId, entityKey: entityId, lifecycle: "suspended", suspended: true, manual: false, locked: false,
      profileFlags: { monitoring_enabled: false, fomo_monitoring_enabled: true, onchain_monitoring_enabled: false },
      accounts: [text(accountId)], wallets: [{ family: "evm", comparisonAddress: address, sourceAddresses: [address],
        confidenceEvidence: [{ source: { table: "wallet_identities", rowOrdinal: 0 }, value: text("confirmed"), recognized: "confirmed" }] }],
      status: "historical_coherent", grantsBusinessEligibility: false }],
    issues: [], coverage: { plannedTables: 141, plannedRows: 3, providedRows: 3, providedChunks: 3, supportedIdentityTables: [],
      semanticReferenceRules: 0, completeSemanticCoverage: false, cohortCountsAreDiagnostic: true } };
  const approvalRef = "fixture-migration-approval";
  const review: Mutable<PostgresCohortReview> = { version: 1, importId: "fixture-cohort-import-" + nonce, approvalRef,
    actorId: "fixture-approved-migrator", actorAuthorizationRef: "fixture-reviewed-migration-authority",
    generationId: target.generation, importedAt: epoch, sourceWatermark: epoch - 1000,
    source: { operationId: crosswalk.operationId, snapshotSha256: hash(), catalogFingerprint: hash(), manifestSha256: hash(),
      reviewedRoutingSha256: hash(), crosswalkSha256: postgresCohortImportFingerprint(crosswalk), databaseEncoding: "UTF-8" },
    allowlist: [{ entityId, accountId, family: "evm", address, associationRow: { table: "entity_accounts", rowOrdinal: 0 },
      walletRow: { table: "wallet_identities", rowOrdinal: 0 }, identityEvidenceRef: "fixture-existing-identity-" + nonce,
      ownershipEvidenceRef: "fixture-existing-registry-owner-" + nonce, effectiveAt: epoch - 1000, knownAt: epoch - 1000 }] };
  if (profileCount !== 1 || enabledCount !== 0) {
    const baseRows = clone(crosswalk.rows), baseCohort = clone(crosswalk.identityCohorts[0]!);
    const baseAssociation = clone(review.allowlist[0]!);
    crosswalk.rows = []; crosswalk.identityCohorts = []; review.allowlist = [];
    for (let ordinal = 0; ordinal < profileCount; ordinal++) {
      const enabled = ordinal < enabledCount, owner = entityId + "-" + ordinal, account = accountId + "-" + ordinal;
      const wallet = "0x" + createHash("sha256").update(nonce + "-" + ordinal).digest("hex").slice(0, 40);
      const sourceRows = clone(baseRows);
      for (const source of sourceRows) {
        source.rowOrdinal = ordinal;
        if ("entity_id" in source.values) source.values.entity_id = text(owner);
        if ("account_id" in source.values) source.values.account_id = text(account);
        if ("address" in source.values) source.values.address = text(wallet);
        if (source.table === "trader_profiles") source.values.monitoring_enabled = { storage: "integer", value: enabled ? "1" : "0" };
      }
      crosswalk.rows.push(...sourceRows);
      crosswalk.identityCohorts.push({ ...clone(baseCohort), entityId: owner, entityKey: owner,
        lifecycle: enabled ? "active" : "suspended", suspended: !enabled,
        profileFlags: { ...baseCohort.profileFlags, monitoring_enabled: enabled }, accounts: [text(account)],
        wallets: [{ ...clone(baseCohort.wallets[0]!), comparisonAddress: wallet, sourceAddresses: [wallet],
          confidenceEvidence: [{ source: { table: "wallet_identities", rowOrdinal: ordinal }, value: text("confirmed"), recognized: "confirmed" }] }] });
      review.allowlist.push({ ...clone(baseAssociation), entityId: owner, accountId: account, address: wallet,
        associationRow: { table: "entity_accounts", rowOrdinal: ordinal }, walletRow: { table: "wallet_identities", rowOrdinal: ordinal } });
    }
    crosswalk.coverage = { ...crosswalk.coverage, plannedRows: profileCount * 3, providedRows: profileCount * 3 };
    review.source = { ...review.source, crosswalkSha256: postgresCohortImportFingerprint(crosswalk) };
  }
  const cohort = createReviewedPostgresCohortImportPlan({ crosswalk, review, trustedReviewSha256: postgresCohortImportFingerprint(review) });
  const providerReview: Mutable<PostgresProviderBudgetReview> = { version: 1, importId: "fixture-provider-import-" + nonce,
    generationId: target.generation, importedAt: epoch, approvalRef, contractRef: "fixture-reviewed-provider-contract",
    budgets: [{ providerId: "fixture-provider-" + nonce, origin: "https://" + nonce + ".example", windowStartedAt: epoch - 1000,
      windowMs: 60_000, maximumRequests: 5, requestsUsed: 2, maximumConcurrency: 1, cooldownUntil: "9223372036854775807" }] };
  if (providerCount !== 1) providerReview.budgets = Array.from({ length: providerCount }, (_, ordinal) => ({
    ...providerReview.budgets[0]!, providerId: "fixture-provider-" + nonce + "-" + ordinal,
    origin: "https://" + nonce + "-" + ordinal + ".example",
  }));
  const provider = createReviewedPostgresProviderBudgetSeedPlan({ review: providerReview, trustedReviewSha256: postgresCohortImportFingerprint(providerReview) });
  return { cohort, provider, approvalRef };
}
function nativeOptions(target: PostgresMigrationTarget, plan: { kind: "cohort_projection" | "provider_budget_seed"; planSha256: string; approvalRef: string },
  transaction: PostgresTransaction): PostgresCohortTransactionApplyOptions {
  return { transaction, capability: { kind: "isolated", purpose: plan.kind, target, authorizationRef: plan.approvalRef,
    planSha256: plan.planSha256, expiresAtMs: epoch + 60_000 }, assertAuthorized: async request => {
      if (request.planSha256 !== plan.planSha256 || request.approvalRef !== plan.approvalRef) throw new Error("fixture approval mismatch");
    }, budget: { deadlineAtMs: epoch + 60_000, maximumTransactionMs: 4000, maximumQueriesPerTransaction: 1000,
      maximumTotalQueries: 2000, maximumTransactions: 1, recordsPerTransaction: 1, maximumImportLagMs: 60_000 } };
}
function receipt(writeId: string, plans: ReturnType<typeof projectionPlans>): FirstPostgresWriteReceipt {
  return { writeId, receiptSha256: migrationCutoverDigest([plans.cohort.planSha256, plans.provider.planSha256]),
    providerGuardSha256: hash("c"), deliveryGuardSha256: hash("d") };
}
function schemaRows(names: readonly string[], targetSchema: string): Row[] {
  return names.map(name => {
    const spec = postgresCohortImportSchemaContract[name]!;
    return { table_name: name, relkind: "r", relpersistence: "p", resolved: true, can_select: true, can_insert: true, can_update: true,
      columns: Object.entries(spec.columns).map(([column, type]) => ({ name: column, type, not_null: !spec.nullable.includes(column) })),
      constraints: [{ type: "p", columns: spec.primaryKey }, ...spec.foreignKeys.map(fk => ({ type: "f", validated: true,
        columns: fk.columns, foreign_schema: targetSchema, foreign_table: fk.table, foreign_columns: fk.targetColumns })),
        ...spec.unique.map(columns => ({ type: "u", columns })), ...spec.checks.map(definition => ({ type: "c", validated: true, definition }))] };
  });
}
/** A native-client model, not a PostgreSQL engine or external approval/rehearsal proof. */
function modelPool(target: PostgresMigrationTarget) {
  let committed = new Map<string, Row[]>(), working = committed;
  let uncertain: "before" | "after" | null = null, commitGate: Promise<void> | undefined;
  let failure: ((sql: string, values: readonly unknown[]) => boolean) | undefined;
  let authoritySafe = true;
  const trace: { sql: string; connection: number }[] = [], releases: (Error | undefined)[] = [];
  let connections = 0;
  const rows = (table: string) => working.get(table) ?? [];
  const result = (items: Row[], rowCount = items.length): PostgresResult => ({ rows: items, rowCount });
  const query = async (sql: string, values: readonly unknown[] = [], connection: number): Promise<PostgresResult> => {
    trace.push({ sql, connection });
    if (sql === "BEGIN") { working = structuredClone(committed); return result([]); }
    if (sql === "ROLLBACK") { working = structuredClone(committed); return result([]); }
    if (sql === "COMMIT") {
      await commitGate; const mode = uncertain; uncertain = null;
      if (mode !== "before") committed = structuredClone(working);
      working = committed;
      if (mode) throw new Error("fixture lost commit acknowledgment");
      return result([]);
    }
    if (failure?.(sql, values)) throw new Error("fixture injected SQL failure");
    if (sql.includes("migration-runtime-identity")) return result([{ database: target.database, username: target.username,
      session_username: target.username, server_address: target.serverAddress, server_port: target.serverPort, system_identifier: target.systemIdentifier,
      role_safe: authoritySafe, no_role_memberships: true, owns_target_schema: true, cannot_create_schema: true, cannot_create_temp: true,
      no_other_schema_authority: true, no_other_relation_authority: true, no_other_sequence_authority: true, no_callable_security_definers: true }]);
    if (sql.includes("migration-runtime-ledger-kind")) return result([{ identity_valid: true, ledger_valid: true }]);
    if (sql.includes("migration-runtime-ledger")) return result([{ database_name: target.database, schema_name: target.schema,
      generation_id: target.generation, ledger_format: 1, version: target.schemaVersion, fingerprint: target.schemaFingerprint }]);
    if (sql.includes("cohort-import-target")) return result([{ database: target.database, username: target.username,
      server_address: target.serverAddress, server_port: target.serverPort }]);
    if (sql.includes("current_database()")) return result([{ database: target.database, schema_name: target.schema,
      generation_id: target.generation, fingerprint: target.schemaFingerprint, server_address: target.serverAddress,
      server_port: target.serverPort, system_identifier: target.systemIdentifier }]);
    if (sql.includes("cohort-import-schema")) return result(schemaRows(values[1] as readonly string[], target.schema));
    if (sql.includes("cohort-import-generation")) return result([{ generation_id: target.generation }]);
    if (sql.includes("SELECT c.relname AS table_name")) return result(postgresTables.map(table_name => ({ table_name })));
    if (sql.includes("relkind,relpersistence")) return result([{ relkind: "r", relpersistence: "p" }]);
    if (sql.includes("pg_try_advisory_xact_lock")) return result([{ locked: true }]);
    if (/set_config|LOCK TABLE|pg_advisory_xact_lock/.test(sql)) return result([]);
    if (sql.includes("SELECT marker_sha256,marker")) return result(rows("migration_cutover_first_write_markers")
      .filter(row => row.source_key === values[0]).map(row => clone(row)));
    if (sql.includes("INSERT INTO") && sql.includes("migration_cutover_first_write_markers")) {
      if (rows("migration_cutover_first_write_markers").some(row => row.source_key === values[0])) return result([], 0);
      working.set("migration_cutover_first_write_markers", [...rows("migration_cutover_first_write_markers"),
        { source_key: values[0], marker_sha256: values[1], marker: JSON.parse(values[2] as string) }]);
      return result([{ source_key: values[0] }], 1);
    }
    if (sql.includes("SELECT revision,state")) return result(rows("migration_cutover_transitions_v2").filter(row => row.source_key === values[0]).map(row => clone(row)));
    if (sql.includes("INSERT INTO") && sql.includes("migration_cutover_transitions_v2")) {
      const current = rows("migration_cutover_transitions_v2").find(row => row.source_key === values[0]);
      if (current && current.revision !== values[3]) return result([], 0);
      const next = { source_key: values[0], revision: values[1], state: JSON.parse(values[2] as string) };
      working.set("migration_cutover_transitions_v2", [...rows("migration_cutover_transitions_v2").filter(row => row.source_key !== values[0]), next]);
      return result([{ revision: values[1] }], 1);
    }
    const insert = /INSERT INTO\s+(\w+)\s*\(([^)]+)\)/.exec(sql);
    if (insert) {
      const table = insert[1]!, columns = insert[2]!.split(",").map(value => value.trim());
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      if (table === "wallet_service_import_ledger") row.revoked_at = null;
      if (table === "forward_target_identity_bindings") Object.assign(row, { conflict_at: null, conflict_by_version: null });
      const primaryKey = postgresCohortImportSchemaContract[table]?.primaryKey ?? ["intent_key"];
      const exists = rows(table).some(item => primaryKey.every(column => item[column] === row[column]));
      if (!exists) working.set(table, [...rows(table), row]);
      return result([], exists ? 0 : 1);
    }
    if (sql.includes("SELECT v.effective_at,v.known_at,h.version_id,h.head_generation")) {
      const head = rows("forward_target_channel_heads").find(row => row.entity_id === values[0] && row.subject_key === values[2]);
      const version = rows("forward_target_channel_versions").find(row => row.version_id === head?.version_id);
      return result(head && version ? [{ ...version, ...head }] : []);
    }
    const select = /FROM\s+(\w+)/.exec(sql);
    if (select) {
      const predicates = [...sql.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)/g)];
      let items = rows(select[1]!).filter(row => predicates.every(match => row[match[1]!] === values[Number(match[2]) - 1]));
      if (sql.includes("channel='wallet'")) items = items.filter(row => row.channel === "wallet");
      const limit = /LIMIT (\d+)/.exec(sql); if (limit) items = items.slice(0, Number(limit[1]));
      return result(items.map(item => clone(item)));
    }
    throw new Error("Unhandled integration model SQL: " + sql);
  };
  return { trace, releases, rows: (table: string) => committed.get(table) ?? [],
    phase: () => (committed.get("migration_cutover_transitions_v2")?.[0]?.state as DurableCutoverState | undefined)?.phase,
    denyRole: () => { authoritySafe = false; }, loseCommit: (mode: "before" | "after") => { uncertain = mode; },
    failWhen: (handler: (sql: string, values: readonly unknown[]) => boolean) => { failure = handler; },
    delayCommit: (gate: Promise<void>) => { commitGate = gate; },
    pool: { async connect(): Promise<PostgresClient> {
      const connection = ++connections;
      return { query: (sql, values) => query(sql, values, connection), release: error => { releases.push(error); working = committed; } };
    }, async end() {} },
  };
}
function integratedFixture(options: { capacity?: boolean; maximumSqlStatements?: number; maximumOperationMs?: number; target?: PostgresMigrationTarget;
  configureProtocol?: (fixture: ReturnType<typeof protocolFixture>) => void } = {}) {
  const target = { ...(options.target ?? migrationTarget) }, protocol = protocolFixture(target, randomUUID());
  const plans = options.capacity ? projectionPlans(target, randomUUID(), 216, 192, 4) : projectionPlans(target, randomUUID());
  if (options.maximumSqlStatements !== undefined) {
    protocol.policy.budgets.maximumSqlStatements = options.maximumSqlStatements;
    protocol.bundle.observations.capacity.body.budgetSha256 = migrationCutoverDigest(protocol.policy.budgets);
    protocol.resignAll();
  }
  if (options.maximumOperationMs !== undefined) protocol.policy.deadlines.maximumOperationMs = options.maximumOperationMs;
  protocol.resignAll();
  // Malformed evidence fixtures are fixed before pinning the dedicated runtime capability, not injected after authorization.
  options.configureProtocol?.(protocol);
  const db = modelPool(target); let denyApproval = false, callbacks = 0, runtimeClockOffset = 0;
  const operationMs = options.maximumOperationMs ?? 5000;
  const runtime = createPostgresMigrationRuntime({ pool: db.pool, target,
    capability: { mode: "isolated", purpose: "business_import", approvalRef: plans.approvalRef,
      planSha256: protocol.command("prepare", 0).planSha256, expiresAtMs: epoch + 60_000 },
    assertAuthorized: async request => {
      if (denyApproval || request.target.systemIdentifier !== target.systemIdentifier ||
        request.capability.planSha256 !== protocol.command("prepare", 0).planSha256) throw new Error("fixture external approval rejected");
    }, clock: () => Date.now() + runtimeClockOffset, limits: { operationTimeoutMs: operationMs, connectionTimeoutMs: 1000, statementTimeoutMs: 1000,
      lockTimeoutMs: 250, maximumSqlStatements: 10_000, workMemKb: 1024, closeTimeoutMs: 1000 } });
  let wrapperQueries = 0;
  const countedRuntime = { run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => runtime.run(transaction =>
    operation({ ...transaction, query: (sql, values) => { wrapperQueries++; return transaction.query(sql, values); } })) };
  const store = createMigrationRuntimeCutoverTransitionStore({ runtime: countedRuntime, target: protocol.policy.binding.target,
    statementTimeoutMs: 4000, lockTimeoutMs: 1000, clock: () => at() });
  const coordinator = createMigrationCutoverCoordinator({ expected: protocol.policy, store, clock: () => at() });
  let nativeQueries = { cohort: 0, provider: 0 };
  const write = async (transaction: PostgresTransaction, writeId: string) => {
    callbacks++;
    const cohortOptions = nativeOptions(target, plans.cohort, transaction), providerOptions = nativeOptions(target, plans.provider, transaction);
    const capacityBudget = { ...cohortOptions.budget, maximumTransactionMs: options.maximumOperationMs ?? 4000,
      maximumQueriesPerTransaction: 10_000, maximumTotalQueries: 10_000, recordsPerTransaction: 216 };
    const cohort = await applyReviewedPostgresCohortImportPlanInTransaction(plans.cohort,
      options.capacity ? { ...cohortOptions, budget: capacityBudget } : cohortOptions);
    const provider = await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(plans.provider,
      options.capacity ? { ...providerOptions, budget: { ...capacityBudget, recordsPerTransaction: 4 } } : providerOptions);
    nativeQueries = { cohort: cohort.queries, provider: provider.queries };
    expect(cohort.commitState).toBe("pending_parent_commit"); expect(provider.commitState).toBe("pending_parent_commit");
    return receipt(writeId, plans);
  };
  return { ...protocol, target, plans, db, runtime, coordinator, store, write, callbacks: () => callbacks, advanceRuntimeClock: (milliseconds: number) => { runtimeClockOffset += milliseconds; }, wrapperQueries: () => wrapperQueries, nativeQueries: () => nativeQueries,
    denyApproval: () => { denyApproval = true; },
    async select() {
      await coordinator.execute(protocol.command("prepare", 0), protocol.bundle);
      await coordinator.execute(protocol.command("select-postgres", 1), protocol.bundle);
    },
    first: () => coordinator.execute(protocol.command("first-postgres-write", 2), protocol.bundle, { write }),
  };
}

describe("dedicated migration runtime + real coordinator + native importer contract (modeled PG client)", () => {
  it("keeps selection free of heads, then commits both native plans and marker on exactly one physical connection", async () => {
    const f = integratedFixture();
    try {
      await f.select(); expect(f.db.phase()).toBe("postgres-selected"); expect(f.db.rows("forward_target_channel_heads")).toHaveLength(0);
      const start = f.db.trace.length, written = await f.first(), trace = f.db.trace.slice(start);
      expect(written).toMatchObject({ revision: 3, phase: "postgres-written", writeAuthorized: false, activationEnabled: false });
      expect(trace.filter(item => item.sql === "BEGIN")).toHaveLength(1); expect(trace.filter(item => item.sql === "COMMIT")).toHaveLength(1);
      expect(new Set(trace.map(item => item.connection)).size).toBe(1);
      const marker = trace.findIndex(item => item.sql.includes("INSERT INTO") && item.sql.includes("migration_cutover_transitions_v2"));
      const seed = trace.findIndex(item => item.sql.includes("INSERT INTO wallet_service_provider_budgets"));
      const nativeMarker = trace.findIndex(item => item.sql.includes("INSERT INTO") && item.sql.includes("migration_cutover_first_write_markers"));
      expect(nativeMarker).toBeGreaterThan(seed); expect(marker).toBeGreaterThan(nativeMarker); expect(trace.at(-1)?.sql).toBe("COMMIT");
      expect(serviceSchemaV2.plan.version).toBe(3);
      expect(written.planSha256).toBe(migrationCutoverPlanDigest(f.policy, f.bundle));
      const state = f.db.rows("migration_cutover_transitions_v2")[0]?.state as DurableCutoverState | undefined;
      const markerRow = f.db.rows("migration_cutover_first_write_markers")[0];
      if (!state || !markerRow) throw new Error("Missing committed fixture state/native marker");
      const persistedMarker = markerRow.marker as FirstPostgresWriteMarkerV2;
      expect(state.version).toBe(2); expect(state.preparation.closure).toEqual(f.bundle.closure);
      expect(state.journal.every(entry => entry.command.version === 2 && entry.requestSha256 === migrationCutoverDigest(entry.command, 2))).toBe(true);
      expect(persistedMarker).toMatchObject({ version: 2, sourceKey: markerRow.source_key,
        policySha256: migrationCutoverDigest(f.policy, 2), planSha256: state.planSha256,
        bindingSha256: migrationCutoverDigest(f.policy.binding, 2), cohortId: f.policy.binding.cohortId,
        generation: f.target.generation, ...receipt(firstWrite.writeId, f.plans) });
      expect(markerRow.marker_sha256).toBe(migrationCutoverDigest(persistedMarker, 2));
      expect(f.db.rows("migration_cutover_first_write_markers")).toHaveLength(1);
      expect(f.db.rows("wallet_service_import_ledger")).toHaveLength(2);
      expect(f.db.rows("wallet_service_profile_versions")[0]).toMatchObject({ enabled: false, suspended: true });
      expect(f.db.rows("wallet_service_provider_budgets")[0]?.cooldown_until).toBe("9223372036854775807");
    } finally { await f.runtime.close(); }
  });
  it.each(["marker", "native-marker", "provider"])("rolls all native rows and heads back when %s SQL fails", async failure => {
    const f = integratedFixture();
    try {
      await f.select();
      f.db.failWhen((sql, values) => failure === "marker" ? sql.includes("INSERT INTO") && sql.includes("migration_cutover_transitions_v2") && values[1] === 3
        : failure === "native-marker" ? sql.includes("INSERT INTO") && sql.includes("migration_cutover_first_write_markers")
        : sql.includes("INSERT INTO wallet_service_provider_budgets"));
      await expect(f.first()).rejects.toThrow("injected SQL failure");
      expect(f.db.phase()).toBe("postgres-selected"); expect(f.db.rows("wallet_service_import_ledger")).toHaveLength(0);
      expect(f.db.rows("forward_target_channel_versions")).toHaveLength(0); expect(f.db.rows("wallet_service_profile_cohort")).toHaveLength(0);
      expect(f.db.trace.at(-1)?.sql).toBe("ROLLBACK");
      expect(f.db.rows("migration_cutover_first_write_markers")).toHaveLength(0);
    } finally { await f.runtime.close(); }
  });
  it("never acknowledges native pending results before the coordinator's physical COMMIT resolves", async () => {
    const f = integratedFixture(); let release!: () => void;
    try {
      await f.select(); f.db.delayCommit(new Promise<void>(resolve => { release = resolve; }));
      let acknowledged = false; const pending = f.first().then(value => { acknowledged = true; return value; });
      for (let i = 0; i < 150 && !f.db.trace.slice(-1).some(item => item.sql === "COMMIT"); i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(f.db.trace.at(-1)?.sql).toBe("COMMIT"); expect(acknowledged).toBe(false); expect(f.db.phase()).toBe("postgres-selected");
      release(); await pending; expect(acknowledged).toBe(true); expect(f.db.phase()).toBe("postgres-written");
    } finally { release?.(); await f.runtime.close(); }
  });
  it.each(["before", "after"] as const)("reconciles commit-unknown %s durable commit without guessing or duplicating first-write", async mode => {
    const f = integratedFixture();
    try {
      await f.select(); const command = f.command("first-postgres-write", 2); f.db.loseCommit(mode);
      await expect(f.coordinator.execute(command, f.bundle, { write: f.write })).rejects.toBeInstanceOf(CutoverCommitUnknownError);
      expect(f.db.releases.at(-1)).toBeInstanceOf(PostgresCommitUncertainError);
      const result = await f.coordinator.reconcile(command, at(10_000));
      expect(result.outcome).toBe(mode === "after" ? "committed" : "not-committed");
      expect(f.db.rows("migration_cutover_first_write_markers")).toHaveLength(mode === "after" ? 1 : 0);
      const before = f.callbacks(); await f.coordinator.execute(command, f.bundle, { write: f.write });
      expect(f.callbacks()).toBe(before + (mode === "before" ? 1 : 0)); expect(f.db.phase()).toBe("postgres-written");
      expect(f.db.rows("wallet_service_profile_cohort")).toHaveLength(1); expect(f.db.rows("wallet_service_provider_budgets")).toHaveLength(1);
      expect(f.db.rows("migration_cutover_first_write_markers")).toHaveLength(1);
    } finally { await f.runtime.close(); }
  });
  it("rejects external approval denial and actual-role probe failure before any native import", async () => {
    for (const denial of ["approval", "role"]) {
      const f = integratedFixture();
      try {
        await f.select(); if (denial === "approval") f.denyApproval(); else f.db.denyRole();
        await expect(f.first()).rejects.toThrow(); expect(f.callbacks()).toBe(0);
        expect(f.db.phase()).toBe("postgres-selected"); expect(f.db.rows("wallet_service_import_ledger")).toHaveLength(0);
      } finally { await f.runtime.close(); }
    }
  });
  it("rejects nested migration runtime execution from the first-write callback", async () => {
    const f = integratedFixture();
    try {
      await f.select(); await expect(f.coordinator.execute(f.command("first-postgres-write", 2), f.bundle, {
        write: () => f.runtime.run(async () => firstWrite),
      })).rejects.toThrow("nested_migration_uow_forbidden");
      expect(f.db.phase()).toBe("postgres-selected"); expect(f.db.rows("forward_target_channel_heads")).toHaveLength(0);
    } finally { await f.runtime.close(); }
  });
  it("does not save a first-write marker when the native port exhausts its query budget", async () => {
    const f = integratedFixture();
    try {
      await f.select(); await expect(f.coordinator.execute(f.command("first-postgres-write", 2), f.bundle, {
        write: async (transaction, writeId) => {
          const options = nativeOptions(f.target, f.plans.cohort, transaction);
          await applyReviewedPostgresCohortImportPlanInTransaction(f.plans.cohort, { ...options,
            budget: { ...options.budget, maximumQueriesPerTransaction: 2 } });
          return receipt(writeId, f.plans);
        },
      })).rejects.toThrow("query_budget");
      expect(f.db.phase()).toBe("postgres-selected"); expect(f.db.rows("wallet_service_import_ledger")).toHaveLength(0);
    } finally { await f.runtime.close(); }
  });

  it.each(["missing-closure", "unsigned-compatible-release", "source-only-rollback"] as const)(
    "rejects %s before the native callback without inventing V2 proof", async missing => {
      const f = integratedFixture({ configureProtocol: protocol => {
        if (missing === "missing-closure") delete protocol.bundle.closure;
        else if (missing === "unsigned-compatible-release") {
          protocol.compatibilityProof.attestation.signatureBase64 = Buffer.alloc(64).toString("base64");
          protocol.resignAll();
        } else {
          const closure = protocol.bundle.closure;
          if (!closure) throw new Error("Missing synthetic closure");
          closure.rollback = syntheticSeal("rollback", { ...closure.rollback.payload,
            route: "source-before-first-write" as const, rollbackRelease: null,
            rollbackArtifactSha256: null, compatibilityTestReceiptSha256: null });
        }
      } });
      try {
        if (missing === "missing-closure") await expect(f.select()).rejects.toThrow("UNKNOWN_OR_MISSING_FIELDS");
        else if (missing === "unsigned-compatible-release") {
          expect(f.evaluation().preparationReady).toBe(false);
          await expect(f.select()).rejects.toThrow();
        } else {
          await f.select();
          await expect(f.first()).rejects.toThrow("FIRST_WRITE_COMPATIBLE_ROLLBACK_REQUIRED");
        }
        expect(f.callbacks()).toBe(0); expect(f.db.rows("wallet_service_import_ledger")).toHaveLength(0);
        expect(f.db.rows("migration_cutover_first_write_markers")).toHaveLength(0);
      } finally { await f.runtime.close(); }
    });
  it("revalidates committed V2 preparation and native marker on restart before writer composition", async () => {
    const f = integratedFixture();
    const startup = () => verifyCommittedPostgresWriterStartup({ expected: f.policy,
      runtime: { target: f.policy.binding.target, cohortId: f.policy.binding.cohortId },
      store: f.store, clock: () => at(), deadline: at(10_000) });
    try {
      await f.select(); await expect(startup()).rejects.toThrow();
      await f.first();
      await expect(startup()).resolves.toMatchObject({ protocolVersion: 2, phase: "postgres-written",
        activationEnabled: false, writeAuthorized: false });
      const persistedMarker = f.db.rows("migration_cutover_first_write_markers")[0];
      if (!persistedMarker) throw new Error("Missing committed fixture marker");
      const nativeMarker = persistedMarker.marker as FirstPostgresWriteMarkerV2;
      nativeMarker.generation = "fixture-wrong-generation";
      persistedMarker.marker_sha256 = migrationCutoverDigest(nativeMarker, 2);
      await expect(startup()).rejects.toThrow("NATIVE_FIRST_WRITE_MARKER_MISMATCH");
      expect(f.callbacks()).toBe(1);
    } finally { await f.runtime.close(); }
  });
});


describe("realistic cardinality capacity on actual runtime/coordinator wrappers (modeled PG client)", () => {
  it("rolls the entire 216-profile first write back under the unchanged signed 1000-statement budget", async () => {
    const f = integratedFixture({ capacity: true });
    try {
      await f.select(); const before = clone(f.db.rows("migration_cutover_transitions_v2")), start = f.db.trace.length;
      const wrapperStart = f.wrapperQueries(), began = performance.now();
      const error: unknown = await f.first().then(() => undefined, failure => failure);
      expect(error).toBeInstanceOf(Error); expect(String(error)).toMatch(/budget|sql.*limit/i);
      const trace = f.db.trace.slice(start);
      expect(f.callbacks()).toBe(1); expect(f.db.rows("migration_cutover_transitions_v2")).toEqual(before);
      for (const table of ["migration_cutover_first_write_markers", "wallet_service_import_ledger", "wallet_service_profile_cohort", "wallet_service_profile_versions",
        "forward_target_channel_versions", "forward_target_channel_heads", "forward_target_identity_bindings", "wallet_service_provider_budgets"])
        expect(f.db.rows(table)).toHaveLength(0);
      expect(trace.filter(row => row.sql === "BEGIN")).toHaveLength(1);
      expect(trace.filter(row => row.sql === "COMMIT")).toHaveLength(0);
      expect(trace.at(-1)?.sql).toBe("ROLLBACK");
      process.stdout.write("COHORT_CAPACITY_1000 " + JSON.stringify({ wrapperQueries: f.wrapperQueries() - wrapperStart,
        runtimeQueries: trace.length, failure: String(error), elapsedModelMs: performance.now() - began, approvedStatements: f.policy.budgets.maximumSqlStatements }) + "\n");
    } finally { await f.runtime.close(); }
  });
  it("commits 216 profiles (192 enabled) and four reviewed budgets with one marker under an explicitly signed 10000 budget", async () => {
    const f = integratedFixture({ capacity: true, maximumSqlStatements: 10_000 });
    try {
      expect(f.plans.cohort.profiles).toHaveLength(216); await f.select();
      const start = f.db.trace.length, wrapperStart = f.wrapperQueries(), began = performance.now();
      const written = await f.first(), elapsedModelMs = performance.now() - began, trace = f.db.trace.slice(start);
      const wrapperQueries = f.wrapperQueries() - wrapperStart, native = f.nativeQueries();
      expect(written).toMatchObject({ revision: 3, phase: "postgres-written", activationEnabled: false });
      expect(f.db.rows("wallet_service_profile_versions")).toHaveLength(216);
      expect(f.db.rows("wallet_service_profile_versions").filter(row => row.enabled === true)).toHaveLength(192);
      expect(f.db.rows("wallet_service_profile_versions").filter(row => row.suspended === true)).toHaveLength(24);
      expect(f.db.rows("wallet_service_provider_budgets")).toHaveLength(4);
      expect(f.db.rows("wallet_service_import_ledger")).toHaveLength(2);
      expect(f.db.rows("migration_cutover_first_write_markers")).toHaveLength(1);
      expect(trace.filter(row => row.sql === "BEGIN")).toHaveLength(1); expect(trace.filter(row => row.sql === "COMMIT")).toHaveLength(1);
      expect(new Set(trace.map(row => row.connection)).size).toBe(1); expect(trace.at(-1)?.sql).toBe("COMMIT");
      expect(native).toEqual({ cohort: 8656, provider: 48 }); expect(wrapperQueries).toBe(8714);
      expect(trace.length).toBe(8722); expect(wrapperQueries).toBeLessThanOrEqual(10_000);
      expect(trace.length).toBeLessThanOrEqual(10_000); expect(elapsedModelMs).toBeLessThan(4000);
      process.stdout.write("COHORT_CAPACITY_216_192_4 " + JSON.stringify({ ...native, wrapperQueries,
        coordinatorAndWrapperOverhead: wrapperQueries - native.cohort - native.provider,
        runtimeQueries: trace.length, runtimeOverhead: trace.length - wrapperQueries, elapsedModelMs,
        nativeMaximumTransactionMs: 4000, runtimeOperationMs: 5000, coordinatorOperationMs: f.policy.deadlines.maximumOperationMs,
        coordinatorDeadlineRemainingMs: Date.parse(f.command("first-postgres-write", 2).deadline) - Date.now(),
        explicitApprovedStatements: f.policy.budgets.maximumSqlStatements }) + "\n");
    } finally { await f.runtime.close(); }
  }, 15_000);
  it("discards an expired 60-second session without committing native rows, a late marker or an acknowledgment", async () => {
    const f = integratedFixture({ capacity: true, maximumSqlStatements: 10_000, maximumOperationMs: 60_000 });
    try {
      await f.select(); const before = clone(f.db.rows("migration_cutover_transitions_v2")), start = f.db.trace.length;
      let advanced = false, acknowledged = false;
      f.db.failWhen(sql => {
        if (!advanced && sql.includes("INSERT INTO wallet_service_profile_versions")) {
          advanced = true; f.advanceRuntimeClock(60_001);
        }
        return false;
      });
      const error: unknown = await f.first().then(() => { acknowledged = true; return undefined; }, failure => failure);
      expect(advanced).toBe(true); expect(acknowledged).toBe(false); expect(error).toBeInstanceOf(Error);
      const failures = error instanceof AggregateError ? error.errors.map(String) : [String(error)];
      expect(failures.join(" ")).toMatch(/deadline|timeout|expired/i);
      expect(f.db.rows("migration_cutover_transitions_v2")).toEqual(before);
      for (const table of ["migration_cutover_first_write_markers", "wallet_service_import_ledger", "wallet_service_profile_cohort", "wallet_service_profile_versions",
        "forward_target_channel_versions", "forward_target_channel_heads", "forward_target_identity_bindings", "wallet_service_provider_budgets"])
        expect(f.db.rows(table)).toHaveLength(0);
      const trace = f.db.trace.slice(start);
      expect(trace.filter(row => row.sql === "BEGIN")).toHaveLength(1);
      expect(trace.filter(row => row.sql === "COMMIT")).toHaveLength(0);
      expect(trace.filter(row => row.sql.includes("INSERT INTO") && row.sql.includes("migration_cutover_transitions_v2"))).toHaveLength(0);
      // The dedicated runtime forbids further SQL once expired, including ROLLBACK.
      // Error release discards the connection; the model aborts its pending transaction on release.
      expect(f.db.releases.at(-1)).toBeInstanceOf(Error);
      process.stdout.write("COHORT_CAPACITY_DEADLINE " + JSON.stringify({ runtimeOperationMs: 60_000,
        deterministicClockAdvanceMs: 60_001, failure: String(error), causes: failures,
        connectionDiscarded: f.db.releases.at(-1) instanceof Error, runtimeQueries: trace.length, acknowledged }) + "\n");
    } finally { await f.runtime.close(); }
  });
});


describe("isolated cohort target naming", () => {
  it.each([
    ["radar_rehearsal_0123456789abcdef", "radar_rehearsal_0123456789abcdef"],
    ["radar_rehearsal_0123456789abcdef_db", "radar_rehearsal_0123456789abcdef_cohort"],
  ])("accepts exact matching rehearsal nonces: %s / %s", async (database, targetSchema) => {
    const f = integratedFixture({ target: { ...migrationTarget, database, schema: targetSchema } });
    try { await f.select(); await f.first(); expect(f.db.rows("wallet_service_profile_versions")).toHaveLength(1); }
    finally { await f.runtime.close(); }
  });
  it.each([
    ["radar_rehearsal_0123456789abcdef", "radar_rehearsal_fedcba9876543210"],
    ["radar_rehearsal_0123456789abcdef", "radar_acceptance_test"],
    ["radar_rehearsal_0123456789abcdeg", "radar_rehearsal_0123456789abcdeg"],
    ["radar_rehearsal_0123456789abcdef_a_b", "radar_rehearsal_0123456789abcdef_a_b"],
    ["production_rehearsal", "production_rehearsal"],
    ["radar_acceptance_test", "radar_acceptance_test"],
  ])("rejects ambiguous or malformed isolated names before SQL: %s / %s", async (database, targetSchema) => {
    const plans = projectionPlans(migrationTarget, randomUUID()); let queries = 0;
    const transaction = { query: async () => { queries++; throw new Error("SQL must not run"); } } as PostgresTransaction;
    const target = { ...migrationTarget, database, schema: targetSchema };
    await expect(applyReviewedPostgresCohortImportPlanInTransaction(plans.cohort, nativeOptions(target, plans.cohort, transaction)))
      .rejects.toThrow("isolated_target_required");
    expect(queries).toBe(0);
  });
});

const pgEnabled = !!process.env.ADDRESS_RADAR_COHORT_FIRST_WRITE_TARGET_JSON && !!process.env.ADDRESS_RADAR_COHORT_FIRST_WRITE_DATABASE_URL;
describe.skipIf(!pgEnabled)("optional real PG: pre-provisioned dedicated acceptance role/schema, rollback only", () => {
  it("verifies the actual runtime/schema and native SQL share one transaction, then rolls marker and projections back", async () => {
    const target = JSON.parse(process.env.ADDRESS_RADAR_COHORT_FIRST_WRITE_TARGET_JSON!) as PostgresMigrationTarget;
    const connectionString = process.env.ADDRESS_RADAR_COHORT_FIRST_WRITE_DATABASE_URL!, url = new URL(connectionString);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["127.0.0.1", "[::1]"]).toContain(url.hostname); expect(url.port).toBe("5433");
    expect(target.schemaVersion).toBe(3); expect(target.schemaFingerprint).toBe(serviceSchemaV2.plan.fingerprint);
    expect(target.serverPort).toBe(5433); expect(decodeURIComponent(url.pathname.slice(1))).toBe(target.database);
    expect(decodeURIComponent(url.username)).toBe(target.username); expect(url.search).toBe(""); expect(url.hash).toBe("");
    const rehearsal = /^radar_rehearsal_([0-9a-f]{16})(?:_[a-z][a-z0-9]{0,15})?$/;
    const databaseNonce = rehearsal.exec(target.database)?.[1], schemaNonce = rehearsal.exec(target.schema)?.[1];
    expect(databaseNonce !== undefined && databaseNonce === schemaNonce).toBe(true);
    const { Pool } = createRequire(new URL("../../../packages/database/package.json", import.meta.url))("pg") as {
      Pool: new (options: { connectionString: string; max: number; connectionTimeoutMillis: number }) => {
        connect(): Promise<PostgresClient>; end(): Promise<void>;
      };
    };
    const nonce = randomUUID(), plans = projectionPlans(target, nonce), protocol = protocolFixture(target, nonce);
    // Build signed selected state through the actual coordinator, but with a modeled database.
    // Inject this fixture state inside the real rollback-only transaction; it is NOT a durable preparation proof.
    const selectedModel = modelPool(target);
    const modelRuntime = createPostgresMigrationRuntime({ pool: selectedModel.pool, target,
      capability: { mode: "isolated", purpose: "business_import", approvalRef: plans.approvalRef,
        planSha256: protocol.command("prepare", 0).planSha256, expiresAtMs: epoch + 60_000 },
      assertAuthorized: async () => {}, clock: Date.now, limits: { operationTimeoutMs: 5000, connectionTimeoutMs: 1000,
        statementTimeoutMs: 1000, lockTimeoutMs: 250, maximumSqlStatements: 10_000, workMemKb: 1024, closeTimeoutMs: 1000 } });
    const modelStore = createMigrationRuntimeCutoverTransitionStore({ runtime: modelRuntime, target: protocol.policy.binding.target,
      statementTimeoutMs: 4000, lockTimeoutMs: 1000, clock: () => at() });
    const modelCoordinator = createMigrationCutoverCoordinator({ expected: protocol.policy, store: modelStore, clock: () => at() });
    let selected: DurableCutoverState;
    try {
      await modelCoordinator.execute(protocol.command("prepare", 0), protocol.bundle);
      await modelCoordinator.execute(protocol.command("select-postgres", 1), protocol.bundle);
      selected = clone(selectedModel.rows("migration_cutover_transitions_v2")[0]!.state) as DurableCutoverState;
    } finally { await modelRuntime.close(); }
    const sourceKey = migrationCutoverDigest({ hostId: protocol.policy.hostId, canonicalPath: protocol.policy.binding.source.canonicalPath });
    const runtime = createPostgresMigrationRuntime({ pool: new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 }), target,
      capability: { mode: "isolated", purpose: "business_import", approvalRef: plans.approvalRef,
        planSha256: protocol.command("prepare", 0).planSha256, expiresAtMs: epoch + 60_000 },
      assertAuthorized: async request => {
        expect(request.capability.mode).toBe("isolated"); expect(request.capability.planSha256).toBe(protocol.command("prepare", 0).planSha256);
      }, clock: Date.now, limits: { operationTimeoutMs: 5000, connectionTimeoutMs: 2000, statementTimeoutMs: 2000,
        lockTimeoutMs: 1000, maximumSqlStatements: 10_000, workMemKb: 1024, closeTimeoutMs: 1000 } });
    const txids: string[] = [];
    try {
      const store = createMigrationRuntimeCutoverTransitionStore({ runtime: { run: operation => runtime.run(async transaction => {
        const current = (await transaction.query("SELECT txid_current()::text AS id")).rows[0]!.id;
        expect(typeof current).toBe("string"); txids.push(current as string);
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [sourceKey]);
        await transaction.query('INSERT INTO "' + target.schema + '".migration_cutover_transitions_v2(source_key,revision,state) VALUES($1,$2,$3::jsonb)',
          [sourceKey, selected.revision, migrationCutoverCanonicalJson(selected)]);
        const result = await operation(transaction);
        txids.push((await transaction.query("SELECT txid_current()::text AS id")).rows[0]!.id as string);
        const marker = (await transaction.query('SELECT state FROM "' + target.schema + '".migration_cutover_transitions_v2 WHERE source_key=$1', [sourceKey])).rows[0]!;
        expect((marker.state as DurableCutoverState).phase).toBe("postgres-written");
        const nativeMarker = (await transaction.query('SELECT marker_sha256,marker FROM "' + target.schema + '".migration_cutover_first_write_markers WHERE source_key=$1', [sourceKey])).rows[0];
        if (!nativeMarker) throw new Error("Missing in-transaction native first-write marker");
        expect(nativeMarker.marker_sha256).toBe(migrationCutoverDigest(nativeMarker.marker, 2));
        expect(nativeMarker.marker).toMatchObject({ version: 2, generation: target.generation,
          planSha256: protocol.command("first-postgres-write", 2).planSha256, ...receipt(firstWrite.writeId, plans) });
        // Force a PostgreSQL error after marker CAS, so neither the fixture selection nor imported data commits.
        await transaction.query("SELECT 1/0");
        return result;
      }) }, target: protocol.policy.binding.target, statementTimeoutMs: 4000, lockTimeoutMs: 1000, clock: () => at() });
      const coordinator = createMigrationCutoverCoordinator({ expected: protocol.policy, store, clock: () => at() });
      await expect(coordinator.execute(protocol.command("first-postgres-write", 2), protocol.bundle, { write: async (transaction, writeId) => {
        txids.push((await transaction.query("SELECT txid_current()::text AS id")).rows[0]!.id as string);
        await applyReviewedPostgresCohortImportPlanInTransaction(plans.cohort, nativeOptions(target, plans.cohort, transaction));
        await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(plans.provider, nativeOptions(target, plans.provider, transaction));
        return receipt(writeId, plans);
      } })).rejects.toMatchObject({ code: "22012" });
      expect(txids).toHaveLength(3); expect(new Set(txids).size).toBe(1);
      const retained = await runtime.run(async transaction => (await transaction.query(`SELECT
        (SELECT count(*) FROM migration_cutover_transitions_v2 WHERE source_key=$1)::text transitions,
        (SELECT count(*) FROM migration_cutover_first_write_markers WHERE source_key=$1)::text markers,
        (SELECT count(*) FROM wallet_service_import_ledger WHERE import_id=ANY($2::text[]))::text imports,
        (SELECT count(*) FROM forward_target_channel_versions WHERE version_id=$3)::text heads`,
      [sourceKey, [plans.cohort.importId, plans.provider.importId], plans.cohort.profiles[0]!.versionId])).rows[0]!);
      expect(retained).toEqual({ transitions: "0", markers: "0", imports: "0", heads: "0" });
    } finally { await runtime.close(); }
  }, 15_000);
});

