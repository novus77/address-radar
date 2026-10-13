import { createHash as censusFixtureCreateHash } from "node:crypto";
import { executeWriterCensusCommand, collectWriterCensus, validateWriterCensusPolicy, type WriterCensusPolicy, type WriterCensusCommand, type WriterCensusCommandResult } from "../../../scripts/check-migration-writer-fence.js";
const censusFixtureHash = (text: string) => censusFixtureCreateHash("sha256").update(text).digest("hex");
import { createMigrationRuntimeCutoverTransitionStore } from "../src/migration-cutover-coordinator.js";
import { verifyCommittedPostgresWriterStartup, migrationCompatiblePostgresRollbackPayload, POSTGRES_COMPATIBILITY_GUARD_CHECKS, type CompatiblePostgresReleaseProof } from "../src/migration-cutover-coordinator.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_CUTOVER_TRANSITIONS_DDL, migrationCutoverTransitionsDdl,
  MIGRATION_CUTOVER_TRANSITIONS_V2_DDL, MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL, migrationCutoverProtocolV2Ddl, CENSUS_METHODS, CUTOVER_SERVICES, CUTOVER_TIMERS, WRITER_KINDS, PREPARATION_OBSERVATIONS,
  migrationCutoverCanonicalJson, migrationCutoverDigest, migrationCutoverPlanDigest, migrationCutoverObservationPayload,
  fenceClosureSigningMessage, fenceClosureEvidenceSha256, type FenceClosureScope, type FenceClosureSigned, type FirstPostgresWriteMarkerV2,
  migrationCutoverAuthorizationPayload, evaluateMigrationWriterFence, createMigrationCutoverCoordinator,
  createPostgresCutoverTransitionStore, createReadOnlyCutoverStartupStore, verifyCommittedPostgresCutover, CutoverCommitUnknownError,
  type WriterFencePolicy, type WriterFenceBundle, type CutoverObservation, type CutoverCommand,
  type CutoverAction, type CutoverTransitionStore, type CutoverTransactionScope,
  type DurableCutoverState, type FirstPostgresWriteReceipt,
} from "../src/migration-cutover-coordinator.js";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresTransaction } from "../src/postgres-unit-of-work.js";

// These keys, hosts, measurements and artifacts are injected protocol fixtures, never production proof.
const keys = generateKeyPairSync("ed25519");
const fixtureIndependentKeys = generateKeyPairSync("ed25519");
const keyBase64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const epoch = Date.parse("2026-10-04T04:00:00.000Z");
const at = (offset = 0) => new Date(epoch + offset).toISOString();
const hash = (character = "a") => character.repeat(64);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const firstWrite: FirstPostgresWriteReceipt = { writeId: "fixture-first-write", receiptSha256: hash("b"), providerGuardSha256: hash("c"), deliveryGuardSha256: hash("d") };
function fixture() {
  const target = { database: "business", schema: "business", schemaSha256: hash("e"), releaseSha256: hash("f"), generation: "pg-generation-2", serverAddress: "127.0.0.1", serverPort: 5432, systemIdentifier: "7333333333333333333" };
  const policy: WriterFencePolicy = {
    version: 2, evidenceMode: "injected-protocol-fixture", hostId: "fixture-host", bootId: "fixture-boot", challengeId: "fixture-fence",
    binding: { source: { id: "fixture-source", canonicalPath: "/fixture/source.sqlite", device: "1", inode: "2", schemaSha256: hash() },
      sourceGeneration: "sqlite-generation-1", generation: target.generation, watermark: "100", cohortId: "fixture-cohort", snapshot: { id: "fixture-snapshot", sha256: hash() },
      target, rollbackTarget: { ...target, releaseSha256: hash("b") } },
    writers: [...CUTOVER_SERVICES.map(id => ({ id, kind: "services" as const, executableSha256: hash() })),
      ...CUTOVER_TIMERS.map(id => ({ id, kind: "timers" as const, executableSha256: hash() })),
      { id: "fixture-operator", kind: "operators", executableSha256: hash() },
      { id: "fixture-deploy", kind: "deploy", executableSha256: hash() },
      { id: "fixture-usercron", kind: "usercron", executableSha256: hash() },
      { id: "fixture-bridge", kind: "externalInputs", executableSha256: hash() },
      { id: "fixture-external-input", kind: "externalInputs", executableSha256: hash() }],
    catalog: ["fixture_trades", "fixture_provider_guards", "fixture_delivery_guards"],
    guards: [{ id: "fixture-provider", kind: "provider", rows: "2", sha256: hash("c") }, { id: "fixture-delivery", kind: "delivery", rows: "3", sha256: hash("d") }],
    collectors: [{ issuerId: "fixture-collector", keyId: "fixture-collector-key", publicKeyBase64: keyBase64, collectorSha256: hash(), kinds: [...PREPARATION_OBSERVATIONS, "rollback"] },
      { issuerId: "fixture-independent", keyId: "fixture-independent-key", publicKeyBase64: fixtureIndependentKeys.publicKey.export({type:"spki",format:"der"}).toString("base64"), collectorSha256: hash("9"), kinds: ["rehearsal"] }],
    reviewers: [{ issuerId: "fixture-reviewer", keyId: "fixture-reviewer-key", publicKeyBase64: keyBase64, actions: ["prepare", "select-postgres", "first-postgres-write", "rollback", "abort"] }],
    deadlines: { windowStart: at(-30_000), windowEnd: at(50_000), maximumEvidenceAgeMs: 60_000, maximumOperationMs: 10_000, maximumLockMs: 1000 },
    budgets: { connections: [], migrationConnections: 1, operatorConnections: 1, backupConnections: 1, reservedConnections: 2, maximumConnections: 32,
      availableRamBytes: "2000", peakRamBytes: "500", reserveRamBytes: "100", availableDiskBytes: "5000", peakDiskBytes: "1000", peakWalBytes: "500", peakTempBytes: "0", reserveDiskBytes: "100",
      maximumTransitions: 16, maximumSqlStatements: 32 },
  };
  policy.postgresRollbackCatalog = policy.catalog.map(table => ({table,operations:["insert","update","delete"]}));
  policy.postgresRollbackVerifier = {issuerId:"fixture-independent",keyId:"fixture-independent-key"};
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
  const bundle: WriterFenceBundle = { version: 2, activation: { delivery: false, fomo: false, history: false, ownerMerge: false }, observations: {
    fence: report("fence", { fenceId: policy.challengeId, enforcedAt: at(-20_000), validUntil: at(30_000), deniedGenerations: [policy.binding.sourceGeneration],
      barriers: policy.writers.map(w => ({ writerId: w.id, admission: "denied", input: "blocked", rejection: { attemptId: `fixture-rejection-${w.id}`, generation: policy.binding.sourceGeneration, result: "generation-rejected" } })) }),
    snapshot: report("snapshot", { mode: "full-fenced-snapshot", fenceId: policy.challengeId, snapshotId: policy.binding.snapshot.id, snapshotSha256: policy.binding.snapshot.sha256,
      watermark: policy.binding.watermark, startedAt: at(-17_000), completedAt: at(-15_000), catalogSha256: migrationCutoverDigest(policy.catalog), tables: sourceTables }),
    census: report("census", { fenceId: policy.challengeId, snapshotSha256: policy.binding.snapshot.sha256, startedAt: at(-10_000), completedAt: at(-8000), methods: [...CENSUS_METHODS],
      groups: WRITER_KINDS.map(kind => ({ kind, writerIds: policy.writers.filter(w => w.kind === kind).map(w => w.id) })), writers: clone(policy.writers),
      scannedPaths: ["/fixture/source.sqlite", "/fixture/source.sqlite-wal", "/fixture/source.sqlite-shm"],
      files: [{ canonicalPath: "/fixture/source.sqlite", device: "1", inode: "2" }, { canonicalPath: "/fixture/source.sqlite-wal", device: null, inode: null }, { canonicalPath: "/fixture/source.sqlite-shm", device: null, inode: null }], processes: [], fileHolders: [] }),
    parity: report("parity", parity),
    target: report("target", { current: clone(policy.binding.target), compatible: clone(policy.binding.rollbackTarget), probeSha256: hash() }),
    guards: report("guards", { baseline: clone(policy.guards), retained: clone(policy.guards), probeSha256: hash() }),
    capacity: report("capacity", { budgetSha256: migrationCutoverDigest(policy.budgets), measurementId: "fixture-measurement", traceSha256: hash(), startedAt: at(-25_000), completedAt: at(-10_000),
      peakRamBytes: "500", peakDiskBytes: "1000", peakWalBytes: "500", peakTempBytes: "0", connectionPeak: 11 }),
    rehearsal: report("rehearsal", { before: { target: "source-only", snapshotSha256: policy.binding.snapshot.sha256, paritySha256: migrationCutoverDigest(parity), guardsSha256: migrationCutoverDigest(policy.guards), receiptSha256: hash(), testedAt: at(-12_000) },
      after: { target: clone(policy.binding.rollbackTarget), writeReceiptSha256: hash(), retainedMutationsSha256: hash(), recoveredMutationsSha256: hash(), guardsSha256: migrationCutoverDigest(policy.guards), receiptSha256: hash(), startedAt: at(-12_000), firstWriteAt: at(-11_000), completedAt: at(-9000) } }),
  } };
  const compatibilityProof=syntheticCompatibleProof(policy);
  bundle.observations.rehearsal.body.compatibleRelease = compatibilityProof;
  const evaluation = () => evaluateMigrationWriterFence(bundle, policy, at());
  const resignAll = () => {
    refreshSyntheticClosure(policy,bundle);
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
      watermark: state.firstPostgresWrite ? "101" : policy.binding.watermark, firstWriteReceiptSha256: state.firstPostgresWrite?.receiptSha256 ?? null,
      tables: clone(parityTables), guards: clone(policy.guards),
      providerGuardSha256: state.firstPostgresWrite?.providerGuardSha256 ?? migrationCutoverDigest(policy.guards.filter(g => g.kind === "provider")),
      deliveryGuardSha256: state.firstPostgresWrite?.deliveryGuardSha256 ?? migrationCutoverDigest(policy.guards.filter(g => g.kind === "delivery")),
      retainedMutationsSha256: state.firstPostgresWrite ? hash() : null, recoveredMutationsSha256: state.firstPostgresWrite ? hash() : null }, at());
    return authorize(c);
  };
  return { policy, bundle, compatibilityProof, evaluation, resignAll, signObservation, authorize, command, recovery };
}

/** Atomic in-memory test adapter. Its successful commits are protocol simulations, not PG durability proof. */
class FixtureStore implements CutoverTransitionStore {
  state: DurableCutoverState | null = null;
  marker: FirstPostgresWriteMarkerV2 | null = null;
  effects: string[] = [];
  scopes: CutoverTransactionScope[] = [];
  commitUnknown: "before" | "after" | null = null;
  afterCommit: (() => void) | null = null;
  locked = false;
  async run<T>(scope: CutoverTransactionScope, operation: Parameters<CutoverTransitionStore["run"]>[1]): Promise<T> {
    this.scopes.push(scope);
    if (this.locked) throw new Error("SOURCE_ADVISORY_LOCK_BUSY");
    this.locked = true;
    let staged = clone(this.state), stagedMarker=clone(this.marker);
    const effects: string[] = [];
    try {
      const result = await operation({ postgres: { async query(sql) { effects.push(sql); return { rows: [], rowCount: 1 }; } },
        loadFirstWriteMarker: async () => clone(stagedMarker),
        saveFirstWriteMarker: async marker => { if(stagedMarker!==null)throw new Error("NATIVE_FIRST_WRITE_MARKER_ALREADY_EXISTS");stagedMarker=clone(marker); },
        load: async () => clone(staged), save: async (revision, next) => {
          if ((staged?.revision ?? 0) !== revision) throw new Error("STALE_REVISION");
          staged = clone(next);
        } });
      if (this.commitUnknown === "before") { this.commitUnknown = null; throw new PostgresCommitUncertainError(new Error("fixture disconnected")); }
      this.state = staged; this.marker=stagedMarker; this.effects.push(...effects); this.afterCommit?.();
      if (this.commitUnknown === "after") { this.commitUnknown = null; throw new PostgresCommitUncertainError(new Error("fixture acknowledgement lost")); }
      return result as T;
    } finally { this.locked = false; }
  }
}
function protocol() {
  const f = fixture(), store = new FixtureStore();
  let clock = at();
  const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => clock });
  const prepare = () => coordinator.execute(f.command("prepare", 0), f.bundle);
  const select = () => coordinator.execute(f.command("select-postgres", 1), f.bundle);
  const write = async (tx: PostgresTransaction) => { await tx.query("FIXTURE_FIRST_WRITE"); return clone(firstWrite); };
  return { ...f, store, coordinator, prepare, select, write, setClock: (value: string) => { clock = value; } };
}

