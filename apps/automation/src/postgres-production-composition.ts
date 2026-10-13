import { claimPostgresReadyPurchase } from "./postgres-ready-purchase-claim.js";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createPostgresConsumerWorkRepository, createPostgresForwardPurchaseRepository,
  createPostgresForwardTokenWatchRepository, createPostgresForwardOpportunityRepository,
  createPostgresForwardOpportunityWorkRepository, createPostgresForwardOpportunityFanoutRepository,
  createPostgresForwardTraderCapabilityRepository, createPostgresForwardTraderCapabilityWorkRepository,
  projectPostgresForwardSignal, refreshPostgresForwardTargetIdentity, readPostgresForwardTrace,
  type CaptureConsumerLease, type NormalizationLease, type ForwardOpportunityLease, type ForwardTraderCapabilityLease,
  type ForwardSignalSafetyAssessment, type ForwardTargetRefreshKey, type ForwardTargetSourceCheck,
  type ForwardTraceQuery, type PostgresTransaction,
} from "@address-radar/database";
import { canonicalForwardPeak, forwardEvidenceIdentifier, forwardEvidenceTime, FORWARD_OPPORTUNITY_EVIDENCE_VERSION,
  FORWARD_TRADER_CAPABILITY_VERSION, FORWARD_SIGNAL_WINDOW_MS, type ForwardPeakEvidence, type ForwardTargetPrincipal } from "@address-radar/domain";
import {
  WALLET_CAPTURE_NAMESPACE, WALLET_CAPTURE_PARSER_VERSION, normalizePostgresWalletLease,
  preparePostgresWalletCapture,
  type CapturedPostgresWalletEvent, type CapturedWalletPurchaseResolution, type PostgresWalletRun,
} from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { consumePostgresForwardOpportunity } from "./forward-opportunity-worker.js";
import { consumePostgresForwardTraderCapability } from "./forward-trader-capability-consumer.js";
import { readPostgresForwardTargetAuthorization } from "./forward-target-authorization.js";

