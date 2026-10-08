import { afterEach, beforeEach, expect, test, vi } from "vitest";
const ports = vi.hoisted(() => ({ apply: vi.fn(), execute: vi.fn() }));
vi.mock("../src/postgres-cohort-import.js", () => ({ applyReviewedPostgresCohortImportPlanInTransaction: ports.apply }));
vi.mock("../../../packages/database/src/migration-cutover-coordinator.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../packages/database/src/migration-cutover-coordinator.js")>();
  return { ...actual, createMigrationCutoverCoordinator: () => ({ execute: ports.execute }) };
});
import { executeAddressOnlyFirstPostgresWrite } from "../src/postgres-address-only-cutover.js";
import { migrationCutoverDigest } from "../../../packages/database/src/migration-cutover-coordinator.js";
import { createPostgresUnitOfWork, type PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";

function input(): any {
  return { expected: { version: 2, binding: { generation: "new", cohortId: "addresses",
    target: { generation: "new", database: "address_radar", schema: "address_radar_business", schemaSha256: "a".repeat(64), serverAddress: "127.0.0.1", serverPort: 5432 } },
    guards: [{ kind: "delivery", id: "disabled" }, { kind: "provider", id: "budget" }] },
    store: {}, clock: () => "2026-10-08T00:00:00.000Z", bundle: { activation: { delivery: false, fomo: false, history: false, ownerMerge: false } },
    activatedAt: Date.parse("2026-10-08T00:00:00.000Z"),
    command: { version: 2, action: "first-postgres-write", writeId: "write-1", deadline: "2026-10-08T00:00:10.000Z",
      authorization: { expiresAt: "2026-10-08T00:00:10.000Z" } },
    plan: { kind: "cohort_projection", source: { kind: "address_only_registry" }, importId: "addresses", generationId: "new", approvalRef: "review-1", importedAt: 1, sourceWatermark: 0, planSha256: "b".repeat(64), profiles: [1], quarantine: [] },
    capability: { kind: "approved_cutover", purpose: "cohort_projection", planSha256: "b".repeat(64), expiresAtMs: Date.parse("2026-10-08T00:00:10.000Z"),
      target: { generation: "new", database: "address_radar", schema: "address_radar_business", schemaFingerprint: "a".repeat(64), serverAddress: "127.0.0.1", serverPort: 5432 } },
    budget: { deadlineAtMs: Date.parse("2026-10-08T00:00:10.000Z"), maximumTransactionMs: 1000,
      maximumQueriesPerTransaction: 100, maximumTotalQueries: 100, maximumTransactions: 1,
      recordsPerTransaction: 100, maximumImportLagMs: 86_400_000 }, assertAuthorized: vi.fn(), verifyGuardsInTransaction: vi.fn().mockResolvedValue(undefined) };
}
const imported = { commitState: "pending_parent_commit", stagedProfiles: 1, checkedExistingProfiles: 0,
  queries: 12, quarantinedProfiles: 0, grantsBusinessEligibility: false, allSixServicesComplete: false };
function transaction(activatedAt: unknown = input().activatedAt) {
  return { query: vi.fn().mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT generation_id")
    ? [{ generation_id: "new", activated_at: activatedAt }] : [], rowCount: 1 })) };
}
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(Date, "now").mockReturnValue(input().activatedAt); ports.apply.mockResolvedValue(imported); });
afterEach(() => { vi.restoreAllMocks(); });
test("rejects isolated capability and mismatched cohort before coordinator execution", async () => {
  const options = input(); options.capability.kind = "isolated";
  await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow();
  options.capability.kind = "approved_cutover"; options.plan.importId = "other";
  await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow();
  expect(ports.execute).not.toHaveBeenCalled();
});
test("passes the exact parent transaction and checks guards on both sides of import", async () => {
  const options = input(), parent = transaction(), order: string[] = [];
  options.verifyGuardsInTransaction.mockImplementation(async () => { order.push("guards"); });
  options.assertAuthorized.mockImplementation(async () => { order.push("authorize"); });
  parent.query.mockImplementation(async (sql: string) => {
    order.push(sql.startsWith("INSERT") ? "generation-insert" : "generation-verify");
    return { rows: [{ generation_id: "new", activated_at: String(options.activatedAt) }], rowCount: 1 };
  });
  ports.apply.mockImplementation(async (_plan, execution) => {
    order.push("import"); expect(execution.transaction).toBe(parent); return imported;
  });
  ports.execute.mockImplementation(async (_command, _bundle, execution) => {
    expect(parent.query).not.toHaveBeenCalled(); order.push("authorized-callback");
    const receipt = await execution.write(parent, "write-1");
    expect(receipt.writeId).toBe("write-1");
    return { phase: "postgres-written" };
  });
  expect(await executeAddressOnlyFirstPostgresWrite(options)).toEqual({ phase: "postgres-written" });
  expect(ports.apply.mock.calls[0]![1].transaction).toBe(parent);
  expect(options.verifyGuardsInTransaction).toHaveBeenCalledTimes(2);
  expect(options.verifyGuardsInTransaction.mock.calls[0]![0]).toBe(parent);
  expect(order).toEqual(["authorized-callback", "guards", "authorize", "generation-insert", "generation-verify", "import", "guards"]);
  expect(parent.query.mock.calls[0]).toEqual([
    expect.stringContaining('INSERT INTO "address_radar_business"."forward_strategy_generations"'), ["new", options.activatedAt],
  ]);
  expect(options.assertAuthorized).toHaveBeenCalledWith({ capability: options.capability,
    planSha256: options.plan.planSha256, generationId: "new", approvalRef: "review-1" });
});
test("propagates importer failure without acknowledging success", async () => {
  const options = input(); ports.apply.mockRejectedValue(new Error("import-failed"));
  ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(transaction(), "write-1"));
  await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow("import-failed");
});
test("refuses incomplete imported profile coverage", async () => {
  ports.apply.mockResolvedValue({ commitState: "pending_parent_commit", stagedProfiles: 0, checkedExistingProfiles: 0, quarantinedProfiles: 0 });
  ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(transaction(), "write-1"));
  await expect(executeAddressOnlyFirstPostgresWrite(input())).rejects.toThrow("incomplete_import");
});

