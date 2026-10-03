import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresUnitOfWork, createPostgresNormalizationRepository, createPostgresConsumerWorkRepository,
  createPostgresForwardPurchaseRepository, createPostgresForwardTokenWatchRepository,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_CONSUMER_WORK_SCHEMA_SQL,
  POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL,
  type PostgresPool, type VerifiedForwardPurchase,
} from "@address-radar/database";
import { FORWARD_CAPTURE_EXTENSION_MS, FORWARD_OPPORTUNITY_WINDOW_MS } from "@address-radar/domain";
import { stagePostgresFomoMessage, normalizePostgresFomoLease } from "../src/postgres-fomo-normalization.js";
import { consumePostgresForwardToken, FORWARD_TOKEN_CONSUMER } from "../src/postgres-forward-token-consumer.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local test database");
  }
}
type TestPool = PostgresPool & { end(): Promise<void> };
const schema = "forward_token_test_" + randomUUID().replaceAll("-", "");
const now = Date.parse("2026-10-03T00:00:00Z");
const generationId = "forward-token-test";
const key = { generationId, chain: "base" as const, tokenAddress: "0xabc" };
const purchase = (changes: Partial<VerifiedForwardPurchase> = {}): VerifiedForwardPurchase => ({
  executionKey: "verified-fill-1", chain: "base", tokenAddress: "0xabc", entityId: "entity-1", sourceUserId: "account-1",
  occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC", quoteAmount: "50", amountUsd: "50",
  entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
  executionEvidenceRef: "execution:1", ownershipEvidenceRef: "ownership:1", ...changes,
});

