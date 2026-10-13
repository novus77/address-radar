import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createPostgresUnitOfWork, type PostgresClient } from "../../../packages/database/src/postgres-unit-of-work.js";
import type { MigrationProjectionCrosswalk } from "../../../packages/database/src/migration-projection-crosswalk.js";
import { applyReviewedPostgresCohortImportPlan, applyReviewedPostgresProviderBudgetSeedPlan,
  applyReviewedPostgresCohortImportPlanInTransaction,
  applyReviewedPostgresProviderBudgetSeedPlanInTransaction,
  createReviewedPostgresCohortImportPlan, createReviewedPostgresProviderBudgetSeedPlan,
  postgresCohortImportFingerprint, postgresCohortImportSchemaContract,
  type PostgresCohortReview, type PostgresCohortImportPlan, type PostgresCohortApplyOptions,
  type PostgresProviderBudgetReview } from "../src/postgres-cohort-import.js";

const now = Date.now();
const hash = "a".repeat(64);
const address = "0x" + "aB".repeat(20);
type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const text = (value: string) => ({ storage: "text" as const, value: Buffer.from(value).toString("base64"), encoding: "base64" as const });
const target = { database: "radar_rehearsal_0123456789abcdef", username: "migration_importer", schema: "radar_rehearsal_0123456789abcdef",
  generation: "generation-reviewed", service: "migration", serverAddress: "127.0.0.1", serverPort: 5433,
  schemaVersion: 2, schemaFingerprint: hash };
function fixture(count = 1) {
  const rows: Mutable<MigrationProjectionCrosswalk["rows"]> = [];
  const identityCohorts: Mutable<MigrationProjectionCrosswalk["identityCohorts"]> = [];
  const allowlist: Mutable<PostgresCohortReview["allowlist"]> = [];
  for (let i = 0; i < count; i++) {
    const entityId = "entity-" + i, accountId = "account-" + i;
    const walletAddress = i === 0 ? address : "0x" + (i + 1).toString(16).padStart(40, "0");
    rows.push({ table: "entity_accounts", rowOrdinal: i, rowBodySha256: hash, targetRoute: "identity_review",
      values: { entity_id: text(entityId), account_id: text(accountId), confidence: text("confirmed"), source: text("registry") },
      primaryKey: [text(entityId), text(accountId)], references: [], status: "historical", grantsBusinessEligibility: false });
    rows.push({ table: "wallet_identities", rowOrdinal: i, rowBodySha256: hash, targetRoute: "identity_review",
      values: { account_id: text(accountId), chain_family: text("evm"), address: text(walletAddress), confidence: text("confirmed"), source: text("registry") },
      primaryKey: [text(accountId), text("evm"), text(walletAddress)], references: [], status: "historical", grantsBusinessEligibility: false });
    rows.push({ table: "trader_profiles", rowOrdinal: i, rowBodySha256: hash, targetRoute: "identity_review",
      values: { entity_id: text(entityId), monitoring_enabled: { storage: "integer", value: "1" },
        fomo_monitoring_enabled: { storage: "integer", value: "0" }, onchain_monitoring_enabled: { storage: "integer", value: "1" } },
      primaryKey: [text(entityId)], references: [], status: "historical", grantsBusinessEligibility: false });
    identityCohorts.push({ entityId, entityKey: "source-key-" + i, lifecycle: "active", suspended: false, manual: false, locked: false,
      profileFlags: { monitoring_enabled: true, fomo_monitoring_enabled: false, onchain_monitoring_enabled: true },
      accounts: [text(accountId)], wallets: [{ family: "evm", comparisonAddress: walletAddress.toLowerCase(), sourceAddresses: [walletAddress],
        confidenceEvidence: [{ source: { table: "wallet_identities", rowOrdinal: i }, value: text("confirmed"), recognized: "confirmed" }] }],
      status: "historical_coherent", grantsBusinessEligibility: false });
    allowlist.push({ entityId, family: "evm", address: walletAddress, accountId,
      associationRow: { table: "entity_accounts", rowOrdinal: i }, walletRow: { table: "wallet_identities", rowOrdinal: i },
      identityEvidenceRef: "actual-legacy-identity:" + i, ownershipEvidenceRef: "actual-legacy-ownership:" + i,
      effectiveAt: now - 1000, knownAt: now - 1000 });
  }
  const crosswalk: Mutable<MigrationProjectionCrosswalk> = { operationId: "source-operation", snapshotSha256: hash,
    catalogFingerprint: hash, reviewedRoutingSha256: hash, rows, identityCohorts, issues: [],
    coverage: { plannedTables: 141, plannedRows: rows.length, providedRows: rows.length, providedChunks: 2,
      supportedIdentityTables: [], semanticReferenceRules: 0, completeSemanticCoverage: false, cohortCountsAreDiagnostic: true },
    historicalOnly: true, grantsBusinessEligibility: false, sourceWrites: false, databaseWrites: false };
  const review: Mutable<PostgresCohortReview> = { version: 1, importId: "reviewed-cohort-import", approvalRef: "approval:isolated",
    actorId: "approved-migration-actor", actorAuthorizationRef: "authorization:cohort-write",
    source: { operationId: crosswalk.operationId, snapshotSha256: hash, catalogFingerprint: hash,
      reviewedRoutingSha256: hash, manifestSha256: hash, crosswalkSha256: postgresCohortImportFingerprint(crosswalk), databaseEncoding: "UTF-8" },
    generationId: target.generation, sourceWatermark: now - 1000, importedAt: now, allowlist };
  return { crosswalk, review, create: () => createReviewedPostgresCohortImportPlan({ crosswalk, review,
    trustedReviewSha256: postgresCohortImportFingerprint(review) }) };
}

