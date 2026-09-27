import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AutomationJobStore } from "@address-radar/database";
import type { RepeatableTraderAbilityStage, RepeatableTraderAbilityWindow } from "@address-radar/domain";
import { evaluateRepeatableTraderAbility } from "@address-radar/wallet-analysis";

import { detectRepeatedBundleRisk, type BundleTrade } from "./bundle-risk-detector.js";
import type { AutomationExecutionResult, AutomationHandler } from "./scheduler.js";

const STRATEGY_VERSION = "trader-ability-v3-repeatable";
const DAY_MS = 24 * 60 * 60_000;
const WINDOWS = Object.freeze(["24h", "7d", "30d"] as const);
const DISPATCH_BATCH_SIZE = 100;

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
}

interface OutcomeRow {
  readonly sampleId: string;
  readonly closeMultiple: number | null;
  readonly coverageStatus: string;
  readonly computedAt: number;
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

function bundleRisk(database: DatabaseSync, evaluatedAt: number) {
  const trades = database.prepare(`
    SELECT canonical_event_id AS eventId, entity_id AS traderId, chain,
      token_address AS tokenAddress, occurred_at AS occurredAt
    FROM canonical_trader_events
    WHERE side = 'buy' AND occurred_at >= ? AND occurred_at <= ?
    ORDER BY chain, token_address, occurred_at
  `).all(evaluatedAt - 30 * DAY_MS, evaluatedAt) as unknown as BundleTrade[];
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
  return result;
}

async function evaluateTrader(input: {
  readonly database: DatabaseSync;
  readonly traderId: string;
  readonly evaluatedAt: number;
}): Promise<AutomationExecutionResult> {
  const exists = input.database.prepare("SELECT 1 AS present FROM trader_entities WHERE entity_id = ?").get(input.traderId);
  if (!exists) return { status: "terminal", diagnostic: "trader entity does not exist" };
  const samples = input.database.prepare(`
    SELECT sample_id AS sampleId, chain, token_address AS tokenAddress,
      first_buy_at AS firstBuyAt, sample_status AS sampleStatus
    FROM trader_token_samples
    WHERE entity_id = ?
  `).all(input.traderId) as unknown as SampleRow[];
  const outcomes = input.database.prepare(`
    SELECT o.sample_id AS sampleId, o.close_multiple AS closeMultiple,
      o.coverage_status AS coverageStatus, o.computed_at AS computedAt
    FROM trader_token_outcomes o
    JOIN trader_token_samples s ON s.sample_id = o.sample_id
    WHERE s.entity_id = ? AND o.horizon = '24h'
  `).all(input.traderId) as unknown as OutcomeRow[];
  const riskResult = bundleRisk(input.database, input.evaluatedAt);
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
  if (risk.state === "bundle_risk") {
    input.database.prepare(`
      INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
      VALUES (?, 'ability', 'bundle_risk', ?)
    `).run(input.traderId, input.evaluatedAt);
  }
  return { status: "completed", diagnostic: `ability evaluated with ${samples.length} samples` };
}

async function dispatch(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly cursor: string | null;
  readonly now: number;
}): Promise<AutomationExecutionResult> {
  const day = Math.floor(input.now / DAY_MS);
  let cursorDay = -1;
  let lastTraderId = "";
  try {
    const parsed = JSON.parse(input.cursor ?? "{}") as { day?: number; lastTraderId?: string };
    cursorDay = Number(parsed.day ?? -1);
    lastTraderId = typeof parsed.lastTraderId === "string" ? parsed.lastTraderId : "";
  } catch { /* restart the current daily scan */ }
  if (cursorDay !== day) lastTraderId = "";
  const rows = input.database.prepare(`
    SELECT entity_id AS traderId
    FROM trader_entities
    WHERE entity_id > ? AND (
      EXISTS(SELECT 1 FROM trader_token_samples s WHERE s.entity_id = trader_entities.entity_id)
      OR EXISTS(SELECT 1 FROM candidate_admission_snapshots c WHERE c.trader_id = trader_entities.entity_id)
    )
    ORDER BY entity_id
    LIMIT ?
  `).all(lastTraderId, DISPATCH_BATCH_SIZE) as unknown as Array<{ traderId: string }>;
  for (const row of rows) enqueueTraderAbilityEvaluation(input.jobs, row.traderId, input.now, input.now, `daily:${day}`);
  const exhausted = rows.length < DISPATCH_BATCH_SIZE;
  return {
    status: "checkpoint",
    cursor: JSON.stringify({ day, lastTraderId: exhausted ? "\uffff" : rows.at(-1)!.traderId }),
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
): void {
  const idempotencyKey = `ability-evaluation:${traderId}:${sourceKey}:${STRATEGY_VERSION}`;
  jobs.enqueue({
    jobId: stableId("ability-evaluation", [idempotencyKey]),
    idempotencyKey,
    lane: "trader_backfill",
    jobType: "ability_evaluation",
    subjectKey: traderId,
    priority: 76,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({ traderId, evaluatedAt }),
    createdAt: now,
  });
}

export function enqueueTraderAbilityDispatcher(jobs: AutomationJobStore, now: number): void {
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
  return {
    jobType: "ability_evaluation",
    async execute(job) {
      const payload = parsePayload(job.payload);
      if (payload.mode === "dispatch") {
        if (!input.jobs) return { status: "terminal", diagnostic: "ability dispatcher requires a job store" };
        return dispatch({ database: input.database, jobs: input.jobs, cursor: job.cursor, now: now() });
      }
      if (!payload.traderId) return { status: "terminal", diagnostic: "ability job requires traderId" };
      return evaluateTrader({ database: input.database, traderId: payload.traderId, evaluatedAt: payload.evaluatedAt ?? now() });
    },
  };
}

