import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createFactDemandStore, withAddressRadarWriteTransaction, type AutomationJobStore } from "@address-radar/database";
import { normalizeAddressRadarTokenAddress, type MarketObservation, type RepeatableTraderAbilityStage, type TraderEvent } from "@address-radar/domain";
import { evaluateRepeatableTraderAbility, evaluateTraderOpportunityHistory } from "@address-radar/wallet-analysis";

import { detectRepeatedBundleRisk, type BundleTrade } from "./bundle-risk-detector.js";
import type { AutomationExecutionResult, AutomationHandler } from "./scheduler.js";

const STRATEGY_VERSION = "trader-ability-v4-opportunity";
const DAY_MS = 24 * 60 * 60_000;
const WINDOWS = Object.freeze(["30d"] as const);
const DISPATCH_BATCH_SIZE = 100;
const ACTIVE_JOB_HIGH_WATER_MARK = 1_000;
const BACKPRESSURE_DELAY_MS = 5 * 60_000;

interface AbilityPayload {
  readonly mode?: "dispatch";
  readonly traderId?: string;
  readonly evaluatedAt?: number;
}

interface SampleRow {
  readonly sampleId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly firstBuyAt: number;
  readonly sampleStatus: string;
  readonly weightedEntryPriceUsd: number | null;
  readonly totalBuyUsd: number | null;
}

interface OutcomeRow {
  readonly sampleId: string;
  readonly closeMultiple: number | null;
  readonly coverageStatus: string;
  readonly computedAt: number;
  readonly mfeMultiple: number | null;
  readonly observedAt: number | null;
  readonly source: string | null;
}

interface WalletPositionPayload {
  readonly tokenId: string;
  readonly enteredAt: number;
  readonly investedUsd: number;
  readonly realizedValueUsd: number;
  readonly remainingValueUsd: number;
}