describe("injected migration preparation protocol", () => {
  it("evaluates complete signed fixture evidence without authorizing writes or activation", () => {
    expect(fixture().evaluation()).toMatchObject({ preparationReady: true, writeAuthorized: false, activationEnabled: false, evidenceMode: "injected-protocol-fixture", blockers: [] });
  });
  it.each(PREPARATION_OBSERVATIONS)("requires observation %s", kind => {
    const f = fixture(); delete (f.bundle.observations as Partial<WriterFenceBundle["observations"]>)[kind];
    expect(f.evaluation().preparationReady).toBe(false);
  });
  it.each(WRITER_KINDS)("compares external expected category %s, including non-service writers", kind => {
    const f = fixture(); const groups = f.bundle.observations.census.body.groups as Array<{ kind: string; writerIds: string[] }>;
    groups.find(g => g.kind === kind)!.writerIds.pop(); f.resignAll();
    expect(f.evaluation().preparationReady).toBe(false);
  });
  it.each([
    ["unknown writer", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.census.body.writers as unknown[]).push({ id: "unknown", kind: "operators", executableSha256: hash() }); }],
    ["unknown process", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.body.processes = [{ writerId: "unknown", pid: 100 }]; }],
    ["known live writer", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.body.processes = [{ writerId: CUTOVER_SERVICES[0], pid: 100 }]; }],
    ["open file holder", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.body.fileHolders = [{ writerId: "fixture-operator", pid: 100 }]; }],
    ["missing scan method", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.census.body.methods as string[]).pop(); }],
    ["missing WAL scan", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.census.body.scannedPaths as string[]).pop(); }],
    ["replaced inode", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.census.body.files as Array<Record<string, unknown>>)[0]!.inode = "3"; }],
    ["old boot", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.provenance.bootId = "other-boot"; }],
    ["unapproved collector binary", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.provenance.collectorSha256 = hash("b"); }],
    ["wrong challenge", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.provenance.challengeId = "old-fence"; }],
    ["delta", (f: ReturnType<typeof fixture>) => { f.bundle.observations.snapshot.body.mode = "delta"; }],
    ["array mode coercion", (f: ReturnType<typeof fixture>) => { f.bundle.observations.snapshot.body.mode = ["full-fenced-snapshot"]; }],
    ["snapshot before fence", (f: ReturnType<typeof fixture>) => { f.bundle.observations.snapshot.body.startedAt = at(-21_000); }],
    ["census before final snapshot", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.body.startedAt = at(-16_000); }],
    ["unknown replacement table", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.snapshot.body.tables as Array<Record<string, unknown>>)[0]!.table = "unknown_table"; }],
    ["source target row mismatch", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.parity.body.tables as Array<Record<string, unknown>>)[0]!.preservedRows = "9007199254740991"; }],
    ["wrong compatible release", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.target.body.compatible as Record<string, unknown>).releaseSha256 = hash("c"); }],
    ["wrong PG cluster", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.target.body.current as Record<string, unknown>).systemIdentifier = "1"; }],
    ["guard omission", (f: ReturnType<typeof fixture>) => { (f.bundle.observations.guards.body.retained as unknown[]).pop(); }],
    ["unmeasured budget", (f: ReturnType<typeof fixture>) => { f.bundle.observations.capacity.body.peakRamBytes = undefined; }],
    ["future observation", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.observedAt = at(1); }],
    ["stale observation", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.observedAt = at(-61_000); }],
    ["expired observation", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.expiresAt = at(); }],
    ["untrusted issuer", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.issuerId = "rogue"; }],
    ["fabricated true flags", (f: ReturnType<typeof fixture>) => { f.bundle.observations.census.body = { complete: true, fenced: true, passed: true }; }],
  ] as const)("rejects %s even when re-signed by the fixture collector", (_name, mutate) => {
    const f = fixture(); mutate(f);
    if (_name !== "unmeasured budget") f.resignAll();
    expect(f.evaluation().preparationReady).toBe(false);
  });
  it("rejects signatures under a self-selected key without modifying external trust", () => {
    const f = fixture(), rogue = generateKeyPairSync("ed25519"), report = f.bundle.observations.census;
    report.keyId = "rogue-key";
    report.signatureBase64 = sign(null, Buffer.from(migrationCutoverObservationPayload(report)), rogue.privateKey).toString("base64");
    expect(f.evaluation().blockers).toContain("UNTRUSTED_OR_INCOHERENT_OBSERVATION");
  });
  it.each(["delivery", "fomo", "history", "ownerMerge"])("keeps activation %s disabled", flag => {
    const f = fixture(); Object.assign(f.bundle.activation, { [flag]: true }); expect(f.evaluation().preparationReady).toBe(false);
  });
  it("rejects fixtures presented against production expectations", () => {
    const f = fixture(); f.policy.evidenceMode = "production-observation"; expect(f.evaluation().preparationReady).toBe(false);
  });
  it("checks explicit resource budgets and bounded policy", () => {
    const f = fixture(); f.policy.budgets.maximumConnections = 10; expect(f.evaluation().preparationReady).toBe(false);
    const g = fixture(); g.policy.deadlines.maximumEvidenceAgeMs = Number.MAX_SAFE_INTEGER; expect(g.evaluation().preparationReady).toBe(false);
    const h = fixture(); h.policy.budgets.connections.pop(); expect(h.evaluation().preparationReady).toBe(false);
  });
  it("encodes deterministic JSON and rejects digest normalization tricks", () => {
    expect(migrationCutoverDigest({ b: 1, a: "value" })).toBe(migrationCutoverDigest({ a: "value", b: 1 }));
    const sparse = new Array(1);
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("must not execute"); } });
    for (const bad of [undefined, NaN, Infinity, -0, 1.5, 1n, sparse, accessor, new Date(), { toJSON: () => ({}) }]) expect(() => migrationCutoverCanonicalJson(bad)).toThrow();
    const f = fixture(); Object.assign(f.bundle, { toJSON: () => fixture().bundle }); expect(f.evaluation().preparationReady).toBe(false);
  });
});

describe("injected durable cutover transitions", () => {
  it("records preparation and PG selection while activation remains separately false", async () => {
    const p = protocol(); expect(await p.prepare()).toMatchObject({ revision: 1, phase: "prepared", activationEnabled: false, writeAuthorized: false });
    expect(await p.select()).toMatchObject({ revision: 2, phase: "postgres-selected" }); expect(p.store.effects).toEqual([]);
  });
  it("records the first PG write in the same transaction and never repeats an idempotent write", async () => {
    const p = protocol(); await p.prepare(); await p.select();
    const c = p.command("first-postgres-write", 2);
    const receipt = await p.coordinator.execute(c, p.bundle, { write: p.write });
    expect(receipt.phase).toBe("postgres-written"); expect(p.store.state!.firstPostgresWrite).toMatchObject(firstWrite);
    expect(await p.coordinator.execute(c, p.bundle, { write: async () => { throw new Error("must not replay"); } })).toEqual(receipt);
    expect(p.store.effects).toEqual(["FIXTURE_FIRST_WRITE"]);
  });
  it("rejects stale revisions and reused operation IDs", async () => {
    const p = protocol(); await p.prepare();
    await expect(p.coordinator.execute(p.command("select-postgres", 0), p.bundle)).rejects.toThrow("STALE_REVISION");
    await expect(p.coordinator.execute(p.command("select-postgres", 1, "fixture-prepare"), p.bundle)).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("rejects missing, untrusted and wrong-action authorization before persistence", async () => {
    const p = protocol(), c = p.command("prepare", 0); c.authorization.signatureBase64 = Buffer.alloc(64).toString("base64");
    await expect(p.coordinator.execute(c, p.bundle)).rejects.toThrow("EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED");
    const d = p.command("prepare", 0); d.authorization.keyId = "self-selected-key"; p.authorize(d);
    await expect(p.coordinator.execute(d, p.bundle)).rejects.toThrow("EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED");
    const e = p.command("prepare", 0); e.action = "select-postgres";
    await expect(p.coordinator.execute(e, p.bundle)).rejects.toThrow("EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED");
    expect(p.store.state).toBeNull();
  });
  it("rejects authorizations that outlive the fenced evidence", async () => {
    const p = protocol(); p.bundle.observations.fence.body.validUntil = at(1000); p.resignAll();
    await expect(p.prepare()).rejects.toThrow("AUTHORIZATION_OUTLIVES_EVIDENCE"); expect(p.store.state).toBeNull();
  });
  it("locks the same canonical source across generation and schema changes", async () => {
    const p = protocol(); await p.prepare(); const first = p.store.scopes[0]!.sourceKey;
    const policy = clone(p.policy); policy.binding.generation = "pg-generation-3"; policy.binding.target.generation = policy.binding.generation;
    policy.binding.rollbackTarget.generation = policy.binding.generation; policy.binding.source.schemaSha256 = hash("b");
    if(!policy.closureTrust)throw new Error("Fixture requires pinned closure trust");
    policy.closureTrust.expectedBinding.generation=policy.binding.generation;
    const other = createMigrationCutoverCoordinator({ expected: policy, store: p.store, clock: () => at() });
    await expect(other.reconcile(p.command("prepare", 0), at(10_000))).rejects.toThrow("STALE_GENERATION");
    expect(p.store.scopes.at(-1)!.sourceKey).toBe(first);
  });
  it("requires fresh before-write parity for source-only rollback", async () => {
    const p = protocol(); await p.prepare(); await p.select();
    const c = p.recovery(p.command("rollback", 2), p.store.state!);
    expect((await p.coordinator.execute(c, null)).phase).toBe("source-rollback-selected");
    expect(p.store.effects).toEqual([]);
  });
  it("rejects invented before-write row accounting", async () => {
    const p = protocol(); await p.prepare(); const c = p.recovery(p.command("rollback", 1), p.store.state!);
    const table = (c.recovery!.body.tables as Array<Record<string, unknown>>)[0]!;
    table.sourceRows = "0"; table.preservedRows = "0"; table.quarantinedRows = "0";
    p.signObservation(c.recovery!); p.authorize(c);
    await expect(p.coordinator.execute(c, null)).rejects.toThrow("SNAPSHOT_PARITY_MISMATCH");
  });
  it.each(["source", "release", "schema", "generation", "cluster", "guards", "mutation-gap"])("refuses after-write rollback with invalid %s", async kind => {
    const p = protocol(); await p.prepare(); await p.select(); await p.coordinator.execute(p.command("first-postgres-write", 2), p.bundle, { write: p.write });
    const c = p.recovery(p.command("rollback", 3), p.store.state!), body = c.recovery!.body;
    if (kind === "source") body.target = "source-only";
    if (kind === "release") (body.target as Record<string, unknown>).releaseSha256 = hash("c");
    if (kind === "schema") (body.target as Record<string, unknown>).schemaSha256 = hash("c");
    if (kind === "generation") (body.target as Record<string, unknown>).generation = "old-generation";
    if (kind === "cluster") (body.target as Record<string, unknown>).systemIdentifier = "1";
    if (kind === "guards") body.providerGuardSha256 = hash("e");
    if (kind === "mutation-gap") body.recoveredMutationsSha256 = hash("e");
    p.signObservation(c.recovery!); p.authorize(c);
    await expect(p.coordinator.execute(c, null)).rejects.toThrow("AFTER_WRITE_EXACT_POSTGRES_RECOVERY_REQUIRED");
    expect(p.store.state!.phase).toBe("postgres-written");
  });
  it("selects only the exact compatible PG rollback after a committed write", async () => {
    const p = protocol(); await p.prepare(); await p.select(); await p.coordinator.execute(p.command("first-postgres-write", 2), p.bundle, { write: p.write });
    const c = p.recovery(p.command("rollback", 3), p.store.state!);
    expect((await p.coordinator.execute(c, null)).phase).toBe("postgres-rollback-selected");
    await expect(p.coordinator.execute(p.command("abort", 4), null)).rejects.toThrow("TERMINAL_TRANSITION");
  });
  it("can record a safe abort before writes without restarting the source", async () => {
    const p = protocol(); await p.prepare(); expect((await p.coordinator.execute(p.command("abort", 1), null)).phase).toBe("aborted"); expect(p.store.effects).toEqual([]);
  });
  it("cannot abort after a PG write", async () => {
    const p = protocol(); await p.prepare(); await p.select(); await p.coordinator.execute(p.command("first-postgres-write", 2), p.bundle, { write: p.write });
    await expect(p.coordinator.execute(p.command("abort", 3), null)).rejects.toThrow("CANNOT_ABORT_AFTER_POSTGRES_WRITE");
  });
  it("rolls back callback failure, cancellation and deadline expiry with the first-write marker", async () => {
    for (const failure of ["error", "abort", "deadline"]) {
      const p = protocol(), controller = new AbortController(); await p.prepare(); await p.select();
      await expect(p.coordinator.execute(p.command("first-postgres-write", 2), p.bundle, { signal: controller.signal, write: async tx => {
        await tx.query("FIXTURE_ROLLED_BACK_WRITE");
        if (failure === "error") throw new Error("fixture write failure");
        if (failure === "abort") controller.abort(); else p.setClock(at(10_000));
        return clone(firstWrite);
      } })).rejects.toThrow();
      expect(p.store.state!.phase).toBe("postgres-selected"); expect(p.store.state!.firstPostgresWrite).toBeNull(); expect(p.store.effects).toEqual([]);
    }
  });
  it.each(["before", "after"] as const)("reconciles commit-unknown %s durable commit without blind replay", async timing => {
    const p = protocol(); await p.prepare(); await p.select(); p.store.commitUnknown = timing;
    const c = p.command("first-postgres-write", 2);
    await expect(p.coordinator.execute(c, p.bundle, { write: p.write })).rejects.toBeInstanceOf(CutoverCommitUnknownError);
    const recovery = await p.coordinator.reconcile(c, at(10_000));
    expect(recovery.outcome).toBe(timing === "after" ? "committed" : "not-committed");
    expect(p.store.effects.length).toBe(timing === "after" ? 1 : 0);
  });
  it("reconciles a late commit acknowledgement after the original authorization expires", async () => {
    const p = protocol(); p.store.afterCommit = () => p.setClock(at(11_000)); const c = p.command("prepare", 0);
    await expect(p.coordinator.execute(c, p.bundle)).rejects.toBeInstanceOf(CutoverCommitUnknownError);
    p.store.afterCommit = null;
    expect((await p.coordinator.reconcile(c, at(20_000))).outcome).toBe("committed");
  });
  it("keeps unknown commits unresolved while the source lock is busy", async () => {
    const p = protocol(); p.store.locked = true;
    await expect(p.coordinator.reconcile(p.command("prepare", 0), at(10_000))).rejects.toThrow("SOURCE_ADVISORY_LOCK_BUSY");
  });
  it("rejects a backwards clock and an already-aborted signal", async () => {
    const p = protocol(); await p.prepare(); p.setClock(at(-1));
    await expect(p.select()).rejects.toThrow("CLOCK_MOVED_BACKWARDS");
    const q = protocol(), controller = new AbortController(); controller.abort();
    await expect(q.coordinator.execute(q.command("prepare", 0), q.bundle, { signal: controller.signal })).rejects.toThrow("OPERATION_ABORTED");
    expect(q.store.state).toBeNull();
  });
});

describe("PG adapter contract using injected query responses", () => {
  it.each(["valid", "wrong-cluster", "lock-busy", "unlogged-ledger", "missing-ledger"])("checks bounded transactions, source lock, target and durable ledger: %s", async condition => {
    const f = fixture(), sql: string[] = [];
    const target = f.policy.binding.target;
    const transaction: PostgresTransaction = { async query(text) {
      sql.push(text);
      if (text.includes("pg_try_advisory")) return { rows: [{ locked: condition !== "lock-busy" }], rowCount: 1 };
      if (text.includes("current_database()")) return { rows: [{ database: target.database, schema_name: target.schema, generation_id: target.generation, fingerprint: target.schemaSha256,
        server_address: target.serverAddress, server_port: target.serverPort, system_identifier: condition === "wrong-cluster" ? "1" : target.systemIdentifier }], rowCount: 1 };
      if (text.includes("relpersistence") && condition === "missing-ledger") return { rows: [], rowCount: 0 };
      if (text.includes("relpersistence")) return { rows: [{ relkind: "r", relpersistence: condition === "unlogged-ledger" ? "u" : "p" }], rowCount: 1 };
      return { rows: [], rowCount: text.includes("INSERT INTO") ? 1 : 0 };
    } };
    let runtimeRuns = 0;
    // Injected protocol runtime only. Real role/approval probes belong to dedicated runtime integration.
    const runtime = { run<T>(operation: (tx: PostgresTransaction) => Promise<T>) {
      runtimeRuns++;
      return createPostgresUnitOfWork({ connect: async () => ({ query: transaction.query, release() {} }) },
        { statementTimeoutMs: 10_000, lockTimeoutMs: 1000 }).run(operation);
    } };
    const store = createMigrationRuntimeCutoverTransitionStore({ runtime, statementTimeoutMs: 10_000, lockTimeoutMs: 1000, target, clock: () => at() });
    const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => at() });
    if (condition === "valid") {
      expect((await coordinator.execute(f.command("prepare", 0), f.bundle)).phase).toBe("prepared");
      expect(sql.findIndex(s => s.includes("pg_try_advisory"))).toBeLessThan(sql.findIndex(s => s.includes("FOR UPDATE")));
      expect(runtimeRuns).toBe(1); expect(sql.filter(sql => sql === "BEGIN")).toHaveLength(1);
      expect(sql[0]).toBe("BEGIN"); expect(sql[1]).toContain("statement_timeout");
      expect(sql.some(s => s.includes("WHERE existing.revision=$4"))).toBe(true); expect(sql.at(-1)).toBe("COMMIT");
    } else { await expect(coordinator.execute(f.command("prepare", 0), f.bundle)).rejects.toThrow(); expect(sql.some(s => s.includes("INSERT INTO"))).toBe(false); }
  });
});

