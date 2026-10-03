import { createPostgresAcceptanceRuntime, createPostgresCaptureRepository, createPostgresNormalizationRepository,
  createPostgresForwardPurchaseRepository, createPostgresForwardTokenWatchRepository,
  createPostgresForwardOpportunityRepository, createPostgresForwardOpportunityWorkRepository,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
  POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL, POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL } from "@address-radar/database";
import { consumePostgresForwardOpportunity } from "./forward-opportunity-worker.js";
import { projectPostgresForwardTraderCapability } from "./forward-trader-capability-worker.js";

type Runtime = Pick<ReturnType<typeof createPostgresAcceptanceRuntime>, "probe" | "run">;
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function verifyPostgresTraderCapabilityAcceptance(runtime: Runtime, now: number) {
  await runtime.probe();
  const rollback = new Error("Synthetic trader capability rollback");
  let verified = false;
  try {
    await runtime.run(async (transaction) => {
      await transaction.query("SET LOCAL search_path TO pg_temp, pg_catalog");
      await transaction.query([POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
        POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL,
        POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL,
        POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL].join("\n").replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      const purchases = createPostgresForwardPurchaseRepository(transaction);
      const watches = createPostgresForwardTokenWatchRepository(transaction);
      const evidence = createPostgresForwardOpportunityRepository(transaction);
      const work = createPostgresForwardOpportunityWorkRepository(transaction);
      await purchases.registerGeneration({ generationId: "fixture-generation", activatedAt: now });
      const seed = async (index: number, recordedAt: number) => {
        const sourceEventId = `fixture-event-${index}`, tokenAddress = `0xaaa${index}`;
        const capture = await createPostgresCaptureRepository(transaction, { maximumPayloadBytes: 65536 }).append({
          sourceNamespace: "capability-acceptance", sourceEventId, collectorId: "fixture-collector", sessionId: "fixture-session",
          receivedAt: recordedAt, scrubbedPayload: "{}", semanticPayload: "{}" });
        const normalization = createPostgresNormalizationRepository(transaction, 65536);
        const jobId = await normalization.request({ sourceNamespace: "capability-acceptance", sourceEventId,
          semanticFingerprint: capture.semanticFingerprint, parserVersion: "fixture-parser", requestedAt: recordedAt });
        const lease = await normalization.claim({ owner: "fixture-normalizer", now: recordedAt, leaseMs: 60000 });
        requireCondition(lease, "Fixture source lease missing");
        await normalization.complete(lease, { eventKind: "buy", sourceUserId: "fixture-account", entityId: null,
          chain: "base", tokenAddress, occurredAt: now, normalizedPayload: "{}" }, recordedAt);
        await purchases.record({ generationId: "fixture-generation", sourceJobId: jobId, recordedAt,
          purchase: { executionKey: `fixture-execution-${index}`, chain: "base", tokenAddress, entityId: "fixture-entity",
            sourceUserId: "fixture-account", occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC", quoteAmount: "50",
            amountUsd: "50", entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
            executionEvidenceRef: `fixture:execution:${index}`, ownershipEvidenceRef: "fixture:ownership" } });
        await watches.discover({ generationId: "fixture-generation", sourceJobId: jobId, discoveredAt: recordedAt });
        return tokenAddress;
      };
      const tokens = [await seed(0, now), await seed(1, now)];
      for (const [index, tokenAddress] of tokens.entries()) {
        await evidence.recordPeak({ peakId: `fixture-peak-${index}`, revisionId: "v1", kind: "trade", chain: "base",
          tokenAddress, priceUsd: "0.05", verification: "validated", evidenceRef: "fixture:market",
          occurredAt: now + 1, knownAt: now + 1 });
      }
      requireCondition(await work.scheduleSamples(now + 1, 10) === 2, "Fixture sample work missing");
      for (let index = 0; index < 2; index++) {
        const lease = await work.claim({ owner: "fixture-worker", now: now + 1, leaseMs: 60000 });
        requireCondition(lease, "Fixture opportunity lease missing");
        requireCondition((await consumePostgresForwardOpportunity(transaction, lease, { now: now + 1, retryAt: now + 1000 })).status === "evaluated",
          "Fixture opportunity was not persisted");
      }
      const project = (asOf: number, maximumSamples = 10) => projectPostgresForwardTraderCapability(transaction,
        { entityId: "fixture-entity", generationId: "fixture-generation", asOf, maximumSamples });
      const waiting = await project(now + 1);
      requireCondition(waiting.status === "projected" && !waiting.projection.stableCapability
        && waiting.projection.metrics.awaitingScreeningTokens === 2, "Pre-100K evidence bypassed screening");
      for (const [index, tokenAddress] of tokens.entries()) await watches.recordMarket({ generationId: "fixture-generation",
        chain: "base", tokenAddress, sourceEventId: `fixture-market-${index}`, marketCapUsd: "100000", occurredAt: now + 2,
        now: now + 2, verification: "validated", evidenceRef: `fixture:100k:${index}` });
      const stable = await project(now + 2);
      requireCondition(stable.status === "projected" && stable.projection.stableCapability
        && stable.projection.cohortMaturity === "collecting" && stable.projection.metrics.hit5xTokens === 2,
        "Observed 100K did not screen the already stored opportunities");
      requireCondition((await project(now + 3)).status === "unchanged", "Clock refresh expanded capability versions");
      await seed(2, now + 4);
      const incomplete = await project(now + 4);
      requireCondition(incomplete.status === "projected" && incomplete.projection.stableCapability
        && incomplete.projection.metrics.distinctTokens === 3 && incomplete.projection.metrics.awaitingScreeningTokens === 1,
        "Missing data disappeared from the denominator or erased proven ability");
      requireCondition((await project(now + 5, 2)).status === "deferred", "Sample budget silently truncated capability evidence");
      const expired = await project(now + 30 * 86400000 + 1);
      requireCondition(expired.status === "projected" && !expired.projection.stableCapability
        && expired.projection.observationStatus === "no_samples", "Out-of-cohort buys retained current capability");
      requireCondition((await project(now + 2)).status === "stale_decision", "An older decision replaced the current capability head");
      const counts = await transaction.query("SELECT (SELECT count(*) FROM forward_trader_capability_versions)::int AS versions, (SELECT count(*) FROM forward_trader_capability_intents)::int AS intents, (SELECT count(*) FROM forward_trader_capability_versions WHERE stable_capability)::int AS historical_stable, (SELECT count(*) FROM forward_trader_capability_heads)::int AS heads");
      const row = counts.rows[0];
      requireCondition(row?.versions === 4 && row.intents === 4 && row.historical_stable === 2 && row.heads === 1,
        "Capability revisions or historical basis were not preserved");
      verified = true;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_trader_capability_versions') AS remaining"));
  requireCondition(verified && cleanup.rows[0]?.remaining === null, "Synthetic capability cleanup not verified");
  return { fixtureScope: "synthetic_transaction_rollback" as const, versions: 4, intents: 4, historicalStableVersions: 2,
    observed100kRequired: true, stableDistinctTokenPolicyVerified: true, clockRefreshDeduplicated: true,
    sampleBudgetDeferred: true, olderDecisionRejected: true, legacyAdmissionUnchanged: true,
    noWalletRequired: true, noRadarAuthorizationGranted: true, cleanupVerified: true,
    businessActivation: false, liveSourceCoverageVerified: false };
}
