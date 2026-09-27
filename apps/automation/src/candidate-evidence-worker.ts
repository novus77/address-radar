import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createCandidateHistoryStore,
  type AutomationJobStore,
} from "@address-radar/database";
import {
  CANDIDATE_MILESTONES,
  evaluateCandidateAdmission,
  strongestSatisfiedTier,
  type CandidateEvidenceType,
} from "@address-radar/scoring";

import type { AutomationExecutionResult, AutomationHandler } from "./scheduler.js";
import type { CandidateSourceRecoveryPlanner } from "./candidate-source-recovery.js";
import { enqueueTraderAbilityEvaluation } from "./trader-ability-worker.js";

const STRATEGY_VERSION = "candidate-evidence-v1";
const MINIMUM_CUMULATIVE_BUY_USD = 50;
const DISPATCH_INTERVAL_MS = 5_000;
const SOURCE_RETRY_MS = 60_000;
const DISPATCH_BATCH_SIZE = 100;

interface CandidateEvidencePayload {
  readonly mode?: "dispatch";
  readonly tokenId?: string;
  readonly chain?: string;
  readonly tokenAddress?: string;
  readonly traderId?: string;
  readonly evaluatedAt?: number;
}

interface HistoricalTokenRow {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
}

interface MilestoneRow {
  readonly milestoneId: string;
  readonly marketCapUsd: number;
  readonly crossedAt: number;
}

interface BuyEventRow {
  readonly canonicalEventId: string;
  readonly traderId: string;
  readonly amountUsd: number | null;
  readonly occurredAt: number;
  readonly sourceStatus: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN";
}

interface PriceRow {
  readonly observedAt: number;
  readonly priceUsd: number;
}

interface DispatchCursor {
  readonly eventUpdatedAt: number;
  readonly eventId: string;
  readonly milestoneRowId: number;
}

const evidenceRank = new Map<CandidateEvidenceType, number>(
  CANDIDATE_MILESTONES.flatMap(milestone => milestone.tiers).map(tier => [tier.type, tier.rank]),
);

function stableId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function parsePayload(payload: string): CandidateEvidencePayload {
  try {
    return JSON.parse(payload) as CandidateEvidencePayload;
  } catch {
    return {};
  }
}

function parseCursor(cursor: string | null): DispatchCursor {
  if (!cursor) return { eventUpdatedAt: 0, eventId: "", milestoneRowId: 0 };
  try {
    const value = JSON.parse(cursor) as Partial<DispatchCursor>;
    return {
      eventUpdatedAt: Number(value.eventUpdatedAt) || 0,
      eventId: typeof value.eventId === "string" ? value.eventId : "",
      milestoneRowId: Number(value.milestoneRowId) || 0,
    };
  } catch {
    return { eventUpdatedAt: 0, eventId: "", milestoneRowId: 0 };
  }
}

function priceAtOrBefore(prices: readonly PriceRow[], at: number): number | null {
  let selected: number | null = null;
  for (const price of prices) {
    if (price.observedAt > at) break;
    if (price.priceUsd > 0) selected = price.priceUsd;
  }
  return selected;
}

function sourceIds(database: DatabaseSync, events: readonly BuyEventRow[]): readonly string[] {
  const statement = database.prepare(`
    SELECT observation_id AS observationId
    FROM canonical_trader_event_observations
    WHERE canonical_event_id = ?
    ORDER BY observation_id
  `);
  const ids = new Set<string>();
  for (const event of events) {
    const observations = statement.all(event.canonicalEventId) as Array<{ observationId: string }>;
    if (observations.length === 0) {
      ids.add(`${event.canonicalEventId}:${event.sourceStatus}`);
      continue;
    }
    for (const observation of observations) ids.add(observation.observationId);
  }
  return Object.freeze([...ids].sort());
}