type Row = Record<string, unknown>;
function database() {
  let state = new Map<string, Row[]>(); let snapshot = state;
  const calls: string[] = []; let commitGate: Promise<void> | undefined;
  let fail: ((sql: string) => boolean) | undefined;
  const tableRows = (table: string) => state.get(table) ?? [];
  const client: PostgresClient = { release() {}, async query(sql, args = []) {
    calls.push(sql);
    if (sql === "BEGIN") { snapshot = structuredClone(state); return { rows: [], rowCount: 0 }; }
    if (sql === "ROLLBACK") { state = snapshot; return { rows: [], rowCount: 0 }; }
    if (sql === "COMMIT") { await commitGate; return { rows: [], rowCount: 0 }; }
    if (fail?.(sql)) throw new Error("injected failure");
    if (sql.includes("cohort-import-target")) return { rows: [{ database: target.database, username: target.username,
      server_address: target.serverAddress, server_port: target.serverPort }], rowCount: 1 };
    if (sql.includes("cohort-import-schema")) return { rows: Object.entries(postgresCohortImportSchemaContract)
      .filter(([name]) => (args[1] as readonly string[]).includes(name)).map(([name, spec]) => ({
      table_name: name, relkind: "r", relpersistence: "p", resolved: true,
      can_select: true, can_insert: true, can_update: true,
      columns: Object.entries(spec.columns).map(([column, type]) => ({ name: column, type, not_null: !spec.nullable.includes(column) })),
      constraints: [{ type: "p", columns: spec.primaryKey }, ...spec.foreignKeys.map(fk => ({ type: "f", columns: fk.columns,
        foreign_schema: target.schema, foreign_table: fk.table, foreign_columns: fk.targetColumns })),
      ...spec.unique.map(columns => ({ type: "u", columns })), ...spec.checks.map(definition => ({ type: "c", definition }))],
    })), rowCount: Object.keys(postgresCohortImportSchemaContract).length };
    if (sql.includes("cohort-import-generation")) return { rows: [{ generation_id: target.generation }], rowCount: 1 };
    if (sql.includes("parent-first-write-marker")) { state.set("parent_marker", [{ written: true }]); return { rows: [], rowCount: 1 }; }
    if (/set_config|LOCK TABLE|pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 1 };
    const insert = /INSERT INTO\s+(\w+)\s*\(([^)]+)\)/.exec(sql);
    if (insert) {
      const table = insert[1]!, columns = insert[2]!.split(",").map(x => x.trim());
      const row = Object.fromEntries(columns.map((column, i) => [column, args[i]]));
      if (table === "forward_target_identity_bindings") Object.assign(row, { conflict_at: null, conflict_by_version: null });
      if (table === "wallet_service_import_ledger") row.revoked_at = null;
      const keys = postgresCohortImportSchemaContract[table as keyof typeof postgresCohortImportSchemaContract]?.primaryKey ?? ["intent_key"];
      const existing = tableRows(table).find(x => keys.every(k => x[k] === row[k]));
      if (!existing) state.set(table, [...tableRows(table), row]);
      return { rows: [], rowCount: existing ? 0 : 1 };
    }
    if (sql.includes("SELECT v.effective_at,v.known_at,h.version_id,h.head_generation")) {
      const head = tableRows("forward_target_channel_heads").find(x => x.entity_id === args[0] && x.subject_key === args[2]);
      const version = tableRows("forward_target_channel_versions").find(x => x.version_id === head?.version_id);
      return { rows: head && version ? [{ ...version, ...head }] : [], rowCount: head && version ? 1 : 0 };
    }
    const select = /FROM\s+(\w+)/.exec(sql);
    if (select) {
      const table = select[1]!;
      const predicates = [...sql.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)/g)];
      let rows = tableRows(table).filter(row => predicates.every(match => row[match[1]!] === args[Number(match[2]) - 1]));
      if (sql.includes("channel='wallet'")) rows = rows.filter(row => row.channel === "wallet");
      const limit = /LIMIT (\d+)/.exec(sql); if (limit) rows = rows.slice(0, Number(limit[1]));
      return { rows: rows.map(row => ({ ...row })), rowCount: rows.length };
    }
    throw new Error("Unhandled SQL: " + sql);
  } };
  const uow = createPostgresUnitOfWork({ connect: async () => client }, { statementTimeoutMs: 1000, lockTimeoutMs: 1000 });
  const runtime = { run: uow.run, probe: async () => ({ ...target }) };
  const options = (plan: PostgresCohortImportPlan): PostgresCohortApplyOptions => ({ runtime,
    capability: { kind: "isolated", purpose: "cohort_projection", authorizationRef: plan.approvalRef,
      target, planSha256: plan.planSha256, expiresAtMs: now + 60_000 },
    assertAuthorized: async () => {}, budget: { deadlineAtMs: now + 60_000, maximumTransactionMs: 5000,
      maximumQueriesPerTransaction: 300, maximumTotalQueries: 5000, maximumTransactions: 20, recordsPerTransaction: 1,
      maximumImportLagMs: 60_000 } });
  return { calls, runtime, options, rows: tableRows,
    mutate(table: string, fn: (rows: Row[]) => void) { const rows = tableRows(table); fn(rows); state.set(table, rows); },
    failWhen(fn: (sql: string) => boolean) { fail = fn; }, delayCommit(gate: Promise<void>) { commitGate = gate; } };
}

