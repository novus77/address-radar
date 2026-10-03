import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime, createPostgresForwardTraderCapabilityWorkRepository } from "@address-radar/database";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL, seedCapabilityWorkFixture, verifyPostgresTraderCapabilityWorkAcceptance } from "../src/postgres-trader-capability-work-acceptance.js";
import { consumePostgresForwardTraderCapability } from "../src/forward-trader-capability-consumer.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const suite = connectionString ? describe : describe.skip;
function runtime(maximumConnections = 1) {
  return createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections, connectionTimeoutMs: 2000,
    idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 1000 });
}
suite("forward capability work with real PostgreSQL", () => {
  it("fences replacement/expiry, wakes screening and recomputes aging with atomic receipts", async () => {
    const database = runtime();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const report = await verifyPostgresTraderCapabilityWorkAcceptance(database, 1_750_000_000_000 + attempt);
        expect(report).toMatchObject({ versions: 5, receipts: 7, wakeLinks: 8, requests: 14, cleanupVerified: true,
          obsoleteLeaseRejected: true, expiredProjectionRolledBack: true, sampleBudgetDeferredWithoutReceipt: true,
          screeningWakeVerified: true, agingRecomputed: true, clockRefreshDeduplicated: true, businessActivation: false });
      }
    } finally { await database.close(); }
  });
  it("rolls back projections and fixture tables if receipt persistence is interrupted", async () => {
    const database = runtime();
    try {
      const interrupted = { probe: () => database.probe(), run: database.run.bind(database) };
      interrupted.run = operation => database.run(transaction => operation({ query: (sql, values) => {
        if (sql.includes("INSERT INTO forward_trader_capability_work_receipts")) throw new Error("Receipt interruption");
        return transaction.query(sql, values);
      } }));
      await expect(verifyPostgresTraderCapabilityWorkAcceptance(interrupted, 1_750_000_000_000)).rejects.toThrow("Receipt interruption");
      const tables = await database.run(transaction => transaction.query("SELECT to_regclass('forward_capability_jobs') AS jobs,to_regclass('forward_trader_capability_heads') AS heads"));
      expect(tables.rows[0]).toEqual({ jobs: null, heads: null });
    } finally { await database.close(); }
  });
  it("claims different subjects on two connections without duplicate receipts", async () => {
    const database = runtime(2); const schema = `capability_test_${randomUUID().replaceAll("-", "")}`;
    const now = 1_750_000_000_000;
    try {
      await database.run(transaction => transaction.query(`CREATE SCHEMA ${schema}`));
      const run: typeof database.run = operation => database.run(async transaction => {
        await transaction.query(`SET LOCAL search_path TO ${schema}`); return operation(transaction);
      });
      await run(async transaction => {
        await transaction.query(CAPABILITY_WORK_FIXTURE_SCHEMA_SQL); await seedCapabilityWorkFixture(transaction, now);
        expect(await createPostgresForwardTraderCapabilityWorkRepository(transaction).scheduleSamples(now + 3, 10)).toBe(3);
      });
      const [first, second] = await Promise.all([
        run(transaction => createPostgresForwardTraderCapabilityWorkRepository(transaction).claim({ owner: "first", now: now + 4, leaseMs: 1000 })),
        run(transaction => createPostgresForwardTraderCapabilityWorkRepository(transaction).claim({ owner: "second", now: now + 4, leaseMs: 1000 })),
      ]);
      expect(first).not.toBeNull(); expect(second).not.toBeNull(); expect(first!.entityId).not.toBe(second!.entityId);
      await Promise.all([first!, second!].map(lease => run(transaction => consumePostgresForwardTraderCapability(transaction, lease,
        { now: () => now + 5, maximumSamples: 10, retryDelayMs: 100 }))));
      const result = await run(transaction => transaction.query("SELECT count(*) AS n FROM forward_trader_capability_work_receipts"));
      expect(Number(result.rows[0]!.n)).toBe(2);
    } finally {
      await database.run(transaction => transaction.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)); await database.close();
    }
  });
});
