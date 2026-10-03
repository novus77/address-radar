import {
  createPostgresConsumerWorkRepository, createPostgresForwardPurchaseRepository,
  createPostgresForwardTokenWatchRepository, createPostgresNormalizationRepository,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL,
  POSTGRES_CONSUMER_WORK_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL,
  type PostgresAcceptanceRuntime, type PostgresTransaction, type VerifiedForwardPurchase,
} from "@address-radar/database";
import { FORWARD_CAPTURE_EXTENSION_MS, FORWARD_OPPORTUNITY_WINDOW_MS } from "@address-radar/domain";
import { stagePostgresFomoMessage, normalizePostgresFomoLease } from "./postgres-fomo-normalization.js";
import { consumePostgresForwardPurchase, FORWARD_PURCHASE_CONSUMER } from "./postgres-forward-purchase-consumer.js";
import { consumePostgresForwardToken, FORWARD_TOKEN_CONSUMER } from "./postgres-forward-token-consumer.js";

export interface PostgresPipelineAcceptanceReport {
  readonly fixtureScope: "synthetic_transaction_rollback";
  readonly captureIdentities: number;
  readonly rawRevisions: number;
  readonly normalizedEvents: number;
  readonly consumerReceipts: number;
  readonly deferredConsumers: number;
  readonly economicTrades: number;
  readonly purchaseSamples: number;
  readonly tokenWatches: number;
  readonly amountEstimated: true;
  readonly opportunityWindowMs: number;
  readonly screeningEnabled: true;
  readonly cleanupVerified: true;
  readonly businessActivation: false;
  readonly liveSourceCoverageVerified: false;
}

type Runtime = Pick<PostgresAcceptanceRuntime, "probe" | "run">;
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`PostgreSQL pipeline acceptance: ${message}`);
}

