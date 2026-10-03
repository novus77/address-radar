import { createPostgresAcceptanceRuntime, createPostgresCaptureRepository, createPostgresNormalizationRepository,
  createPostgresForwardPurchaseRepository, createPostgresForwardOpportunityRepository,
  createPostgresForwardOpportunityWorkRepository, createPostgresForwardOpportunityFanoutRepository,
  ForwardPeakFanoutLeaseLostError, POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
  POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
  POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_FANOUT_SCHEMA_SQL } from "@address-radar/database";
import type { ForwardPeakEvidence } from "@address-radar/domain";
import { consumePostgresForwardOpportunity } from "./forward-opportunity-worker.js";
import { recordPostgresForwardPeakAndWake, reconcilePostgresForwardOpportunities } from "./forward-opportunity-reconciliation.js";

type Runtime = Pick<ReturnType<typeof createPostgresAcceptanceRuntime>, "probe" | "run">;
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function verifyPostgresOpportunityFanoutAcceptance(runtime: Runtime, now: number) {
  await runtime.probe();
  const rollback = new Error("Synthetic opportunity fanout rollback");
  let verified = false;
  try {
    await runtime.run(async (transaction) => {
      await transaction.query("SET LOCAL search_path TO pg_temp, pg_catalog");
      await transaction.query([POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
        POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
        POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_FANOUT_SCHEMA_SQL]
        .join("\n").replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      const purchases = createPostgresForwardPurchaseRepository(transaction);
      await purchases.registerGeneration({ generationId: "fixture-generation", activatedAt: now });
      const seed = async (index: number, recordedAt: number) => {
        const sourceEventId = `fixture-event-${index}`;
        const sourceUserId = `fixture-account-${index}`;
        const capture = await createPostgresCaptureRepository(transaction, { maximumPayloadBytes: 65536 }).append({
          sourceNamespace: "fanout-acceptance", sourceEventId, collectorId: "fixture-collector", sessionId: "fixture-session",
          receivedAt: recordedAt, scrubbedPayload: "{}", semanticPayload: "{}" });
        const normalization = createPostgresNormalizationRepository(transaction, 65536);
        const jobId = await normalization.request({ sourceNamespace: "fanout-acceptance", sourceEventId,
          semanticFingerprint: capture.semanticFingerprint, parserVersion: "fixture-parser", requestedAt: recordedAt });
        const lease = await normalization.claim({ owner: "fixture-normalizer", now: recordedAt, leaseMs: 60000 });
        requireCondition(lease, "Fixture source lease missing");
        await normalization.complete(lease, { eventKind: "buy", sourceUserId, entityId: null, chain: "base",
          tokenAddress: "0xabc", occurredAt: now, normalizedPayload: "{}" }, recordedAt);
        const purchase = await purchases.record({ generationId: "fixture-generation", sourceJobId: jobId, recordedAt,
          purchase: { executionKey: `fixture-execution-${index}`, chain: "base", tokenAddress: "0xabc",
            entityId: `fixture-entity-${index}`, sourceUserId, occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC",
            quoteAmount: "50", amountUsd: "50", entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
            executionEvidenceRef: `fixture:execution:${index}`, ownershipEvidenceRef: `fixture:ownership:${index}` } });
        requireCondition(purchase.sampleId, "Fixture sample missing");
      };
      for (let index = 0; index < 4; index++) await seed(index, now);
      const evidence = createPostgresForwardOpportunityRepository(transaction);
      const work = createPostgresForwardOpportunityWorkRepository(transaction);
      const fanout = createPostgresForwardOpportunityFanoutRepository(transaction);
      const peak: ForwardPeakEvidence = { peakId: "fixture-peak", revisionId: "v1", kind: "trade", chain: "base",
        tokenAddress: "0xabc", priceUsd: "0.03", verification: "validated", evidenceRef: "fixture:market",
        occurredAt: now + 1, knownAt: now + 1 };
      // Simulate an existing fact whose producer wakeup was omitted before reconciliation.
      await evidence.recordPeak(peak);
      const repaired = await reconcilePostgresForwardOpportunities(transaction, { now: now + 1, sampleLimit: 10, peakLimit: 10 });
      requireCondition(repaired.sampleRequests === 4 && repaired.peakFanouts === 1, "Reconciliation missed durable inputs");
      const claim = async (at: number, leaseMs = 60000) => {
        const lease = await fanout.claim({ owner: "fixture-fanout", now: at, leaseMs });
        requireCondition(lease, "Fixture fanout lease missing"); return lease;
      };
      for (const expected of [2, 2, 0]) {
        const page = await fanout.dispatch(await claim(now + 1), { now: () => now + 1, limit: 2 });
        requireCondition(page.examined === expected && page.scheduled === expected, "Fanout cursor missed or duplicated a sample");
        requireCondition(page.completed === (expected === 0), "Fanout finished before the final page");
      }
      const drain = async (at: number, tier: number) => {
        let count = 0;
        for (let attempt = 0; attempt < 10; attempt++) {
          const lease = await work.claim({ owner: "fixture-worker", now: at, leaseMs: 60000 });
          if (!lease) break;
          const result = await consumePostgresForwardOpportunity(transaction, lease, { now: at, retryAt: at + 1000 });
          requireCondition(result.status === "evaluated" && result.tier === tier, "Fanout did not produce its evidence-backed opportunity");
          count++;
        }
        return count;
      };
      requireCondition(await drain(now + 1, 3) === 4, "Four 3x samples were not evaluated");
      const duplicate = await recordPostgresForwardPeakAndWake(transaction, { peak: { ...peak, knownAt: now + 2 }, now: now + 2 });
      requireCondition(duplicate.fanout === "duplicate" && await fanout.claim({ owner: "fixture-fanout", now: now + 2, leaseMs: 60000 }) === null,
        "Timestamp refresh reopened completed fanout");
      await recordPostgresForwardPeakAndWake(transaction, { peak: { ...peak, revisionId: "v2", priceUsd: "0.05", knownAt: now + 2 }, now: now + 2 });
      const first = await fanout.dispatch(await claim(now + 2), { now: () => now + 2, limit: 2 });
      requireCondition(first.scheduled === 2 && !first.completed, "New peak did not start bounded fanout");
      const expired = await claim(now + 2, 1);
      let rejected = false;
      try { await fanout.dispatch(expired, { now: () => now + 3, limit: 2 }); }
      catch (error) { rejected = error instanceof ForwardPeakFanoutLeaseLostError; }
      requireCondition(rejected, "Expired fanout lease advanced its cursor");
      const recovered = await claim(now + 3);
      requireCondition(recovered.claimGeneration > expired.claimGeneration, "Fanout reclaim did not advance generation");
      const second = await fanout.dispatch(recovered, { now: () => now + 3, limit: 2 });
      requireCondition(second.scheduled === 2 && !second.completed, "Fanout reclaim lost its committed cursor");
      requireCondition((await fanout.dispatch(await claim(now + 3), { now: () => now + 3, limit: 2 })).completed, "Fanout did not finish");
      requireCondition(await drain(now + 3, 5) === 4, "Four upgraded samples were not reevaluated");
      await seed(4, now + 4);
      const late = await reconcilePostgresForwardOpportunities(transaction, { now: now + 4, sampleLimit: 10, peakLimit: 10 });
      requireCondition(late.sampleRequests === 1 && late.peakFanouts === 0, "Late sample restarted old fanout");
      requireCondition(await drain(now + 4, 5) === 1, "Late sample missed already persisted within-window peaks");
      const unchanged = await reconcilePostgresForwardOpportunities(transaction, { now: now + 5, sampleLimit: 10, peakLimit: 10 });
      requireCondition(unchanged.sampleRequests === 0 && unchanged.peakFanouts === 0, "Clock-only reconciliation expanded work");
      const counts = await transaction.query("SELECT (SELECT count(*) FROM forward_peak_fanout_jobs WHERE status='completed')::int AS fanouts, (SELECT count(*) FROM forward_opportunity_requests)::int AS requests, (SELECT count(*) FROM forward_opportunity_work_receipts)::int AS receipts, (SELECT count(*) FROM forward_opportunity_evaluations)::int AS evaluations, (SELECT count(*) FROM forward_opportunity_intents)::int AS intents");
      const row = counts.rows[0];
      requireCondition(row?.fanouts === 2 && row.requests === 13 && row.receipts === 9 && row.evaluations === 9 && row.intents === 9,
        "Bounded fanout or reconciliation produced unexpected totals");
      verified = true;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_peak_fanout_jobs') AS remaining"));
  requireCondition(verified && cleanup.rows[0]?.remaining === null, "Synthetic fanout cleanup not verified");
  return { fixtureScope: "synthetic_transaction_rollback" as const, completedFanouts: 2, samples: 5,
    requests: 13, receipts: 9, evaluations: 9, downstreamIntents: 9, durableCursorVerified: true,
    expiredLeaseRejected: true, lostWakeupRepaired: true, lateSampleVerified: true,
    timestampRefreshDeduplicated: true, cleanupVerified: true, businessActivation: false, liveSourceCoverageVerified: false };
}