describe.skipIf(!connectionString)("PostgreSQL forward token discovery", () => {
  let admin: TestPool | undefined;
  let pool: TestPool | undefined;
  let unit: ReturnType<typeof createPostgresUnitOfWork>;
  let schemaCreated = false;
  beforeAll(async () => {
    const driver = createRequire(import.meta.url)("pg") as { Pool: new (input: { connectionString: string; max: number; options?: string }) => TestPool };
    admin = new driver.Pool({ connectionString: connectionString!, max: 1 });
    const client = await admin.connect();
    try { await client.query("CREATE SCHEMA " + schema); schemaCreated = true; } finally { client.release(); }
    pool = new driver.Pool({ connectionString: connectionString!, max: 2, options: "-c search_path=" + schema });
    unit = createPostgresUnitOfWork(pool, { statementTimeoutMs: 3000, lockTimeoutMs: 1000 });
    await unit.run(tx => tx.query(POSTGRES_CAPTURE_INBOX_SCHEMA_SQL + POSTGRES_NORMALIZATION_SCHEMA_SQL +
      POSTGRES_CONSUMER_WORK_SCHEMA_SQL + POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL + POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL));
  });
  beforeEach(async () => {
    await unit.run(tx => tx.query("TRUNCATE capture_event_identities,forward_strategy_generations,forward_economic_trades CASCADE"));
    await unit.run(tx => createPostgresForwardPurchaseRepository(tx).registerGeneration({ generationId, activatedAt: now }));
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        if (schemaCreated) {
          const client = await admin.connect();
          try { await client.query("DROP SCHEMA " + schema + " CASCADE"); } finally { client.release(); }
        }
      } finally { await admin.end(); }
    }
  });
  async function source(id = "message-1") {
    await unit.run(tx => stagePostgresFomoMessage(tx, {
      sourceMessageId: id, sourceUrl: "wss://feed.example/live", approvedOrigins: ["wss://feed.example"],
      maximumPayloadBytes: 65536, collectorId: "collector-1", sessionId: "session-1", receivedAt: now,
      body: JSON.stringify({ type: "data", topicType: "trading_activity", payload: {
        tradeId: id, userId: "account-1", userHandle: "trader", tokenAddress: "0xAbC", networkId: 8453,
        type: "swap_buy", createdAt: new Date(now).toISOString(), usdAmount: 50, price: 0.01, marketCap: 90000,
      } }),
    }));
    const lease = await unit.run(tx => createPostgresNormalizationRepository(tx, 65536).claim({ owner: "normalizer", now, leaseMs: 60000 }));
    if (!lease) throw new Error("Missing normalization lease");
    await unit.run(tx => normalizePostgresFomoLease(tx, lease, { now, maximumPayloadBytes: 65536 }));
    return lease.jobId;
  }
  async function discover(id = "message-1") {
    const jobId = await source(id);
    await unit.run(tx => createPostgresConsumerWorkRepository(tx, FORWARD_TOKEN_CONSUMER).schedulePending(now, 100));
    const lease = await unit.run(tx => createPostgresConsumerWorkRepository(tx, FORWARD_TOKEN_CONSUMER).claim({ owner: "token-worker", now, leaseMs: 60000 }));
    if (!lease) throw new Error("Missing token consumer lease");
    await unit.run(tx => consumePostgresForwardToken(tx, lease, { generationId, now, retryAt: now + 300000 }));
    return { jobId, lease };
  }
  async function market(cap = "100000", occurredAt = now + 1000, id = "market-1") {
    return unit.run(tx => createPostgresForwardTokenWatchRepository(tx).recordMarket({
      ...key, sourceEventId: id, marketCapUsd: cap, occurredAt, now: occurredAt,
      verification: "validated", evidenceRef: "market-proof:" + id,
    }));
  }
  it("atomically discovers unresolved-wallet tokens before 100K and records a fenced receipt", async () => {
    await discover();
    const result = await unit.run(tx => tx.query("SELECT first_discovered_at,capture_until,screening_enabled_at FROM forward_token_watches"));
    expect(Number(result.rows[0]?.capture_until)).toBe(now + FORWARD_CAPTURE_EXTENSION_MS);
    expect(result.rows[0]?.screening_enabled_at).toBeNull();
    expect((await unit.run(tx => tx.query("SELECT outcome FROM capture_consumer_receipts"))).rows).toEqual([{ outcome: "produced" }]);
    expect((await unit.run(tx => tx.query("SELECT purpose FROM forward_token_watch_intents"))).rows).toEqual([{ purpose: "buyer_capture" }]);
  });
  it("does not extend discovery on repeated observations of the same token", async () => {
    await discover("message-1");
    await discover("message-2");
    const result = await unit.run(tx => tx.query("SELECT count(*)::int AS count FROM forward_token_watch_intents"));
    expect(result.rows[0]?.count).toBe(1);
    expect((await unit.run(tx => createPostgresForwardTokenWatchRepository(tx).get(key)))?.captureUntil).toBe(now + FORWARD_CAPTURE_EXTENSION_MS);
  });
  it("enables screening at the first verified 100K milestone and never extends for a refresh", async () => {
    await discover();
    const first = await market();
    expect(first.newTiers).toEqual([100000]);
    expect(first.watch.screeningEnabledAt).toBe(now + 1000);
    expect(first.watch.captureUntil).toBe(now + 1000 + FORWARD_CAPTURE_EXTENSION_MS);
    expect((await market()).status).toBe("duplicate");
    const refresh = await market("100001", now + 2000, "market-2");
    expect(refresh.newTiers).toEqual([]);
    expect(refresh.watch.captureUntil).toBe(first.watch.captureUntil);
  });
  it("extends only when new market-cap tiers are reached", async () => {
    await discover();
    await market();
    const higher = await market("300000", now + 2000, "market-2");
    expect(higher.newTiers).toEqual([200000, 300000]);
    expect(higher.watch.captureUntil).toBe(now + 2000 + FORWARD_CAPTURE_EXTENSION_MS);
    expect((await unit.run(tx => tx.query("SELECT count(*)::int AS count FROM forward_token_milestone_hits"))).rows[0]?.count).toBe(3);
  });
  it("defers unverified market evidence without unlocking screening", async () => {
    await discover();
    const result = await unit.run(tx => createPostgresForwardTokenWatchRepository(tx).recordMarket({
      ...key, sourceEventId: "market-1", marketCapUsd: "1000000", occurredAt: now, now,
      verification: "pending_review", evidenceRef: "unverified:1",
    }));
    expect(result.status).toBe("deferred");
    expect(result.watch.screeningEnabledAt).toBeNull();
    expect((await unit.run(tx => tx.query("SELECT count(*)::int AS count FROM forward_token_milestone_hits"))).rows[0]?.count).toBe(0);
  });
  it("rejects changed market event contents without overwriting the original", async () => {
    await discover();
    await market();
    await expect(market("200000")).rejects.toThrow("identity conflict");
    expect((await unit.run(tx => tx.query("SELECT market_cap_usd::text FROM forward_token_market_inputs"))).rows).toEqual([{ market_cap_usd: "100000" }]);
  });
  it("extends once for a verified 50U purchase with explicit target eligibility, retaining the 30-day sample", async () => {
    const { jobId } = await discover();
    const occurredAt = now + 2000;
    const trade = await unit.run(tx => createPostgresForwardPurchaseRepository(tx).record({
      generationId, sourceJobId: jobId, purchase: purchase({ occurredAt }), recordedAt: occurredAt,
    }));
    const input = { generationId, tradeId: trade.tradeId, now: occurredAt,
      eligibility: { entityId: "entity-1", kind: "manual_authorized" as const, evidenceRef: "grant:1" } };
    const result = await unit.run(tx => createPostgresForwardTokenWatchRepository(tx).extendForPurchase(input));
    expect(result.status).toBe("applied");
    expect(result.watch.captureUntil).toBe(occurredAt + FORWARD_CAPTURE_EXTENSION_MS);
    expect((await unit.run(tx => createPostgresForwardTokenWatchRepository(tx).extendForPurchase({ ...input, now: occurredAt + 1000 }))).status).toBe("duplicate");
    const sample = await unit.run(tx => tx.query("SELECT expires_at FROM forward_purchase_samples"));
    expect(Number(sample.rows[0]?.expires_at)).toBe(occurredAt + FORWARD_OPPORTUNITY_WINDOW_MS);
  });
  it("does not treat an unresolved or ungranted target as eligible", async () => {
    const { jobId } = await discover();
    const trade = await unit.run(tx => createPostgresForwardPurchaseRepository(tx).record({
      generationId, sourceJobId: jobId, purchase: purchase({ occurredAt: now + 2000 }), recordedAt: now + 2000,
    }));
    const result = await unit.run(tx => createPostgresForwardTokenWatchRepository(tx).extendForPurchase({
      generationId, tradeId: trade.tradeId, now: now + 2000, eligibility: null,
    }));
    expect(result.status).toBe("ineligible");
    expect(result.watch.captureUntil).toBe(now + FORWARD_CAPTURE_EXTENSION_MS);
  });
  it("rolls back discovery and intents when the consumer fence rejects completion", async () => {
    await source();
    await unit.run(tx => createPostgresConsumerWorkRepository(tx, FORWARD_TOKEN_CONSUMER).schedulePending(now, 100));
    const lease = await unit.run(tx => createPostgresConsumerWorkRepository(tx, FORWARD_TOKEN_CONSUMER).claim({ owner: "token-worker", now, leaseMs: 60000 }));
    if (!lease) throw new Error("Missing token consumer lease");
    await expect(unit.run(tx => consumePostgresForwardToken(tx, { ...lease, owner: "stale-worker" }, {
      generationId, now, retryAt: now + 300000,
    }))).rejects.toThrow("lease was lost");
    expect((await unit.run(tx => tx.query("SELECT count(*)::int AS count FROM forward_token_watches"))).rows[0]?.count).toBe(0);
    expect((await unit.run(tx => tx.query("SELECT count(*)::int AS count FROM forward_token_watch_intents"))).rows[0]?.count).toBe(0);
  });
});