describe("read-only saved-evidence CLI", () => {
  it("rejects fixture policies and sanitizes malformed input without opening PG", () => {
    const directory = mkdtempSync(join(tmpdir(), "cutover-protocol-fixture-"));
    try {
      const f = fixture(), policyPath = join(directory, "expected.json"), bundlePath = join(directory, "bundle.json");
      writeFileSync(policyPath, JSON.stringify(f.policy)); writeFileSync(bundlePath, JSON.stringify(f.bundle));
      const args = ["--import", "tsx", "scripts/check-migration-writer-fence.ts", "--bundle", bundlePath, "--expected-policy", policyPath, "--expected-policy-sha256", migrationCutoverDigest(f.policy)];
      const child = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(child.status).toBe(2); expect(JSON.parse(child.stdout)).toMatchObject({ writeAuthorized: false, activationEnabled: false, error: "FIXTURE_POLICY_NOT_PRODUCTION" });
      writeFileSync(policyPath, "credential:must-not-leak");
      const malformed = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(malformed.status).toBe(2); expect(malformed.stdout + malformed.stderr).not.toContain("must-not-leak");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("read-only committed backend selection with injected fixtures", () => {
  const verifySelection = (p: ReturnType<typeof protocol>, clock = at()) => verifyCommittedPostgresCutover({
    expected: p.policy, runtime: { target: p.policy.binding.target, cohortId: p.policy.binding.cohortId },
    store: p.store, clock: () => clock, deadline: new Date(Date.parse(clock) + 10_000).toISOString(),
  });
  it("requires persisted PG selection rather than configured activation booleans", async () => {
    const p = protocol(); await expect(verifySelection(p)).rejects.toThrow("COMMITTED_POSTGRES_SELECTION_REQUIRED");
    await p.prepare(); await expect(verifySelection(p)).rejects.toThrow("COMMITTED_POSTGRES_SELECTION_REQUIRED");
    await p.select();
    expect(await verifySelection(p)).toMatchObject({ backend: "postgres", phase: "postgres-selected", revision: 2,
      cohortId: "fixture-cohort", evidenceMode: "injected-protocol-fixture", activationEnabled: false, writeAuthorized: false });
    expect(p.store.effects).toEqual([]); expect(p.store.state!.revision).toBe(2);
  });
  it("verifies historical committed authorization after its execution window expires", async () => {
    const p = protocol(); await p.prepare(); await p.select();
    expect((await verifySelection(p, at(70_000))).phase).toBe("postgres-selected");
  });
  it("accepts a durable first-write state without granting activation", async () => {
    const p = protocol(); await p.prepare(); await p.select(); await p.coordinator.execute(p.command("first-postgres-write", 2), p.bundle, { write: p.write });
    expect((await verifySelection(p)).phase).toBe("postgres-written"); expect(p.store.effects).toEqual(["FIXTURE_FIRST_WRITE"]);
  });
  it.each(["cohort", "generation", "schema", "release", "cluster"])("rejects a runtime %s mismatch", async field => {
    const p = protocol(); await p.prepare(); await p.select();
    const runtime = { target: clone(p.policy.binding.target), cohortId: p.policy.binding.cohortId };
    if (field === "cohort") runtime.cohortId = "other-cohort";
    if (field === "generation") runtime.target.generation = "other-generation";
    if (field === "schema") runtime.target.schemaSha256 = hash("b");
    if (field === "release") runtime.target.releaseSha256 = hash("b");
    if (field === "cluster") runtime.target.systemIdentifier = "1";
    await expect(verifyCommittedPostgresCutover({ expected: p.policy, runtime, store: p.store, clock: () => at(), deadline: at(10_000) })).rejects.toThrow("RUNTIME_CUTOVER_IDENTITY_MISMATCH");
  });
  it.each(["signature", "phase", "evidence", "cohort"])("rejects persisted %s fabrication", async field => {
    const p = protocol(); await p.prepare(); await p.select();
    if (field === "signature") p.store.state!.journal[1]!.command.authorization.signatureBase64 = Buffer.alloc(64).toString("base64");
    if (field === "phase") p.store.state!.journal[1]!.receipt.phase = "postgres-written";
    if (field === "evidence") p.store.state!.preparation.observations.fence.body.barriers = [];
    if (field === "cohort") p.store.state!.binding.cohortId = "other-cohort";
    await expect(verifySelection(p)).rejects.toThrow();
  });
  it("refuses aborted and source rollback selections", async () => {
    const p = protocol(); await p.prepare(); await p.coordinator.execute(p.command("abort", 1), null);
    await expect(verifySelection(p)).rejects.toThrow("COMMITTED_POSTGRES_SELECTION_REQUIRED");
    const q = protocol(); await q.prepare(); await q.coordinator.execute(q.recovery(q.command("rollback", 1), q.store.state!), null);
    await expect(verifySelection(q)).rejects.toThrow("COMMITTED_POSTGRES_SELECTION_REQUIRED");
  });
});

describe("trusted v2 transition ledger extension", () => {
  it("qualifies only explicit safe schemas and refuses SQL injection or implicit public storage", () => {
    expect(migrationCutoverTransitionsDdl("business")).toContain('CREATE TABLE "business"."migration_cutover_transitions"');
    expect(MIGRATION_CUTOVER_TRANSITIONS_DDL).not.toContain("IF NOT EXISTS");
    for (const schema of ["public", "information_schema", "pg_catalog", 'business"; DROP TABLE receipts;', "business.extra", ""]) {
      expect(() => migrationCutoverTransitionsDdl(schema)).toThrow("INVALID_LEDGER_SCHEMA");
    }
  });
});

describe("committed selection evidence lifetime", () => {
  it("rejects a re-signed selection record made after the prepared fence expired", async () => {
    const p = protocol(); await p.prepare(); await p.select();
    const journal = p.store.state!.journal[1]!;
    journal.command.deadline = at(45_000); journal.command.authorization.issuedAt = at(35_000); journal.command.authorization.expiresAt = at(45_000);
    p.authorize(journal.command); journal.requestSha256 = migrationCutoverDigest(journal.command, 2); journal.receipt.recordedAt = at(35_000);
    await expect(verifyCommittedPostgresCutover({ expected: p.policy, runtime: { target: p.policy.binding.target, cohortId: p.policy.binding.cohortId },
      store: p.store, clock: () => at(35_000), deadline: at(45_000) })).rejects.toThrow("EXPIRED_OBSERVATION");
  });
});

describe("startup reader on an injected verified runtime without a raw pool", () => {
  function startup(p: ReturnType<typeof protocol>, mode = "valid") {
    const sql: string[] = [], target = p.policy.binding.target;
    let runs = 0;
    const store = createReadOnlyCutoverStartupStore({ target, clock: () => at(), runtime: {
      async run(operation) {
        runs++;
        return operation({ async query(text) {
          sql.push(text);
          if (text.includes("pg_current_xact_id_if_assigned")) return { rows: [{ no_prior_writes: mode !== "ambient-writer" }], rowCount: 1 };
          if (text.includes("pg_try_advisory_xact_lock_shared")) return { rows: [{ locked: mode !== "busy" }], rowCount: 1 };
          if (text.includes("current_database()") && mode === "denied-cluster-probe") throw new Error("fixture function EXECUTE denied");
          if (text.includes("current_database()")) return { rows: [{ database: target.database, schema_name: target.schema,
            generation_id: mode === "wrong-generation" ? "other" : target.generation, fingerprint: target.schemaSha256,
            server_address: target.serverAddress, server_port: target.serverPort, system_identifier: mode === "wrong-cluster" ? "1" : target.systemIdentifier }], rowCount: 1 };
          if (text.includes("relpersistence")) return { rows: mode === "missing-table" ? [] : [{ relkind: "r", relpersistence: "p" }], rowCount: mode === "missing-table" ? 0 : 1 };
          if(text.includes("c.relname AS table_name")){const catalog=p.policy.postgresRollbackCatalog;if(!catalog)throw new Error("Missing fixture catalog");return{rows:catalog.map(e=>({table_name:e.table})),rowCount:catalog.length};}
          if(text.includes("SELECT marker_sha256,marker"))return syntheticMarkerRows(p.store.marker);
          if (text.includes("SELECT revision,state")) return { rows: p.store.state === null ? [] : [{ revision: String(p.store.state.revision), state: clone(p.store.state) }], rowCount: p.store.state === null ? 0 : 1 };
          throw new Error("Unexpected fixture SQL");
        } });
      },
    } });
    const verify = () => verifyCommittedPostgresCutover({ expected: p.policy, runtime: { target, cohortId: p.policy.binding.cohortId }, store, clock: () => at(), deadline: at(10_000) });
    return { store, verify, sql, runs: () => runs };
  }
  it("verifies selected state with SELECT-only console-compatible reads", async () => {
    const p = protocol(); await p.prepare(); await p.select(); const s = startup(p);
    expect((await s.verify()).phase).toBe("postgres-selected"); expect(s.runs()).toBe(1);
    expect(s.sql.some(sql => /FOR UPDATE|pg_try_advisory|\bINSERT\b|\bDELETE\b|\bUPDATE\b/i.test(sql))).toBe(false);
    expect(s.sql.some(sql => sql.includes("pg_control_system"))).toBe(true);
    expect(p.store.state!.revision).toBe(2);
  });
  it.each(["ambient-writer", "missing-table", "wrong-generation", "wrong-cluster", "denied-cluster-probe"])("refuses startup %s", async mode => {
    const p = protocol(); await p.prepare(); await p.select(); await expect(startup(p, mode).verify()).rejects.toThrow();
  });
  it("rejects missing committed state and malformed persisted authorization", async () => {
    const p = protocol(); await expect(startup(p).verify()).rejects.toThrow("COMMITTED_POSTGRES_SELECTION_REQUIRED");
    await p.prepare(); await p.select(); p.store.state!.journal[1]!.command.authorization.signatureBase64 = Buffer.alloc(64).toString("base64");
    await expect(startup(p).verify()).rejects.toThrow("PERSISTED_SCOPED_AUTHORIZATION_INVALID");
  });
  it("cannot be repurposed for ledger writes or caller SQL", async () => {
    const p = protocol(); await p.prepare(); await p.select(); const s = startup(p);
    const scope = { ...p.store.scopes[0]!, signal: undefined };
    await expect(s.store.run(scope, tx => tx.save(2, p.store.state!))).rejects.toThrow("READ_ONLY_STARTUP_ADAPTER");
    await expect(s.store.run(scope, tx => tx.postgres.query("FIXTURE_BUSINESS_WRITE"))).rejects.toThrow("READ_ONLY_STARTUP_ADAPTER");
    expect(s.sql).not.toContain("FIXTURE_BUSINESS_WRITE"); expect(p.store.state!.revision).toBe(2);
  });
});

describe("long signed operations within a bounded fixture maintenance window", () => {
  // An illustrative protocol fixture only; no formal production window or actual target is approved.
  function longOperation() {
    const f = fixture();
    f.policy.deadlines.windowStart = at(-40 * 60_000); f.policy.deadlines.windowEnd = at(10 * 60_000);
    f.policy.catalog = Array.from({ length: 141 }, (_, i) => `fixture_table_${i}`);
    const sourceTemplate = clone((f.bundle.observations.snapshot.body.tables as Array<Record<string, unknown>>)[0]!);
    const parityTemplate = clone((f.bundle.observations.parity.body.tables as Array<Record<string, unknown>>)[0]!);
    f.bundle.observations.snapshot.body.tables = f.policy.catalog.map(table => ({ ...sourceTemplate, table }));
    f.bundle.observations.parity.body.tables = f.policy.catalog.map(table => ({ ...parityTemplate, table }));
    f.bundle.observations.snapshot.body.catalogSha256 = migrationCutoverDigest(f.policy.catalog);
    f.bundle.observations.fence.body.enforcedAt = at(-30 * 60_000);
    f.bundle.observations.snapshot.body.startedAt = at(-29 * 60_000);
    f.bundle.observations.snapshot.body.completedAt = at(-4 * 60_000);
    f.bundle.observations.capacity.body.startedAt = at(-35 * 60_000);
    f.bundle.observations.capacity.body.completedAt = at(-31 * 60_000);
    const before = f.bundle.observations.rehearsal.body.before as Record<string, unknown>;
    const after = f.bundle.observations.rehearsal.body.after as Record<string, unknown>;
    before.paritySha256 = migrationCutoverDigest(f.bundle.observations.parity.body);
    before.testedAt = at(-3 * 60_000); after.startedAt = at(-3 * 60_000); after.firstWriteAt = at(-2 * 60_000); after.completedAt = at(-60_000);
    f.resignAll();
    return f;
  }
  it("accepts a 25-minute 141-table snapshot/restore with fresh observations and final census", async () => {
    const f = longOperation();
    expect(f.policy.deadlines.maximumEvidenceAgeMs).toBe(60_000);
    expect(f.evaluation()).toMatchObject({ preparationReady: true, evidenceMode: "injected-protocol-fixture", writeAuthorized: false });
    const store = new FixtureStore();
    const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => at() });
    expect((await coordinator.execute(f.command("prepare", 0), f.bundle)).phase).toBe("prepared");
    expect(store.state!.snapshotTables).toHaveLength(141);
  });
  it.each(["fence", "snapshot-start", "snapshot-end", "rehearsal", "capacity"])("rejects %s boundary outside the approved fixture window", name => {
    const f = longOperation(), outside = at(-40 * 60_000 - 1);
    if (name === "fence") f.bundle.observations.fence.body.enforcedAt = outside;
    if (name === "snapshot-start") f.bundle.observations.snapshot.body.startedAt = outside;
    if (name === "snapshot-end") f.bundle.observations.snapshot.body.completedAt = at(11 * 60_000);
    if (name === "rehearsal") (f.bundle.observations.rehearsal.body.before as Record<string, unknown>).testedAt = outside;
    if (name === "capacity") f.bundle.observations.capacity.body.startedAt = outside;
    f.resignAll();
    expect(f.evaluation()).toMatchObject({ preparationReady: false, blockers: ["BOUNDARY_OUTSIDE_APPROVED_WINDOW"] });
  });
  it("still refuses stale signed observations or a stale final census after a long operation", () => {
    const f = longOperation(); f.bundle.observations.snapshot.observedAt = at(-61_000); f.resignAll(); expect(f.evaluation().preparationReady).toBe(false);
    const g = longOperation(); g.bundle.observations.census.body.startedAt = at(-61_000); g.resignAll(); expect(g.evaluation().preparationReady).toBe(false);
  });
});


describe("independently attested compatible-PG release protocol fixtures", () => {
  function compatible() {
    const q = protocol(), independent = fixtureIndependentKeys;
    q.policy.postgresRollbackCatalog = q.policy.catalog.map(table => ({ table, operations: ["insert", "update", "delete"] }));
    q.policy.postgresRollbackVerifier = { issuerId: "fixture-independent", keyId: "fixture-independent-key" };
    q.policy.collectors=q.policy.collectors.filter(c=>c.keyId!=="fixture-independent-key");
    q.policy.collectors.push({ ...q.policy.postgresRollbackVerifier, publicKeyBase64: independent.publicKey.export({ type: "spki", format: "der" }).toString("base64"), collectorSha256: hash("9"), kinds: ["rehearsal"] });
    const proof: CompatiblePostgresReleaseProof = {
      version: 2, binding: clone(q.policy.binding), strategy: "compatible-postgres-release", recoveryMode: "retain-live-postgres-data", backend: "postgres",
      candidate: clone(q.policy.binding.target), compatible: clone(q.policy.binding.rollbackTarget),
      candidateArtifactSha256: q.policy.binding.target.releaseSha256, compatibleArtifactSha256: q.policy.binding.rollbackTarget.releaseSha256,
      catalogSha256: migrationCutoverDigest(q.policy.postgresRollbackCatalog), schemaProbeSha256: hash(), mutationTraceSha256: hash(),
      parentTransactionRollbackReceiptSha256: hash(), commitUnknownReconciliationReceiptSha256: hash(),
      providerGuardSha256: migrationCutoverDigest(q.policy.guards.filter(guard => guard.kind === "provider")),
      deliveryGuardSha256: migrationCutoverDigest(q.policy.guards.filter(guard => guard.kind === "delivery")),
      startedAt: at(-14_000), firstWriteAt: at(-13_000), completedAt: at(-7000),
      tableChecks: q.policy.postgresRollbackCatalog.map(entry => ({ table: entry.table, retainedRows: "9007199254740993", recoveredRows: "9007199254740993", retainedSha256: hash(), recoveredSha256: hash(),
        cases: entry.operations.map(operation => ({ operation, committedReceiptSha256: hash(), compatibleReadReceiptSha256: hash(), compatibleWriteReceiptSha256: hash() })) })),
      guardChecks: POSTGRES_COMPATIBILITY_GUARD_CHECKS.map(check => ({ check, receiptSha256: hash() })),
      attestation: { ...q.policy.postgresRollbackVerifier, observedAt: at(-6000), expiresAt: at(30_000),
        provenance: { hostId: q.policy.hostId, bootId: q.policy.bootId, challengeId: q.policy.challengeId, collectorSha256: hash("9"), runId: "fixture-independent-run", sequence: "1" }, signatureBase64: "" },
    };
    const resign = () => {
      proof.attestation.signatureBase64 = sign(null, Buffer.from(migrationCompatiblePostgresRollbackPayload(proof)), independent.privateKey).toString("base64");
      q.bundle.observations.rehearsal.body.compatibleRelease = proof; q.resignAll();
    };
    resign();
    // The coordinator was constructed before the optional reviewed policy was added.
    const coordinator = createMigrationCutoverCoordinator({ expected: q.policy, store: q.store, clock: () => at() });
    const prepare = () => coordinator.execute(q.command("prepare", 0), q.bundle);
    const select = () => coordinator.execute(q.command("select-postgres", 1), q.bundle);
    const write = () => coordinator.execute(q.command("first-postgres-write", 2), q.bundle, { write: q.write });
    const options = () => ({ expected: q.policy, runtime: { target: q.policy.binding.target, cohortId: q.policy.binding.cohortId }, store: q.store, clock: () => at(), deadline: at(10_000) });
    return { ...q, proof, resign, coordinator, prepare, select, write, options };
  }
  it("verifies compatible same-data recovery without inventing a reverse journal or write permission", async () => {
    const q = compatible(); await q.prepare(); await q.select(); await q.write();
    const result = await verifyCommittedPostgresWriterStartup(q.options());
    expect(result).toMatchObject({ phase: "postgres-written", mutableJournalVerified: false, writerStartupBlockers: [], evidenceMode: "injected-protocol-fixture",
      rollbackReadiness: { strategy: "compatible-postgres-release", recoveryMode: "retain-live-postgres-data", target: q.policy.binding.rollbackTarget }, activationEnabled: false, writeAuthorized: false });
    expect(Object.isFrozen(result.rollbackReadiness)).toBe(true);
  });
  it("keeps selected console read-only and refuses first write without independent compatible-release proof", async () => {
    const q = protocol(); await q.prepare(); await q.select();
    await expect(verifyCommittedPostgresWriterStartup({ expected: q.policy, runtime: { target: q.policy.binding.target, cohortId: q.policy.binding.cohortId }, store: q.store, clock: () => at(), deadline: at(10_000) })).rejects.toThrow("POSTGRES_WRITER_FIRST_COMMITTED_WRITE_REQUIRED");
    const missing=protocol();
    delete missing.bundle.observations.rehearsal.body.compatibleRelease;
    missing.resignAll();
    await missing.prepare(); await missing.select();
    await expect(missing.coordinator.execute(missing.command("first-postgres-write",2),missing.bundle,{write:missing.write})).rejects.toThrow("POSTGRES_WRITER_ROLLBACK_READINESS_NOT_PROVEN");
    expect(missing.store.effects).toEqual([]);expect(missing.store.marker).toBeNull();
  });
  it.each(["wrong-cohort", "wrong-source", "wrong-target", "missing-table", "unknown-table", "missing-operation", "missing-guard", "wrong-artifact", "sqlite-backend", "schema-downgrade", "reset-mutation", "wrong-issuer", "wrong-key", "same-verifier", "outside-window", "future-attestation", "fake-signature", "untrusted-boolean"])("rejects compatible proof %s", name => {
    const q = compatible();
    if (name === "wrong-cohort") q.proof.binding.cohortId = "unreviewed-cohort";
    if (name === "wrong-source") q.proof.binding.source.inode = "100";
    if (name === "wrong-target") q.proof.compatible.systemIdentifier = "1";
    if (name === "missing-table") q.proof.tableChecks.pop();
    if (name === "unknown-table") q.proof.tableChecks[0]!.table = "not_reviewed";
    if (name === "missing-operation") q.proof.tableChecks[0]!.cases.pop();
    if (name === "missing-guard") q.proof.guardChecks.pop();
    if (name === "wrong-artifact") q.proof.compatibleArtifactSha256 = hash("1");
    if (name === "sqlite-backend") (q.proof as unknown as Record<string, unknown>).backend = "sqlite";
    if (name === "schema-downgrade") q.proof.compatible.schemaSha256 = hash("1");
    if (name === "reset-mutation") q.proof.tableChecks[0]!.recoveredRows = "0";
    if (name === "wrong-issuer") q.proof.attestation.issuerId = "self-selected";
    if (name === "wrong-key") q.proof.attestation.keyId = "self-selected";
    if (name === "same-verifier") q.policy.collectors[1]!.publicKeyBase64 = q.policy.collectors[0]!.publicKeyBase64;
    if (name === "outside-window") q.proof.startedAt = at(-31_000);
    if (name === "future-attestation") q.proof.attestation.observedAt = at(1);
    if (name === "untrusted-boolean") (q.proof as unknown as Record<string, unknown>).verified = true;
    q.resign();
    if (name === "fake-signature") { q.proof.attestation.signatureBase64 = Buffer.alloc(64).toString("base64"); q.resignAll(); }
    expect(q.evaluation().preparationReady).toBe(false);
  });
  it("requires written phase even when selected has complete compatible-release evidence", async () => {
    const q = compatible(); await q.prepare(); await q.select();
    await expect(verifyCommittedPostgresWriterStartup(q.options())).rejects.toThrow("POSTGRES_WRITER_FIRST_COMMITTED_WRITE_REQUIRED");
  });

  function liveStartup(q: ReturnType<typeof compatible>, mode = "valid") {
    const sql: string[] = [], target = q.policy.binding.target;
    let runs = 0;
    const store = createReadOnlyCutoverStartupStore({ target, clock: () => at(), runtime: {
      async run(operation) {
        runs++;
        return operation({ async query(text) {
          sql.push(text);
          if (text.includes("pg_current_xact_id_if_assigned")) return { rows: [{ no_prior_writes: true }], rowCount: 1 };
          if (text.includes("current_database()")) return { rows: [{ database: target.database, schema_name: target.schema,
            generation_id: target.generation, fingerprint: target.schemaSha256, server_address: target.serverAddress,
            server_port: target.serverPort, system_identifier: target.systemIdentifier }], rowCount: 1 };
          if (text.includes("relpersistence")) return { rows: [{ relkind: "r", relpersistence: "p" }], rowCount: 1 };
          if (text.includes("c.relname AS table_name")) {
            const names = q.policy.postgresRollbackCatalog!.map(entry => entry.table);
            if (mode === "missing") names.pop();
            if (mode === "unknown") names.push("unreviewed_live_writer_table");
            if (mode === "duplicate") names.push(names[0]!);
            return { rows: names.map(table_name => ({ table_name })), rowCount: names.length };
          }
          if(text.includes("SELECT marker_sha256,marker"))return syntheticMarkerRows(q.store.marker);
          if (text.includes("SELECT revision,state")) return { rows: [{ revision: String(q.store.state!.revision), state: clone(q.store.state!) }], rowCount: 1 };
          throw new Error("Unexpected compatibility fixture SQL");
        } });
      },
    } });
    return { sql, runs: () => runs, verify: () => verifyCommittedPostgresWriterStartup({ ...q.options(), store }) };
  }
  it("checks exact live PG catalog and committed proof in one SELECT-only existing runtime UOW", async () => {
    const q = compatible(); await q.prepare(); await q.select(); await q.write(); const live = liveStartup(q);
    expect((await live.verify()).rollbackReadiness.strategy).toBe("compatible-postgres-release");
    expect(live.runs()).toBe(1);
    expect(live.sql.filter(sql => sql.includes("c.relname AS table_name"))).toHaveLength(1);
    expect(live.sql.some(sql => /FOR UPDATE|pg_try_advisory|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql))).toBe(false);
  });
  it.each(["missing", "unknown", "duplicate"])("rejects %s live table coverage despite valid independent proof", async mode => {
    const q = compatible(); await q.prepare(); await q.select(); await q.write();
    await expect(liveStartup(q, mode).verify()).rejects.toThrow("LIVE_POSTGRES_ROLLBACK_CATALOG_MISMATCH");
  });
  it("allows only a separately signed compatible-PG rollback state and exact rollback runtime release", async () => {
    const q = compatible(); await q.prepare(); await q.select(); await q.write();
    await q.coordinator.execute(q.recovery(q.command("rollback", 3), q.store.state!), null);
    await expect(verifyCommittedPostgresWriterStartup(q.options())).rejects.toThrow("RUNTIME_CUTOVER_IDENTITY_MISMATCH");
    const options = q.options(); options.runtime.target = q.policy.binding.rollbackTarget;
    expect((await verifyCommittedPostgresWriterStartup(options)).phase).toBe("postgres-rollback-selected");
  });
});


describe("dedicated migration runtime cutover store boundary", () => {
  it("refuses the deprecated raw-pool entry without opening a connection", () => {
    const f = fixture(); let connections = 0;
    expect(() => createPostgresCutoverTransitionStore({ pool: { async connect() { connections++; throw new Error("must not connect"); } },
      target: f.policy.binding.target, clock: () => at(), statementTimeoutMs: 10_000, lockTimeoutMs: 1000 }))
      .toThrow("RAW_POOL_CUTOVER_STORE_DISABLED_USE_VERIFIED_MIGRATION_RUNTIME");
    expect(connections).toBe(0);
  });
  it("propagates dedicated external authority refusal before executing coordinator SQL", async () => {
    const f = fixture(); let runs = 0;
    const store = createMigrationRuntimeCutoverTransitionStore({ runtime: { async run() { runs++; throw new Error("fixture external approval denied"); } },
      target: f.policy.binding.target, clock: () => at(), statementTimeoutMs: 10_000, lockTimeoutMs: 1000 });
    const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => at() });
    await expect(coordinator.execute(f.command("prepare", 0), f.bundle)).rejects.toThrow("fixture external approval denied");
    expect(runs).toBe(1);
  });
});