function resolveToken(database: DatabaseSync, payload: CandidateEvidencePayload): HistoricalTokenRow | null {
  if (payload.tokenId) {
    const row = database.prepare(`
      SELECT token_id AS tokenId, chain, token_address AS tokenAddress
      FROM historical_tokens
      WHERE token_id = ?
    `).get(payload.tokenId) as HistoricalTokenRow | undefined;
    if (row) return row;
    const separator = payload.tokenId.indexOf(":");
    if (separator > 0 && separator < payload.tokenId.length - 1) {
      return {
        tokenId: payload.tokenId,
        chain: payload.tokenId.slice(0, separator),
        tokenAddress: payload.tokenId.slice(separator + 1),
      };
    }
  }
  if (!payload.chain || !payload.tokenAddress) return null;
  return (database.prepare(`
    SELECT token_id AS tokenId, chain, token_address AS tokenAddress
    FROM historical_tokens
    WHERE chain = ? AND token_address = ?
  `).get(payload.chain, payload.tokenAddress) as HistoricalTokenRow | undefined) ?? {
    tokenId: `${payload.chain}:${payload.tokenAddress}`,
    chain: payload.chain,
    tokenAddress: payload.tokenAddress,
  };
}

function enqueueTokenJob(input: {
  readonly jobs: AutomationJobStore;
  readonly tokenId?: string;
  readonly chain?: string;
  readonly tokenAddress?: string;
  readonly traderId?: string;
  readonly sourceKey: string;
  readonly evaluatedAt: number;
  readonly now: number;
}): void {
  const subject = input.tokenId ?? `${input.chain}:${input.tokenAddress}`;
  const idempotencyKey = `candidate-evidence:${input.sourceKey}:${STRATEGY_VERSION}`;
  input.jobs.enqueue({
    jobId: stableId("candidate-evidence", [idempotencyKey]),
    idempotencyKey,
    lane: "trader_backfill",
    jobType: "candidate_evidence",
    subjectKey: subject,
    priority: 82,
    cursor: null,
    nextAttemptAt: input.now,
    payload: JSON.stringify({
      tokenId: input.tokenId,
      chain: input.chain,
      tokenAddress: input.tokenAddress,
      traderId: input.traderId,
      evaluatedAt: input.evaluatedAt,
    }),
    createdAt: input.now,
  });
}

async function dispatchChanges(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly cursor: string | null;
  readonly now: number;
}): Promise<AutomationExecutionResult> {
  const cursor = parseCursor(input.cursor);
  const activeJobs = input.jobs.activeCount("candidate_evidence");
  if (activeJobs >= 2_000) {
    return {
      status: "checkpoint",
      cursor: input.cursor,
      retryAt: input.now + 5 * 60_000,
      diagnostic: `candidate evidence backpressure: ${activeJobs} active jobs`,
    };
  }
  const availableCapacity = 2_000 - activeJobs;
  const events = input.database.prepare(`
    SELECT canonical_event_id AS eventId, entity_id AS traderId, chain,
      token_address AS tokenAddress, updated_at AS updatedAt
    FROM canonical_trader_events
    WHERE updated_at > ? OR (updated_at = ? AND canonical_event_id > ?)
    ORDER BY updated_at, canonical_event_id
    LIMIT ?
  `).all(cursor.eventUpdatedAt, cursor.eventUpdatedAt, cursor.eventId, Math.min(DISPATCH_BATCH_SIZE, availableCapacity)) as Array<{
    eventId: string;
    traderId: string;
    chain: string;
    tokenAddress: string;
    updatedAt: number;
  }>;
  let eventUpdatedAt = cursor.eventUpdatedAt;
  let eventId = cursor.eventId;
  for (const event of events) {
    enqueueTokenJob({
      jobs: input.jobs,
      chain: event.chain,
      tokenAddress: event.tokenAddress,
      traderId: event.traderId,
      sourceKey: `event:${event.eventId}:${event.updatedAt}`,
      evaluatedAt: event.updatedAt,
      now: input.now,
    });
    eventUpdatedAt = event.updatedAt;
    eventId = event.eventId;
  }

  const remainingCapacity = Math.max(0, availableCapacity - events.length);
  const milestones = remainingCapacity === 0 ? [] : input.database.prepare(`
    SELECT rowid AS rowId, token_id AS tokenId, crossed_at AS crossedAt
    FROM token_milestone_crossings
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `).all(cursor.milestoneRowId, Math.min(DISPATCH_BATCH_SIZE, remainingCapacity)) as Array<{
    rowId: number;
    tokenId: string;
    crossedAt: number;
  }>;
  let milestoneRowId = cursor.milestoneRowId;
  for (const milestone of milestones) {
    enqueueTokenJob({
      jobs: input.jobs,
      tokenId: milestone.tokenId,
      sourceKey: `milestone:${milestone.rowId}`,
      evaluatedAt: milestone.crossedAt,
      now: input.now,
    });
    milestoneRowId = milestone.rowId;
  }

  return {
    status: "checkpoint",
    cursor: JSON.stringify({ eventUpdatedAt, eventId, milestoneRowId }),
    retryAt: input.now + (events.length === DISPATCH_BATCH_SIZE || milestones.length === DISPATCH_BATCH_SIZE ? 0 : DISPATCH_INTERVAL_MS),
    diagnostic: `candidate evidence dispatch: ${events.length} events, ${milestones.length} milestones`,
  };
}