test.each([undefined, null, "1791417600000", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses missing or invalid explicit activation timestamp: %s", async activatedAt => {
    const options = input(); options.activatedAt = activatedAt;
    await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow("binding_refused");
    expect(ports.execute).not.toHaveBeenCalled(); expect(ports.apply).not.toHaveBeenCalled();
  });

test.each(["generation", "target", "plan", "capability"])("refuses a mismatched %s generation", async field => {
  const options = input();
  if (field === "generation") options.expected.binding.generation = "other";
  if (field === "target") options.expected.binding.target.generation = "other";
  if (field === "plan") options.plan.generationId = "other";
  if (field === "capability") options.capability.target.generation = "other";
  await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow("binding_refused");
  expect(ports.execute).not.toHaveBeenCalled();
});

test.each(["PREPARATION_REQUIRED", "INVALID_TRANSITION", "EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED"])(
  "does not write a generation when coordinator refuses: %s", async reason => {
    const parent = transaction();
    ports.execute.mockImplementation(async () => {
      expect(parent.query).not.toHaveBeenCalled(); throw new Error(reason);
    });
    await expect(executeAddressOnlyFirstPostgresWrite(input())).rejects.toThrow(reason);
    expect(parent.query).not.toHaveBeenCalled(); expect(ports.apply).not.toHaveBeenCalled();
  });

test.each(["guard", "capability", "write-id"])("does not register generation on %s refusal", async reason => {
  const options = input(), parent = transaction();
  if (reason === "guard") options.verifyGuardsInTransaction.mockRejectedValue(new Error("guard-refused"));
  if (reason === "capability") options.assertAuthorized.mockRejectedValue(new Error("capability-refused"));
  ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent,
    reason === "write-id" ? "other" : "write-1"));
  await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow();
  expect(parent.query).not.toHaveBeenCalled(); expect(ports.apply).not.toHaveBeenCalled();
});

test.each([input().activatedAt, String(input().activatedAt)])("allows identical generation replay: %s", async stored => {
  const parent = transaction(stored);
  ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
  const first = await executeAddressOnlyFirstPostgresWrite(input());
  expect(await executeAddressOnlyFirstPostgresWrite(input())).toEqual(first);
  expect(parent.query).toHaveBeenCalledTimes(4);
  expect(parent.query.mock.calls[0]![0]).toContain("ON CONFLICT(generation_id) DO NOTHING");
  expect(parent.query.mock.calls[1]![0]).toContain("FOR UPDATE");
});

test.each([input().activatedAt + 1, String(input().activatedAt + 1), null])(
  "rejects a conflicting stored activation timestamp: %s", async stored => {
    const parent = transaction(stored);
    ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
    await expect(executeAddressOnlyFirstPostgresWrite(input())).rejects.toThrow("generation_conflict");
    expect(ports.apply).not.toHaveBeenCalled();
  });