describe("explicit single-transaction SQL budgets without automatic increases", () => {
  function budgetFixture(maximumSqlStatements: number) {
    const f = fixture(); f.policy.budgets.maximumSqlStatements = maximumSqlStatements;
    f.bundle.observations.capacity.body.budgetSha256 = migrationCutoverDigest(f.policy.budgets); f.resignAll();
    return f;
  }
  it.each([1000, 10000])("accepts explicit write ceiling %i without rewriting the policy", limit => {
    const f = budgetFixture(limit); expect(f.evaluation().preparationReady).toBe(true);
    expect(f.policy.budgets.maximumSqlStatements).toBe(limit);
  });
  it.each([10001, "10000", true, 0])("rejects out-of-range or coercive ceiling %s", limit => {
    const f = budgetFixture(limit as number); expect(f.evaluation().preparationReady).toBe(false);
  });
  it.each([8, 1000, 10000])("keeps startup read budget bounded with write ceiling %i", async limit => {
    const f = budgetFixture(limit), store = new FixtureStore();
    const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => at() });
    await coordinator.execute(f.command("prepare", 0), f.bundle); await coordinator.execute(f.command("select-postgres", 1), f.bundle);
    await verifyCommittedPostgresCutover({ expected: f.policy, runtime: { target: f.policy.binding.target, cohortId: f.policy.binding.cohortId }, store, clock: () => at(), deadline: at(10_000) });
    expect(store.scopes.at(-1)!.maximumSqlStatements).toBe(Math.min(limit, 1000));
    expect(store.scopes[0]!.maximumSqlStatements).toBe(limit);
  });
  it.each([[1000, false], [1209, false], [1210, true], [10000, true]] as const)("enforces explicit %i budget atomically, including marker statement", async (limit, succeeds) => {
    const f = budgetFixture(limit), stored = new FixtureStore(), target = f.policy.binding.target;
    const preparation = createMigrationCutoverCoordinator({ expected: f.policy, store: stored, clock: () => at() });
    await preparation.execute(f.command("prepare", 0), f.bundle); await preparation.execute(f.command("select-postgres", 1), f.bundle);
    const before = clone(stored.state), sql: string[] = [];
    // Large-query protocol fixture, NOT a claim about actual 216-profile importer costs or real PG.
    let staged = clone(stored.state), stagedMarker=clone(stored.marker), pendingEffects = 0, committedEffects = 0;
    const runtime = { run<T>(operation: (transaction: PostgresTransaction) => Promise<T>) {
      return createPostgresUnitOfWork({ async connect() { return { async query(text: string, values?: unknown[]) {
        sql.push(text);
        if (text === "BEGIN") { staged = clone(stored.state); stagedMarker=clone(stored.marker); pendingEffects = 0; }
        if (text === "COMMIT") { stored.state = clone(staged); stored.marker=clone(stagedMarker); committedEffects += pendingEffects; }
        if (text === "ROLLBACK") { staged = clone(stored.state); stagedMarker=clone(stored.marker); pendingEffects = 0; }
        if (text.includes("pg_try_advisory")) return { rows: [{ locked: true }], rowCount: 1 };
        if (text.includes("current_database()")) return { rows: [{ database: target.database, schema_name: target.schema, generation_id: target.generation,
          fingerprint: target.schemaSha256, server_address: target.serverAddress, server_port: target.serverPort, system_identifier: target.systemIdentifier }], rowCount: 1 };
        if (text.includes("relpersistence")) return { rows: [{ relkind: "r", relpersistence: "p" }], rowCount: 1 };
        if (text.includes("SELECT revision,state")) return { rows: [{ revision: String(staged!.revision), state: clone(staged) }], rowCount: 1 };
        if(text.includes("SELECT marker_sha256,marker"))return syntheticMarkerRows(stagedMarker);
        if(text.includes("INSERT INTO")&&text.includes("migration_cutover_first_write_markers")){const value=values?.[2];if(typeof value!=="string")throw new Error("Missing marker JSON");if(stagedMarker!==null)return{rows:[],rowCount:0};stagedMarker=JSON.parse(value) as FirstPostgresWriteMarkerV2;return{rows:[{source_key:stagedMarker.sourceKey}],rowCount:1};}
        if (text.includes("INSERT INTO")) { staged = JSON.parse(values![2] as string) as DurableCutoverState; return { rows: [{ revision: staged.revision }], rowCount: 1 }; }
        if (text === "FIXTURE_MUTABLE_WRITE") pendingEffects++;
        return { rows: [], rowCount: 0 };
      }, release() {} }; } }, { statementTimeoutMs: 10_000, lockTimeoutMs: 1000 }).run(operation);
    } };
    const store = createMigrationRuntimeCutoverTransitionStore({ runtime, statementTimeoutMs: 10_000, lockTimeoutMs: 1000, target, clock: () => at() });
    const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => at() });
    const result = coordinator.execute(f.command("first-postgres-write", 2), f.bundle, { write: async transaction => {
      for (let i = 0; i < 1200; i++) await transaction.query("FIXTURE_MUTABLE_WRITE");
      return clone(firstWrite);
    } });
    if (succeeds) {
      await expect(result).resolves.toMatchObject({ phase: "postgres-written" });
      expect(committedEffects).toBe(1200); expect(stored.state!.firstPostgresWrite).not.toBeNull();
      expect(stored.state!.journal).toHaveLength(3); expect(sql.filter(statement => statement === "COMMIT")).toHaveLength(1);
    } else {
      await expect(result).rejects.toThrow("SQL_STATEMENT_BUDGET_EXCEEDED");
      expect(committedEffects).toBe(0); expect(stored.state).toEqual(before);
      expect(sql).toContain("ROLLBACK"); expect(sql).not.toContain("COMMIT");
    }
    expect(sql.filter(statement => statement === "BEGIN")).toHaveLength(1);
    expect(f.policy.budgets.maximumSqlStatements).toBe(limit);
  });
});