describe("native physical connection address probe", () => {
  it("pins the physical host address rather than PostgreSQL inet CIDR text", async () => {
    const { applyReviewedPostgresCohortImportPlanInTransaction: applyNative } = await import("../src/postgres-cohort-import.js");
    const plan = fixture().create(); const calls: string[] = [];
    const transaction = { async query(sql: string) {
      calls.push(sql);
      if (sql.includes("set_config('statement_timeout'")) return { rows: [], rowCount: 0 };
      if (sql.includes("cohort-import-target")) return { rows: [{ database: target.database, username: target.username,
        server_address: sql.includes("host(inet_server_addr())") ? target.serverAddress : target.serverAddress + "/32",
        server_port: target.serverPort }], rowCount: 1 };
      throw new Error("fixture probe completed");
    } };
    await expect(applyNative(plan, { transaction, capability: { kind: "isolated", purpose: "cohort_projection",
      authorizationRef: plan.approvalRef, target, planSha256: plan.planSha256, expiresAtMs: Date.now() + 10000 },
      assertAuthorized: async () => {}, budget: { deadlineAtMs: Date.now() + 10000, maximumTransactionMs: 1000,
        maximumQueriesPerTransaction: 100, maximumTotalQueries: 100, maximumTransactions: 1, recordsPerTransaction: 1,
        maximumImportLagMs: 60000 } })).rejects.toThrow("fixture probe completed");
    expect(calls.find(sql => sql.includes("cohort-import-target"))).toContain("host(inet_server_addr())");
  });
});

describe("reviewed pure cohort projection plan", () => {
  it("projects only the exact allowlist and retains historical flags, case, confidence and provenance", () => {
    const f = fixture(2); f.review.allowlist = f.review.allowlist.slice(0, 1);
    const plan = f.create(); expect(plan.profiles).toHaveLength(1);
    expect(plan.profiles[0]?.profile).toMatchObject({ wallet: { address, accountId: "account-0" }, profileEnabled: true,
      fact: { subjectId: address.toLowerCase(), associationConfidence: "confirmed", walletConfidence: "confirmed" } });
    expect(plan.profiles[0]?.profilePayload).toContain('"provenanceScope":"legacy_registry_linkage"');
    expect(plan.profiles[0]?.flags.fomo_monitoring_enabled).toBe(false);
    expect(plan.completion).toMatchObject({ tokenProjection: false, freshChainFacts: false, allSixServices: false });
    expect(plan.unsupportedProjections).toContain("token_projection"); expect(Object.isFrozen(plan.profiles)).toBe(true);
  });
  it("retains disabled onchain and suspended state without inferred business qualification", () => {
    const f = fixture(); const cohort = f.crosswalk.identityCohorts[0]!;
    Object.assign(cohort, { lifecycle: "suspended", suspended: true, profileFlags: {
      monitoring_enabled: false, fomo_monitoring_enabled: true, onchain_monitoring_enabled: false } });
    Object.assign(f.crosswalk.rows[2]!.values, { monitoring_enabled: { storage: "integer", value: "0" },
      fomo_monitoring_enabled: { storage: "integer", value: "1" }, onchain_monitoring_enabled: { storage: "integer", value: "0" } });
    f.review.source.crosswalkSha256 = postgresCohortImportFingerprint(f.crosswalk);
    const plan = f.create(); expect(plan.profiles[0]?.profile).toMatchObject({ profileEnabled: false, profileSuspended: true,
      fact: { monitoringEnabled: false, suspended: true } });
    expect(plan.grantsBusinessEligibility).toBe(false);
  });
  it.each(["snapshotSha256", "catalogFingerprint", "reviewedRoutingSha256", "crosswalkSha256"] as const)("rejects mismatched %s", field => {
    const f = fixture(); f.review.source[field] = "b".repeat(64); expect(f.create).toThrow("source");
  });
  it("rejects unpinned review changes, duplicate wallets and unsafe clocks", () => {
    const f = fixture(); const pinned = postgresCohortImportFingerprint(f.review); f.review.allowlist[0]!.knownAt++;
    expect(() => createReviewedPostgresCohortImportPlan({ ...f, trustedReviewSha256: pinned })).toThrow("review");
    f.review.allowlist[0]!.knownAt--; f.review.allowlist.push(f.review.allowlist[0]!); expect(f.create).toThrow("duplicate");
  });
  it.each(["quarantined", "missing_reference", "unknown_flags", "untrusted_confidence", "other_account"])("quarantines %s without making owner claims", reason => {
    const f = fixture();
    if (reason === "quarantined") Object.assign(f.crosswalk.identityCohorts[0]!, { status: "quarantined" });
    if (reason === "missing_reference") f.review.allowlist[0]!.ownershipEvidenceRef = null;
    if (reason === "unknown_flags") Object.assign(f.crosswalk.identityCohorts[0]!.profileFlags, { onchain_monitoring_enabled: null });
    if (reason === "untrusted_confidence") f.crosswalk.rows[1]!.values.confidence = text("low");
    if (reason === "other_account") f.review.allowlist[0]!.accountId = "unknown";
    f.review.source.crosswalkSha256 = postgresCohortImportFingerprint(f.crosswalk);
    const plan = f.create(); expect(plan.profiles).toHaveLength(0); expect(plan.quarantine).toHaveLength(1);
  });
  it("does not auto merge owners and enforces bounded plan serialization", () => {
    const f = fixture(2); f.review.allowlist[1]!.address = address;
    expect(f.create).toThrow("duplicate");
    expect(() => createReviewedPostgresCohortImportPlan({ ...fixture(), trustedReviewSha256: hash,
      limits: { maximumBytes: 1 } })).toThrow("budget");
    expect(() => postgresCohortImportFingerprint({ scope: ["legacy_registry_linkage"], bad: undefined })).toThrow();
  });
  it("requires concrete source integer booleans rather than trusting diagnostic summary flags", () => {
    const f = fixture(); f.crosswalk.rows[2]!.values.monitoring_enabled = { storage: "integer", value: "0" };
    f.review.source.crosswalkSha256 = postgresCohortImportFingerprint(f.crosswalk);
    const plan = f.create(); expect(plan.profiles).toHaveLength(0);
    expect(plan.quarantine[0]?.reason).toContain("source_profile_boolean");
  });
});

