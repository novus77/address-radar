import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPostgresAcceptanceRuntime, createPostgresCaptureRepository, createPostgresNormalizationRepository,
  createPostgresForwardPurchaseRepository, createPostgresForwardOpportunityWorkRepository,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL,
} from "@address-radar/database";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("opportunity admission lock order", () => {
  it("skips a sample locked by a concurrent producer instead of locking its outbox first", async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 2,
      connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
    const schema = `opportunity_lock_${randomUUID().replaceAll("-", "")}`;
    const now = 1700000000000;
    let unlock: () => void = () => {};
    let locked: () => void = () => {};
    const unlocked = new Promise<void>((resolve) => { unlock = resolve; });
    const sampleLocked = new Promise<void>((resolve) => { locked = resolve; });
    let holder: Promise<void> | undefined;
    let sampleId: string;
    try {
      sampleId = await runtime.run(async (transaction) => {
        await transaction.query(`CREATE SCHEMA "${schema}"`);
        await transaction.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await transaction.query([POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
          POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
          POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL].join("\n"));
        const capture = await createPostgresCaptureRepository(transaction, { maximumPayloadBytes: 65536 }).append({
          sourceNamespace: "lock-order-fixture", sourceEventId: "fixture-event", collectorId: "fixture-collector",
          sessionId: "fixture-session", receivedAt: now, scrubbedPayload: "{}", semanticPayload: "{}" });
        const normalization = createPostgresNormalizationRepository(transaction, 65536);
        const jobId = await normalization.request({ sourceNamespace: "lock-order-fixture", sourceEventId: "fixture-event",
          semanticFingerprint: capture.semanticFingerprint, parserVersion: "fixture-parser", requestedAt: now });
        const lease = await normalization.claim({ owner: "fixture-normalizer", now, leaseMs: 60000 });
        if (!lease) throw new Error("Fixture normalization lease missing");
        await normalization.complete(lease, { eventKind: "buy", sourceUserId: "fixture-account", entityId: null,
          chain: "base", tokenAddress: "0xabc", occurredAt: now, normalizedPayload: "{}" }, now);
        const purchases = createPostgresForwardPurchaseRepository(transaction);
        await purchases.registerGeneration({ generationId: "fixture-generation", activatedAt: now });
        const purchase = await purchases.record({ generationId: "fixture-generation", sourceJobId: jobId, recordedAt: now,
          purchase: { executionKey: "fixture-execution", chain: "base", tokenAddress: "0xabc", entityId: "fixture-entity",
            sourceUserId: "fixture-account", occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC", quoteAmount: "50",
            amountUsd: "50", entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
            executionEvidenceRef: "fixture:execution", ownershipEvidenceRef: "fixture:ownership" } });
        if (!purchase.sampleId) throw new Error("Fixture sample missing");
        return purchase.sampleId;
      });
      holder = runtime.run(async (transaction) => {
        await transaction.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await transaction.query("SELECT sample_id FROM forward_purchase_samples WHERE sample_id=$1 FOR UPDATE", [sampleId]);
        locked();
        await unlocked;
        await createPostgresForwardOpportunityWorkRepository(transaction).request({ sampleId,
          executionFingerprint: String((await transaction.query("SELECT execution_fingerprint FROM forward_purchase_samples WHERE sample_id=$1", [sampleId])).rows[0]?.execution_fingerprint),
          trigger: { kind: "sample_created" }, requestedAt: now });
      });
      await Promise.race([sampleLocked, holder.then(() => { throw new Error("Fixture producer ended before locking"); })]);
      const admitted = await runtime.run(async (transaction) => {
        await transaction.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        return createPostgresForwardOpportunityWorkRepository(transaction).scheduleSamples(now, 10);
      });
      expect(admitted).toBe(0);
      unlock(); await holder;
      const counts = await runtime.run(async (transaction) => {
        await transaction.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        return transaction.query("SELECT (SELECT count(*) FROM forward_opportunity_jobs)::int AS jobs, (SELECT count(*) FROM forward_opportunity_requests)::int AS requests");
      });
      expect(counts.rows[0]).toEqual({ jobs: 1, requests: 1 });
    } finally {
      unlock();
      if (holder) await holder.catch(() => undefined);
      try { await runtime.run((transaction) => transaction.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)); }
      finally { await runtime.close(); }
    }
  });
});