describe("explicit 60-second first-write deadline with injected clocks", () => {
  function fixtureForSixtySeconds() {
    const f = fixture();
    f.policy.deadlines.windowEnd = at(120_000);
    f.policy.deadlines.maximumEvidenceAgeMs = 300_000;
    f.policy.deadlines.maximumOperationMs = 60_000;
    f.policy.budgets.maximumSqlStatements = 10_000;
    f.bundle.observations.capacity.body.budgetSha256 = migrationCutoverDigest(f.policy.budgets);
    f.bundle.observations.fence.body.validUntil = at(90_000);
    for (const report of Object.values(f.bundle.observations)) report.expiresAt = at(90_000);
    f.compatibilityProof.attestation.expiresAt=at(90_000);
    f.compatibilityProof.attestation.signatureBase64=sign(null,Buffer.from(migrationCompatiblePostgresRollbackPayload(f.compatibilityProof)),fixtureIndependentKeys.privateKey).toString("base64");
    f.resignAll();
    return f;
  }
  it("accepts an explicit 60000ms ceiling and rejects larger or coercive operation budgets", () => {
    const f = fixtureForSixtySeconds(); expect(f.evaluation().preparationReady).toBe(true);
    for (const invalid of [60_001, "60000", true]) {
      f.policy.deadlines.maximumOperationMs = invalid as number;
      expect(f.evaluation().preparationReady).toBe(false);
    }
  });
  async function timedFirstWrite(elapsedMs: number, lateCommit = false) {
    const f = fixtureForSixtySeconds(), persisted = new FixtureStore(), target = f.policy.binding.target;
    const preparation = createMigrationCutoverCoordinator({ expected: f.policy, store: persisted, clock: () => at() });
    await preparation.execute(f.command("prepare", 0), f.bundle); await preparation.execute(f.command("select-postgres", 1), f.bundle);
    const before = clone(persisted.state), sql: string[] = [];
    let clock = at(), staged = clone(persisted.state), stagedMarker=clone(persisted.marker), stagedEffects = 0, effects = 0;
    // Deterministic deadline simulation, not real PG latency or an approved production window.
    const runtime = { run<T>(operation: (transaction: PostgresTransaction) => Promise<T>) {
      return createPostgresUnitOfWork({ async connect() { return { async query(text: string, values?: unknown[]) {
        sql.push(text);
        if (text === "BEGIN") { staged = clone(persisted.state); stagedMarker=clone(persisted.marker); stagedEffects = 0; }
        if (text === "COMMIT") { persisted.state = clone(staged); persisted.marker=clone(stagedMarker); effects += stagedEffects; if (lateCommit) clock = at(60_000); }
        if (text === "ROLLBACK") { staged = clone(persisted.state); stagedMarker=clone(persisted.marker); stagedEffects = 0; }
        if (text.includes("pg_try_advisory")) return { rows: [{ locked: true }], rowCount: 1 };
        if (text.includes("current_database()")) return { rows: [{ database: target.database, schema_name: target.schema, generation_id: target.generation,
          fingerprint: target.schemaSha256, server_address: target.serverAddress, server_port: target.serverPort, system_identifier: target.systemIdentifier }], rowCount: 1 };
        if (text.includes("relpersistence")) return { rows: [{ relkind: "r", relpersistence: "p" }], rowCount: 1 };
        if (text.includes("SELECT revision,state")) return { rows: [{ revision: String(staged!.revision), state: clone(staged) }], rowCount: 1 };
        if(text.includes("SELECT marker_sha256,marker"))return syntheticMarkerRows(stagedMarker);
        if(text.includes("INSERT INTO")&&text.includes("migration_cutover_first_write_markers")){const value=values?.[2];if(typeof value!=="string")throw new Error("Missing marker JSON");if(stagedMarker!==null)return{rows:[],rowCount:0};stagedMarker=JSON.parse(value) as FirstPostgresWriteMarkerV2;return{rows:[{source_key:stagedMarker.sourceKey}],rowCount:1};}
        if (text.includes("INSERT INTO")) { staged = JSON.parse(values![2] as string) as DurableCutoverState; return { rows: [{ revision: staged.revision }], rowCount: 1 }; }
        if (text === "FIXTURE_LONG_COHORT_WRITE") { clock = at(elapsedMs); stagedEffects++; }
        return { rows: [], rowCount: 0 };
      }, release() {} }; } }, { statementTimeoutMs: 30_000, lockTimeoutMs: 1000 }).run(operation);
    } };
    const store = createMigrationRuntimeCutoverTransitionStore({ runtime, target, clock: () => clock, statementTimeoutMs: 30_000, lockTimeoutMs: 1000 });
    const coordinator = createMigrationCutoverCoordinator({ expected: f.policy, store, clock: () => clock });
    const command = f.command("first-postgres-write", 2);
    command.deadline = at(60_000); command.authorization.expiresAt = at(60_000); f.authorize(command);
    const execute = () => coordinator.execute(command, f.bundle, { write: async transaction => {
      await transaction.query("FIXTURE_LONG_COHORT_WRITE"); return clone(firstWrite);
    } });
    return { execute, coordinator, command, persisted, before, sql, effects: () => effects };
  }
  it.each([[59_999, true], [60_000, false], [60_001, false]] as const)("enforces elapsed %ims without splitting marker from rows", async (elapsed, succeeds) => {
    const q = await timedFirstWrite(elapsed);
    if (succeeds) {
      await expect(q.execute()).resolves.toMatchObject({ phase: "postgres-written" });
      expect(q.effects()).toBe(1); expect(q.persisted.state!.firstPostgresWrite).not.toBeNull(); expect(q.persisted.state!.journal).toHaveLength(3);
      expect(q.sql.filter(sql => sql === "COMMIT")).toHaveLength(1);
    } else {
      await expect(q.execute()).rejects.toThrow("OPERATION_DEADLINE_EXCEEDED");
      expect(q.persisted.state).toEqual(q.before); expect(q.effects()).toBe(0); expect(q.sql).toContain("ROLLBACK"); expect(q.sql).not.toContain("COMMIT");
    }
    expect(q.sql.filter(sql => sql === "BEGIN")).toHaveLength(1);
  });
  it("treats a commit acknowledged at the deadline as unknown and reconciles instead of replaying import", async () => {
    const q = await timedFirstWrite(59_999, true);
    await expect(q.execute()).rejects.toBeInstanceOf(CutoverCommitUnknownError);
    expect(q.effects()).toBe(1); expect(q.persisted.state!.firstPostgresWrite).not.toBeNull();
    await expect(q.coordinator.reconcile(q.command, at(70_000))).resolves.toMatchObject({ outcome: "committed" });
    expect(q.effects()).toBe(1); expect(q.persisted.state!.journal).toHaveLength(3);
  });
});