describe("bounded explicitly authorized cohort apply", () => {
  it("uses actual schema/target probes, repository-managed heads and atomically idempotent receipts", async () => {
    const plan = fixture(2).create(), db = database();
    const first = await applyReviewedPostgresCohortImportPlan(plan, db.options(plan));
    expect(first).toMatchObject({ appliedProfiles: 2, resumedProfiles: 0, tokenProjection: "unsupported" });
    expect(db.rows("wallet_service_profile_cohort")).toHaveLength(2);
    expect(db.rows("forward_target_channel_heads")).toHaveLength(2);
    expect(db.rows("forward_target_identity_bindings")).toHaveLength(2);
    expect(db.rows("forward_target_authorization_intents")).toHaveLength(2);
    expect(db.calls.filter(sql => sql === "COMMIT")).toHaveLength(2);
    const second = await applyReviewedPostgresCohortImportPlan(plan, db.options(plan));
    expect(second).toMatchObject({ appliedProfiles: 0, resumedProfiles: 2 });
    expect(db.rows("forward_target_authorization_intents")).toHaveLength(2);
    expect(db.calls.some(sql => sql.includes("cohort-import-schema"))).toBe(true);
    expect(db.calls.join(" ")).not.toMatch(/CREATE TABLE|manual_radar|stable_capability|fact_attestations|fact_validators/);
  });
  it("does not acknowledge before awaited top-level UOW commit", async () => {
    const plan = fixture().create(), db = database(); let release!: () => void;
    db.delayCommit(new Promise<void>(resolve => { release = resolve; }));
    let done = false; const pending = applyReviewedPostgresCohortImportPlan(plan, db.options(plan)).then(() => { done = true; });
    for (let i = 0; i < 150 && !db.calls.includes("COMMIT"); i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(db.calls).toContain("COMMIT"); expect(done).toBe(false); release(); await pending; expect(done).toBe(true);
  });
  it("rolls back the failing batch while preserving already committed resumable batches", async () => {
    const plan = fixture(2).create(), db = database(); let versions = 0;
    db.failWhen(sql => sql.includes("INSERT INTO wallet_service_profile_versions") && ++versions === 2);
    await expect(applyReviewedPostgresCohortImportPlan(plan, db.options(plan))).rejects.toThrow("injected");
    expect(db.rows("wallet_service_profile_cohort")).toHaveLength(1);
    expect(db.rows("forward_target_channel_versions")).toHaveLength(1); expect(db.calls).toContain("ROLLBACK");
    db.failWhen(() => false); expect(await applyReviewedPostgresCohortImportPlan(plan, db.options(plan))).toMatchObject({ appliedProfiles: 1, resumedProfiles: 1 });
  });
  it.each(["owner", "conflict", "flags", "receipt", "head"])("refuses changed %s on retry without clearing conflict or overwriting state", async kind => {
    const plan = fixture().create(), db = database(); await applyReviewedPostgresCohortImportPlan(plan, db.options(plan));
    if (kind === "owner") db.mutate("forward_target_identity_bindings", rows => { rows[0]!.owner_entity_id = "other"; });
    if (kind === "conflict") db.mutate("forward_target_identity_bindings", rows => { rows[0]!.conflict_at = now; });
    if (kind === "flags") db.mutate("wallet_service_profile_versions", rows => { rows[0]!.enabled = false; });
    if (kind === "receipt") db.mutate("wallet_service_import_ledger", rows => { rows[0]!.source_fingerprint = "changed"; });
    if (kind === "head") db.mutate("forward_target_channel_heads", rows => { rows[0]!.version_id = "live-version"; });
    await expect(applyReviewedPostgresCohortImportPlan(plan, db.options(plan))).rejects.toThrow("collision");
    expect(db.rows("wallet_service_profile_cohort")).toHaveLength(1);
  });
  it("rejects forged plans, absent authorization, wrong target, production disguised as isolated and expired limits before writes", async () => {
    const plan = fixture().create(), db = database(), options = db.options(plan);
    await expect(applyReviewedPostgresCohortImportPlan({ ...plan }, options)).rejects.toThrow("plan");
    await expect(applyReviewedPostgresCohortImportPlan(plan, { ...options, assertAuthorized: async () => { throw new Error("denied"); } })).rejects.toThrow("denied");
    await expect(applyReviewedPostgresCohortImportPlan(plan, { ...options, capability: { ...options.capability, target: { ...target, database: "radar_live", schema: "radar_live" } } })).rejects.toThrow("isolated");
    await expect(applyReviewedPostgresCohortImportPlan(plan, { ...options, runtime: { ...db.runtime, probe: async () => ({ ...target, schemaFingerprint: "b".repeat(64) }) } })).rejects.toThrow("target");
    await expect(applyReviewedPostgresCohortImportPlan(plan, { ...options, budget: { ...options.budget, deadlineAtMs: now - 1 } })).rejects.toThrow("deadline");
    expect(db.rows("wallet_service_import_ledger")).toHaveLength(0);
  });
  it("refuses view/unlogged/incorrect key schema and exhausted query budgets before durable mutation", async () => {
    const plan = fixture().create();
    for (const change of ["view", "unlogged", "foreign_key", "privilege"]) {
      const db = database(), options = db.options(plan), run = options.runtime.run;
      const injected: PostgresCohortApplyOptions = { ...options, runtime: { ...options.runtime, run: fn => run(tx => fn({ query: async (sql, args) => {
        const result = await tx.query(sql, args); if (!sql.includes("cohort-import-schema")) return result;
        const rows = structuredClone(result.rows);
        if (change === "view") rows[0]!.relkind = "v";
        if (change === "unlogged") rows[0]!.relpersistence = "u";
        if (change === "foreign_key") rows.find(row => row.table_name === "wallet_service_profile_cohort")!.constraints = [];
        if (change === "privilege") rows.find(row => row.table_name === "wallet_service_profile_cohort")!.can_insert = false;
        return { ...result, rows };
      } })) } };
      await expect(applyReviewedPostgresCohortImportPlan(plan, injected)).rejects.toThrow("schema");
      expect(db.rows("wallet_service_import_ledger")).toHaveLength(0);
    }
    const db = database(), options = db.options(plan);
    await expect(applyReviewedPostgresCohortImportPlan(plan, { ...options, budget: { ...options.budget, maximumQueriesPerTransaction: 4 } })).rejects.toThrow("query_budget");
    expect(db.calls).toContain("ROLLBACK");
  });
  it("rejects cutover through an independent runtime and never reports zero unsupported tokens as success", async () => {
    const plan = fixture().create(), db = database(), options = db.options(plan); let accepted = 0;
    await expect(applyReviewedPostgresCohortImportPlan(plan, { ...options,
      capability: { ...options.capability, kind: "approved_cutover" }, assertAuthorized: async request => {
        expect(request.capability.kind).toBe("approved_cutover"); accepted++;
      } })).rejects.toThrow("parent_transaction");
    expect(accepted).toBe(0); expect(db.calls).toHaveLength(0);
    const result = await applyReviewedPostgresCohortImportPlan(plan, options);
    expect(result.tokenProjection).toBe("unsupported"); expect(result.allSixServicesComplete).toBe(false);
    const f = fixture(); Object.assign(f.crosswalk.identityCohorts[0]!, { status: "quarantined" });
    f.review.source.crosswalkSha256 = postgresCohortImportFingerprint(f.crosswalk);
    const empty = f.create(); await expect(applyReviewedPostgresCohortImportPlan(empty, db.options(empty))).rejects.toThrow("no_applicable");
  });
  it("keeps native first-write projection and parent marker in one commit, rolling both back on failure", async () => {
    const plan = fixture(2).create(), db = database(), { runtime: _runtime, ...base } = db.options(plan);
    const native = { ...base, capability: { ...base.capability, kind: "approved_cutover" as const },
      budget: { ...base.budget, recordsPerTransaction: 2 } };
    await expect(db.runtime.run(async transaction => {
      const result = await applyReviewedPostgresCohortImportPlanInTransaction(plan, { ...native, transaction });
      expect(result).toMatchObject({ stagedProfiles: 2, commitState: "pending_parent_commit" });
      expect(db.calls.filter(sql => sql === "COMMIT")).toHaveLength(0);
      await transaction.query("/* parent-first-write-marker */ SELECT 1");
      throw new Error("parent marker failure");
    })).rejects.toThrow("parent marker failure");
    expect(db.rows("wallet_service_profile_cohort")).toHaveLength(0); expect(db.rows("parent_marker")).toHaveLength(0);
    expect(db.calls.filter(sql => sql === "BEGIN")).toHaveLength(1); expect(db.calls.filter(sql => sql === "COMMIT")).toHaveLength(0);
    await db.runtime.run(async transaction => {
      await applyReviewedPostgresCohortImportPlanInTransaction(plan, { ...native, transaction });
      await transaction.query("/* parent-first-write-marker */ SELECT 1");
    });
    expect(db.calls.filter(sql => sql === "COMMIT")).toHaveLength(1);
    expect(db.rows("wallet_service_profile_cohort")).toHaveLength(2); expect(db.rows("parent_marker")).toHaveLength(1);
  });
  it("rejects a native plan exceeding the single-transaction record quota before any write", async () => {
    const plan = fixture(2).create(), db = database(), { runtime: _runtime, ...base } = db.options(plan);
    await expect(db.runtime.run(transaction => applyReviewedPostgresCohortImportPlanInTransaction(plan, {
      ...base, transaction, capability: { ...base.capability, kind: "approved_cutover" },
    }))).rejects.toThrow("native_transaction_record_budget");
    expect(db.rows("wallet_service_import_ledger")).toHaveLength(0);
  });
});

describe("separately reviewed provider contract seeds", () => {
  function seedReview(): Mutable<PostgresProviderBudgetReview> { return { version: 1, importId: "provider-contract-import", approvalRef: "approval:isolated",
    generationId: target.generation, importedAt: now, contractRef: "reviewed-provider-contract",
    budgets: [{ providerId: "provider", origin: "https://rpc.example", windowStartedAt: now, windowMs: 60_000,
      maximumRequests: 5, requestsUsed: 2, maximumConcurrency: 2, cooldownUntil: "0" }] }; }
  it("requires explicit externally reviewed provider limits and does not guess or reset usage", async () => {
    const review = seedReview(), plan = createReviewedPostgresProviderBudgetSeedPlan({ review, trustedReviewSha256: postgresCohortImportFingerprint(review) });
    const db = database(), options = db.options(fixture().create());
    const seedOptions = { ...options, capability: { ...options.capability, purpose: "provider_budget_seed" as const,
      planSha256: plan.planSha256, authorizationRef: plan.approvalRef } };
    expect(await applyReviewedPostgresProviderBudgetSeedPlan(plan, seedOptions)).toMatchObject({ appliedBudgets: 1 });
    expect(db.rows("wallet_service_import_ledger")[0]?.proof_scope).toBe("provider_contract");
    expect(db.rows("wallet_service_provider_budgets")[0]?.requests_used).toBe(2);
    expect(await applyReviewedPostgresProviderBudgetSeedPlan(plan, seedOptions)).toMatchObject({ resumedBudgets: 1 });
    db.mutate("wallet_service_provider_budgets", rows => { rows[0]!.requests_used = 3; });
    await expect(applyReviewedPostgresProviderBudgetSeedPlan(plan, seedOptions)).rejects.toThrow("collision");
    expect(db.rows("wallet_service_provider_budgets")[0]?.requests_used).toBe(3);
  });
  it.each(["missing_limit", "path_origin", "duplicate", "overdrawn", "unknown_cooldown", "overflow_cooldown"])("rejects %s", reason => {
    const review = seedReview();
    if (reason === "missing_limit") Object.assign(review.budgets[0]!, { maximumRequests: undefined });
    if (reason === "path_origin") review.budgets[0]!.origin += "/secret";
    if (reason === "duplicate") review.budgets.push(review.budgets[0]!);
    if (reason === "overdrawn") review.budgets[0]!.requestsUsed = 6;
    if (reason === "unknown_cooldown") Object.assign(review.budgets[0]!, { cooldownUntil: undefined });
    if (reason === "overflow_cooldown") review.budgets[0]!.cooldownUntil = "9223372036854775808";
    expect(() => createReviewedPostgresProviderBudgetSeedPlan({ review, trustedReviewSha256: postgresCohortImportFingerprint(review) })).toThrow();
  });
  it("preserves a reviewed manual-pause bigint sentinel rather than guessing a zero cooldown", async () => {
    const review = seedReview(); review.budgets[0]!.cooldownUntil = "9223372036854775807";
    const plan = createReviewedPostgresProviderBudgetSeedPlan({ review, trustedReviewSha256: postgresCohortImportFingerprint(review) });
    const db = database(), options = db.options(fixture().create());
    await applyReviewedPostgresProviderBudgetSeedPlan(plan, { ...options, capability: { ...options.capability,
      purpose: "provider_budget_seed", planSha256: plan.planSha256 } });
    expect(db.rows("wallet_service_provider_budgets")[0]?.cooldown_until).toBe("9223372036854775807");
  });
  it("keeps provider seeds and parent marker in one native transaction with no independent commit", async () => {
    const review = seedReview(), plan = createReviewedPostgresProviderBudgetSeedPlan({ review, trustedReviewSha256: postgresCohortImportFingerprint(review) });
    const db = database(), { runtime: _runtime, ...base } = db.options(fixture().create());
    const options = { ...base, capability: { ...base.capability, kind: "approved_cutover" as const,
      purpose: "provider_budget_seed" as const, planSha256: plan.planSha256 } };
    await expect(db.runtime.run(async transaction => {
      const result = await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(plan, { ...options, transaction });
      expect(result).toMatchObject({ stagedBudgets: 1, checkedExistingBudgets: 0, commitState: "pending_parent_commit" });
      expect(db.calls).not.toContain("COMMIT"); await transaction.query("/* parent-first-write-marker */ SELECT 1");
      throw new Error("parent rollback");
    })).rejects.toThrow("parent rollback");
    expect(db.rows("wallet_service_provider_budgets")).toHaveLength(0); expect(db.rows("wallet_service_import_ledger")).toHaveLength(0);
    expect(db.rows("parent_marker")).toHaveLength(0); expect(db.calls.filter(sql => sql === "BEGIN")).toHaveLength(1);
    await db.runtime.run(async transaction => {
      await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(plan, { ...options, transaction });
      await transaction.query("/* parent-first-write-marker */ SELECT 1");
    });
    expect(db.calls.filter(sql => sql === "COMMIT")).toHaveLength(1);
    expect(db.rows("wallet_service_provider_budgets")).toHaveLength(1); expect(db.rows("parent_marker")).toHaveLength(1);
  });
  it("does not acknowledge a native result as committed while the parent COMMIT is still pending", async () => {
    const plan = fixture().create(), db = database(), { runtime: _runtime, ...base } = db.options(plan);
    let release!: () => void, committed = false;
    db.delayCommit(new Promise<void>(resolve => { release = resolve; }));
    const pending = db.runtime.run(async transaction => {
      const result = await applyReviewedPostgresCohortImportPlanInTransaction(plan, { ...base, transaction,
        capability: { ...base.capability, kind: "approved_cutover" } });
      expect(result.commitState).toBe("pending_parent_commit");
      await transaction.query("/* parent-first-write-marker */ SELECT 1");
    }).then(() => { committed = true; });
    for (let i = 0; i < 150 && !db.calls.includes("COMMIT"); i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(db.calls).toContain("COMMIT"); expect(committed).toBe(false);
    release(); await pending; expect(committed).toBe(true);
  });
});

// The legacy acceptance TEMP harness is not authorized by the strict nonce target gate.
describe.skip("legacy acceptance PG TEMP harness disabled; use nonce-scoped first-write integration", () => {
  it("executes native projection and marker SQL on one connection under outer BEGIN/ROLLBACK with a schema-proof test adapter", async () => {
    const raw = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL!;
    const url = new URL(raw);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.port).toBe("5433"); expect(url.pathname).toBe("/address_radar_acceptance_test");
    expect(decodeURIComponent(url.username)).toBe("address_radar_acceptance"); expect(url.search).toBe(""); expect(url.hash).toBe("");
    const { Client } = createRequire(new URL("../../../packages/database/package.json", import.meta.url))("pg") as {
      Client: new (options: { connectionString: string; connectionTimeoutMillis: number }) => {
        connect(): Promise<void>; end(): Promise<void>;
        query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
      };
    };
    const client = new Client({ connectionString: raw, connectionTimeoutMillis: 2000 }); let begun = false;
    try {
      await client.connect(); await client.query("BEGIN"); begun = true;
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SET LOCAL lock_timeout='1000ms'");
      await client.query("SET LOCAL search_path=pg_catalog,pg_temp");
      const { POSTGRES_SERVICE_FACT_SCHEMA_SQL } = await import("../src/postgres-service-fact-adapters.js");
      const { POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL } = await import("../../../packages/database/src/forward-target-authorization-store.js");
      await client.query("CREATE TEMP TABLE forward_strategy_generations(generation_id text PRIMARY KEY)");
      await client.query(POSTGRES_SERVICE_FACT_SCHEMA_SQL.replace(/CREATE TABLE/g, "CREATE TEMP TABLE"));
      await client.query(POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL.replace(/CREATE TABLE/g, "CREATE TEMP TABLE"));
      await client.query("CREATE TEMP TABLE cohort_test_parent_marker(plan_sha256 text PRIMARY KEY)");
      await client.query("INSERT INTO forward_strategy_generations(generation_id) VALUES($1)", [target.generation]);
      const identity = (await client.query("SELECT current_database() database,current_user username,inet_server_addr()::text address,inet_server_port() port")).rows[0]!;
      const isolatedTarget = { ...target, database: identity.database as string, username: identity.username as string,
        serverAddress: identity.address as string, serverPort: identity.port as number };
      const plan = fixture().create(), { runtime: _runtime, ...base } = database().options(plan);
      // TEMP relations intentionally fail the production schema gate. This adapter only exercises real
      // PostgreSQL DML/FKs/rollback; it is NOT a live permanent-schema, role, signature or cutover verifier.
      const transaction = { async query(sql: string, args: readonly unknown[] = []) {
        if (sql.includes("cohort-import-schema")) return { rows: (args[1] as readonly string[]).map(name => {
          const spec = postgresCohortImportSchemaContract[name]!;
          return { table_name: name, relkind: "r", relpersistence: "p", resolved: true, can_select: true, can_insert: true, can_update: true,
            columns: Object.entries(spec.columns).map(([column, type]) => ({ name: column, type, not_null: !spec.nullable.includes(column) })),
            constraints: [{ type: "p", columns: spec.primaryKey }, ...spec.foreignKeys.map(fk => ({ type: "f", columns: fk.columns,
              foreign_schema: target.schema, foreign_table: fk.table, foreign_columns: fk.targetColumns })),
            ...spec.unique.map(columns => ({ type: "u", columns })), ...spec.checks.map(definition => ({ type: "c", definition }))] };
        }), rowCount: (args[1] as readonly string[]).length };
        const values = sql.includes("set_config('search_path'") ? ["pg_catalog,pg_temp"] : [...args];
        return await client.query(sql.replaceAll('"' + target.schema + '".', '"pg_temp".'), values);
      } };
      const pending = await applyReviewedPostgresCohortImportPlanInTransaction(plan, { ...base, transaction,
        capability: { ...base.capability, target: isolatedTarget } });
      expect(pending).toMatchObject({ stagedProfiles: 1, commitState: "pending_parent_commit" });
      await transaction.query("INSERT INTO cohort_test_parent_marker(plan_sha256) VALUES($1)", [plan.planSha256]);
      const counts = (await client.query(`SELECT (SELECT count(*) FROM wallet_service_profile_cohort)::text profiles,
        (SELECT count(*) FROM forward_target_identity_bindings)::text bindings,(SELECT count(*) FROM cohort_test_parent_marker)::text markers`)).rows[0]!;
      expect(counts).toEqual({ profiles: "1", bindings: "1", markers: "1" });
      await client.query("ROLLBACK"); begun = false;
      expect((await client.query("SELECT to_regclass('pg_temp.wallet_service_profile_cohort') IS NULL AS clean")).rows[0]!.clean).toBe(true);
    } finally { if (begun) await client.query("ROLLBACK"); await client.end(); }
  }, 10_000);
});

describe("address-only plans through the existing transaction importer", () => {
  async function addressPlan() {
    const { createReviewedPostgresAddressOnlyImportPlan } = await import("../src/postgres-cohort-import.js");
    const rawSeed = JSON.stringify({ format: "address-only-seed-v1", capturedAt: new Date(now - 1000).toISOString(),
      rules: { historicalEvidenceImported: false, historicalJobsImported: false, legacyLifecycleIsNotNewCapabilityProof: true,
        gatewayDeliveryEnabled: false, activationAuthorizedByExport: false },
      tables: { fomo_accounts: [{ account_id: "account", handle: "trader" }],
        entity_accounts: [{ account_id: "account", entity_id: "entity", confidence: "confirmed", source: "registry" }],
        wallet_identities: [{ account_id: "account", chain_family: "evm", address, confidence: "confirmed", source: "manual" }],
        trader_entities: [{ entity_id: "entity", lifecycle: "elite" }],
        trader_profiles: [{ entity_id: "entity", monitoring_enabled: 1, fomo_monitoring_enabled: 0, onchain_monitoring_enabled: 1 }],
        trader_monitoring_policy: [{ trader_id: "entity", policy: "realtime" }] } });
    const { createHash } = await import("node:crypto");
    const review = { importId: "address-import", approvalRef: "approval:isolated", actorId: "actor", actorAuthorizationRef: "review:address-only",
      generationId: target.generation, importedAt: now, seedSha256: createHash("sha256").update(rawSeed).digest("hex") };
    return createReviewedPostgresAddressOnlyImportPlan({ rawSeed, review, trustedReviewSha256: postgresCohortImportFingerprint(review) });
  }
  it("writes a distinct ledger scope and verifies exact idempotent profile replay", async () => {
    const plan = await addressPlan(), db = database();
    expect(await applyReviewedPostgresCohortImportPlan(plan, db.options(plan))).toMatchObject({ appliedProfiles: 1, resumedProfiles: 0 });
    expect(db.rows("wallet_service_import_ledger")[0]?.proof_scope).toBe("address_only_registry");
    expect(await applyReviewedPostgresCohortImportPlan(plan, db.options(plan))).toMatchObject({ appliedProfiles: 0, resumedProfiles: 1 });
    expect(db.rows("wallet_service_profile_cohort")).toHaveLength(1);
  });
  it("rolls back all identity and profile writes when any profile insert fails", async () => {
    const plan = await addressPlan(), db = database();
    db.failWhen(sql => sql.includes("INSERT INTO wallet_service_profile_versions"));
    await expect(applyReviewedPostgresCohortImportPlan(plan, db.options(plan))).rejects.toThrow("injected failure");
    for (const table of ["wallet_service_import_ledger", "wallet_service_profile_cohort", "forward_target_identity_bindings", "forward_target_channel_versions"]) {
      expect(db.rows(table)).toEqual([]);
    }
  });
});