// Synthetic fixtures run only in transaction-local temporary tables, never in the public business schema.
export async function verifyPostgresPipelineAcceptance(runtime: Runtime, now: number): Promise<PostgresPipelineAcceptanceReport> {
  if (!Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(now + FORWARD_OPPORTUNITY_WINDOW_MS + 300_000)) {
    throw new Error("Invalid PostgreSQL acceptance timestamp");
  }
  const identity = await runtime.probe();
  requireCondition(identity.database.endsWith("_test") && ["127.0.0.1", "::1"].includes(identity.serverAddress), "isolated target required");
  const rollback = new Error("pipeline acceptance rollback marker");
  let report: Omit<PostgresPipelineAcceptanceReport, "cleanupVerified"> | undefined;
  try {
    await runtime.run(async transaction => {
      const occupied = await transaction.query("SELECT to_regclass('pg_temp.capture_event_identities') AS relation");
      requireCondition(occupied.rows[0]?.relation === null, "temporary fixture namespace is already occupied");
      await transaction.query("SET LOCAL search_path TO pg_temp, pg_catalog");
      const schema = POSTGRES_CAPTURE_INBOX_SCHEMA_SQL + POSTGRES_NORMALIZATION_SCHEMA_SQL
        + POSTGRES_CONSUMER_WORK_SCHEMA_SQL + POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL + POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL;
      await transaction.query(schema.replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      const generationId = "isolated-pipeline-acceptance";
      const key = { generationId, chain: "base" as const, tokenAddress: "0xabc" };
      await createPostgresForwardPurchaseRepository(transaction).registerGeneration({ generationId, activatedAt: now });
      const stage = (sourceMessageId: string, at: number, changes: Record<string, unknown> = {}, sessionId = "fixture-session") =>
        stagePostgresFomoMessage(transaction, {
          sourceMessageId, sourceUrl: "wss://feed.example/live", approvedOrigins: ["wss://feed.example"],
          maximumPayloadBytes: 65_536, collectorId: "fixture-collector", sessionId, receivedAt: at,
          body: JSON.stringify({ type: "data", topicType: "trading_activity", authorization: "fixture-secret",
            payload: { tradeId: "fixture-position", userId: "fixture-account", userHandle: "fixture-trader",
              tokenAddress: "0xAbC", networkId: 8453, type: "swap_buy", createdAt: new Date(now).toISOString(),
              usdAmount: 50, price: 0.01, marketCap: 90_000, ...changes } }),
        });
      const normalize = async (jobId: string, at: number) => {
        const lease = await createPostgresNormalizationRepository(transaction, 65_536)
          .claim({ owner: "fixture-normalizer", now: at, leaseMs: 60_000 });
        requireCondition(lease?.jobId === jobId, "normalization must claim the expected revision");
        requireCondition(await normalizePostgresFomoLease(transaction, lease, { now: at, maximumPayloadBytes: 65_536 }), "normalization lease lost");
      };
      const claimConsumer = async (policy: typeof FORWARD_PURCHASE_CONSUMER | typeof FORWARD_TOKEN_CONSUMER, jobId: string, at: number) => {
        const work = createPostgresConsumerWorkRepository(transaction, policy);
        await work.schedulePending(at, 100);
        const lease = await work.claim({ owner: "fixture-consumer", now: at, leaseMs: 60_000 });
        requireCondition(lease?.jobId === jobId, "consumer must claim its own expected revision");
        return lease;
      };
      const discover = async (jobId: string, at: number) => {
        const lease = await claimConsumer(FORWARD_TOKEN_CONSUMER, jobId, at);
        await consumePostgresForwardToken(transaction, lease, { generationId, now: at, retryAt: at + 300_000 });
      };
      const first = await stage("fixture-source-1", now);
      requireCondition(first?.captured.status === "inserted", "initial capture was not inserted");
      const replay = await stage("fixture-source-1", now + 1, {}, "fixture-reconnect");
      requireCondition(replay?.captured.status === "duplicate" && replay.jobId === first.jobId, "capture replay duplicated work");
      await normalize(first.jobId, now + 2);
      await discover(first.jobId, now + 3);
      const initialWatch = await createPostgresForwardTokenWatchRepository(transaction).get(key);
      requireCondition(initialWatch?.screeningEnabledAt === null
        && initialWatch.captureUntil === now + 3 + FORWARD_CAPTURE_EXTENSION_MS, "pre-100K discovery policy drifted");
      const purchase: VerifiedForwardPurchase = {
        executionKey: "fixture-execution", chain: "base", tokenAddress: "0xabc", entityId: "fixture-entity",
        sourceUserId: "fixture-account", occurredAt: now, tokenQuantity: "5000", quoteAsset: "USDC",
        quoteAmount: "50", amountUsd: "50", entryPriceUsd: "0.01", amountBasis: "stablecoin_nominal",
        amountEstimated: true, executionEvidenceRef: "fixture:execution", ownershipEvidenceRef: "fixture:ownership",
      };
      const purchaseLease = await claimConsumer(FORWARD_PURCHASE_CONSUMER, first.jobId, now + 4);
      const bought = await consumePostgresForwardPurchase(transaction, purchaseLease, {
        generationId, resolution: { status: "verified", purchase }, now: now + 4, retryAt: now + 300_000,
      });
      requireCondition(bought.status === "sample_ready" && bought.applied, "qualified purchase did not produce a sample");
      await createPostgresForwardTokenWatchRepository(transaction).recordMarket({
        ...key, sourceEventId: "fixture-market-100K", marketCapUsd: "100000", occurredAt: now + 1000,
        now: now + 1000, verification: "validated", evidenceRef: "fixture:market",
      });
      const watch = await createPostgresForwardTokenWatchRepository(transaction).get(key);
      requireCondition(watch?.screeningEnabledAt === now + 1000, "100K screening did not activate");
      requireCondition(watch.captureUntil === now + 1000 + FORWARD_CAPTURE_EXTENSION_MS, "first milestone did not extend capture");
      const missing = await stage("fixture-source-missing", now + 2000, { tradeId: "fixture-missing-position" });
      requireCondition(missing, "missing-basis fixture was not staged");
      await normalize(missing.jobId, now + 2001);
      await discover(missing.jobId, now + 2002);
      const missingLease = await claimConsumer(FORWARD_PURCHASE_CONSUMER, missing.jobId, now + 2003);
      const deferred = await consumePostgresForwardPurchase(transaction, missingLease, {
        generationId, resolution: { status: "deferred", reasonCode: "execution_basis_missing" },
        now: now + 2003, retryAt: now + 302_003,
      });
      requireCondition(deferred.status === "deferred" && deferred.applied, "missing execution did not defer");
      const revision = await stage("fixture-source-1", now + 3000, { usdAmount: 75, price: 0.02 });
      requireCondition(revision && revision.jobId !== first.jobId, "semantic revision did not retain independent work");
      await normalize(revision.jobId, now + 3001);
      await discover(revision.jobId, now + 3002);
      const revisionLease = await claimConsumer(FORWARD_PURCHASE_CONSUMER, revision.jobId, now + 3003);
      const reviewed = await consumePostgresForwardPurchase(transaction, revisionLease, {
        generationId, resolution: { status: "verified", purchase }, now: now + 3003, retryAt: now + 303_003,
      });
      requireCondition(reviewed.status === "deferred" && reviewed.applied, "source revision bypassed review");
      const raw = await transaction.query("SELECT scrubbed_payload FROM capture_raw_payloads");
      requireCondition(raw.rows.every(row => !String(row.scrubbed_payload).includes("fixture-secret")), "secret entered the raw inbox");
      const samples = await transaction.query(`SELECT s.occurred_at,s.expires_at,r.amount_estimated,r.entry_price_usd::text AS price
        FROM forward_purchase_samples s JOIN forward_trade_revisions r
          ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint`);
      requireCondition(samples.rows.length === 1 && samples.rows[0]?.amount_estimated === true
        && samples.rows[0]?.price === "0.01"
        && Number(samples.rows[0]?.expires_at) - Number(samples.rows[0]?.occurred_at) === FORWARD_OPPORTUNITY_WINDOW_MS,
      "original execution evidence or the 30-day sample window changed");
      const rows = await transaction.query(`SELECT
        (SELECT count(*)::int FROM capture_event_identities) AS identities,
        (SELECT count(*)::int FROM capture_raw_payloads) AS revisions,
        (SELECT count(*)::int FROM capture_normalized_results) AS normalized,
        (SELECT count(*)::int FROM capture_consumer_receipts) AS receipts,
        (SELECT count(*)::int FROM capture_consumer_jobs WHERE status='pending') AS deferred,
        (SELECT count(*)::int FROM forward_economic_trades) AS trades,
        (SELECT count(*)::int FROM forward_purchase_samples) AS samples,
        (SELECT count(*)::int FROM forward_token_watches) AS watches`);
      const counts = rows.rows[0];
      requireCondition(counts?.identities === 2 && counts.revisions === 3 && counts.normalized === 3
        && counts.receipts === 3 && counts.deferred === 3 && counts.trades === 1
        && counts.samples === 1 && counts.watches === 1, "pipeline totals do not reconcile");
      const reasons = await transaction.query("SELECT failure_reason FROM capture_consumer_jobs WHERE status='pending' ORDER BY failure_reason");
      requireCondition(JSON.stringify(reasons.rows.map(row => row.failure_reason)) === JSON.stringify([
        "execution_basis_missing", "source_revision_review", "source_revision_review",
      ]), "deferred work does not retain its actual blockers");
      report = { fixtureScope: "synthetic_transaction_rollback", captureIdentities: counts.identities,
        rawRevisions: counts.revisions, normalizedEvents: counts.normalized, consumerReceipts: counts.receipts,
        deferredConsumers: counts.deferred, economicTrades: counts.trades, purchaseSamples: counts.samples,
        tokenWatches: counts.watches, amountEstimated: true, opportunityWindowMs: FORWARD_OPPORTUNITY_WINDOW_MS,
        screeningEnabled: true, businessActivation: false, liveSourceCoverageVerified: false };
      throw rollback;
    });
    throw new Error("PostgreSQL pipeline acceptance did not roll back");
  } catch (error) { if (error !== rollback) throw error; }
  const cleanup = await runtime.run((transaction: PostgresTransaction) =>
    transaction.query("SELECT to_regclass('pg_temp.capture_event_identities') AS relation"));
  requireCondition(cleanup.rows[0]?.relation === null && report, "temporary pipeline fixtures survived rollback");
  return Object.freeze({ ...report, cleanupVerified: true });
}