// Census fixtures invoke no host commands, SSH, production services or database connections.
describe("bounded nonmutating writer census completeness", () => {
  function policy(): WriterCensusPolicy {
    return { version: 1, host: "fixture-host", sourceFiles: ["/fixture/source.sqlite", "/fixture/source.sqlite-wal", "/fixture/source.sqlite-shm"],
      users: ["address-radar"], units: [...CUTOVER_SERVICES, ...CUTOVER_TIMERS].map(unit => ({ unit, owner: null, writerId: unit })),
      cronLines: [], operatorSessions: [], processCommands: [{ command: "node", writerId: "fixture-scanner" }],
      inputs: [{ id: "deployment-admission", kind: "deploy", unit: "address-radar-migrate.service" }, { id: "external-bridge", kind: "external", unit: "address-radar-fomo-verification-sync.service" }],
      limits: { maximumCommands: 32, commandTimeoutMs: 1000, operationTimeoutMs: 15_000, maximumOutputBytes: 8192 } };
  }
  const result = (stdout = "", stderr = "", exitCode: number | null = 0, error: WriterCensusCommandResult["error"] = null): WriterCensusCommandResult => ({ stdout, stderr, exitCode, error });
  async function scan(overrides: Record<string, WriterCensusCommandResult> = {}, p = policy()) {
    const commands: WriterCensusCommand[] = [];
    const report = await collectWriterCensus(p, { clock: () => epoch, async execute(command) {
      commands.push(command);
      if (overrides[command.id]) return overrides[command.id]!;
      if (command.id === "host") return result("fixture-host\n");
      if (command.id === "system-live") return result(p.units.filter(unit => unit.owner === null).map(unit => `${unit.unit} loaded inactive dead fixture`).join("\n"));
      if (command.id === "system-files") return result(p.units.filter(unit => unit.owner === null).map(unit => `${unit.unit} disabled`).join("\n"));
      if (command.id === "source-handles") return result("", "", 1);
      return result();
    } });
    return { report, commands };
  }
  it("retains approved scopes but never treats current reads as a fence or authorization", async () => {
    const { report, commands } = await scan();
    expect(report).toMatchObject({ readOnly: true, coverage: "configured-scopes-only", censusComplete: false, fenceEstablished: false, preparationReady: false, writeAuthorized: false, activationEnabled: false });
    expect(report.blockers).toContain("READ_ONLY_CENSUS_NOT_A_FENCE");
    expect(report.observations.filter(observation => ["deploy", "external"].includes(observation.surface)).map(observation => observation.status)).toEqual(["unknown", "unknown"]);
    expect(commands.some(command => command.executable === "sudo" && command.args.includes("address-radar") && command.args.includes("crontab"))).toBe(true);
    expect(commands.some(command => command.args.includes("list-timers") && command.args.includes("--user"))).toBe(true);
    expect(commands.some(command => command.args.includes("stop") || command.args.includes("restart"))).toBe(false);
  });
  it.each([
    ["empty-success", result(), "absent"],
    ["explicit-no-crontab", result("", "no crontab for address-radar\n", 1), "absent"],
    ["denied", result("", "permission denied", 1), "denied"],
    ["sudo-denied", result("", "sudo: a password is required", 1), "denied"],
    ["missing-command", result("", "", null, "not-found"), "unavailable"],
    ["not-available-stderr", result("", "not_available", 1), "unavailable"],
    ["not-available-stdout", result("not_available\n"), "unavailable"],
    ["unknown-error", result("", "unrecognized failure", 1), "unknown"],
  ] as const)("distinguishes cron %s without turning failures into absence", async (_name, observation, expected) => {
    const { report } = await scan({ "cron:address-radar": observation });
    expect(report.observations.find(observation => observation.id === "cron:address-radar")!.status).toBe(expected);
    if (expected !== "absent") expect(report.blockers).toContain(`INCOMPLETE:cron:address-radar:${expected}`);
  });
  it("treats a clean lsof empty match as absent, not a missing-command or permission success", async () => {
    const { report } = await scan();
    expect(report.observations.find(observation => observation.id === "source-handles")!.status).toBe("absent");
    expect(report.blockers).not.toContain("INCOMPLETE:source-handles:unknown");
    for (const failure of [result("", "permission denied", 1), result("", "", null, "not-found")]) {
      expect((await scan({ "source-handles": failure })).report.observations.find(observation => observation.id === "source-handles")!.status).not.toBe("absent");
    }
  });
  it("flags additional active and scheduled writers, including user timers", async () => {
    const { report } = await scan({ "system-timers": result("Sun 2026-10-04 unknown-backup.timer unknown-backup.service\n"),
      "user-files:address-radar": result("hidden-writer.timer enabled\n"), "user-timers:address-radar": result("Sun 2026-10-04 hidden-writer.timer hidden-writer.service\n") });
    expect(report.blockers).toContain("UNKNOWN_UNIT_OR_SCHEDULED_WRITER:system:unknown-backup.timer");
    expect(report.blockers).toContain("UNKNOWN_UNIT_OR_SCHEDULED_WRITER:address-radar:hidden-writer.timer");
    expect(report.censusComplete).toBe(false);
  });
  it("compares approved cron line hashes while never logging command credentials", async () => {
    const line = "* * * * * TOKEN=supersecret /fixture/bridge --password=privatevalue";
    const p = policy(); p.cronLines.push({ owner: "address-radar", lineSha256: censusFixtureHash(line), writerId: "fixture-bridge" });
    const { report } = await scan({ "cron:address-radar": result(line + "\n") }, p);
    const cron = report.observations.find(observation => observation.id === "cron:address-radar")!;
    expect(cron.entries[0]!.status).toBe("present"); expect(cron.raw.stdoutSha256).toBe(censusFixtureHash(line + "\n"));
    expect(JSON.stringify(report)).not.toMatch(/supersecret|privatevalue/);
    const extra = (await scan({ "cron:address-radar": result(line + "\n") })).report;
    expect(extra.blockers).toContain("UNKNOWN_CRON_WRITER:address-radar");
  });
  it("does not leak rejected cron command text from stderr", async () => {
    const { report } = await scan({ "cron:address-radar": result("", "command failed: opaqueSensitiveValue", 1) });
    expect(JSON.stringify(report)).not.toContain("opaqueSensitiveValue");
  });
  it.each(["w", "u"])("identifies unknown writable source handle %s without process argv or broad scans", async access => {
    const { report, commands } = await scan({ "source-handles": result(`p500\ncunknown-writer\nf3\na${access}\nn/fixture/source.sqlite\n`) });
    expect(report.blockers).toContain("UNKNOWN_WRITABLE_SOURCE_HANDLE");
    expect(report.blockers).toContain("OBSERVED_WRITABLE_SOURCE_HANDLE");
    expect(commands.find(command => command.id === "source-handles")!.args.slice(-3)).toEqual(policy().sourceFiles);
  });
  it("keeps unprovable handle access and unknown operator sessions incomplete", async () => {
    const { report } = await scan({ "source-handles": result("p500\ncnode\nf3\nn/fixture/source.sqlite\n"), "operator-sessions": result("9 1000 address-radar pts/0\n") });
    expect(report.blockers).toContain("UNKNOWN_OR_UNVERIFIABLE_SOURCE_HANDLE"); expect(report.blockers).toContain("UNKNOWN_OPERATOR_SESSION");
  });
  it("fails closed on truncated output, missing permissions and unsupported user buses", async () => {
    const { report } = await scan({ "system-live": result("", "", null, "output-limit"), "user-live:address-radar": result("", "Failed to connect to bus", 1) });
    expect(report.observations.find(observation => observation.id === "system-live")!.status).toBe("unavailable");
    expect(report.observations.find(observation => observation.id === "user-live:address-radar")!.status).toBe("unavailable");
    expect(report.censusComplete).toBe(false);
  });
  it("enforces total command and clock budgets without running remaining commands", async () => {
    const p = policy(); p.limits.maximumCommands = 2;
    expect((await scan({}, p)).commands).toHaveLength(2);
    let clock = epoch, calls = 0;
    const report = await collectWriterCensus(policy(), { clock: () => clock, async execute() { calls++; clock += 15_000; return result(); } });
    expect(calls).toBe(1); expect(report.blockers).toContain("CENSUS_OPERATION_DEADLINE_EXCEEDED"); expect(report.censusComplete).toBe(false);
  });
  it("requires scoped migration/oneshot/timer/user inputs and refuses shell-injection policy", () => {
    const p = policy(); p.units = p.units.filter(unit => unit.unit !== "address-radar-migrate.service");
    expect(() => validateWriterCensusPolicy(p)).toThrow("Incomplete approved writer unit scope");
    const user = policy(); user.users = ["root"]; expect(() => validateWriterCensusPolicy(user)).toThrow();
    const command = policy(); command.users.push("user;touch /tmp/unsafe"); expect(() => validateWriterCensusPolicy(command)).toThrow();
    const files = policy(); files.sourceFiles[0] = "/fixture/../etc/shadow"; expect(() => validateWriterCensusPolicy(files)).toThrow();
    const limits = policy(); limits.limits.operationTimeoutMs = 30001; expect(() => validateWriterCensusPolicy(limits)).toThrow();
  });
});


describe("native census executor cannot be repurposed for writes", () => {
  it.each([
    ["systemctl", ["stop", "address-radar-scanner.service"]],
    ["sudo", ["-n", "-u", "root", "crontab", "-r"]],
    ["loginctl", ["terminate-user", "address-radar"]],
    ["hostname", ["new-hostname"]],
    ["lsof", ["-nP", "/proc"]],
    ["rm", ["/fixture/source.sqlite"]],
  ] as const)("rejects mutating or unscoped executable %s before spawning any child", async (executable, args) => {
    await expect(executeWriterCensusCommand({ id: "fixture-denied-command", executable, args, timeoutMs: 1000, maximumOutputBytes: 8192 } as WriterCensusCommand))
      .rejects.toThrow("Read-only census command required");
  });
});


describe("corrected bounded child-holder census", () => {
  const source = ["/fixture/source.sqlite", "/fixture/source.sqlite-wal", "/fixture/source.sqlite-shm"];
  const fixture = () => ({version:1, sourceFiles:[...source], bounds:{maximumProcesses:128,maximumFdsPerProcess:256,maximumTotalFds:4096,maximumCgroups:64,maximumTasks:32,maximumElapsedMs:2000},
    sourceMetadata:source.map((path,index)=>({path,status:"present",device:"1",inode:String(10+index),mode:"regular",resolvedPath:path})),
    processes:[{pid:100,ppid:1,uid:1000,command:"node",startTimeTicks:"1",units:["address-radar-scanner.service"],status:"absent",fdsExamined:4,handles:[]},
      {pid:101,ppid:100,uid:1000,command:"node",startTimeTicks:"2",units:["address-radar-scanner.service"],status:"present",fdsExamined:5,
      handles:[{fd:3,path:source[0],device:"1",inode:"10",flagsOctal:"0100002",matchedBy:"path-and-inode"}]}], errors:[],truncated:false,sourceChanged:false,elapsedMs:4});
  it("retains structured live units, timer boundary fields and operator identities", async () => {
    const module = await import("../../../scripts/check-migration-writer-fence.js");
    const parse = (module as any).parseWriterCensusListing;
    expect(typeof parse).toBe("function");
    expect(parse("units","address-radar-scanner.service loaded active running hidden-secret-description\n")).toEqual([{unit:"address-radar-scanner.service",load:"loaded",active:"active",sub:"running"}]);
    const timers=parse("timers","Sun 2026-10-04 06:30:00 UTC 5min Sun 2026-10-04 06:20:00 UTC 5min ago address-radar-backup.timer address-radar-backup.service\n");
    expect(timers[0]).toMatchObject({unit:"address-radar-backup.timer",activates:"address-radar-backup.service"});
    expect(timers[0].boundary).toContain("06:30:00");
    expect(parse("sessions","9 1000 ubuntu seat0 pts/0\n")).toEqual([{session:"9",uid:"1000",owner:"ubuntu",seat:"seat0",tty:"pts/0"}]);
    expect(JSON.stringify(parse("units","address-radar-scanner.service loaded active running token=do-not-publish"))).not.toContain("do-not-publish");
  });
  it("distinguishes parent no handles from child writable DB and retains actual flags/inode", async () => {
    const module = await import("../../../scripts/check-migration-writer-fence.js");
    const parsed=(module as any).parseWriterProcessCensus(JSON.stringify(fixture()),source);
    expect(parsed.processes[0]).toMatchObject({pid:100,status:"absent",handles:[]});
    expect(parsed.processes[1].handles[0]).toMatchObject({flagsOctal:"0100002",inode:"10",access:"read-write",writable:true});
    expect(parsed.sourceMetadata[0]).toMatchObject({path:source[0],device:"1",inode:"10"});
  });
  it.each(["denied","unavailable","unknown"])("retains per-process %s errors, never turning them into no-handles", async status => {
    const module = await import("../../../scripts/check-migration-writer-fence.js");
    const f=fixture();
    const parent=f.processes[0];
    if (parent === undefined) throw new Error("Fixture requires a parent process");
    parent.status=status;
    const withError={...f,errors:[...f.errors,{operation:"fd-list",pid:100,status,errno:13}]};
    const parsed=(module as any).parseWriterProcessCensus(JSON.stringify(withError),source);
    expect(parsed.processes[0].status).toBe(status);expect(parsed.errors[0].errno).toBe(13);
  });
  it.each(["truncated","sourceChanged"])("retains %s as an explicit incompleteness condition", async field => {
    const module = await import("../../../scripts/check-migration-writer-fence.js");
    const f=fixture();(f as any)[field]=true;
    expect((module as any).parseWriterProcessCensus(JSON.stringify(f),source)[field]).toBe(true);
  });
  it.each(["flags","scope","pid","bound"])("rejects fabricated/coerced kernel metadata: %s", async kind => {
    const module = await import("../../../scripts/check-migration-writer-fence.js");const f=fixture();
    if(kind==="flags")f.processes[1]!.handles[0]!.flagsOctal="0100002junk";
    if(kind==="scope")f.sourceFiles[0]="/etc/shadow";
    if(kind==="pid")(f.processes[0] as any).pid="100";
    if(kind==="bound")f.bounds.maximumProcesses=129;
    expect(()=>(module as any).parseWriterProcessCensus(JSON.stringify(f),source)).toThrow();
  });
  it("rejects arbitrary Python and unscoped PID/cgroup readers before spawn", async () => {
    await expect(executeWriterCensusCommand({id:"bad-python",executable:"sudo",args:["-n","python3","-c","print('untrusted')","{}"],timeoutMs:1000,maximumOutputBytes:8192})).rejects.toThrow("Read-only census command required");
  });
});


describe("fixed native kernel reader", () => {
  it("allows only the exact bounded read script with explicit source and roots", async () => {
    const {WRITER_PROCESS_CENSUS_PYTHON}=await import("../../../scripts/check-migration-writer-fence.js");
    const output=await executeWriterCensusCommand({id:"fixture-kernel-reader",executable:"sudo",args:["-n","python3","-c",WRITER_PROCESS_CENSUS_PYTHON,JSON.stringify({files:["/fixture/source.sqlite","/fixture/source.sqlite-wal","/fixture/source.sqlite-shm"],roots:[]})],timeoutMs:1000,maximumOutputBytes:8192});
    expect(output).toHaveProperty("exitCode");
  });
});

