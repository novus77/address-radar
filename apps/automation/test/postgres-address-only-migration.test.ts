import { beforeEach, expect, test, vi } from "vitest";
const ports = vi.hoisted(() => ({ apply: vi.fn(), verify: vi.fn(), runtime: vi.fn() }));
vi.mock("../src/postgres-cohort-import.js", () => ({ applyReviewedPostgresCohortImportPlanInTransaction: ports.apply }));
vi.mock("../src/postgres-address-only-startup.js", async original => ({
  ...await original<typeof import("../src/postgres-address-only-startup.js")>(), verifyAddressOnlyCommittedStartup: ports.verify,
}));
vi.mock("../../../packages/database/src/postgres-migration-runtime.js", () => ({ createPostgresMigrationRuntime: ports.runtime }));
import { executeDedicatedAddressOnlyMigration, type AddressOnlyMigrationOptions } from "../src/postgres-address-only-migration.js";
import { addressOnlyCohortDigest } from "../src/postgres-address-only-startup.js";
import { createPostgresUnitOfWork } from "../../../packages/database/src/postgres-unit-of-work.js";

function fixture() {
  const now = Date.now(), sha = "a".repeat(64), generationId = "addresses-new";
  const profile = { subjectKey: "wallet:solana:owner", entityId: "entity/1", observedAt: now,
    profilePayload: "{}", profile: { fact: { walletFamily: "solana" } } };
  const cohortSha256 = addressOnlyCohortDigest([{ subject_key: profile.subjectKey, entity_id: profile.entityId,
    wallet_family: "solana", profile_payload: "{}", import_id: "import-1", observed_at: now }]);
  const target = { database: "address_radar", schema: "address_radar_business", username: "radar_migrator",
    schemaFingerprint: sha, systemIdentifier: "123", serverAddress: "127.0.0.1", serverPort: 5432,
    generation: generationId, schemaVersion: 3, service: "migration" };
  const options = { target, plan: { kind: "cohort_projection", importId: "import-1", generationId,
    approvalRef: "approval-1", planSha256: sha, source: { kind: "address_only_registry", seedSha256: sha },
    profiles: [profile], quarantine: [], grantsBusinessEligibility: false },
    manifest: { protocol: "address-only-v1", operationId: "operation-1", importId: "import-1", generationId,
      activatedAt: now, planSha256: sha, seedSha256: sha, cohortSha256, walletCount: 1, entityCount: 1,
      releaseSha256: sha, backupSha256: sha, fenceSha256: sha,
      target: { database: target.database, schema: target.schema, schemaFingerprint: sha,
        systemIdentifier: "123", serverAddress: "127.0.0.1", serverPort: 5432 },
      gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false },
    capability: { kind: "approved_cutover", purpose: "cohort_projection", planSha256: sha,
      authorizationRef: "approval-1", expiresAtMs: now + 10000, target },
    budget: { deadlineAtMs: now + 10000, maximumTransactionMs: 10000, maximumQueriesPerTransaction: 100,
      maximumTotalQueries: 100, maximumTransactions: 1, recordsPerTransaction: 1, maximumImportLagMs: 10000 },
    assertAuthorized: vi.fn().mockResolvedValue(undefined), releaseSha256: sha,
    measureSourceFence: vi.fn().mockResolvedValue({ backupSha256: sha, fenceSha256: sha,
      gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false }),
  } as unknown as Omit<AddressOnlyMigrationOptions, "migrationRuntime">;
  const order: string[] = [], durable: string[] = [];
  let pending: string[] = [];
  const client = { release: vi.fn(), query: vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      order.push(sql); if (sql === "COMMIT") durable.push(...pending); if (sql === "ROLLBACK") pending = [];
    } else if (sql.startsWith("INSERT")) pending.push("generation");
    else if (sql === "cohort") pending.push("cohort");
    return { rows: sql.startsWith("SELECT generation_id") ? [{ generation_id: generationId, activated_at: now }] : [], rowCount: 0 };
  }) };
  const runtime = createPostgresUnitOfWork({ connect: async () => client }, { statementTimeoutMs: 1000, lockTimeoutMs: 100 });
  ports.apply.mockImplementation(async (_plan, execution) => {
    await execution.transaction.query("cohort");
    return { commitState: "pending_parent_commit", stagedProfiles: 1, checkedExistingProfiles: 0, quarantinedProfiles: 0 };
  });
  ports.verify.mockResolvedValue({ protocol: "address-only-v1", writeAuthorized: false, activationEnabled: false });
  ports.runtime.mockReturnValue({ ...runtime, close: vi.fn().mockResolvedValue(undefined) });
  const migrationRuntime = { pool: {} as AddressOnlyMigrationOptions["migrationRuntime"]["pool"],
    assertAuthorized: vi.fn().mockResolvedValue(undefined),
    limits: { operationTimeoutMs: 10000, connectionTimeoutMs: 1000, statementTimeoutMs: 5000,
      lockTimeoutMs: 100, maximumSqlStatements: 1000, workMemKb: 1024, closeTimeoutMs: 1000 } };
  return { options: { ...options, migrationRuntime }, client, order, durable };

}
beforeEach(() => vi.resetAllMocks());
test("commits generation, registry and parity together before returning a receipt", async () => {
  const { options, order, durable, client } = fixture();
  await expect(executeDedicatedAddressOnlyMigration(options)).resolves.toMatchObject({ commitState: "committed", activationEnabled: false });
  expect(order).toEqual(["BEGIN", "COMMIT"]); expect(durable).toEqual(["generation", "cohort"]);
  expect(options.measureSourceFence).toHaveBeenCalledTimes(2);
  expect(client.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  expect(ports.apply.mock.calls[0]![1].budget.maximumTotalQueries).toBe(96);
});
test.each(["import", "parity", "final-fence", "authorization"])("rolls back all data on %s refusal", async failure => {
  const { options, order, durable } = fixture();
  if (failure === "import") ports.apply.mockRejectedValue(new Error("refused"));
  if (failure === "parity") ports.verify.mockRejectedValue(new Error("refused"));
  if (failure === "final-fence") vi.mocked(options.measureSourceFence).mockResolvedValueOnce(await options.measureSourceFence()).mockRejectedValueOnce(new Error("refused"));
  if (failure === "authorization") vi.mocked(options.assertAuthorized).mockRejectedValue(new Error("refused"));
  await expect(executeDedicatedAddressOnlyMigration(options)).rejects.toThrow("refused");
  expect(order.at(-1)).toBe("ROLLBACK"); expect(durable).toEqual([]);
});
test("does not return a successful receipt or retry an uncertain COMMIT", async () => {
  const { options, client } = fixture();
  const original = client.query.getMockImplementation()!;
  client.query.mockImplementation(async sql => { if (sql === "COMMIT") throw new Error("connection lost"); return original(sql); });
  await expect(executeDedicatedAddressOnlyMigration(options)).rejects.toThrow();
  expect(client.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
});
test.each(["seed", "digest", "target", "authorization", "budget", "eligibility"])("rejects %s mismatch before opening transaction", async failure => {
  const { options, client } = fixture();
  if (failure === "seed") Reflect.set(options.manifest, "seedSha256", "b".repeat(64));
  if (failure === "digest") Reflect.set(options.manifest, "cohortSha256", "b".repeat(64));
  if (failure === "target") Reflect.set(options.target, "systemIdentifier", "999");
  if (failure === "authorization") Reflect.set(options.capability, "authorizationRef", "other");
  if (failure === "budget") Reflect.set(options.budget, "maximumTotalQueries", 4);
  if (failure === "eligibility") Reflect.set(options.plan, "grantsBusinessEligibility", true);
  await expect(executeDedicatedAddressOnlyMigration(options)).rejects.toThrow(); expect(client.query).not.toHaveBeenCalled();
});

test("constructs an exclusive native runtime with the same absolute expiry and remaining budget", async () => {
  const { options } = fixture();
  await executeDedicatedAddressOnlyMigration(options);
  expect(ports.runtime).toHaveBeenCalledTimes(1);
  const config = ports.runtime.mock.calls[0]![0];
  expect(config.target).toEqual(options.target);
  expect(config.capability).toMatchObject({ mode: "approved_cutover", purpose: "business_import",
    planSha256: options.plan.planSha256, approvalRef: options.plan.approvalRef });
  expect(config.capability.expiresAtMs).toBeLessThanOrEqual(options.budget.deadlineAtMs);
  expect(config.capability.expiresAtMs).toBeLessThanOrEqual(options.capability.expiresAtMs);
  expect(config.limits.operationTimeoutMs).toBeLessThanOrEqual(options.budget.maximumTransactionMs);
  expect(ports.runtime.mock.results[0]!.value.close).toHaveBeenCalledTimes(1);
});

test.each([true,false])("preserves commit outcome when runtime cleanup fails: committed=%s", async committed => {
  const { options, client } = fixture();
  const configured = ports.runtime.getMockImplementation()!();
  configured.close.mockRejectedValue(new Error("close failed"));
  ports.runtime.mockReturnValue(configured);
  if (!committed) {
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async sql => { if (sql === "COMMIT") throw new Error("connection lost"); return original(sql); });
  }
  try { await executeDedicatedAddressOnlyMigration(options); throw new Error("missing cleanup refusal"); }
  catch(error) {
    expect(error).toMatchObject({ name: "AddressOnlyMigrationCleanupError", commitState: committed ? "committed" : "unknown" });
    if(committed) expect((error as {committedReceipt:unknown}).committedReceipt).toMatchObject({commitState:"committed"});
    else expect((error as {operationError:unknown}).operationError).toBeDefined();
  }
});