test.each([{ rows: [] }, { rows: [{ generation_id: "other", activated_at: input().activatedAt }] }])(
  "rejects missing or mismatched generation readback", async ({ rows }) => {
    const parent = transaction(); parent.query.mockResolvedValue({ rows, rowCount: rows.length });
    ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
    await expect(executeAddressOnlyFirstPostgresWrite(input())).rejects.toThrow("generation_conflict");
    expect(ports.apply).not.toHaveBeenCalled();
  });

test.each(["success", "generation-insert", "generation-verify", "conflict", "import", "final-guard", "marker"])(
  "joins the parent UOW through marker and rolls back failures: %s", async outcome => {
    const options = input(), order: string[] = [], durable: string[] = [];
    let pending: string[] = [], parent: PostgresTransaction | undefined;
    const client = { release: vi.fn(), query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        order.push(sql);
        if (sql === "COMMIT") durable.push(...pending);
        if (sql === "ROLLBACK") pending = [];
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      const step = sql.startsWith("INSERT INTO") ? "generation-insert"
        : sql.startsWith("SELECT generation_id") ? "generation-verify" : sql;
      order.push(step);
      if (step === outcome) throw new Error(outcome);
      if (step === "generation-insert") {
        expect(values).toEqual(["new", options.activatedAt]); pending.push("generation");
      }
      if (step === "cohort" || step === "marker") pending.push(step);
      return { rows: step === "generation-verify" ? [{ generation_id: "new",
        activated_at: String(options.activatedAt + (outcome === "conflict" ? 1 : 0)) }] : [], rowCount: 1 };
    }) };
    const connect = vi.fn().mockResolvedValue(client);
    const work = createPostgresUnitOfWork({ connect }, { statementTimeoutMs: 1000, lockTimeoutMs: 100 });
    ports.execute.mockImplementation((_command, _bundle, execution) => work.run(async tx => {
      parent = tx; const receipt = await execution.write(tx, "write-1");
      expect(receipt.writeId).toBe("write-1"); await tx.query("marker");
      return { phase: "postgres-written", activationEnabled: false, writeAuthorized: false };
    }));
    ports.apply.mockImplementation(async (_plan, execution) => {
      expect(execution.transaction).toBe(parent); await execution.transaction.query("cohort");
      if (outcome === "import") throw new Error("import"); return imported;
    });
    options.verifyGuardsInTransaction.mockImplementation(async (tx: PostgresTransaction) => {
      expect(tx).toBe(parent); order.push("guards");
      if (outcome === "final-guard" && pending.includes("cohort")) throw new Error("final-guard");
    });
    const result = executeAddressOnlyFirstPostgresWrite(options);
    if (outcome === "success") {
      await expect(result).resolves.toEqual({ phase: "postgres-written", activationEnabled: false, writeAuthorized: false });
      expect(durable).toEqual(["generation", "cohort", "marker"]);
      expect(order).toEqual(["BEGIN", "guards", "generation-insert", "generation-verify", "cohort", "guards", "marker", "COMMIT"]);
      expect(ports.execute.mock.calls[0]![0]).toEqual(options.command);
      expect(ports.execute.mock.calls[0]![1].activation).toEqual({ delivery: false, fomo: false, history: false, ownerMerge: false });
      expect(ports.apply.mock.calls[0]![1].capability).toEqual(options.capability);
      expect(ports.apply.mock.calls[0]![1]).not.toHaveProperty("permissions");
    } else {
      await expect(result).rejects.toThrow(outcome === "conflict" ? "generation_conflict" : outcome);
      expect(durable).toEqual([]); expect(order.at(-1)).toBe("ROLLBACK"); expect(order).not.toContain("COMMIT");
    }
    expect(connect).toHaveBeenCalledTimes(1); expect(client.release).toHaveBeenCalledTimes(1);
  });

// Generation registration consumes the same SQL and elapsed-time allowance as the import.
test.each(["maximumQueriesPerTransaction", "maximumTotalQueries"])(
  "reserves both generation statements before writing: %s", async key => {
    const options = input(), parent = transaction(); options.budget[key] = 2;
    ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
    await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow("query_budget_exceeded");
    expect(parent.query).not.toHaveBeenCalled(); expect(ports.apply).not.toHaveBeenCalled();
  });