describe("live adapter failure does not erase independent structured observations", () => {
  it("keeps units/timers/operators and source stat even when lsof fails", async () => {
    const sourceFiles=["/fixture/source.sqlite","/fixture/source.sqlite-wal","/fixture/source.sqlite-shm"];
    const policy: WriterCensusPolicy={version:1,host:"fixture-host",sourceFiles,users:["address-radar"],units:[...CUTOVER_SERVICES,...CUTOVER_TIMERS].map(unit=>({unit,owner:null,writerId:unit})),cronLines:[],operatorSessions:[],processCommands:[],inputs:[{id:"deploy",kind:"deploy",unit:null},{id:"external",kind:"external",unit:null}],limits:{maximumCommands:32,commandTimeoutMs:1000,operationTimeoutMs:15000,maximumOutputBytes:8192}};
    const {WRITER_PROCESS_CENSUS_BOUNDS}=await import("../../../scripts/check-migration-writer-fence.js");
    const report=await collectWriterCensus(policy,{clock:()=>epoch,execute:async command=>({stdout:command.id==="host"?"fixture-host":command.id==="system-live"?"address-radar-scanner.service loaded active running redacted-description":command.id==="system-timers"?"Sun 2026-10-04 06:00:00 UTC 2s ago address-radar-backup.timer address-radar-backup.service":command.id==="operator-sessions"?"9 1000 address-radar - -":command.id==="known-unit-pids"?CUTOVER_SERVICES.map(unit=>`Id=${unit}\nMainPID=0\nActiveState=inactive\nSubState=dead\nControlGroup=`).join("\n\n"):command.id==="process-census"?JSON.stringify({version:1,sourceFiles,bounds:WRITER_PROCESS_CENSUS_BOUNDS,sourceMetadata:sourceFiles.map((path,index)=>({path,status:"present",device:"1",inode:String(index+1),mode:"regular",resolvedPath:path})),processes:[],errors:[],truncated:false,sourceChanged:false,elapsedMs:1}):"",stderr:command.id==="source-handles"?"permission denied":"",exitCode:command.id==="source-handles"?1:0,error:null})});
    expect(report.observations.find(o=>o.id==="system-live")!.metadata).toEqual([{unit:"address-radar-scanner.service",load:"loaded",active:"active",sub:"running"}]);
    expect(report.observations.find(o=>o.id==="operator-sessions")!.metadata).toEqual([{session:"9",uid:"1000",owner:"address-radar",seat:"-",tty:"-"}]);
    expect(report.observations.find(o=>o.id==="process-census")!.metadata).toMatchObject({sourceMetadata:[{path:sourceFiles[0],device:"1",inode:"1"},{path:sourceFiles[1],device:"1",inode:"2"},{path:sourceFiles[2],device:"1",inode:"3"}]});
    expect(report.observations.find(o=>o.id==="source-handles")!.status).toBe("denied");
    expect(report).toMatchObject({censusComplete:false,fenceEstablished:false,writeAuthorized:false,activationEnabled:false});
  });
});


function syntheticCompatibleProof(policy:WriterFencePolicy):CompatiblePostgresReleaseProof {
  const catalog=policy.postgresRollbackCatalog,verifier=policy.postgresRollbackVerifier;
  if(!catalog||!verifier)throw new Error("Synthetic fixture requires explicit compatibility catalog/verifier");
  const proof:CompatiblePostgresReleaseProof={version:2,binding:clone(policy.binding),strategy:"compatible-postgres-release",recoveryMode:"retain-live-postgres-data",backend:"postgres",candidate:clone(policy.binding.target),compatible:clone(policy.binding.rollbackTarget),candidateArtifactSha256:policy.binding.target.releaseSha256,compatibleArtifactSha256:policy.binding.rollbackTarget.releaseSha256,catalogSha256:migrationCutoverDigest(catalog),schemaProbeSha256:hash(),mutationTraceSha256:hash(),parentTransactionRollbackReceiptSha256:hash(),commitUnknownReconciliationReceiptSha256:hash(),providerGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="provider")),deliveryGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="delivery")),startedAt:at(-14000),firstWriteAt:at(-13000),completedAt:at(-7000),tableChecks:catalog.map(e=>({table:e.table,retainedRows:"9007199254740993",recoveredRows:"9007199254740993",retainedSha256:hash(),recoveredSha256:hash(),cases:e.operations.map(operation=>({operation,committedReceiptSha256:hash(),compatibleReadReceiptSha256:hash(),compatibleWriteReceiptSha256:hash()}))})),guardChecks:POSTGRES_COMPATIBILITY_GUARD_CHECKS.map(check=>({check,receiptSha256:hash()})),attestation:{...verifier,observedAt:at(-6000),expiresAt:at(30000),provenance:{hostId:policy.hostId,bootId:policy.bootId,collectorSha256:hash("9"),runId:"fixture-independent-run",sequence:"1",challengeId:policy.challengeId},signatureBase64:""}};
  proof.attestation.signatureBase64=sign(null,Buffer.from(migrationCompatiblePostgresRollbackPayload(proof)),fixtureIndependentKeys.privateKey).toString("base64");
  return proof;
}
function syntheticSeal<T>(kind:"authorization"|"census"|"snapshot"|"rollback",payload:T):FenceClosureSigned<T>{return{payload,signatureBase64:sign(null,fenceClosureSigningMessage(kind,payload),kind==="rollback"?fixtureIndependentKeys.privateKey:keys.privateKey).toString("base64")};}
function fixtureString(value:unknown):string{if(typeof value!=="string")throw new Error("Synthetic evidence requires a literal string");return value;}
function refreshSyntheticClosure(policy:WriterFencePolicy,bundle:WriterFenceBundle):void {
  const scopes:FenceClosureScope[]=policy.writers.map(w=>({id:w.id,kind:w.kind==="services"?"service":w.kind==="timers"?"timer":w.kind==="operators"?"operator":w.kind==="usercron"?"cron":w.kind==="deploy"?"deploy":w.id==="fixture-bridge"?"bridge":"external-input",paths:w.id==="fixture-bridge"?["/fixture/input","/fixture/output"]:[policy.binding.source.canonicalPath],directions:w.id==="fixture-bridge"?["source-to-input","output-to-source"]:[]}));
  const binding={sourcePath:policy.binding.source.canonicalPath,sourceDevice:policy.binding.source.device,sourceInode:policy.binding.source.inode,generation:policy.binding.generation,watermark:policy.binding.watermark,cluster:policy.binding.target.systemIdentifier,schemaSha256:policy.binding.target.schemaSha256,release:policy.binding.target.releaseSha256,artifactSha256:policy.binding.target.releaseSha256,cohortSha256:migrationCutoverDigest({cohortId:policy.binding.cohortId},2),providerGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="provider")),deliveryGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="delivery"))};
  const pem=keys.publicKey.export({type:"spki",format:"pem"}).toString();
  policy.closureTrust={authorizationPublicKeyPem:pem,observerPublicKeyPem:pem,snapshotPublicKeyPem:pem,independentCompatibilityPublicKeyPem:fixtureIndependentKeys.publicKey.export({type:"spki",format:"pem"}).toString(),expectedBinding:binding,expectedScopesSha256:fenceClosureEvidenceSha256(scopes),expectedTableNames:[...policy.catalog],expectedRollbackRelease:policy.binding.rollbackTarget.releaseSha256,expectedRollbackArtifactSha256:policy.binding.rollbackTarget.releaseSha256,maximumEvidenceAgeMs:policy.deadlines.maximumEvidenceAgeMs,maximumMaintenanceWindowMs:Date.parse(policy.deadlines.windowEnd)-Date.parse(policy.deadlines.windowStart)};
  const authorization={binding,scopes,windowStart:policy.deadlines.windowStart,windowEnd:policy.deadlines.windowEnd,maximumSqlStatements:policy.budgets.maximumSqlStatements,maximumTransactionMs:policy.deadlines.maximumOperationMs};
  const census={authorizationSha256:fenceClosureEvidenceSha256(authorization),observedAt:bundle.observations.census.observedAt,fencedAt:fixtureString(bundle.observations.fence.body.enforcedAt),scopes:scopes.map(s=>({id:s.id,admission:"closed" as const,controlReceiptSha256:hash(),closedUntil:policy.deadlines.windowEnd,processIds:[],timer:s.kind==="timer"?"disabled-no-pending-trigger" as const:"not-applicable" as const,bridgeDirections:[...s.directions],cursorReceiptSha256:s.kind==="bridge"?hash():null})),processes:[],discoveredScopeIds:scopes.map(s=>s.id),sourceDevice:binding.sourceDevice,sourceInode:binding.sourceInode,sourcePath:binding.sourcePath,generation:binding.generation,watermark:binding.watermark};
  const rawTables=bundle.observations.snapshot.body.tables;if(!Array.isArray(rawTables))throw new Error("Synthetic snapshot tables required");
  const tables=rawTables.map((entry:Record<string,unknown>)=>({name:fixtureString(entry.table),rowCount:fixtureString(entry.rows),sha256:fixtureString(entry.sha256)}));
  const parity=migrationCutoverDigest(bundle.observations.parity.body);
  const snapshot={authorizationSha256:fenceClosureEvidenceSha256(authorization),censusSha256:fenceClosureEvidenceSha256(census),binding,kind:"final-full-fenced" as const,startedAt:fixtureString(bundle.observations.snapshot.body.startedAt),completedAt:fixtureString(bundle.observations.snapshot.body.completedAt),tableCensusSha256:fenceClosureEvidenceSha256(tables),tables,parityReceiptSha256:parity,restoreReceiptSha256:hash()};
  const proof=bundle.observations.rehearsal.body.compatibleRelease;
  const completed=proof===undefined?fixtureString((bundle.observations.rehearsal.body.after as Record<string,unknown>).completedAt):fixtureString((proof as Record<string,unknown>).completedAt);
  const rollback={authorizationSha256:fenceClosureEvidenceSha256(authorization),binding,route:proof===undefined?"source-before-first-write" as const:"compatible-postgres-release" as const,completedAt:completed,parityReceiptSha256:parity,rollbackRelease:proof===undefined?null:policy.binding.rollbackTarget.releaseSha256,rollbackArtifactSha256:proof===undefined?null:policy.binding.rollbackTarget.releaseSha256,compatibilityTestReceiptSha256:proof===undefined?null:migrationCutoverDigest(proof,2),preservedProviderGuardSha256:binding.providerGuardSha256,preservedDeliveryGuardSha256:binding.deliveryGuardSha256};
  bundle.closure={authorization:syntheticSeal("authorization",authorization),census:syntheticSeal("census",census),snapshot:syntheticSeal("snapshot",snapshot),rollback:syntheticSeal("rollback",rollback)};
}
function syntheticMarkerRows(marker:FirstPostgresWriteMarkerV2|null):{rows:Record<string,unknown>[];rowCount:number}{return marker===null?{rows:[],rowCount:0}:{rows:[{marker_sha256:migrationCutoverDigest(marker,2),marker:clone(marker)}],rowCount:1};}