export const POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL = `
CREATE TABLE wallet_forward_signal_jobs (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id), chain text NOT NULL, token_address text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','idle','waiting_source','waiting_threshold','expired')),
  next_attempt_at bigint NOT NULL, requested_at bigint NOT NULL, claim_generation integer NOT NULL DEFAULT 0,
  lease_owner text, lease_expires_at bigint, reason_code text,wake_generation bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(generation_id,chain,token_address)
);
CREATE INDEX wallet_forward_signal_due ON wallet_forward_signal_jobs(generation_id,next_attempt_at,requested_at,chain,token_address);
CREATE TABLE wallet_forward_signal_wake_receipts (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),source_kind text NOT NULL,source_key text NOT NULL,
  chain text NOT NULL,token_address text NOT NULL,dispatched_at bigint NOT NULL,
  PRIMARY KEY(generation_id,source_kind,source_key,chain,token_address)
);
CREATE TABLE wallet_forward_signal_wake_intents (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),source_key text NOT NULL,
  chain text NOT NULL,token_address text NOT NULL,created_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched')),
  PRIMARY KEY(generation_id,source_key,chain,token_address)
);
CREATE INDEX wallet_forward_signal_wakes_pending ON wallet_forward_signal_wake_intents(generation_id,created_at,source_key) WHERE status='pending';
`;
/** Producers call this with an actual immutable fact/revision ID in their own fact commit. No timestamp cursor. */
export async function requestPostgresWalletSignalWake(transaction: PostgresTransaction, input: {
  readonly generationId: string;readonly chain: string;readonly tokenAddress: string;readonly sourceKey: string;readonly now: number;
}) {
  [input.generationId,input.chain,input.tokenAddress,input.sourceKey].forEach(forwardEvidenceIdentifier);forwardEvidenceTime(input.now);
  await transaction.query(`INSERT INTO wallet_forward_signal_wake_intents(generation_id,source_key,chain,token_address,created_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[input.generationId,input.sourceKey,input.chain,input.tokenAddress,input.now]);
}
const stageNames = ["normalization", "token", "purchase", "fanout", "opportunity", "capability", "signal"] as const;
export type PostgresCompositionStage = typeof stageNames[number];
export interface PostgresProductionIdentity {
  readonly database: string; readonly username: string; readonly schema: string;
  readonly serverAddress: string; readonly serverPort: number;
  readonly service: string; readonly schemaVersion: number; readonly schemaFingerprint: string;
}
export interface PostgresCompositionContext {
  readonly generationId: string; readonly asOf: number; readonly limit: number; readonly signal: AbortSignal;
}
export interface PostgresCompositionSample {
  readonly sampleId: string; readonly executionFingerprint: string; readonly entityId: string;
  readonly chain: string; readonly tokenAddress: string; readonly boughtAt: number;
}
export interface PostgresProductionPriceLease {
  readonly generationId: string; readonly ownerId: string; readonly claimGeneration: number; readonly leaseExpiresAt: number;
  /** These callbacks must fence the parent's real shared PG lease, not return an eligibility boolean. */
  assertOwned(transaction: PostgresTransaction, now: number): Promise<void>;
  /** Advance a durable provider cursor and release the lease in the same UOW as its actual facts. */
  complete(transaction: PostgresTransaction, now: number): Promise<void>;
}
export interface PostgresProductionFactAdapters {
  /** Read-only execution/ownership revalidation, not a position-to-trade guess. */
  purchase(input: PostgresCompositionContext & { readonly lease: CaptureConsumerLease; readonly payload: CapturedPostgresWalletEvent }): Promise<CapturedWalletPurchaseResolution>;
  /** This adapter owns bounded durable provider cursors; replay must return stable evidence IDs. */
  prices(input: PostgresCompositionContext): Promise<
    { readonly status: "available"; readonly lease: PostgresProductionPriceLease; readonly peaks: readonly ForwardPeakEvidence[];
      readonly markets: readonly Parameters<ReturnType<typeof createPostgresForwardTokenWatchRepository>["recordMarket"]>[0][] }
    | { readonly status: "deferred"; readonly reasonCode: string }>;
  target(input: PostgresCompositionContext & { readonly key: ForwardTargetRefreshKey }): Promise<ForwardTargetSourceCheck>;
  safety(input: PostgresCompositionContext & { readonly sample: PostgresCompositionSample }): Promise<
    { readonly status: "available"; readonly assessment: ForwardSignalSafetyAssessment }
    | { readonly status: "deferred"; readonly reasonCode: string }>;
}
export interface PostgresProductionCompositionOptions {
  readonly runtime: { readonly backend?: "postgresql"; readonly run: PostgresWalletRun;
    probe(): Promise<PostgresProductionIdentity & { readonly generation: string }> };
  readonly identity: PostgresProductionIdentity;
  readonly generation: { readonly generationId: string; readonly activatedAt: number };
  readonly ownerId: string; readonly principal: ForwardTargetPrincipal;
  readonly adapters: PostgresProductionFactAdapters;
  readonly activeStages?: readonly PostgresCompositionStage[];
  readonly includePrices?: boolean;
  readonly quotas: Readonly<Record<PostgresCompositionStage, number>>;
  readonly maximumClaims: number; readonly maximumRunMs: number; readonly admissionLimit: number;
  readonly leaseMs: number; readonly retryDelayMs: number; readonly maximumPayloadBytes: number;
  readonly maximumSamples: number; readonly factLimit: number; readonly reconcileIntervalMs: number;
  readonly now: () => number;
}
interface StageReport { attempted: number; claimed: number; applied: number; deferred: number; failed: number }
interface SignalLease { readonly chain: string; readonly tokenAddress: string; readonly claimGeneration: number; readonly leaseExpiresAt: number; readonly wakeGeneration: number }
export class PostgresOpportunityEvidenceBudgetError extends Error {
  constructor() { super("Opportunity evidence budget exceeded"); this.name = "PostgresOpportunityEvidenceBudgetError"; }
}
/** Bound the existing opportunity reader without truncating evidence into a false assessment. */
export function boundPostgresOpportunityEvidence(transaction: PostgresTransaction, limit: number): PostgresTransaction {
  positive(limit, 1000);
  return { async query(sql, values = []) {
    if (!sql.startsWith("SELECT payload FROM forward_peak_evidence WHERE chain=")) return transaction.query(sql, values);
    const result = await transaction.query(`${sql} LIMIT $6`, [...values, limit + 1]);
    if (result.rows.length > limit) throw new PostgresOpportunityEvidenceBudgetError();
    return result;
  } };
}

function positive(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Explicit bounded composition budget required");
}
function ensureApplied(applied: boolean): void { if (!applied) throw new Error("Composition consumer lease lost"); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type PostgresProductionPriceBatch = Extract<Awaited<ReturnType<PostgresProductionFactAdapters["prices"]>>, { status: "available" }>;

/** Also usable by the targeted-facts historical role, without running source consumers or old history batches. */
export async function receivePostgresProductionPriceBatch(transaction: PostgresTransaction, input: {
  readonly generationId: string; readonly asOf: number; readonly limit: number; readonly batch: PostgresProductionPriceBatch;
  readonly now: () => number;
}) {
  const { batch, generationId, asOf } = input;
  forwardEvidenceIdentifier(generationId); forwardEvidenceTime(asOf); positive(input.limit, 1000);
  if (batch.peaks.length + batch.markets.length > input.limit) throw new Error("Price adapter exceeded its fact budget");
  const lease = batch.lease;
  if (!lease || lease.generationId !== generationId || typeof lease.assertOwned !== "function" || typeof lease.complete !== "function") {
    throw new Error("Available price facts require an explicit shared PostgreSQL lease");
  }
  forwardEvidenceIdentifier(lease.ownerId); positive(lease.claimGeneration); forwardEvidenceTime(lease.leaseExpiresAt);
  const current = () => { const at = input.now(); forwardEvidenceTime(at); if (at < asOf || at >= lease.leaseExpiresAt) throw new Error("Price lease expired or clock moved backwards"); return at; };
  await lease.assertOwned(transaction, current());
  for (const peak of batch.peaks) {
    const canonical = canonicalForwardPeak(peak); if (canonical.knownAt > asOf) throw new Error("Price adapter supplied future evidence");
    await createPostgresForwardOpportunityRepository(transaction).recordPeak(canonical);
    await createPostgresForwardOpportunityFanoutRepository(transaction).enqueue({ peakId: canonical.peakId, revisionId: canonical.revisionId, now: asOf });
  }
  for (const market of batch.markets) {
    if (market.generationId !== generationId || market.now !== asOf || market.occurredAt > asOf || market.verification !== "validated") throw new Error("Market input does not match factual generation and clock");
    await createPostgresForwardTokenWatchRepository(transaction).recordMarket(market);
  }
  await lease.assertOwned(transaction, current());
  await lease.complete(transaction, current());
  current();
  return { peaks: batch.peaks.length, markets: batch.markets.length };
}
const requiredTables = [
  "capture_event_identities", "capture_event_revisions", "capture_raw_payloads", "capture_normalization_jobs",
  "capture_normalized_results", "capture_consumer_intents", "capture_consumer_jobs", "capture_consumer_receipts",
  "forward_strategy_generations", "forward_economic_trades", "forward_trade_revisions", "forward_trade_source_links",
  "forward_purchase_samples", "forward_sample_work_intents", "forward_token_watches", "forward_token_discovery_links",
  "forward_token_market_inputs", "forward_token_milestone_hits", "forward_token_watch_intents",
  "forward_peak_evidence", "forward_peak_fanout_jobs", "forward_opportunity_requests", "forward_opportunity_jobs",
  "forward_opportunity_evaluations", "forward_opportunity_heads", "forward_opportunity_intents", "forward_opportunity_work_receipts",
  "forward_capability_jobs", "forward_capability_requests", "forward_capability_wake_links", "forward_capability_reconcile_cursors",
  "forward_trader_projection_locks", "forward_trader_capability_versions", "forward_trader_capability_heads",
  "forward_trader_capability_intents", "forward_trader_capability_work_receipts",
  "forward_target_control_locks", "forward_target_channel_versions", "forward_target_channel_heads", "forward_target_identity_bindings",
  "forward_target_authorization_intents", "forward_manual_radar_authorizations", "forward_manual_radar_heads",
  "forward_target_identity_refresh_receipts", "forward_target_identity_refresh_heads",
  "forward_signal_token_locks", "forward_signal_evaluations", "forward_signal_readiness_intents",
  "forward_signal_execution_receipts", "forward_signal_economic_consumption", "forward_signal_readiness_checks",
  "wallet_channel_collectors", "wallet_capture_generation_bindings", "wallet_forward_signal_jobs",
  "wallet_forward_signal_wake_receipts", "wallet_forward_signal_wake_intents",
];

/** Probe an explicitly supplied UOW. This factory neither opens SQLite nor migrates/activates a database. */
export async function createPostgresProductionComposition(options: PostgresProductionCompositionOptions) {
  if ((options.runtime?.backend !== undefined && options.runtime.backend !== "postgresql")
    || typeof options.runtime?.run !== "function" || typeof options.runtime.probe !== "function") throw new Error("Explicit PostgreSQL business runtime required");
  const identity = options.identity;
  if (!identity) throw new Error("Explicit PostgreSQL identity required");
  [identity.database, identity.username, identity.schema, identity.serverAddress, options.ownerId,
    options.generation.generationId, options.principal.actorId, options.principal.authorizationEvidenceRef].forEach(forwardEvidenceIdentifier);
  positive(identity.serverPort, 65535); positive(identity.schemaVersion);
  forwardEvidenceIdentifier(identity.service);
  if (!/^[a-f0-9]{64}$/.test(identity.schemaFingerprint)) throw new Error("Explicit schema fingerprint required");
  forwardEvidenceTime(options.generation.activatedAt);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identity.schema) || !options.principal.permissions.includes("target_registry_write")) {
    throw new Error("Explicit schema and server-authorized target principal required");
  }
  const activeStages = [...(options.activeStages ?? stageNames)];
  if (!activeStages.length || new Set(activeStages).size !== activeStages.length
    || activeStages.some(stage => !stageNames.includes(stage))) throw new Error("Explicit active stages must be nonempty, distinct and known");
  for (const stage of stageNames) {
    if (activeStages.includes(stage)) positive(options.quotas[stage], 1000);
    else if (!Number.isSafeInteger(options.quotas[stage]) || options.quotas[stage] < 0 || options.quotas[stage] > 1000) throw new Error("Invalid inactive stage quota");
  }
  const includePrices = options.includePrices ?? true;
  if (typeof includePrices !== "boolean") throw new Error("Explicit price polling flag is invalid");
  positive(options.maximumClaims, 1000);
  if (activeStages.reduce((sum, stage) => sum + options.quotas[stage], 0) > options.maximumClaims) throw new Error("Total claim budget is smaller than per-stage quota allocation");
  for (const value of [options.maximumRunMs, options.leaseMs, options.retryDelayMs, options.maximumPayloadBytes, options.reconcileIntervalMs]) positive(value, 2_147_483_647);
  for (const value of [options.admissionLimit, options.maximumSamples, options.factLimit]) positive(value, 1000);
  for (const adapter of ["purchase", "prices", "target", "safety"] as const) {
    if (typeof options.adapters?.[adapter] !== "function") throw new Error(`Explicit ${adapter} fact adapter required`);
  }
  const run = options.runtime.run, generationId = options.generation.generationId;
  const probed = await options.runtime.probe();
  if (probed.generation !== generationId || (Object.keys(identity) as Array<keyof PostgresProductionIdentity>)
    .some(key => probed[key] !== identity[key])) throw new Error("PostgreSQL runtime identity mismatch");
  await run(async transaction => {
    const generation = (await transaction.query("SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1", [generationId])).rows[0];
    const at = options.now(); forwardEvidenceTime(at);
    if (!generation || Number(generation.activated_at) !== options.generation.activatedAt || options.generation.activatedAt > at) throw new Error("Explicit registered active generation required");
    const absent = await transaction.query(`SELECT name FROM unnest($1::text[]) AS required(name)
      LEFT JOIN pg_namespace n ON n.nspname=$2 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=name
      WHERE c.oid IS NULL OR c.relkind<>'r' OR c.relpersistence<>'p'`, [requiredTables, identity.schema]);
    if (absent.rows.length) throw new Error("PostgreSQL composition schema is incomplete");
  });

  const consumer = (stage: "token" | "purchase") => ({ consumerName: stage === "token" ? "forward_token_discovery" : "forward_purchase_match",
    // Separate receipts per active generation without changing existing consumers' shared exports.
    consumerVersion: `${stage === "token" ? "forward-token-v1" : "forward-purchase-v1"}:${hash(generationId)}` });
  let firstStage = 0, running = false, purchaseHintTurn = true;
  const now = () => { const at = options.now(); forwardEvidenceTime(at); return at; };
  const context = (asOf: number, signal: AbortSignal): PostgresCompositionContext => ({ generationId, asOf, limit: options.factLimit, signal });
  const leaseInput = () => ({ owner: options.ownerId, now: now(), leaseMs: options.leaseMs });
  const withLease = <T>(lease: { readonly leaseExpiresAt: number }, operation: (transaction: PostgresTransaction) => Promise<T>) =>
    run(async transaction => {
      forwardEvidenceTime(lease.leaseExpiresAt);
      const result = await operation(transaction);
      if (now() >= lease.leaseExpiresAt) throw new Error("Composition lease expired before commit");
      return result;
    });
  async function external<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let reject!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, fail) => { reject = fail; });
    const onAbort = () => reject(signal.reason ?? new Error("Composition read deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
    try { return await Promise.race([operation(signal), aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }
  async function scheduleCapture(stage: "token" | "purchase", asOf: number) {
    const config = consumer(stage);
    await run(transaction => transaction.query(`INSERT INTO capture_consumer_jobs(intent_id,consumer_name,consumer_version,next_attempt_at)
      SELECT i.intent_id,$1,$2,$3 FROM capture_consumer_intents i
      JOIN capture_normalization_jobs n ON n.job_id=i.job_id JOIN capture_normalized_results r ON r.job_id=i.job_id
      JOIN wallet_capture_generation_bindings b ON b.source_namespace=n.source_namespace AND b.source_event_id=n.source_event_id
        AND b.semantic_fingerprint=n.semantic_fingerprint
      WHERE n.source_namespace=$4 AND n.parser_version=$5 AND b.generation_id=$6
        AND NOT EXISTS(SELECT 1 FROM capture_consumer_jobs w WHERE w.intent_id=i.intent_id AND w.consumer_name=$1 AND w.consumer_version=$2)
      ORDER BY i.created_at,i.intent_id LIMIT $7 ON CONFLICT DO NOTHING`,
    [config.consumerName, config.consumerVersion, asOf, WALLET_CAPTURE_NAMESPACE, WALLET_CAPTURE_PARSER_VERSION, generationId, options.admissionLimit]));
  }
  async function claimNormalization() {
    const input = leaseInput();
    return run(async transaction => {
      const row = (await transaction.query(`WITH due AS (
        SELECT j.job_id FROM capture_normalization_jobs j
        JOIN wallet_capture_generation_bindings b USING(source_namespace,source_event_id,semantic_fingerprint)
        WHERE j.source_namespace=$4 AND j.parser_version=$5 AND b.generation_id=$6 AND
          ((j.status='pending' AND j.next_attempt_at<=$1) OR (j.status='leased' AND j.lease_expires_at<=$1))
        ORDER BY j.next_attempt_at,j.requested_at,j.job_id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) UPDATE capture_normalization_jobs j SET status='leased',lease_owner=$2,claim_generation=j.claim_generation+1,
        lease_expires_at=$3 FROM due WHERE j.job_id=due.job_id RETURNING j.*`,
      [input.now, input.owner, input.now + input.leaseMs, WALLET_CAPTURE_NAMESPACE, WALLET_CAPTURE_PARSER_VERSION, generationId])).rows[0];
      if (!row) return null;
      const lease: NormalizationLease = { jobId: String(row.job_id), sourceNamespace: String(row.source_namespace), sourceEventId: String(row.source_event_id),
        semanticFingerprint: String(row.semantic_fingerprint), parserVersion: String(row.parser_version), requestedAt: Number(row.requested_at),
        owner: input.owner, claimGeneration: Number(row.claim_generation), leaseExpiresAt: Number(row.lease_expires_at) };
      return lease;
    });
  }
  async function claimOpportunity() {
    const input = leaseInput();
    return run(async transaction => {
      const row = (await transaction.query(`WITH due AS (
        SELECT j.sample_id,j.execution_fingerprint,j.strategy_version FROM forward_opportunity_jobs j
        JOIN forward_purchase_samples s ON s.sample_id=j.sample_id WHERE s.generation_id=$5 AND j.strategy_version=$1
          AND ((j.status='pending' AND j.next_attempt_at<=$2) OR (j.status='leased' AND j.lease_expires_at<=$2))
        ORDER BY j.next_attempt_at,j.sample_id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) UPDATE forward_opportunity_jobs w SET status='leased',lease_owner=$3,claim_generation=w.claim_generation+1,lease_expires_at=$4
        FROM due WHERE w.sample_id=due.sample_id AND w.execution_fingerprint=due.execution_fingerprint
          AND w.strategy_version=due.strategy_version RETURNING w.*`,
      [FORWARD_OPPORTUNITY_EVIDENCE_VERSION, input.now, input.owner, input.now + input.leaseMs, generationId])).rows[0];
      if (!row) return null;
      const lease: ForwardOpportunityLease = { sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint),
        strategyVersion: FORWARD_OPPORTUNITY_EVIDENCE_VERSION, owner: input.owner, requestGeneration: Number(row.request_generation),
        claimGeneration: Number(row.claim_generation), leaseExpiresAt: Number(row.lease_expires_at) };
      return lease;
    });
  }
  async function claimCapability() {
    const input = leaseInput();
    return run(async transaction => {
      const row = (await transaction.query(`WITH due AS (
        SELECT entity_id,generation_id,strategy_version FROM forward_capability_jobs WHERE generation_id=$5 AND strategy_version=$1
          AND ((status='pending' AND next_attempt_at<=$2) OR (status='leased' AND lease_expires_at<=$2))
        ORDER BY next_attempt_at,latest_requested_at,entity_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE forward_capability_jobs j SET status='leased',lease_owner=$3,lease_expires_at=$4,claim_generation=j.claim_generation+1
        FROM due WHERE j.entity_id=due.entity_id AND j.generation_id=due.generation_id AND j.strategy_version=due.strategy_version RETURNING j.*`,
      [FORWARD_TRADER_CAPABILITY_VERSION, input.now, input.owner, input.now + input.leaseMs, generationId])).rows[0];
      if (!row) return null;
      const lease: ForwardTraderCapabilityLease = { entityId: String(row.entity_id), generationId, strategyVersion: FORWARD_TRADER_CAPABILITY_VERSION,
        requestKey: String(row.latest_request_key), requestGeneration: Number(row.request_generation), claimGeneration: Number(row.claim_generation),
        owner: input.owner, leaseExpiresAt: Number(row.lease_expires_at) };
      return lease;
    });
  }
  async function signalOwned(transaction: PostgresTransaction, lease: SignalLease) {
    const at = now();
    const result = await transaction.query(`SELECT 1 FROM wallet_forward_signal_jobs WHERE generation_id=$1 AND chain=$2 AND token_address=$3
      AND status='leased' AND lease_owner=$4 AND claim_generation=$5 AND lease_expires_at=$6 AND lease_expires_at>$7 FOR UPDATE`,
    [generationId, lease.chain, lease.tokenAddress, options.ownerId, lease.claimGeneration, lease.leaseExpiresAt, at]);
    ensureApplied(result.rows.length === 1);
  }
  async function finishSignal(transaction: PostgresTransaction, lease: SignalLease, reasonCode: string) {
    forwardEvidenceIdentifier(reasonCode);
    await signalOwned(transaction, lease);
    const at = now(), classification = reasonCode === "observe" ? "waiting_threshold"
      : ["ready","blocked","cancelled"].includes(reasonCode) ? "idle" : "waiting_source";
    await transaction.query(`UPDATE wallet_forward_signal_jobs j SET
      status=CASE WHEN NOT EXISTS(SELECT 1 FROM forward_purchase_samples s WHERE s.generation_id=j.generation_id
        AND s.chain=j.chain AND s.token_address=j.token_address AND s.occurred_at BETWEEN GREATEST(0,$4::bigint-$8::bigint) AND $4
        AND s.created_at<=$4 AND NOT EXISTS(SELECT 1 FROM forward_signal_economic_consumption c WHERE c.generation_id=s.generation_id
          AND c.chain=s.chain AND c.token_address=s.token_address AND c.trade_id=s.trade_id)) THEN 'expired'
        WHEN wake_generation>$6 THEN 'pending' ELSE $7 END,
      next_attempt_at=$4,reason_code=$5,lease_owner=NULL,lease_expires_at=NULL
      WHERE generation_id=$1 AND chain=$2 AND token_address=$3`,
    [generationId,lease.chain,lease.tokenAddress,at,reasonCode,lease.wakeGeneration,classification,FORWARD_SIGNAL_WINDOW_MS]);
  }
  async function claimSignal(): Promise<SignalLease | null> {
    const input = leaseInput();
    return run(async transaction => {
      const row = (await transaction.query(`WITH due AS (
        SELECT generation_id,chain,token_address FROM wallet_forward_signal_jobs WHERE generation_id=$1 AND
          ((status='pending' AND next_attempt_at<=$2) OR (status='leased' AND lease_expires_at<=$2))
          AND EXISTS(SELECT 1 FROM forward_purchase_samples s WHERE s.generation_id=wallet_forward_signal_jobs.generation_id
            AND s.chain=wallet_forward_signal_jobs.chain AND s.token_address=wallet_forward_signal_jobs.token_address
            AND s.occurred_at BETWEEN GREATEST(0,$2::bigint-$5::bigint) AND $2 AND s.created_at<=$2
            AND NOT EXISTS(SELECT 1 FROM forward_signal_economic_consumption c WHERE c.generation_id=s.generation_id
              AND c.chain=s.chain AND c.token_address=s.token_address AND c.trade_id=s.trade_id))
        ORDER BY next_attempt_at,requested_at,chain,token_address FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE wallet_forward_signal_jobs j SET status='leased',lease_owner=$3,lease_expires_at=$4,claim_generation=j.claim_generation+1
        FROM due WHERE j.generation_id=due.generation_id AND j.chain=due.chain AND j.token_address=due.token_address RETURNING j.*`,
      [generationId, input.now, input.owner, input.now + input.leaseMs, FORWARD_SIGNAL_WINDOW_MS])).rows[0];
      return row ? { chain: String(row.chain), tokenAddress: String(row.token_address), claimGeneration: Number(row.claim_generation),
        leaseExpiresAt: Number(row.lease_expires_at),wakeGeneration:Number(row.wake_generation ?? 0) } : null;
    });
  }
  async function processSignal(lease: SignalLease, signal: AbortSignal) {
    const asOf = now();
    const rows = await run(transaction => transaction.query(`SELECT sample_id,execution_fingerprint,entity_id,chain,token_address,occurred_at FROM forward_purchase_samples s
      WHERE generation_id=$1 AND chain=$2 AND token_address=$3 AND occurred_at BETWEEN $4 AND $5 AND created_at<=$5
        AND NOT EXISTS(SELECT 1 FROM forward_signal_economic_consumption c WHERE c.generation_id=s.generation_id AND c.chain=s.chain AND c.token_address=s.token_address AND c.trade_id=s.trade_id)
      ORDER BY entity_id,trade_id,sample_id LIMIT $6`, [generationId, lease.chain, lease.tokenAddress, Math.max(0, asOf - FORWARD_SIGNAL_WINDOW_MS), asOf, options.maximumSamples + 1]));
    if (rows.rows.length > options.maximumSamples) {
      await run(transaction => finishSignal(transaction, lease, "signal_input_budget_exceeded")); return "deferred";
    }
    if (!rows.rows.length) { await run(transaction => finishSignal(transaction,lease,"window_expired")); return "deferred"; }
    const safety: ForwardSignalSafetyAssessment[] = [];
    const targets: Array<{ key: ForwardTargetRefreshKey; source: ForwardTargetSourceCheck }> = [];
    for (const row of rows.rows) {
      const sample: PostgresCompositionSample = { sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint),
        entityId: String(row.entity_id), chain: String(row.chain), tokenAddress: String(row.token_address), boughtAt: Number(row.occurred_at) };
      const decision = await external(readSignal => options.adapters.safety({ ...context(asOf, readSignal), sample }), signal);
      if (decision.status !== "available") { await run(transaction => finishSignal(transaction, lease, decision.reasonCode)); return "deferred"; }
      const assessment = decision.assessment;
      if (assessment.sampleId !== sample.sampleId || assessment.executionFingerprint !== sample.executionFingerprint || assessment.assessedAt !== asOf
        || assessment.target.entityId !== sample.entityId || assessment.target.channel !== "wallet" || assessment.target.walletFamily !== (sample.chain === "solana" ? "solana" : "evm")) throw new Error("Safety evidence does not match its generation-bound purchase");
      if (assessment.riskVerdict === "pending" || !assessment.liveSourceVerified || !assessment.sourceEvidenceRef
        || (assessment.riskVerdict === "validated" && (!assessment.riskEvidenceRef || !assessment.independenceKey))) {
        await run(transaction => finishSignal(transaction, lease, "risk_or_live_source_unavailable")); return "deferred";
      }
      const source = await external(readSignal => options.adapters.target({ ...context(asOf, readSignal), key: assessment.target }), signal);
      if (source.status !== "available") { await run(transaction => finishSignal(transaction, lease, "target_source_unavailable")); return "deferred"; }
      safety.push(assessment); targets.push({ key: assessment.target, source });
    }
    return withLease(lease, async transaction => {
      await signalOwned(transaction, lease);
      // Refresh at the exact assessment clock and re-read authorization under the projection's locks.
      for (const target of targets) await refreshPostgresForwardTargetIdentity(transaction, { query: { ...target.key, generationId, asOf },
        source: target.source, principal: options.principal, readAuthorization: readPostgresForwardTargetAuthorization });
      const projected = await projectPostgresForwardSignal(transaction, { generationId, chain: lease.chain, tokenAddress: lease.tokenAddress,
        asOf, inputLimit: options.maximumSamples, safety, readAuthorization: readPostgresForwardTargetAuthorization });
      await finishSignal(transaction, lease, projected.decision.action);
      return projected.decision.action === "ready" ? "applied" : "deferred";
    });
  }
  async function admission(stage: PostgresCompositionStage) {
    const at = now();
    if (stage === "token" || stage === "purchase") return scheduleCapture(stage, at);
    if (stage === "fanout") return run(transaction => createPostgresForwardOpportunityFanoutRepository(transaction).recover(at, options.admissionLimit));
    if (stage === "opportunity") return run(async transaction => {
      const work = createPostgresForwardOpportunityWorkRepository(transaction);
      const rows = await transaction.query(`SELECT i.sample_id,i.execution_fingerprint FROM forward_sample_work_intents i
        JOIN forward_purchase_samples s USING(sample_id) WHERE s.generation_id=$1 AND i.status='pending' AND i.execution_fingerprint=s.execution_fingerprint
        ORDER BY i.created_at,i.sample_id LIMIT $2 FOR UPDATE OF i SKIP LOCKED`, [generationId, options.admissionLimit]);
      for (const row of rows.rows) {
        const requested = await work.request({ sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint), trigger: { kind: "sample_created" }, requestedAt: at });
        if (requested !== "scheduled" && requested !== "duplicate") continue;
        await transaction.query(`UPDATE forward_sample_work_intents SET status='dispatched' WHERE sample_id=$1 AND execution_fingerprint=$2 AND status='pending'`,
          [row.sample_id,row.execution_fingerprint]);
      }
    });
    if (stage === "capability") return run(transaction => createPostgresForwardTraderCapabilityWorkRepository(transaction).reconcile({ generationId, now: at, limit: options.admissionLimit, intervalMs: options.reconcileIntervalMs }));
    if (stage === "signal") return run(async transaction => {
      await transaction.query(`/* wallet-signal-expire */ WITH stale AS (SELECT j.generation_id,j.chain,j.token_address FROM wallet_forward_signal_jobs j
        WHERE j.generation_id=$1 AND j.status<>'expired' AND (j.status<>'leased' OR j.lease_expires_at<=$2) AND NOT EXISTS(SELECT 1 FROM forward_purchase_samples s
          WHERE s.generation_id=j.generation_id AND s.chain=j.chain AND s.token_address=j.token_address
            AND s.occurred_at BETWEEN $3 AND $2 AND s.created_at<=$2
            AND NOT EXISTS(SELECT 1 FROM forward_signal_economic_consumption c WHERE c.generation_id=s.generation_id
              AND c.chain=s.chain AND c.token_address=s.token_address AND c.trade_id=s.trade_id))
        ORDER BY j.requested_at,j.chain,j.token_address LIMIT $4 FOR UPDATE OF j SKIP LOCKED)
        UPDATE wallet_forward_signal_jobs j SET status='expired',reason_code='window_expired',lease_owner=NULL,lease_expires_at=NULL
        FROM stale WHERE j.generation_id=stale.generation_id AND j.chain=stale.chain AND j.token_address=stale.token_address`,
      [generationId,at,Math.max(0,at-FORWARD_SIGNAL_WINDOW_MS),options.admissionLimit]);
      const candidates = await transaction.query(`/* wallet-signal-wake-admission */ WITH recent AS (
        SELECT s.* FROM forward_purchase_samples s WHERE s.generation_id=$1 AND s.occurred_at BETWEEN $3 AND $2 AND s.created_at<=$2
          AND NOT EXISTS(SELECT 1 FROM forward_signal_economic_consumption c WHERE c.generation_id=s.generation_id
            AND c.chain=s.chain AND c.token_address=s.token_address AND c.trade_id=s.trade_id)
      ), wakes AS (
        SELECT 'sample' source_kind,jsonb_build_array(s.sample_id,s.execution_fingerprint)::text source_key,s.chain,s.token_address,s.created_at changed_at FROM recent s
        UNION ALL SELECT 'revision',jsonb_build_array(r.trade_id,r.fingerprint)::text,s.chain,s.token_address,r.recorded_at
          FROM recent s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id WHERE r.recorded_at BETWEEN s.created_at AND $2
        UNION ALL SELECT 'authorization',a.intent_key,s.chain,s.token_address,a.created_at
          FROM recent s JOIN forward_target_authorization_intents a ON a.entity_id=s.entity_id WHERE a.created_at BETWEEN s.created_at AND $2
        UNION ALL SELECT 'capability',v.version_id,s.chain,s.token_address,v.as_of
          FROM recent s JOIN forward_trader_capability_versions v ON v.entity_id=s.entity_id AND v.generation_id=s.generation_id WHERE v.as_of BETWEEN s.created_at AND $2
        UNION ALL SELECT 'peak',jsonb_build_array(p.peak_id,p.revision_id)::text,s.chain,s.token_address,p.known_at
          FROM recent s JOIN forward_peak_evidence p ON p.chain=s.chain AND p.token_address=s.token_address
          WHERE p.known_at BETWEEN s.created_at AND $2 AND p.observed_until>=s.occurred_at
        UNION ALL SELECT 'fact',i.source_key,i.chain,i.token_address,i.created_at FROM wallet_forward_signal_wake_intents i
          WHERE i.generation_id=$1 AND i.status='pending' AND i.created_at<=$2 AND EXISTS(SELECT 1 FROM recent s
            WHERE s.chain=i.chain AND s.token_address=i.token_address AND i.created_at>=s.created_at)
      ) SELECT DISTINCT w.* FROM wakes w WHERE NOT EXISTS(SELECT 1 FROM wallet_forward_signal_wake_receipts r
        WHERE r.generation_id=$1 AND r.source_kind=w.source_kind AND r.source_key=w.source_key AND r.chain=w.chain AND r.token_address=w.token_address)
      ORDER BY changed_at,source_kind,source_key,chain,token_address LIMIT $4`,
      [generationId,at,Math.max(0,at-FORWARD_SIGNAL_WINDOW_MS),options.admissionLimit]);
      for (const row of candidates.rows) {
        const receipt = await transaction.query(`INSERT INTO wallet_forward_signal_wake_receipts(generation_id,source_kind,source_key,chain,token_address,dispatched_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING source_key`,[generationId,row.source_kind,row.source_key,row.chain,row.token_address,at]);
        if (!receipt.rows.length) continue;
        await transaction.query(`INSERT INTO wallet_forward_signal_jobs(generation_id,chain,token_address,next_attempt_at,requested_at,wake_generation)
          VALUES($1,$2,$3,$4,$4,1) ON CONFLICT(generation_id,chain,token_address) DO UPDATE SET
          wake_generation=wallet_forward_signal_jobs.wake_generation+1,
          status=CASE WHEN wallet_forward_signal_jobs.status='leased' THEN 'leased' ELSE 'pending' END,
          next_attempt_at=EXCLUDED.next_attempt_at,requested_at=EXCLUDED.requested_at`,[generationId,row.chain,row.token_address,at]);
        if (row.source_kind === "fact") await transaction.query(`UPDATE wallet_forward_signal_wake_intents SET status='dispatched'
          WHERE generation_id=$1 AND source_key=$2 AND chain=$3 AND token_address=$4`,[generationId,row.source_key,row.chain,row.token_address]);
      }
    });
  }
  async function process(stage: PostgresCompositionStage, report: StageReport, signal: AbortSignal) {
    if (stage === "normalization") {
      const lease = await claimNormalization(); if (!lease) return false; report.claimed++;
      const applied = await withLease(lease, transaction => normalizePostgresWalletLease(transaction, lease, { now: now(), maximumPayloadBytes: options.maximumPayloadBytes }));
      ensureApplied(applied); report.applied++; return true;
    }
    if (stage === "token" || stage === "purchase") {
      const config = consumer(stage);
      const lease = await run(transaction => stage === "purchase"
        ? claimPostgresReadyPurchase(transaction, { ...leaseInput(),generationId,consumerVersion: config.consumerVersion,
          maximumFacts: options.factLimit,maximumCaptures: options.admissionLimit,maximumPayloadBytes: options.maximumPayloadBytes,
          preferReady: purchaseHintTurn })
        : createPostgresConsumerWorkRepository(transaction, config).claim(leaseInput()));
      // Alternate with unchanged FIFO claims: continuous live hints cannot starve missing-proof work.
      if (stage === "purchase" && lease) purchaseHintTurn = !purchaseHintTurn;
      if (!lease) return false; report.claimed++;
      const defer = (reasonCode: string) => withLease(lease, async transaction => {
        const at = now(); ensureApplied(await createPostgresConsumerWorkRepository(transaction, config).defer(lease, { now: at, retryAt: at + options.retryDelayMs, reasonCode }));
      });
      if (lease.requiresReview) { await defer("source_revision_review"); report.deferred++; return true; }
      const source = await run(transaction => transaction.query("SELECT * FROM capture_normalized_results WHERE job_id=$1", [lease.jobId]));
      const row = source.rows[0];
      if (!row || typeof row.normalized_payload !== "string") { await defer("normalized_wallet_input_unavailable"); report.deferred++; return true; }
      const payload = JSON.parse(row.normalized_payload) as CapturedPostgresWalletEvent;
      if (payload.schemaVersion !== WALLET_CAPTURE_PARSER_VERSION || payload.generationId !== generationId) { await defer("wallet_generation_mismatch"); report.deferred++; return true; }
      if (stage === "token") {
        await withLease(lease, async transaction => {
          const result = await createPostgresForwardTokenWatchRepository(transaction).discover({ generationId, sourceJobId: lease.jobId, discoveredAt: now() });
          ensureApplied(await createPostgresConsumerWorkRepository(transaction, config).complete(lease, result.status === "watch_ready"
            ? { outcome: "produced", resultKey: JSON.stringify([generationId, result.watch.chain, result.watch.tokenAddress]) }
            : { outcome: "no_output", reasonCode: "non_trade_event" }, now()));
        }); report.applied++; return true;
      }
      if (row.event_kind !== "buy") {
        await withLease(lease, async transaction => { ensureApplied(await createPostgresConsumerWorkRepository(transaction, config).complete(lease, { outcome: "no_output", reasonCode: "non_trade_event" }, now())); });
        report.applied++; return true;
      }
      const resolution = await external(readSignal => options.adapters.purchase({ ...context(now(), readSignal), lease, payload }), signal);
      if (resolution.status === "deferred") { await defer(resolution.reasonCode); report.deferred++; return true; }
      // A fact port may enrich amounts, but cannot move a captured execution to an invented owner or time.
      preparePostgresWalletCapture({ ...payload, sessionId: "purchase-validation", receivedAt: now(),
        executionTrust: "unverified", verifiedPurchase: resolution.purchase,
        ...(resolution.externalBasis ? { externalBasis: resolution.externalBasis } : {}) });
      const status = await withLease(lease, async transaction => {
        const at = now(), work = createPostgresConsumerWorkRepository(transaction, config);
        const result = await createPostgresForwardPurchaseRepository(transaction).record({ generationId, sourceJobId: lease.jobId, purchase: resolution.purchase, recordedAt: at });
        if (result.status === "revision_pending" || result.status === "ownership_conflict") {
          ensureApplied(await work.defer(lease, { now: now(), retryAt: now() + options.retryDelayMs, reasonCode: result.status })); return "deferred";
        }
        if (result.status === "sample_ready") {
          await createPostgresForwardOpportunityWorkRepository(transaction).request({ sampleId: result.sampleId!, executionFingerprint: result.fingerprint, trigger: { kind: "sample_created" }, requestedAt: at });
          await createPostgresForwardTraderCapabilityWorkRepository(transaction).request({ entityId: resolution.purchase.entityId, generationId,
            sourceKind: "sample", sourceKey: JSON.stringify([result.sampleId, result.fingerprint]), now: at });
        }
        ensureApplied(await work.complete(lease, result.status === "sample_ready" ? { outcome: "produced", resultKey: `forward-sample:${result.sampleId}` }
          : { outcome: "no_output", reasonCode: "excluded_by_policy" }, now()));
        return "applied";
      });
      if (status === "deferred") report.deferred++; else report.applied++;
      return true;
    }
    if (stage === "fanout") {
      const lease = await run(transaction => createPostgresForwardOpportunityFanoutRepository(transaction).claim(leaseInput()));
      if (!lease) return false; report.claimed++;
      await withLease(lease, transaction => createPostgresForwardOpportunityFanoutRepository(transaction).dispatch(lease, { now, limit: options.admissionLimit }));
      report.applied++; return true;
    }
    if (stage === "opportunity") {
      const lease = await claimOpportunity(); if (!lease) return false; report.claimed++;
      let result: Awaited<ReturnType<typeof consumePostgresForwardOpportunity>> | { status: "deferred"; reasonCode: string };
      try { result = await withLease(lease, async transaction => {
        const at = now(), result = await consumePostgresForwardOpportunity(boundPostgresOpportunityEvidence(transaction, options.factLimit), lease, { now: at, retryAt: at + options.retryDelayMs });
        if (result.status === "evaluated") {
          const owner = (await transaction.query("SELECT entity_id FROM forward_purchase_samples WHERE sample_id=$1 AND generation_id=$2", [lease.sampleId, generationId])).rows[0];
          if (!owner) throw new Error("Opportunity lease crossed its generation");
          await createPostgresForwardTraderCapabilityWorkRepository(transaction).request({ entityId: String(owner.entity_id), generationId, sourceKind: "opportunity", sourceKey: result.evaluationId, now: now() });
        }
        return result;
      }); } catch (error) {
        if (!(error instanceof PostgresOpportunityEvidenceBudgetError)) throw error;
        await withLease(lease, transaction => createPostgresForwardOpportunityWorkRepository(transaction).defer(lease,
          { now: now(), retryAt: now() + options.retryDelayMs, reasonCode: "opportunity_evidence_budget_exceeded" }));
        result = { status: "deferred", reasonCode: "opportunity_evidence_budget_exceeded" };
      }
      if (result.status === "deferred") report.deferred++; else report.applied++; return true;
    }
    if (stage === "capability") {
      const lease = await claimCapability(); if (!lease) return false; report.claimed++;
      const result = await withLease(lease, async transaction => {
        const at = now(), work = createPostgresForwardTraderCapabilityWorkRepository(transaction);
        const loaded = await createPostgresForwardTraderCapabilityRepository(transaction).load({ entityId: lease.entityId, generationId, asOf: at, maximumSamples: options.maximumSamples });
        const missing = loaded.status === "deferred" || loaded.facts.some(fact => !fact.screening || !fact.evaluation
          || fact.screening.knownAt > at || fact.screening.observedAt > at || !fact.sample.entryBasisVerified
          || !fact.sample.entryPriceUsd || !fact.sample.executionEvidenceRef
          || ["awaiting_verification", "insufficient_coverage"].includes(fact.evaluation.status)
          || (fact.evaluation.status === "hit" && (!fact.peak || fact.peak.verification !== "validated" || fact.peak.knownAt > at)));
        if (missing) { await work.defer(lease, { now: now(), retryAt: now() + options.retryDelayMs, reasonCode: "capability_facts_unavailable" }); return { status: "deferred" }; }
        return consumePostgresForwardTraderCapability(transaction, lease, { now, maximumSamples: options.maximumSamples, retryDelayMs: options.retryDelayMs });
      });
      if (result.status === "deferred") report.deferred++; else report.applied++; return true;
    }
    const lease = await claimSignal(); if (!lease) return false; report.claimed++;
    if (await processSignal(lease, signal) === "deferred") report.deferred++; else report.applied++;
    return true;
  }

  return Object.freeze({ identity: Object.freeze({ ...identity }), generation: Object.freeze({ ...options.generation }),
    async readTrace(input: Omit<ForwardTraceQuery, "generationId">) { return run(transaction => readPostgresForwardTrace(transaction, { ...input, generationId })); },
    async runOnce(signal: AbortSignal = new AbortController().signal) {
      if (running) throw new Error("PostgreSQL composition is already running");
      signal.throwIfAborted(); running = true;
      const started = performance.now(), offset = firstStage; firstStage = (firstStage + 1) % activeStages.length;
      const stages = Object.fromEntries(stageNames.map(stage => [stage, { attempted: 0, claimed: 0, applied: 0, deferred: 0, failed: 0 }])) as Record<PostgresCompositionStage, StageReport>;
      let facts: { status: "available" | "deferred" | "failed" | "disabled"; peaks: number; markets: number } = { status: includePrices ? "deferred" : "disabled", peaks: 0, markets: 0 };
      const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(options.maximumRunMs)]);
      const perStageMs = Math.max(1, Math.floor(options.maximumRunMs / (activeStages.length + (includePrices ? 1 : 0))));
      try {
        if (includePrices) try {
          const readSignal = AbortSignal.any([turnSignal, AbortSignal.timeout(perStageMs)]);
          const asOf = now(), input = await external(child => options.adapters.prices(context(asOf, child)), readSignal);
          if (input.status === "available") {
            await run(transaction => receivePostgresProductionPriceBatch(transaction, { generationId, asOf, limit: options.factLimit, batch: input, now }));
            facts = { status: "available", peaks: input.peaks.length, markets: input.markets.length };
          }
        } catch { signal.throwIfAborted(); facts = { status: "failed", peaks: 0, markets: 0 }; }
        let attempts = 0;
        for (let index = 0; index < activeStages.length; index++) {
          signal.throwIfAborted();
          if (turnSignal.aborted || performance.now() - started >= options.maximumRunMs) break;
          const stage = activeStages[(offset + index) % activeStages.length]!, report = stages[stage];
          const stageSignal = AbortSignal.any([turnSignal, AbortSignal.timeout(perStageMs)]);
          try {
            await admission(stage);
            for (let count = 0; count < options.quotas[stage] && attempts < options.maximumClaims; count++) {
              if (stageSignal.aborted) break;
              report.attempted++; attempts++;
              if (!await process(stage, report, stageSignal)) break;
            }
          } catch { signal.throwIfAborted(); report.failed++; }
        }
        return Object.freeze({ generationId, activeStages: Object.freeze([...activeStages]), stages, facts, elapsedMs: performance.now() - started,
          gatewayDeliveryEnabled: false as const, fomoEnabled: false as const });
      } finally { running = false; }
    },
  });
}
