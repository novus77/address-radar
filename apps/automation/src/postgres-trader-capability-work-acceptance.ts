import {
  createPostgresCaptureRepository, createPostgresNormalizationRepository, createPostgresForwardPurchaseRepository,
  createPostgresForwardTokenWatchRepository, createPostgresForwardOpportunityRepository, createPostgresForwardOpportunityWorkRepository,
  createPostgresForwardTraderCapabilityWorkRepository, ForwardTraderCapabilityLeaseLostError,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL,
  POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL, POSTGRES_FORWARD_TRADER_CAPABILITY_WORK_SCHEMA_SQL,
  type PostgresAcceptanceRuntime, type PostgresTransaction,
} from "@address-radar/database";
import { consumePostgresForwardOpportunity } from "./forward-opportunity-worker.js";
import { consumePostgresForwardTraderCapability } from "./forward-trader-capability-consumer.js";

export const CAPABILITY_WORK_FIXTURE_SCHEMA_SQL = [POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
  POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL, POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL,
  POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL, POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL,
  POSTGRES_FORWARD_TRADER_CAPABILITY_WORK_SCHEMA_SQL].join("\n");
const generationId = "capability-work-fixture";
const windowMs = 30 * 24 * 60 * 60 * 1000;
function ensure(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }

export async function seedCapabilityWorkFixture(transaction: PostgresTransaction, now: number) {
  const capture = createPostgresCaptureRepository(transaction, { maximumPayloadBytes: 65536 });
  const normalization = createPostgresNormalizationRepository(transaction, 65536);
  const purchases = createPostgresForwardPurchaseRepository(transaction);
  const watches = createPostgresForwardTokenWatchRepository(transaction);
  const opportunities = createPostgresForwardOpportunityRepository(transaction);
  await purchases.registerGeneration({ generationId, activatedAt: now });
  for (let index = 0; index < 3; index++) {
    const sourceEventId = `buy-${index}`; const tokenAddress = `0xaaa${index}`;
    const appended = await capture.append({ sourceNamespace: "capability-fixture", sourceEventId, collectorId: "fixture", sessionId: "fixture",
      receivedAt: now, scrubbedPayload: JSON.stringify({ index }), semanticPayload: JSON.stringify({ index }) });
    const jobId = await normalization.request({ sourceNamespace: "capability-fixture", sourceEventId,
      semanticFingerprint: appended.semanticFingerprint, parserVersion: "fixture-v1", requestedAt: now });
    const normalizedLease = await normalization.claim({ owner: "fixture", now, leaseMs: 1000 }); ensure(normalizedLease, "Missing normalization lease");
    ensure(await normalization.complete(normalizedLease, { eventKind: "buy", sourceUserId: `user-${index}`, entityId: null,
      chain: "base", tokenAddress, occurredAt: now, normalizedPayload: "{}" }, now), "Normalization rejected");
    const purchase = await purchases.record({ generationId, sourceJobId: jobId, recordedAt: now,
      purchase: { chain: "base", executionKey: `trade-${index}`, tokenAddress, entityId: index < 2 ? "entity-a" : "entity-b",
        sourceUserId: `user-${index}`, occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC", quoteAmount: "50",
        amountUsd: "50", entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal", amountEstimated: true,
        executionEvidenceRef: `execution-${index}`, ownershipEvidenceRef: `ownership-${index}` } });
    ensure(purchase.status === "sample_ready", "Purchase rejected");
    await watches.discover({ generationId, sourceJobId: jobId, discoveredAt: now });
    if (index < 2) await opportunities.recordPeak({ peakId: `peak-${index}`, revisionId: "v1", kind: "trade", chain: "base",
      tokenAddress, priceUsd: "0.05", occurredAt: now + 1, knownAt: now + 1, verification: "validated", evidenceRef: `peak-ref-${index}` });
  }
  const opportunityWork = createPostgresForwardOpportunityWorkRepository(transaction);
  ensure(await opportunityWork.scheduleSamples(now + 1, 10) === 3, "Initial opportunity scheduling failed");
  for (let index = 0; index < 3; index++) {
    const lease = await opportunityWork.claim({ owner: "fixture", now: now + 1, leaseMs: 1000 }); ensure(lease, "Missing opportunity lease");
    await consumePostgresForwardOpportunity(transaction, lease, { now: now + 1, retryAt: now + 200 });
  }
  return { generationId };
}