interface BundleRiskCache {
  day: number;
  fingerprint: string;
  result: ReturnType<typeof detectRepeatedBundleRisk> | null;
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function parsePayload(payload: string): AbilityPayload {
  try { return JSON.parse(payload) as AbilityPayload; } catch { return {}; }
}

function previousStage(database: DatabaseSync, traderId: string): RepeatableTraderAbilityStage | null {
  const row = database.prepare(`
    SELECT ability_stage AS abilityStage
    FROM trader_repeatable_ability_snapshots
    WHERE entity_id = ? AND window = '30d'
    ORDER BY evaluated_at DESC, snapshot_id DESC
    LIMIT 1
  `).get(traderId) as { abilityStage: RepeatableTraderAbilityStage } | undefined;
  return row?.abilityStage ?? null;
}

function bundleRisk(database: DatabaseSync, evaluatedAt: number, cache: BundleRiskCache) {
  const day = Math.floor(evaluatedAt / DAY_MS);
  const windowStart = (day - 30) * DAY_MS;
  const windowEnd = (day + 1) * DAY_MS - 1;
  const state = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS latest
    FROM canonical_trader_events
    WHERE side = 'buy' AND occurred_at >= ? AND occurred_at <= ?
  `).get(windowStart, windowEnd) as { count: number; latest: number };
  const fingerprint = `${day}:${state.count}:${state.latest}`;
  if (cache.fingerprint === fingerprint && cache.result) return cache.result;
  const trades = database.prepare(`
    SELECT canonical_event_id AS eventId, entity_id AS traderId, chain,
      token_address AS tokenAddress, occurred_at AS occurredAt
    FROM canonical_trader_events
    WHERE side = 'buy' AND occurred_at >= ? AND occurred_at <= ?
    ORDER BY chain, token_address, occurred_at
  `).all(windowStart, windowEnd) as unknown as BundleTrade[];
  const result = detectRepeatedBundleRisk(trades);
  const statement = database.prepare(`
    INSERT INTO wallet_bundle_pair_tokens(
      pair_key, token_id, chain, left_entity_id, right_entity_id,
      min_delta_ms, first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pair_key, token_id) DO UPDATE SET
      min_delta_ms = MIN(wallet_bundle_pair_tokens.min_delta_ms, excluded.min_delta_ms),
      first_observed_at = MIN(wallet_bundle_pair_tokens.first_observed_at, excluded.first_observed_at),
      last_observed_at = MAX(wallet_bundle_pair_tokens.last_observed_at, excluded.last_observed_at)
  `);
  for (const pair of result.pairs) {
    statement.run(pair.pairKey, pair.tokenId, pair.chain, pair.leftTraderId, pair.rightTraderId,
      pair.deltaMs, pair.observedAt, pair.observedAt);
  }
  cache.day = day;
  cache.fingerprint = fingerprint;
  cache.result = result;
  return result;
}

async function evaluateTrader(input: {
  readonly database: DatabaseSync;
  readonly traderId: string;
  readonly evaluatedAt: number;
  readonly bundleRiskCache: BundleRiskCache;
}): Promise<AutomationExecutionResult> {
  const exists = input.database.prepare("SELECT 1 AS present FROM trader_entities WHERE entity_id = ?").get(input.traderId);
  if (!exists) return { status: "terminal", diagnostic: "trader entity does not exist" };
  const samples = input.database.prepare(`
    SELECT sample_id AS sampleId, chain, token_address AS tokenAddress,
      first_buy_at AS firstBuyAt, sample_status AS sampleStatus,
      weighted_entry_price_usd AS weightedEntryPriceUsd, total_buy_usd AS totalBuyUsd
    FROM trader_token_samples
    WHERE entity_id = ?
  `).all(input.traderId) as unknown as SampleRow[];
  const outcomes = input.database.prepare(`
    SELECT o.sample_id AS sampleId, o.close_multiple AS closeMultiple,
      o.coverage_status AS coverageStatus, o.computed_at AS computedAt,
      o.mfe_multiple AS mfeMultiple, o.observed_at AS observedAt, o.source
    FROM trader_token_outcomes o
    JOIN trader_token_samples s ON s.sample_id = o.sample_id
    WHERE s.entity_id = ?
  `).all(input.traderId) as unknown as OutcomeRow[];
  const walletRows = input.database.prepare(`
    SELECT p.analysis_id AS analysisId, p.token_id AS tokenId, p.payload,
      j.updated_at AS computedAt
    FROM wallet_analysis_positions p
    JOIN wallet_analysis_jobs j ON j.analysis_id = p.analysis_id
    JOIN automation_jobs a ON a.idempotency_key = p.analysis_id
    WHERE a.job_type = 'initial_wallet_backfill'
      AND (a.subject_key = ? OR CASE WHEN json_valid(a.payload)
        THEN json_extract(a.payload, '$.traderId') END = ?)
      AND j.status IN ('review_required', 'accepted', 'insufficient_data')
    ORDER BY j.updated_at DESC, p.entered_at DESC
  `).all(input.traderId, input.traderId) as Array<{ analysisId: string; tokenId: string; payload: string; computedAt: number }>;
  const existingTokens = new Set(samples.map((sample) => `${sample.chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(sample.chain, sample.tokenAddress)}`));
  const walletTokens = new Set<string>();
  for (const row of walletRows) {
    const position = parseWalletPosition(row.payload);
    if (!position || position.investedUsd <= 0) continue;
    const identity = splitTokenId(position.tokenId || row.tokenId);
    if (!identity || existingTokens.has(identity.tokenKey) || walletTokens.has(identity.tokenKey)) continue;
    walletTokens.add(identity.tokenKey);
    const sampleId = `wallet-analysis:${input.traderId}:${identity.tokenKey}`;
    samples.push(Object.freeze({
      sampleId,
      chain: identity.chain,
      tokenAddress: identity.tokenAddress,
      firstBuyAt: position.enteredAt,
      sampleStatus: "included",
      weightedEntryPriceUsd: null,
      totalBuyUsd: position.investedUsd,
    }));
    outcomes.push(Object.freeze({
      sampleId,
      closeMultiple: (position.realizedValueUsd + position.remainingValueUsd) / position.investedUsd,
      coverageStatus: "complete",
      computedAt: row.computedAt,
      mfeMultiple: null,
      observedAt: null,
      source: null,
    }));
  }
  const events = input.database.prepare(`
    SELECT event_id AS eventId, account_id AS accountId, entity_id AS entityId,
      chain, token_address AS tokenAddress, side, amount_usd AS amountUsd,
      price_usd AS priceUsd, market_cap_usd AS marketCapUsd, token_age_ms AS tokenAgeMs,
      occurred_at AS occurredAt, collected_at AS collectedAt, source
    FROM trader_events WHERE entity_id = ? AND collected_at <= ?
  `).all(input.traderId, input.evaluatedAt) as unknown as TraderEvent[];
  const marketStatement = input.database.prepare(`
    SELECT observed_at AS observedAt, price_usd AS priceUsd, source
    FROM market_observations
    WHERE chain = ? AND token_address = ? AND observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at, source
  `);
  const opportunities = evaluateTraderOpportunityHistory({
    events, samples, outcomes, asOf: input.evaluatedAt,
    readObservations: (chain, address, from, to) => marketStatement.all(chain, address, from, to) as unknown as MarketObservation[],
  });
  const demands = createFactDemandStore(input.database);
  withAddressRadarWriteTransaction(input.database, () => {
    for (const purchase of opportunities.purchases) {
      if (purchase.status === "excluded") continue;
      const requiredTo = Math.min(purchase.observationEndAt, input.evaluatedAt);
      for (const purpose of ["positive_hit", "complete_range"] as const) {
        const evidence = purchase.maximumEvidence;
        const proven = purpose === "positive_hit" ? purchase.status === "hit" && evidence !== null : purchase.rangeCovered;
        demands.record({
          demandId: stableId("ability-demand", [STRATEGY_VERSION, input.traderId, purchase.purchaseId, purpose]),
          consumerId: input.traderId, purchaseId: purchase.purchaseId, tokenId: purchase.tokenKey,
          strategyVersion: STRATEGY_VERSION, purpose,
          requiredFrom: purchase.boughtAt, requiredTo, evaluatedAt: input.evaluatedAt,
          reasonCode: proven ? "verified_opportunity" : purchase.reasonCode === "verified_opportunity" ? "market_range_missing" : purchase.reasonCode,
          proof: proven ? { kind: purpose,
            from: purpose === "positive_hit" ? evidence!.from : purchase.boughtAt,
            to: purpose === "positive_hit" ? evidence!.to : requiredTo,
            knownAt: purpose === "positive_hit" ? evidence!.computedAt : input.evaluatedAt,
            reference: purpose === "positive_hit"
              ? `${evidence!.source}:${purchase.tokenKey}:${evidence!.from}:${evidence!.to}`
              : `${opportunities.strategyVersion}:${purchase.purchaseId}`,
            ...(purpose === "positive_hit" ? { maximumMultiple: purchase.maximumMultiple! } : {}),
          } : null,
        });
      }
    }
  }, { label: "record_ability_fact_demands" });
  const riskResult = bundleRisk(input.database, input.evaluatedAt, input.bundleRiskCache);
  const risk = riskResult.traders.get(input.traderId) ?? Object.freeze({
    traderId: input.traderId,
    state: "none" as const,
    distinctTokenCount: 0,
    within5sTokenCount: 0,
    within10sTokenCount: 0,
  });
  const prior = previousStage(input.database, input.traderId);
  const statement = input.database.prepare(`
    INSERT OR REPLACE INTO trader_repeatable_ability_snapshots(
      snapshot_id, entity_id, window, ability_stage, bundle_risk_state,
      total_samples, valid_samples, successful_distinct_tokens, win_rate,
      sample_span_ms, maximum_single_token_profit_share, bundle_distinct_token_count,
      reason_codes, strategy_version, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const window of WINDOWS) {
    const evaluation = evaluateRepeatableTraderAbility({
      samples,
      outcomes,
      asOf: input.evaluatedAt,
      window,
      previousStage: window === "30d" ? prior : null,
      opportunities,
    });
    const reasonCodes = risk.state === "bundle_risk"
      ? [...evaluation.reasonCodes, "bundle_risk"]
      : evaluation.reasonCodes;
    statement.run(
      stableId("repeatable-ability", [STRATEGY_VERSION, input.traderId, window, input.evaluatedAt]),
      input.traderId,
      window,
      evaluation.stage,
      risk.state,
      evaluation.metrics.totalSamples,
      evaluation.metrics.validSamples,
      evaluation.metrics.successfulDistinctTokens,
      evaluation.metrics.winRate,
      evaluation.metrics.sampleSpanMs,
      evaluation.metrics.maximumSingleTokenProfitShare,
      risk.distinctTokenCount,
      JSON.stringify(reasonCodes),
      STRATEGY_VERSION,
      input.evaluatedAt,
    );
  }
  for (const label of opportunities.labels) {
    input.database.prepare(`
      INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
      VALUES (?, 'ability', ?, ?)
    `).run(input.traderId, `ability.historical_${label}`, input.evaluatedAt);
  }
  if (risk.state === "bundle_risk") {
    input.database.prepare(`
      INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
      VALUES (?, 'ability', 'bundle_risk', ?)
    `).run(input.traderId, input.evaluatedAt);
  }
  return {
    status: "completed",
    diagnostic: `ability evaluated with ${samples.length} samples (${walletTokens.size} wallet-history samples)`,
  };
}

function parseWalletPosition(payload: string): WalletPositionPayload | null {
  try {
    const value = JSON.parse(payload) as Partial<WalletPositionPayload>;
    if (typeof value.tokenId !== "string"
      || !Number.isFinite(value.enteredAt)
      || !Number.isFinite(value.investedUsd)
      || !Number.isFinite(value.realizedValueUsd)
      || !Number.isFinite(value.remainingValueUsd)) return null;
    return value as WalletPositionPayload;
  } catch {
    return null;
  }
}

function splitTokenId(tokenId: string): { readonly chain: string; readonly tokenAddress: string; readonly tokenKey: string } | null {
  const separator = tokenId.indexOf(":");
  if (separator <= 0 || separator === tokenId.length - 1) return null;
  const chain = tokenId.slice(0, separator).toLowerCase();
  const tokenAddress = normalizeAddressRadarTokenAddress(chain, tokenId.slice(separator + 1));
  return Object.freeze({ chain, tokenAddress, tokenKey: `${chain}:${tokenAddress}` });
}

async function dispatch(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly cursor: string | null;
  readonly now: number;
}): Promise<AutomationExecutionResult> {
  const activeWorkerJobs = Math.max(0, input.jobs.activeCount("ability_evaluation") - 1);
  if (activeWorkerJobs >= ACTIVE_JOB_HIGH_WATER_MARK) {
    return {
      status: "checkpoint",
      cursor: input.cursor,
      retryAt: input.now + BACKPRESSURE_DELAY_MS,
      diagnostic: `ability dispatch paused at ${activeWorkerJobs} active jobs`,
    };
  }
  const day = Math.floor(input.now / DAY_MS);
  let cursorDay = -1;
  let cursorStrategyVersion = "";
  let lastTraderId = "";
  try {
    const parsed = JSON.parse(input.cursor ?? "{}") as { day?: number; lastTraderId?: string; strategyVersion?: string };
    cursorDay = Number(parsed.day ?? -1);
    cursorStrategyVersion = typeof parsed.strategyVersion === "string" ? parsed.strategyVersion : "";
    lastTraderId = typeof parsed.lastTraderId === "string" ? parsed.lastTraderId : "";
  } catch { /* restart the current daily scan */ }
  if (cursorDay !== day || cursorStrategyVersion !== STRATEGY_VERSION) lastTraderId = "";
  const availableCapacity = Math.min(
    DISPATCH_BATCH_SIZE,
    ACTIVE_JOB_HIGH_WATER_MARK - activeWorkerJobs,
  );
  const rows = input.database.prepare(`
    SELECT entity_id AS traderId,
      CASE
        WHEN EXISTS(SELECT 1 FROM candidate_evidence_v3 c WHERE c.trader_id = trader_entities.entity_id) THEN 96
        WHEN EXISTS(SELECT 1 FROM candidate_admission_snapshots c WHERE c.trader_id = trader_entities.entity_id AND c.current_admission = 1) THEN 92
        WHEN EXISTS(SELECT 1 FROM entity_wallet_identities w WHERE w.entity_id = trader_entities.entity_id)
          OR EXISTS(
            SELECT 1 FROM entity_accounts ea
            JOIN wallet_identities w ON w.account_id = ea.account_id
            WHERE ea.entity_id = trader_entities.entity_id
          ) THEN 86
        ELSE 76
      END AS priority
    FROM trader_entities
    WHERE entity_id > ? AND (
      EXISTS(SELECT 1 FROM trader_token_samples s WHERE s.entity_id = trader_entities.entity_id)
      OR EXISTS(SELECT 1 FROM candidate_admission_snapshots c WHERE c.trader_id = trader_entities.entity_id)
    )
    ORDER BY entity_id
    LIMIT ?
  `).all(lastTraderId, availableCapacity) as unknown as Array<{ traderId: string; priority: number }>;
  for (const row of rows) enqueueTraderAbilityEvaluation(input.jobs, row.traderId, input.now, input.now, `daily:${day}`, row.priority);
  const exhausted = rows.length < availableCapacity;
  return {
    status: "checkpoint",
    cursor: JSON.stringify({ day, strategyVersion: STRATEGY_VERSION, lastTraderId: exhausted ? "\uffff" : rows.at(-1)!.traderId }),
    retryAt: exhausted ? (day + 1) * DAY_MS : input.now,
    diagnostic: `ability dispatch: ${rows.length} traders`,
  };
}