async function evaluateToken(input: {
  readonly database: DatabaseSync;
  readonly jobs?: AutomationJobStore;
  readonly recovery?: CandidateSourceRecoveryPlanner;
  readonly payload: CandidateEvidencePayload;
  readonly evaluatedAt: number;
}): Promise<AutomationExecutionResult> {
  const token = resolveToken(input.database, input.payload);
  if (!token) {
    const tokenId = input.payload.tokenId ?? `${input.payload.chain ?? "unknown"}:${input.payload.tokenAddress ?? "unknown"}`;
    const recoveryJobIds = input.recovery && input.payload.chain && input.payload.tokenAddress
      ? input.recovery.plan({ reasonCode: "missing_token_identity", tokenId, chain: input.payload.chain, tokenAddress: input.payload.tokenAddress }).recoveryJobIds
      : [];
    return {
      status: "waiting_source",
      retryAt: input.evaluatedAt + SOURCE_RETRY_MS,
      diagnostic: "historical token metadata is not available",
      sourceBlock: { reasonCode: "missing_token_identity", context: { tokenId }, recoveryJobIds },
    };
  }

  const milestones = input.database.prepare(`
    SELECT milestone_id AS milestoneId, market_cap_usd AS marketCapUsd, crossed_at AS crossedAt
    FROM token_milestone_crossings
    WHERE token_id = ?
    ORDER BY market_cap_usd, crossed_at
  `).all(token.tokenId) as unknown as MilestoneRow[];
  if (milestones.length === 0) {
    const recoveryJobIds = input.recovery?.plan({
      reasonCode: "missing_milestone",
      tokenId: token.tokenId,
      chain: token.chain,
      tokenAddress: token.tokenAddress,
    }).recoveryJobIds ?? [];
    return {
      status: "waiting_source",
      retryAt: input.evaluatedAt + SOURCE_RETRY_MS,
      diagnostic: "token milestone data is not available",
      sourceBlock: { reasonCode: "missing_milestone", context: { tokenId: token.tokenId }, recoveryJobIds },
    };
  }

  const events = input.database.prepare(`
    SELECT canonical_event_id AS canonicalEventId, entity_id AS traderId,
      amount_usd AS amountUsd, occurred_at AS occurredAt, source_status AS sourceStatus
    FROM canonical_trader_events
    WHERE chain = ? AND token_address = ? AND side = 'buy'
      AND (? IS NULL OR entity_id = ?)
    ORDER BY entity_id, occurred_at, canonical_event_id
  `).all(token.chain, token.tokenAddress, input.payload.traderId ?? null, input.payload.traderId ?? null) as unknown as BuyEventRow[];
  if (events.length === 0) {
    const recoveryJobIds = input.recovery?.plan({
      reasonCode: "missing_early_trades",
      tokenId: token.tokenId,
      chain: token.chain,
      tokenAddress: token.tokenAddress,
    }).recoveryJobIds ?? [];
    return {
      status: "waiting_source",
      retryAt: input.evaluatedAt + SOURCE_RETRY_MS,
      diagnostic: "canonical early buy events are not available",
      sourceBlock: { reasonCode: "missing_early_trades", context: { tokenId: token.tokenId }, recoveryJobIds },
    };
  }

  const prices = input.database.prepare(`
    SELECT observed_at AS observedAt, price_usd AS priceUsd
    FROM market_observations
    WHERE chain = ? AND token_address = ? AND observed_at <= ?
    ORDER BY observed_at
  `).all(token.chain, token.tokenAddress, input.evaluatedAt) as unknown as PriceRow[];
  if (prices.length === 0) {
    const recoveryJobIds = input.recovery?.plan({
      reasonCode: "missing_market_history",
      tokenId: token.tokenId,
      chain: token.chain,
      tokenAddress: token.tokenAddress,
    }).recoveryJobIds ?? [];
    return {
      status: "waiting_source",
      retryAt: input.evaluatedAt + SOURCE_RETRY_MS,
      diagnostic: "token price history is not available",
      sourceBlock: { reasonCode: "missing_market_history", context: { tokenId: token.tokenId }, recoveryJobIds },
    };
  }

  const historyStore = createCandidateHistoryStore(input.database);
  const eventsByTrader = new Map<string, BuyEventRow[]>();
  for (const event of events) {
    const traderEvents = eventsByTrader.get(event.traderId) ?? [];
    traderEvents.push(event);
    eventsByTrader.set(event.traderId, traderEvents);
  }

  let persisted = 0;
  for (const [traderId, traderEvents] of eventsByTrader) {
    let strongest: {
      readonly milestone: MilestoneRow;
      readonly evidenceType: CandidateEvidenceType;
      readonly rank: number;
      readonly cumulativeBuyUsd: number;
      readonly weightedEntryMarketCapUsd: number;
      readonly opportunityMultiple: number;
      readonly events: readonly BuyEventRow[];
    } | null = null;

    for (const milestone of milestones) {
      const eligible = traderEvents.filter(event => event.occurredAt <= milestone.crossedAt && (event.amountUsd ?? 0) > 0);
      const cumulativeBuyUsd = eligible.reduce((sum, event) => sum + (event.amountUsd ?? 0), 0);
      if (cumulativeBuyUsd < MINIMUM_CUMULATIVE_BUY_USD) continue;
      const priced = eligible.map(event => ({ event, price: priceAtOrBefore(prices, event.occurredAt) }))
        .filter((value): value is { event: BuyEventRow; price: number } => value.price !== null && value.price > 0);
      if (priced.length !== eligible.length) continue;
      const weightedEntryPrice = priced.reduce((sum, value) => sum + value.price * (value.event.amountUsd ?? 0), 0) / cumulativeBuyUsd;
      const crossingPrice = priceAtOrBefore(prices, milestone.crossedAt);
      const peakPrice = Math.max(...prices.filter(price => price.observedAt >= priced[0]!.event.occurredAt).map(price => price.priceUsd));
      if (!crossingPrice || !Number.isFinite(peakPrice) || peakPrice <= 0 || weightedEntryPrice <= 0) continue;
      const opportunityMultiple = peakPrice / weightedEntryPrice;
      const tier = strongestSatisfiedTier(milestone.marketCapUsd, opportunityMultiple);
      if (!tier) continue;
      const candidate = {
        milestone,
        evidenceType: tier.type,
        rank: tier.rank,
        cumulativeBuyUsd,
        weightedEntryMarketCapUsd: milestone.marketCapUsd * weightedEntryPrice / crossingPrice,
        opportunityMultiple,
        events: eligible,
      };
      if (!strongest || candidate.rank > strongest.rank) strongest = candidate;
    }

    if (strongest) {
      historyStore.saveEvidence({
        evidenceId: stableId("candidate-evidence", [STRATEGY_VERSION, traderId, token.tokenId]),
        traderId,
        tokenId: token.tokenId,
        milestoneId: strongest.milestone.milestoneId,
        evidenceType: strongest.evidenceType,
        admissionClass: evidenceRank.get(strongest.evidenceType)! >= 5 ? "strong" : "early",
        cumulativeBuyUsd: strongest.cumulativeBuyUsd,
        weightedEntryMarketCapUsd: strongest.weightedEntryMarketCapUsd,
        theoreticalOpportunity: strongest.opportunityMultiple,
        capturableMultiple: null,
        realizedMultiple: null,
        evidenceAt: strongest.milestone.crossedAt,
        sourceEventIds: sourceIds(input.database, strongest.events),
        strategyVersion: STRATEGY_VERSION,
      });
      persisted += 1;
    }

    const evidence = historyStore.evidenceForTrader(traderId);
    const snapshot = evaluateCandidateAdmission(evidence.map(item => ({
      tokenKey: item.tokenId,
      evidenceType: item.evidenceType as CandidateEvidenceType,
      evidenceAt: item.evidenceAt,
    })), input.evaluatedAt);
    const evidenceFingerprint = evidence.map(item => [item.evidenceId, item.evidenceType, item.sourceEventIds]).sort();
    historyStore.saveAdmissionSnapshot({
      snapshotId: stableId("candidate-snapshot", [STRATEGY_VERSION, traderId, input.evaluatedAt, evidenceFingerprint]),
      traderId,
      ...snapshot,
      strategyVersion: STRATEGY_VERSION,
      evaluatedAt: input.evaluatedAt,
    });
    if (snapshot.currentAdmission && input.jobs) {
      enqueueTraderAbilityEvaluation(
        input.jobs,
        traderId,
        input.evaluatedAt,
        input.evaluatedAt,
        `candidate:${stableId("snapshot", [traderId, input.evaluatedAt, evidenceFingerprint])}`,
      );
    }
  }

  return {
    status: "completed",
    diagnostic: `candidate evidence persisted for ${persisted}/${eventsByTrader.size} traders`,
  };
}