describe("mandatory V2 closure/native marker and retained V1 audit",()=>{
  const startup=(p:ReturnType<typeof protocol>)=>verifyCommittedPostgresWriterStartup({expected:p.policy,runtime:{target:p.policy.binding.target,cohortId:p.policy.binding.cohortId},store:p.store,clock:()=>at(),deadline:at(10000)});
  it("binds full V2 closure into the plan, signed preparation and same-commit immutable marker",async()=>{
    const p=protocol();await p.prepare();await p.select();await p.coordinator.execute(p.command("first-postgres-write",2),p.bundle,{write:p.write});
    const state=p.store.state,marker=p.store.marker;if(!state||!marker)throw new Error("Missing committed fixture state/marker");
    expect(state.version).toBe(2);expect(state.preparation.closure).toEqual(p.bundle.closure);
    expect(state.planSha256).toBe(migrationCutoverPlanDigest(p.policy,p.bundle));
    expect(state.planSha256).not.toBe(migrationCutoverDigest({policy:p.policy,bundle:p.bundle}));
    expect(state.journal.every(j=>j.command.version===2&&j.requestSha256===migrationCutoverDigest(j.command,2))).toBe(true);
    expect(marker).toMatchObject({version:2,sourceKey:p.store.scopes[0]?.sourceKey,policySha256:migrationCutoverDigest(p.policy,2),planSha256:state.planSha256,bindingSha256:migrationCutoverDigest(p.policy.binding,2),cohortId:p.policy.binding.cohortId,generation:p.policy.binding.generation,...firstWrite});
    expect(await startup(p)).toMatchObject({protocolVersion:2,phase:"postgres-written",closureSha256:migrationCutoverDigest(state.preparation.closure,2),writeAuthorized:false,activationEnabled:false});
  });
  it("rejects missing signed closure before selection and again on restart",async()=>{
    const f=fixture(),store=new FixtureStore();delete f.bundle.closure;
    const coordinator=createMigrationCutoverCoordinator({expected:f.policy,store,clock:()=>at()});
    await expect(coordinator.execute(f.command("prepare",0),f.bundle)).rejects.toThrow("UNKNOWN_OR_MISSING_FIELDS");expect(store.state).toBeNull();
    const p=protocol();await p.prepare();await p.select();if(!p.store.state)throw new Error("Missing fixture state");delete p.store.state.preparation.closure;
    await expect(startup(p)).rejects.toThrow("UNKNOWN_OR_MISSING_FIELDS");
  });
  it("does not accept phase from submitted closure or config",async()=>{
    const f=fixture(),store=new FixtureStore();if(!f.bundle.closure)throw new Error("Missing fixture closure");Object.assign(f.bundle.closure,{phase:"after-first-pg-write"});
    const coordinator=createMigrationCutoverCoordinator({expected:f.policy,store,clock:()=>at()});
    await expect(coordinator.execute(f.command("prepare",0),f.bundle)).rejects.toThrow("UNKNOWN_OR_MISSING_FIELDS");expect(store.marker).toBeNull();
  });
  it("requires PG-compatible closure before invoking a first-write callback",async()=>{
    const p=protocol();const closure=p.bundle.closure;if(!closure)throw new Error("Missing fixture closure");
    const payload={...closure.rollback.payload,route:"source-before-first-write" as const,rollbackRelease:null,rollbackArtifactSha256:null,compatibilityTestReceiptSha256:null};
    closure.rollback=syntheticSeal("rollback",payload);await p.prepare();await p.select();let calls=0;
    await expect(p.coordinator.execute(p.command("first-postgres-write",2),p.bundle,{write:async tx=>{calls++;return p.write(tx);}})).rejects.toThrow("FIRST_WRITE_COMPATIBLE_ROLLBACK_REQUIRED");
    expect(calls).toBe(0);expect(p.store.marker).toBeNull();expect(p.store.effects).toEqual([]);
  });
  it.each(["missing","generation","cohort","plan","receipt"])("rejects committed marker %s without replaying rows",async kind=>{
    const p=protocol();await p.prepare();await p.select();await p.coordinator.execute(p.command("first-postgres-write",2),p.bundle,{write:p.write});
    const marker=p.store.marker;if(!marker)throw new Error("Missing fixture marker");
    if(kind==="missing")p.store.marker=null;if(kind==="generation")marker.generation="wrong-generation";if(kind==="cohort")marker.cohortId="wrong-cohort";if(kind==="plan")marker.planSha256=hash("e");if(kind==="receipt")marker.receiptSha256=hash("e");
    await expect(startup(p)).rejects.toThrow("NATIVE_FIRST_WRITE_MARKER_MISMATCH");
    await expect(p.coordinator.reconcile(p.command("first-postgres-write",2),at(10000))).rejects.toThrow("NATIVE_FIRST_WRITE_MARKER_MISMATCH");expect(p.store.effects).toEqual(["FIXTURE_FIRST_WRITE"]);
  });
  it("rejects an orphan native marker before preparation",async()=>{
    const written=protocol();await written.prepare();await written.select();await written.coordinator.execute(written.command("first-postgres-write",2),written.bundle,{write:written.write});
    const p=protocol();p.store.marker=clone(written.store.marker);await expect(p.prepare()).rejects.toThrow("ORPHAN_OR_PREMATURE_NATIVE_FIRST_WRITE_MARKER");expect(p.store.state).toBeNull();
  });
  it("rolls back both first-write marker and rows when the transaction fails after staging the marker",async()=>{
    const p=protocol();await p.prepare();await p.select();const before=clone(p.store.state);
    const refusing:CutoverTransitionStore={run(scope,operation){return p.store.run(scope,tx=>operation({...tx,save:async()=>{throw new Error("fixture ledger save refused");}}));}};
    const coordinator=createMigrationCutoverCoordinator({expected:p.policy,store:refusing,clock:()=>at()});
    await expect(coordinator.execute(p.command("first-postgres-write",2),p.bundle,{write:p.write})).rejects.toThrow("fixture ledger save refused");
    expect(p.store.state).toEqual(before);expect(p.store.marker).toBeNull();expect(p.store.effects).toEqual([]);
  });
  it("rejects a V1 signing domain relabeled as a V2 command",async()=>{
    const p=protocol(),command=p.command("prepare",0);
    command.authorization.signatureBase64=sign(null,Buffer.from(migrationCutoverAuthorizationPayload(command).replace("/authorization/v2\n","/authorization/v1\n")),keys.privateKey).toString("base64");
    await expect(p.coordinator.execute(command,p.bundle)).rejects.toThrow("EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED");expect(p.store.state).toBeNull();
  });
  it("does not let an authorization outlive the independent compatibility attestation",async()=>{
    const f=fixture(),store=new FixtureStore();f.compatibilityProof.attestation.expiresAt=at(5000);
    f.compatibilityProof.attestation.signatureBase64=sign(null,Buffer.from(migrationCompatiblePostgresRollbackPayload(f.compatibilityProof)),fixtureIndependentKeys.privateKey).toString("base64");f.resignAll();
    const coordinator=createMigrationCutoverCoordinator({expected:f.policy,store,clock:()=>at()});
    await expect(coordinator.execute(f.command("prepare",0),f.bundle)).rejects.toThrow("AUTHORIZATION_OUTLIVES_EVIDENCE");expect(store.state).toBeNull();
  });
  it("keeps legacy V1 audit/reconciliation and scoped safe abort without upgrading its evidence",async()=>{
    const legacy=syntheticLegacyV1();const store=new FixtureStore();store.state=clone(legacy.state);
    const coordinator=createMigrationCutoverCoordinator({expected:legacy.policy,store,clock:()=>at()});
    const audit=evaluateMigrationWriterFence(legacy.bundle,legacy.policy,at());expect(audit.planSha256).toBe(legacy.state.planSha256);expect(audit.preparationReady).toBe(false);expect(audit.blockers).toContain("V1_AUDIT_ONLY_NO_CUTOVER_ADVANCE");
    await expect(coordinator.reconcile(legacy.command("prepare",0),at(10000))).resolves.toMatchObject({outcome:"committed"});
    for(const action of ["prepare","select-postgres","first-postgres-write","rollback"] as const){let calls=0;const command=legacy.command(action,1);if(action==="rollback"){command.recovery=clone(legacy.bundle.observations.rehearsal);legacy.authorize(command);}await expect(coordinator.execute(command,legacy.bundle,action==="first-postgres-write"?{write:async()=>{calls++;return clone(firstWrite);}}:{})).rejects.toThrow("V1_AUDIT_ONLY_NO_CUTOVER_ADVANCE");expect(calls).toBe(0);}
    await expect(verifyCommittedPostgresCutover({expected:legacy.policy,runtime:{target:legacy.policy.binding.target,cohortId:legacy.policy.binding.cohortId},store,clock:()=>at(),deadline:at(10000)})).rejects.toThrow("V1_AUDIT_ONLY_NO_POSTGRES_CAPABILITY");
    await expect(coordinator.execute(legacy.command("abort",1),null)).resolves.toMatchObject({phase:"aborted",activationEnabled:false,writeAuthorized:false});expect(store.state?.version).toBe(1);expect(store.state?.preparation.closure).toBeUndefined();expect(store.marker).toBeNull();
  });
});
function syntheticLegacyV1(){
  // Explicitly signed legacy test data. Never an automatic production conversion path.
  const f=fixture(),policy=clone(f.policy),bundle=clone(f.bundle);policy.version=1;delete policy.closureTrust;bundle.version=1;delete bundle.closure;
  for(const report of Object.values(bundle.observations)){report.version=1;const value=report.body.compatibleRelease;if(value!==undefined){const proof=value as CompatiblePostgresReleaseProof;proof.version=1;proof.attestation.signatureBase64=sign(null,Buffer.from(migrationCompatiblePostgresRollbackPayload(proof)),fixtureIndependentKeys.privateKey).toString("base64");}report.signatureBase64=sign(null,Buffer.from(migrationCutoverObservationPayload(report)),keys.privateKey).toString("base64");}
  const authorize=(command:CutoverCommand)=>{command.authorization.signatureBase64=sign(null,Buffer.from(migrationCutoverAuthorizationPayload(command)),keys.privateKey).toString("base64");return command;};
  const command=(action:CutoverAction,revision:number):CutoverCommand=>authorize({operationId:`legacy-fixture-${action}`,action,expectedRevision:revision,planSha256:migrationCutoverPlanDigest(policy,bundle),deadline:at(10000),writeId:action==="first-postgres-write"?firstWrite.writeId:null,recovery:null,authorization:{issuerId:"fixture-reviewer",keyId:"fixture-reviewer-key",issuedAt:at(),expiresAt:at(10000),signatureBase64:""}});
  const preparation=command("prepare",0);const receipt={operationId:preparation.operationId,revision:1,phase:"prepared" as const,planSha256:preparation.planSha256,recordedAt:at(),activationEnabled:false as const,writeAuthorized:false as const};
  const state:DurableCutoverState={version:1,revision:1,phase:"prepared",binding:clone(policy.binding),policySha256:migrationCutoverDigest(policy),planSha256:preparation.planSha256,activationEnabled:false,preparation:bundle,snapshotTables:clone(f.bundle.observations.snapshot.body.tables) as DurableCutoverState["snapshotTables"],firstPostgresWrite:null,journal:[{operationId:preparation.operationId,requestSha256:migrationCutoverDigest(preparation),command:preparation,receipt}]};
  return{policy,bundle,command,authorize,state};
}


// Structural SQL regression only: real PostgreSQL execution belongs to the parent's isolated fixture.
describe("protocol V2 DDL JSON extraction before key subtraction", () => {
  it.each(["trusted", "schema-qualified"] as const)("groups each extracted jsonb operand in the %s ledger", mode => {
    const [ledger, marker] = mode === "trusted"
      ? [MIGRATION_CUTOVER_TRANSITIONS_V2_DDL, MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL]
      : migrationCutoverProtocolV2Ddl("fixture_cutover");
    // '-' binds more tightly than generic JSON operators; parentheses around the entire subtraction are insufficient.
    expect(ledger).toContain("((state->'preparation') - ARRAY['version','activation','observations','closure'])='{}'::jsonb");
    expect(ledger).toContain("((state->'preparation'->'closure') - ARRAY['authorization','census','snapshot','rollback'])='{}'::jsonb");
    for (const sql of [ledger, marker]) {
      expect(sql).not.toMatch(/\b(?:state|marker)(?:\s*->\s*'[^']+')+\s*-\s*ARRAY\b/);
      expect(sql).toContain("CHECK (COALESCE((");
      expect(sql).toContain("), false))");
    }
    // Root-object subtraction has no JSON extraction operand and retains exact-key rejection.
    expect(ledger).toContain("AND (state - ARRAY['version','revision','phase','binding','policySha256','planSha256','activationEnabled','preparation','snapshotTables','firstPostgresWrite','journal'])='{}'::jsonb");
    expect(marker).toContain("AND (marker - ARRAY['version','sourceKey','policySha256','planSha256','bindingSha256','cohortId','generation','writeId','receiptSha256','providerGuardSha256','deliveryGuardSha256','recordedAt'])='{}'::jsonb");
    expect(marker).toContain(mode === "trusted" ? "REFERENCES migration_cutover_transitions_v2(source_key)"
      : 'REFERENCES "fixture_cutover".migration_cutover_transitions_v2(source_key)');
  });
});

describe('readonly persisted phase inspection for initial prepare', () => {
  it('measures both native ledger and marker absence without writing', async () => {
    const p = protocol();
    const inspected = await p.coordinator.inspectPersistedPhase(at(10_000));
    expect(inspected.phase).toBe('before-first-pg-write');
    expect(inspected.ledgerPresent).toBe(false);
    expect(inspected.nativeMarkerSha256).toBe(null);
    expect(p.store.effects).toEqual([]);
    expect(p.store.state).toBe(null);
    expect(p.store.scopes[0]?.protocolVersion).toBe(2);
  });
  it('prepared state remains authenticated before-write, not missing selection default', async () => {
    const p = protocol(); await p.prepare();
    const inspected = await p.coordinator.inspectPersistedPhase(at(10_000));
    expect(inspected.phase).toBe('before-first-pg-write');
    expect(inspected.ledgerPresent).toBe(true);
    expect(inspected.revision).toBe(1);
  });
  it('orphan marker, missing native adapter, deadline and native query errors refuse', async () => {
    const p = protocol();
    p.store.marker = {version:2} as FirstPostgresWriteMarkerV2;
    await expect(p.coordinator.inspectPersistedPhase(at(10_000))).rejects.toThrow('ORPHAN_OR_PREMATURE_NATIVE_FIRST_WRITE_MARKER');
    await expect(p.coordinator.inspectPersistedPhase(at())).rejects.toThrow('INVALID_PHASE_INSPECTION_DEADLINE');
    const f = fixture();
    const noMarker: CutoverTransitionStore = { async run(_scope, operation) {
      return operation({load:async()=>null, save:async()=>{throw Error('write forbidden');}, postgres:{query:async()=>({rows:[],rowCount:0})}});
    }};
    await expect(createMigrationCutoverCoordinator({expected:f.policy,store:noMarker,clock:()=>at()}).inspectPersistedPhase(at(10_000))).rejects.toThrow('NATIVE_FIRST_WRITE_MARKER_ADAPTER_REQUIRED');
    const failed: CutoverTransitionStore = {async run(){throw Error('native ledger query failed');}};
    await expect(createMigrationCutoverCoordinator({expected:f.policy,store:failed,clock:()=>at()}).inspectPersistedPhase(at(10_000))).rejects.toThrow('native ledger query failed');
  });
});

it('initial phase native startup dispatch probes both durable tables and refuses absent tables', async () => {
  const f = fixture(), target=f.policy.binding.target;
  for (const absentMarker of [false,true]) {
    const calls: string[]=[];
    const runtime={async run<T>(operation:(tx:PostgresTransaction)=>Promise<T>):Promise<T>{
      return operation({async query(sql,values=[]){
        calls.push(sql);
        if(sql.includes('pg_current_xact_id_if_assigned'))return {rows:[{no_prior_writes:true}],rowCount:1};
        if(sql.includes('business_schema_identity'))return {rows:[{database:target.database,server_address:target.serverAddress,server_port:target.serverPort,system_identifier:target.systemIdentifier,schema_name:target.schema,generation_id:target.generation,fingerprint:target.schemaSha256}],rowCount:1};
        if(sql.includes('to_regclass'))return {rows:absentMarker&&String(values[0]).includes('first_write_markers')?[]:[{relkind:'r',relpersistence:'p'}],rowCount:1};
        if(sql.includes('SELECT revision,state')||sql.includes('SELECT marker_sha256,marker'))return {rows:[],rowCount:0};
        throw Error('unexpected SQL');
      }});
    }};
    const store=createReadOnlyCutoverStartupStore({runtime,target,clock:()=>at()});
    const reader=createMigrationCutoverCoordinator({expected:f.policy,store,clock:()=>at()});
    if(absentMarker)await expect(reader.inspectPersistedPhase(at(10_000))).rejects.toThrow('DURABLE_NATIVE_FIRST_WRITE_MARKER_TABLE_REQUIRED');
    else {
      const result=await reader.inspectPersistedPhase(at(10_000));expect(result.ledgerPresent).toBe(false);
      expect(calls.some(sql=>sql.includes('SELECT revision,state'))).toBe(true);
      expect(calls.some(sql=>sql.includes('SELECT marker_sha256,marker'))).toBe(true);
    }
    expect(calls.some(sql=>/^(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/.test(sql))).toBe(false);
  }
});