test.each(["guards", "authorize", "insert", "verify", "import", "final-guards"])(
  "rejects cumulative elapsed-time exhaustion during %s", async step => {
    const options = input(), parent = transaction();
    const expire = () => vi.mocked(Date.now).mockReturnValue(options.activatedAt + options.budget.maximumTransactionMs);
    if (step === "guards") options.verifyGuardsInTransaction.mockImplementationOnce(async () => { expire(); });
    if (step === "authorize") options.assertAuthorized.mockImplementation(async () => { expire(); });
    if (step === "insert" || step === "verify") parent.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith(step === "insert" ? "INSERT" : "SELECT")) expire();
      return { rows: [{ generation_id: "new", activated_at: options.activatedAt }], rowCount: 1 };
    });
    if (step === "import") ports.apply.mockImplementation(async () => { expire(); return imported; });
    if (step === "final-guards") options.verifyGuardsInTransaction
      .mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { expire(); });
    ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
    await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow("transaction_deadline");
    if (["guards", "authorize"].includes(step)) expect(parent.query).not.toHaveBeenCalled();
    if (!["import", "final-guards"].includes(step)) expect(ports.apply).not.toHaveBeenCalled();
  });

test.each(["deadline", "capability"])("checks %s before and after each generation SQL", async kind => {
  for (const boundary of ["before-insert", "after-insert", "after-verify"]) {
    const options = input(), parent = transaction();
    vi.mocked(Date.now).mockReturnValue(options.activatedAt);
    const expires = options.activatedAt + 100;
    if (kind === "deadline") options.budget.deadlineAtMs = expires;
    else options.capability.expiresAtMs = expires;
    const expire = () => vi.mocked(Date.now).mockReturnValue(expires);
    if (boundary === "before-insert") options.assertAuthorized.mockImplementation(async () => { expire(); });
    parent.query.mockImplementation(async (sql: string) => {
      if (boundary === "after-insert" && sql.startsWith("INSERT")
        || boundary === "after-verify" && sql.startsWith("SELECT")) expire();
      return { rows: [{ generation_id: "new", activated_at: options.activatedAt }], rowCount: 1 };
    });
    ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
    await expect(executeAddressOnlyFirstPostgresWrite(options)).rejects.toThrow(
      kind === "deadline" ? "deadline_exceeded" : "capability_expired");
    expect(parent.query).toHaveBeenCalledTimes(boundary === "before-insert" ? 0 : boundary === "after-insert" ? 1 : 2);
    expect(ports.apply).not.toHaveBeenCalled();
  }
});

test("passes remaining budgets on the same parent and accounts for registration in the receipt", async () => {
  const options = input(), parent = transaction(); let now = options.activatedAt;
  vi.mocked(Date.now).mockImplementation(() => now);
  parent.query.mockImplementation(async (sql: string) => {
    now += sql.startsWith("INSERT") ? 20 : 30;
    return { rows: [{ generation_id: "new", activated_at: options.activatedAt }], rowCount: 1 };
  });
  ports.apply.mockImplementation(async (_plan, execution) => {
    expect(execution.transaction).toBe(parent);
    expect(execution.budget).toEqual({ ...options.budget, maximumQueriesPerTransaction: 98,
      maximumTotalQueries: 98, maximumTransactionMs: 950, deadlineAtMs: options.activatedAt + 1000 });
    now += 40; return imported;
  });
  options.verifyGuardsInTransaction.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { now += 10; });
  ports.execute.mockImplementation((_command, _bundle, execution) => execution.write(parent, "write-1"));
  const receipt = await executeAddressOnlyFirstPostgresWrite(options);
  expect(Object.keys(receipt).sort()).toEqual([
    "deliveryGuardSha256", "providerGuardSha256", "receiptSha256", "writeId",
  ]);
  expect(receipt.writeId).toBe("write-1");
  const digestInput = { importId: options.plan.importId, generationId: options.plan.generationId,
    activatedAt: options.activatedAt, planSha256: options.plan.planSha256, source: options.plan.source };
  expect(receipt.receiptSha256).toBe(migrationCutoverDigest({ ...digestInput,
    imported: { ...imported, queries: 14, elapsedMs: 100 } }, 2));
  expect(receipt.receiptSha256).not.toBe(migrationCutoverDigest({ ...digestInput, imported }, 2));
  expect(receipt.receiptSha256).not.toBe(migrationCutoverDigest({ ...digestInput,
    imported: { ...imported, elapsedMs: 100 } }, 2));
  expect(receipt.receiptSha256).not.toBe(migrationCutoverDigest({ ...digestInput,
    imported: { ...imported, queries: 14, elapsedMs: 90 } }, 2));
  expect(options.budget.maximumTotalQueries).toBe(100);
  expect(parent.query).toHaveBeenCalledTimes(2);
});