export function enqueueCandidateEvidenceDispatcher(jobs: AutomationJobStore, now: number): void {
  jobs.enqueue({
    jobId: "candidate-evidence-dispatcher-v1",
    idempotencyKey: "candidate-evidence-dispatcher-v1",
    lane: "repair",
    jobType: "candidate_evidence",
    subjectKey: "candidate-evidence-dispatcher",
    priority: 88,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({ mode: "dispatch" }),
    createdAt: now,
  });
}

export function createCandidateEvidenceWorker(input: {
  readonly database: DatabaseSync;
  readonly jobs?: AutomationJobStore;
  readonly recovery?: CandidateSourceRecoveryPlanner;
  readonly now?: () => number;
}): AutomationHandler {
  const now = input.now ?? Date.now;
  return {
    jobType: "candidate_evidence",
    async execute(job) {
      const payload = parsePayload(job.payload);
      const evaluatedAt = payload.evaluatedAt ?? now();
      if (payload.mode === "dispatch") {
        if (!input.jobs) return { status: "terminal", diagnostic: "candidate evidence dispatcher requires a job store" };
        return dispatchChanges({ database: input.database, jobs: input.jobs, cursor: job.cursor, now: now() });
      }
      return evaluateToken({
        database: input.database,
        ...(input.jobs ? { jobs: input.jobs } : {}),
        ...(input.recovery ? { recovery: input.recovery } : {}),
        payload,
        evaluatedAt,
      });
    },
  };
}
