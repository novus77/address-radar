import {
  createPostgresAcceptanceRuntime, createPostgresCaptureRepository,
  createPostgresNormalizationRepository, createPostgresForwardPurchaseRepository,
  createPostgresForwardOpportunityRepository, POSTGRES_CAPTURE_INBOX_SCHEMA_SQL,
  POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
} from "@address-radar/database";
import { type ForwardPeakEvidence } from "@address-radar/domain";
import { evaluateForwardOpportunity } from "@address-radar/scoring";

type AcceptanceRuntime = Pick<ReturnType<typeof createPostgresAcceptanceRuntime>, "probe" | "run">;

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function verifyPostgresOpportunityAcceptance(runtime: AcceptanceRuntime, now: number) {
  await runtime.probe();
  const rollback = new Error("Synthetic opportunity acceptance rollback");
  let totals: { peakRevisions: number; evaluations: number; downstreamIntents: number } | undefined;
  try {
    await runtime.run(async (transaction) => {
      await transaction.query("SET LOCAL search_path TO pg_temp, pg_catalog");
      const schemas = [POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
        POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL].join("\n");
      await transaction.query(schemas.replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      const capture = await createPostgresCaptureRepository(transaction, { maximumPayloadBytes: 65536 }).append({
        sourceNamespace: "opportunity-acceptance", sourceEventId: "fixture-event",
        collectorId: "fixture-collector", sessionId: "fixture-session", receivedAt: now,
        scrubbedPayload: "{}", semanticPayload: "{}",
      });
      const normalization = createPostgresNormalizationRepository(transaction, 65536);
      const sourceJobId = await normalization.request({ sourceNamespace: "opportunity-acceptance",
        sourceEventId: "fixture-event", semanticFingerprint: capture.semanticFingerprint,
        parserVersion: "fixture-parser", requestedAt: now });
      const lease = await normalization.claim({ owner: "fixture-normalizer", now, leaseMs: 60000 });
      requireCondition(lease, "Fixture normalization lease missing");
      await normalization.complete(lease, { eventKind: "buy", sourceUserId: "fixture-account",
        entityId: null, chain: "base", tokenAddress: "0xabc", occurredAt: now, normalizedPayload: "{}" }, now);
      const purchases = createPostgresForwardPurchaseRepository(transaction);
      await purchases.registerGeneration({ generationId: "fixture-generation", activatedAt: now });
      const purchase = await purchases.record({ generationId: "fixture-generation", sourceJobId, recordedAt: now,
        purchase: { executionKey: "fixture-execution", chain: "base", tokenAddress: "0xabc",
          entityId: "fixture-entity", sourceUserId: "fixture-account", occurredAt: now,
          tokenQuantity: "5000", quoteAsset: "USDC", quoteAmount: "50", amountUsd: "50",
          entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
          executionEvidenceRef: "fixture:execution", ownershipEvidenceRef: "fixture:ownership" } });
      requireCondition("sampleId" in purchase && purchase.sampleId, "Qualified sample missing");
      const repository = createPostgresForwardOpportunityRepository(transaction);
      const sample = await repository.getSample(purchase.sampleId);
      requireCondition(sample, "Stored sample missing");
      const peak: ForwardPeakEvidence = { peakId: "fixture-peak", revisionId: "v1", kind: "trade",
        chain: "base", tokenAddress: "0xabc", priceUsd: "0.03", verification: "validated",
        evidenceRef: "fixture:market-trade", occurredAt: now + 1, knownAt: now + 1 };
      await repository.recordPeak(peak);
      const three = evaluateForwardOpportunity({ sample, peaks: [peak], asOf: now + 2 });
      requireCondition(three.tier === 3, "Exact 3x evidence missing");
      requireCondition((await repository.saveEvaluation(three)).status === "stored", "3x head not stored");
      await repository.recordPeak({ ...peak, knownAt: now + 2 });
      requireCondition((await repository.saveEvaluation({ ...three, computedAt: now + 3 })).status === "duplicate",
        "Timestamp refresh expanded opportunity work");
      const five: ForwardPeakEvidence = { ...peak, revisionId: "v2", priceUsd: "0.05",
        evidenceRef: "fixture:corrected-market-trade", knownAt: now + 3 };
      await repository.recordPeak(five);
      requireCondition((await repository.saveEvaluation(evaluateForwardOpportunity({ sample, peaks: [five],
        asOf: now + 4 }))).status === "stored", "5x revision not stored");
      const pending: ForwardPeakEvidence = { ...peak, revisionId: "v3", priceUsd: "0.02",
        verification: "pending_review", knownAt: now + 5 };
      await repository.recordPeak(pending);
      requireCondition((await repository.saveEvaluation(evaluateForwardOpportunity({ sample, peaks: [pending],
        asOf: now + 6 }))).status === "retained_head", "Incomplete input downgraded proven head");
      let conflictRejected = false;
      try { await repository.recordPeak({ ...peak, priceUsd: "0.04" }); }
      catch (error) { conflictRejected = error instanceof Error && error.message.includes("Immutable"); }
      requireCondition(conflictRejected, "Immutable revision conflict was accepted");
      requireCondition((await repository.saveEvaluation({ ...three, executionFingerprint: "stale-execution" })).status
        === "stale_execution", "Old execution version changed current opportunity");
      let forgedRejected = false;
      try { await repository.saveEvaluation({ ...three, tier: 5, computedAt: now + 7 }); }
      catch { forgedRejected = true; }
      requireCondition(forgedRejected, "Unsupported 5x claim accepted");
      const head = await transaction.query("SELECT e.tier FROM forward_opportunity_heads h JOIN forward_opportunity_evaluations e ON e.evaluation_id=h.evaluation_id");
      requireCondition(head.rows.length === 1 && head.rows[0]?.tier === 5, "Current proven 5x head lost");
      const counts = await transaction.query("SELECT (SELECT count(*) FROM forward_peak_evidence)::int AS peaks, (SELECT count(*) FROM forward_opportunity_evaluations)::int AS evaluations, (SELECT count(*) FROM forward_opportunity_intents)::int AS intents");
      const row = counts.rows[0];
      requireCondition(row?.peaks === 3 && row.evaluations === 3 && row.intents === 2,
        "Unexpected opportunity audit or downstream intent totals");
      totals = { peakRevisions: 3, evaluations: 3, downstreamIntents: 2 };
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_opportunity_evaluations') AS remaining"));
  requireCondition(cleanup.rows[0]?.remaining === null && totals, "Synthetic fixture cleanup not verified");
  return { fixtureScope: "synthetic_transaction_rollback" as const, ...totals, currentTier: 5,
    timestampRefreshDeduplicated: true, staleExecutionRejected: true, immutableConflictRejected: true,
    unsupportedTierRejected: true, provenHeadRetained: true, cleanupVerified: true,
    businessActivation: false, liveSourceCoverageVerified: false };
}