export async function verifyPostgresTraderCapabilityWorkAcceptance(runtime: Pick<PostgresAcceptanceRuntime, "run" | "probe">, now: number) {
  await runtime.probe(); const rollback = new Error("Rollback capability work fixture");
  let report: { versions: number; receipts: number; wakeLinks: number; requests: number } | undefined;
  try {
    await runtime.run(async transaction => {
      await transaction.query(CAPABILITY_WORK_FIXTURE_SCHEMA_SQL.replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      await seedCapabilityWorkFixture(transaction, now);
      const work = createPostgresForwardTraderCapabilityWorkRepository(transaction);
      const consume = (lease: NonNullable<Awaited<ReturnType<typeof work.claim>>>, asOf: number, maximumSamples = 10, finish = asOf) => {
        let calls = 0;
        return consumePostgresForwardTraderCapability(transaction, lease, { now: () => calls++ ? finish : asOf, maximumSamples, retryDelayMs: 4 });
      };
      ensure(await work.scheduleSamples(now + 3, 10) === 3, "Sample wake failed");
      ensure(await work.scheduleOpportunities(now + 3, 10) === 3, "Opportunity wake failed");
      ensure(await work.scheduleSamples(now + 3, 10) === 0 && await work.scheduleOpportunities(now + 3, 10) === 0, "Wake replay was not deduplicated");
      const obsolete = await work.claim({ owner: "old", now: now + 4, leaseMs: 50 }); ensure(obsolete?.entityId === "entity-a", "Unexpected first subject");
      await work.request({ entityId: "entity-a", generationId, sourceKind: "cohort", sourceKey: "explicit-refresh", now: now + 5 });
      await transaction.query("SAVEPOINT obsolete_attempt");
      try { await consume(obsolete, now + 6); throw new Error("Obsolete lease accepted"); }
      catch (error) { if (!(error instanceof ForwardTraderCapabilityLeaseLostError)) throw error; }
      await transaction.query("ROLLBACK TO SAVEPOINT obsolete_attempt");
      const other = await work.claim({ owner: "other", now: now + 6, leaseMs: 50 }); ensure(other?.entityId === "entity-b", "Older waiting subject lost its execution opportunity");
      ensure((await consume(other, now + 6)).status === "projected", "Unknown-data projection was not persisted");
      const budgetLease = await work.claim({ owner: "budget", now: now + 6, leaseMs: 50 }); ensure(budgetLease?.entityId === "entity-a", "Missing budget lease");
      ensure((await consume(budgetLease, now + 6, 1)).status === "deferred", "Budget overflow did not defer");
      ensure(Number((await transaction.query("SELECT count(*) AS n FROM forward_trader_capability_work_receipts WHERE entity_id='entity-a'")).rows[0]!.n) === 0, "Deferral wrote a receipt");
      ensure(await work.claim({ owner: "early", now: now + 9, leaseMs: 50 }) === null, "Deferral ignored retry time");
      const expiring = await work.claim({ owner: "expiring", now: now + 10, leaseMs: 2 }); ensure(expiring, "Missing expiring lease");
      await transaction.query("SAVEPOINT expired_attempt");
      try { await consume(expiring, now + 10, 10, now + 12); throw new Error("Expired lease accepted"); }
      catch (error) { if (!(error instanceof ForwardTraderCapabilityLeaseLostError)) throw error; }
      await transaction.query("ROLLBACK TO SAVEPOINT expired_attempt");
      ensure(Number((await transaction.query("SELECT count(*) AS n FROM forward_trader_capability_heads WHERE entity_id='entity-a'")).rows[0]!.n) === 0, "Expired computation leaked a projection");
      const recovered = await work.claim({ owner: "recovered", now: now + 12, leaseMs: 50 }); ensure(recovered, "Expired lease could not be reclaimed");
      const waiting = await consume(recovered, now + 13); ensure(waiting.status === "projected" && !waiting.stableCapability, "100K screening gate bypassed");
      const watches = createPostgresForwardTokenWatchRepository(transaction);
      for (let index = 0; index < 2; index++) await watches.recordMarket({ generationId, chain: "base", tokenAddress: `0xaaa${index}`,
        sourceEventId: `100k-${index}`, marketCapUsd: "100000", occurredAt: now + 14, now: now + 14, verification: "validated", evidenceRef: `screen-${index}` });
      ensure(await work.scheduleScreening(now + 15, 10) === 2, "Screening did not wake existing buyers");
      const screened = await work.claim({ owner: "screened", now: now + 16, leaseMs: 50 }); ensure(screened, "Screening wake lost");
      const stable = await consume(screened, now + 16); ensure(stable.status === "projected" && stable.stableCapability, "Screened distinct 5x tokens did not establish capability");
      ensure(await work.scheduleScreening(now + 17, 10) === 0, "Screening replay created duplicate wakes");
      const firstPage = await work.reconcile({ generationId, now: now + 17, limit: 1, intervalMs: 100 });
      const finalPage = await work.reconcile({ generationId, now: now + 17, limit: 1, intervalMs: 100 });
      ensure(firstPage.more && !finalPage.more && firstPage.scheduled === 1 && finalPage.scheduled === 1, "Cohort cursor failed");
      ensure((await work.reconcile({ generationId, now: now + 17, limit: 1, intervalMs: 100 })).scheduled === 0, "Completed scan repeated before its interval");
      for (let index = 0; index < 2; index++) {
        const lease = await work.claim({ owner: "refresh", now: now + 18, leaseMs: 50 }); ensure(lease, "Missing clock refresh");
        const result = await consume(lease, now + 18); ensure(result.status === "projected" && result.projectionStatus === "unchanged", "Clock refresh created semantic capability churn");
      }
      ensure((await work.request({ entityId: "entity-a", generationId, sourceKind: "cohort", sourceKey: "older-request", now: now + 16 })).status === "stale_request", "Old request reset the current job");
      ensure(await work.claim({ owner: "stale", now: now + 18, leaseMs: 50 }) === null, "Stale request reopened a completed job");
      const agedAt = now + windowMs + 1;
      ensure((await work.reconcile({ generationId, now: agedAt, limit: 10, intervalMs: 100 })).scheduled === 2, "Aging did not revisit known heads");
      for (let index = 0; index < 2; index++) {
        const lease = await work.claim({ owner: "aging", now: agedAt, leaseMs: 50 }); ensure(lease, "Missing aging lease");
        const result = await consume(lease, agedAt); ensure(result.status === "projected" && !result.stableCapability && result.observationStatus === "no_samples", "Expired cohort retained eligibility");
      }
      const counts = (await transaction.query(`SELECT
        (SELECT count(*) FROM forward_trader_capability_versions) AS versions,
        (SELECT count(*) FROM forward_trader_capability_work_receipts) AS receipts,
        (SELECT count(*) FROM forward_capability_wake_links) AS wake_links,
        (SELECT count(*) FROM forward_capability_requests) AS requests,
        (SELECT count(*) FROM forward_capability_jobs WHERE status<>'completed') AS unfinished,
        (SELECT count(*) FROM forward_opportunity_intents WHERE status<>'pending') AS foreign_dispatches`)).rows[0]!;
      report = { versions: Number(counts.versions), receipts: Number(counts.receipts), wakeLinks: Number(counts.wake_links), requests: Number(counts.requests) };
      ensure(report.versions === 5 && report.receipts === 7 && report.wakeLinks === 8 && report.requests === 14, "Unexpected capability fixture totals");
      ensure(Number(counts.unfinished) === 0 && Number(counts.foreign_dispatches) === 0, "Capability altered another consumer's progress");
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  ensure(report, "Capability fixture did not run");
  const cleaned = await runtime.run(async transaction => (await transaction.query("SELECT to_regclass('forward_capability_jobs') IS NULL AS cleaned")).rows[0]!.cleaned);
  ensure(cleaned === true, "Capability work fixture leaked tables");
  return { fixtureScope: "synthetic_transaction_rollback" as const, ...report, obsoleteLeaseRejected: true, expiredProjectionRolledBack: true,
    sampleBudgetDeferredWithoutReceipt: true, screeningWakeVerified: true, independentWakeOwnership: true, fairRetryVerified: true,
    cohortCursorVerified: true, agingRecomputed: true, clockRefreshDeduplicated: true, cleanupVerified: true,
    legacyAdmissionUnchanged: true, businessActivation: false, liveSourceCoverageVerified: false, gatewayDeliveryEnabled: false };
}