export function enqueueTraderAbilityEvaluation(
  jobs: AutomationJobStore,
  traderId: string,
  evaluatedAt: number,
  now: number,
  sourceKey: string,
  priority = 76,
): void {
  if (jobs.activeJobForSubject("ability_evaluation", traderId)) return;
  const idempotencyKey = `ability-evaluation:${traderId}:${sourceKey}:${STRATEGY_VERSION}`;
  jobs.enqueue({
    jobId: stableId("ability-evaluation", [idempotencyKey]),
    idempotencyKey,
    lane: "trader_backfill",
    jobType: "ability_evaluation",
    subjectKey: traderId,
    priority,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({ traderId, evaluatedAt }),
    createdAt: now,
  });
}

export function enqueueTraderAbilityDispatcher(jobs: AutomationJobStore, now: number): void {
  jobs.cancelRedundantActiveJobs("ability_evaluation", "trader-ability-dispatcher", now);
  jobs.enqueue({
    jobId: "trader-ability-dispatcher-v1",
    idempotencyKey: "trader-ability-dispatcher-v1",
    lane: "repair",
    jobType: "ability_evaluation",
    subjectKey: "trader-ability-dispatcher",
    priority: 72,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({ mode: "dispatch" }),
    createdAt: now,
  });
}

export function createTraderAbilityWorker(input: {
  readonly database: DatabaseSync;
  readonly jobs?: AutomationJobStore;
  readonly now?: () => number;
}): AutomationHandler {
  const now = input.now ?? Date.now;
  const bundleRiskCache: BundleRiskCache = { day: -1, fingerprint: "", result: null };
  withAddressRadarWriteTransaction(input.database, () => {
    input.database.prepare(`
      UPDATE automation_jobs
      SET priority = CASE
        WHEN EXISTS(SELECT 1 FROM candidate_evidence_v3 c WHERE c.trader_id = automation_jobs.subject_key) THEN 96
        WHEN EXISTS(SELECT 1 FROM candidate_admission_snapshots c WHERE c.trader_id = automation_jobs.subject_key AND c.current_admission = 1) THEN 92
        WHEN EXISTS(SELECT 1 FROM entity_wallet_identities w WHERE w.entity_id = automation_jobs.subject_key)
          OR EXISTS(
            SELECT 1 FROM entity_accounts ea
            JOIN wallet_identities w ON w.account_id = ea.account_id
            WHERE ea.entity_id = automation_jobs.subject_key
          ) THEN 86
        ELSE 76
      END
      WHERE job_type = 'ability_evaluation'
        AND subject_key != 'trader-ability-dispatcher'
        AND status IN ('pending', 'retryable', 'waiting_source', 'blocked_source')
    `).run();
    const startedAt = now();
    input.database.prepare(      `UPDATE automation_jobs
       SET cursor = NULL, next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
       WHERE job_id = 'trader-ability-dispatcher-v1'
         AND job_type = 'ability_evaluation' AND subject_key = 'trader-ability-dispatcher'
         AND status IN ('pending', 'retryable')
         AND CASE WHEN json_valid(cursor) THEN json_extract(cursor, '$.strategyVersion')
           ELSE NULL END IS NOT ?`
    ).run(startedAt, startedAt, STRATEGY_VERSION);
  }, { label: "prioritize_ability_jobs" });
  return {
    jobType: "ability_evaluation",
    async execute(job) {
      const payload = parsePayload(job.payload);
      if (payload.mode === "dispatch") {
        if (!input.jobs) return { status: "terminal", diagnostic: "ability dispatcher requires a job store" };
        return dispatch({ database: input.database, jobs: input.jobs, cursor: job.cursor, now: now() });
      }
      if (!payload.traderId) return { status: "terminal", diagnostic: "ability job requires traderId" };
      return evaluateTrader({
        database: input.database,
        traderId: payload.traderId,
        evaluatedAt: Math.max(payload.evaluatedAt ?? 0, now()),
        bundleRiskCache,
      });
    },
  };
}
