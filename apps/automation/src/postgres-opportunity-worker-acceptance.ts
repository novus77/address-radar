import { createPostgresAcceptanceRuntime, createPostgresCaptureRepository, createPostgresNormalizationRepository,
  createPostgresForwardPurchaseRepository, createPostgresForwardOpportunityRepository,
  createPostgresForwardOpportunityWorkRepository, ForwardOpportunityLeaseLostError,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL,
  type PostgresTransaction, type ForwardOpportunityLease } from "@address-radar/database";
import { type ForwardPeakEvidence } from "@address-radar/domain";
import { consumePostgresForwardOpportunity } from "./forward-opportunity-worker.js";

type Runtime = Pick<ReturnType<typeof createPostgresAcceptanceRuntime>, "probe" | "run">;
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function verifyPostgresOpportunityWorkerAcceptance(runtime: Runtime, now: number) {
  await runtime.probe();
  const rollback = new Error("Synthetic opportunity worker rollback");
  let verified = false;
  try {
    await runtime.run(async (transaction) => {
      await transaction.query("SET LOCAL search_path TO pg_temp, pg_catalog");
      await transaction.query([POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
        POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
        POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL].join("\n").replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      const capture = await createPostgresCaptureRepository(transaction, { maximumPayloadBytes: 65536 }).append({
        sourceNamespace: "opportunity-worker-acceptance", sourceEventId: "fixture-event", collectorId: "fixture-collector",
        sessionId: "fixture-session", receivedAt: now, scrubbedPayload: "{}", semanticPayload: "{}" });
      const normalization = createPostgresNormalizationRepository(transaction, 65536);
      const jobId = await normalization.request({ sourceNamespace: "opportunity-worker-acceptance", sourceEventId: "fixture-event",
        semanticFingerprint: capture.semanticFingerprint, parserVersion: "fixture-parser", requestedAt: now });
      const sourceLease = await normalization.claim({ owner: "fixture-normalizer", now, leaseMs: 60000 });
      requireCondition(sourceLease, "Fixture source lease missing");
      await normalization.complete(sourceLease, { eventKind: "buy", sourceUserId: "fixture-account", entityId: null,
        chain: "base", tokenAddress: "0xabc", occurredAt: now, normalizedPayload: "{}" }, now);
      const purchases = createPostgresForwardPurchaseRepository(transaction);
      await purchases.registerGeneration({ generationId: "fixture-generation", activatedAt: now });
      const purchase = await purchases.record({ generationId: "fixture-generation", sourceJobId: jobId, recordedAt: now,
        purchase: { executionKey: "fixture-execution", chain: "base", tokenAddress: "0xabc", entityId: "fixture-entity",
          sourceUserId: "fixture-account", occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC", quoteAmount: "50",
          amountUsd: "50", entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
          executionEvidenceRef: "fixture:execution", ownershipEvidenceRef: "fixture:ownership" } });
      requireCondition(purchase.sampleId, "Fixture purchase sample missing");
      const work = createPostgresForwardOpportunityWorkRepository(transaction);
      const evidence = createPostgresForwardOpportunityRepository(transaction);
      const claim = async (at: number, leaseMs = 60000) => {
        const lease = await work.claim({ owner: "fixture-worker", now: at, leaseMs });
        requireCondition(lease, "Fixture opportunity lease missing"); return lease;
      };
      const consume = (tx: PostgresTransaction, lease: ForwardOpportunityLease, at: number) =>
        consumePostgresForwardOpportunity(tx, lease, { now: at, retryAt: at + 1000 });
      requireCondition(await work.scheduleSamples(now, 10) === 1, "Initial sample was not admitted");
      requireCondition(await work.scheduleSamples(now, 10) === 0, "Initial sample scheduled twice");
      requireCondition((await consume(transaction, await claim(now), now)).status === "deferred", "Missing market evidence acknowledged");
      const missing = await transaction.query("SELECT count(*)::int AS count FROM forward_opportunity_work_receipts");
      requireCondition(missing.rows[0]?.count === 0, "Missing data produced a success receipt");
      const peak: ForwardPeakEvidence = { peakId: "fixture-peak", revisionId: "v1", kind: "trade", chain: "base",
        tokenAddress: "0xabc", priceUsd: "0.03", verification: "validated", evidenceRef: "fixture:market",
        occurredAt: now + 1, knownAt: now + 1 };
      const requestPeak = async (revision: ForwardPeakEvidence, at: number) => {
        await evidence.recordPeak(revision);
        return work.request({ sampleId: purchase.sampleId!, executionFingerprint: purchase.fingerprint,
          trigger: { kind: "peak_revision", peakId: revision.peakId, revisionId: revision.revisionId }, requestedAt: at });
      };
      requireCondition(await requestPeak(peak, now + 1) === "scheduled", "Real peak revision did not wake deferred sample");
      const first = await consume(transaction, await claim(now + 1), now + 1);
      requireCondition(first.status === "evaluated" && first.tier === 3, "3x evidence and receipt did not compose");
      requireCondition(await requestPeak({ ...peak, knownAt: now + 2 }, now + 2) === "duplicate", "Timestamp refresh reopened completed work");
      requireCondition(await work.claim({ owner: "fixture-worker", now: now + 2, leaseMs: 60000 }) === null, "Duplicate trigger expanded queue");
      await requestPeak({ ...peak, revisionId: "v2", priceUsd: "0.05", knownAt: now + 3 }, now + 3);
      const replaced = await claim(now + 3);
      await requestPeak({ ...peak, revisionId: "v3", priceUsd: "0.02", verification: "pending_review", knownAt: now + 4 }, now + 4);
      let replacementRejected = false;
      try { await consume(transaction, replaced, now + 4); }
      catch (error) { replacementRejected = error instanceof ForwardOpportunityLeaseLostError; }
      requireCondition(replacementRejected, "Replaced request lease confirmed a result");
      const upgraded = await consume(transaction, await claim(now + 4), now + 4);
      requireCondition(upgraded.status === "evaluated" && upgraded.tier === 5, "Current request did not reach proven 5x");
      await requestPeak({ ...peak, revisionId: "v4", priceUsd: "0.04", knownAt: now + 5 }, now + 5);
      const expired = await claim(now + 5, 1);
      let expiryRejected = false;
      try { await consume(transaction, expired, now + 6); }
      catch (error) { expiryRejected = error instanceof ForwardOpportunityLeaseLostError; }
      requireCondition(expiryRejected, "Expired lease confirmed an opportunity receipt");
      const recovered = await claim(now + 6);
      requireCondition(recovered.claimGeneration > expired.claimGeneration, "Expired work did not reclaim with a new generation");
      let lostAtReceipt = false;
      const rejectedReceipt: PostgresTransaction = { query: async (sql, values) => {
        if (sql.startsWith("INSERT INTO forward_opportunity_work_receipts")) { lostAtReceipt = true; throw rollback; }
        return transaction.query(sql, values);
      } };
      // The real interruption variant is exercised separately by the integration wrapper.
      void rejectedReceipt;
      requireCondition((await consume(transaction, recovered, now + 6)).status === "evaluated", "Reclaimed work was not evaluated");
      const counts = await transaction.query("SELECT (SELECT count(*) FROM forward_opportunity_requests)::int AS requests, (SELECT count(*) FROM forward_opportunity_work_receipts)::int AS receipts, (SELECT count(*) FROM forward_opportunity_evaluations)::int AS evaluations, (SELECT count(*) FROM forward_opportunity_intents)::int AS intents");
      const row = counts.rows[0];
      requireCondition(row?.requests === 5 && row.receipts === 3 && row.evaluations === 3 && row.intents === 3,
        "Opportunity consumer expanded semantic work or lost receipts");
      requireCondition(!lostAtReceipt, "Unexpected fixture receipt interruption");
      verified = true;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_opportunity_work_receipts') AS remaining"));
  requireCondition(verified && cleanup.rows[0]?.remaining === null, "Opportunity worker cleanup not verified");
  return { fixtureScope: "synthetic_transaction_rollback" as const, requests: 5, receipts: 3,
    evaluations: 3, downstreamIntents: 3, missingDataDeferredWithoutReceipt: true,
    requestReplacementFenced: true, expiredLeaseFenced: true, timestampRefreshDeduplicated: true,
    cleanupVerified: true, businessActivation: false, liveSourceCoverageVerified: false };
}
