import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createCandidateHistoryStore,
  createCandidateEvaluationRequestStore,
  createSqliteAddressRadarWritePort,
  type CandidateEvaluationRequest,
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
const REQUEST_STRATEGY_VERSION = "candidate-evidence-v2";
const MINIMUM_CUMULATIVE_BUY_USD = 50;
const DISPATCH_INTERVAL_MS = 5_000;
const SOURCE_RETRY_MS = 60_000;
const DISPATCH_BATCH_SIZE = 100;
const ADMISSION_RECONCILE_BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60_000;

interface CandidateEvidencePayload {
  readonly mode?: "dispatch";
  readonly tokenId?: string;
  readonly chain?: string;
  readonly tokenAddress?: string;
  readonly traderId?: string;
  readonly evaluatedAt?: number;
  readonly requestKey?: string;
  readonly targetRevision?: number;
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
  readonly admissionDay: number;
  readonly admissionTraderId: string;
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
  if (!cursor) return { eventUpdatedAt: 0, eventId: "", milestoneRowId: 0, admissionDay: -1, admissionTraderId: "" };
  try {
    const value = JSON.parse(cursor) as Partial<DispatchCursor>;
    return {
      eventUpdatedAt: Number(value.eventUpdatedAt) || 0,
      eventId: typeof value.eventId === "string" ? value.eventId : "",
      milestoneRowId: Number(value.milestoneRowId) || 0,
      admissionDay: Number(value.admissionDay) || -1,
      admissionTraderId: typeof value.admissionTraderId === "string" ? value.admissionTraderId : "",
    };
  } catch {
    return { eventUpdatedAt: 0, eventId: "", milestoneRowId: 0, admissionDay: -1, admissionTraderId: "" };
  }
}

function hasResolvedWallet(database: DatabaseSync, traderId: string): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present
    WHERE EXISTS(SELECT 1 FROM entity_wallet_identities WHERE entity_id = ?)
      OR EXISTS(
        SELECT 1 FROM entity_accounts ea
        JOIN wallet_identities wallet ON wallet.account_id = ea.account_id
        WHERE ea.entity_id = ?
      )
  `).get(traderId, traderId));
}

function projectCurrentAdmission(database: DatabaseSync, traderId: string, evaluatedAt: number): void {
  const entity = database.prepare("SELECT lifecycle FROM trader_entities WHERE entity_id = ?").get(traderId) as { lifecycle: string } | undefined;
  if (!entity) return;
  const resolvedWallet = hasResolvedWallet(database, traderId);
  const nextLifecycle = resolvedWallet ? "probation" : "candidate";
  database.prepare(`
    UPDATE trader_entities
    SET lifecycle = ?, updated_at = MAX(updated_at, ?)
    WHERE entity_id = ? AND lifecycle IN ('candidate', 'suspended')
  `).run(nextLifecycle, evaluatedAt, traderId);
  const desiredPolicy = resolvedWallet ? "realtime" : "lightweight";
  database.prepare(`
    INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(trader_id) DO UPDATE SET
      policy = CASE
        WHEN trader_monitoring_policy.policy = 'off' THEN 'off'
        WHEN trader_monitoring_policy.policy = 'realtime' THEN 'realtime'
        WHEN trader_monitoring_policy.policy = 'periodic' AND excluded.policy = 'lightweight' THEN 'periodic'
        ELSE excluded.policy
      END,
      updated_at = MAX(trader_monitoring_policy.updated_at, excluded.updated_at)
  `).run(traderId, desiredPolicy, evaluatedAt);
  if (resolvedWallet) return;

  const accounts = database.prepare(`
    SELECT account.account_id AS accountId, account.handle
    FROM entity_accounts link
    JOIN fomo_accounts account ON account.account_id = link.account_id
    WHERE link.entity_id = ?
      AND NOT EXISTS(SELECT 1 FROM wallet_identities wallet WHERE wallet.account_id = account.account_id)
    ORDER BY account.account_id
  `).all(traderId) as Array<{ accountId: string; handle: string }>;
  for (const account of accounts) {
    const existing = database.prepare("SELECT reasons FROM identity_resolution_queue WHERE handle = ?").get(account.handle) as { reasons: string } | undefined;
    const reasons = [...new Set([...(existing ? JSON.parse(existing.reasons) as string[] : []), "candidate_admitted_v3"])].sort();
    database.prepare(`
      INSERT INTO identity_resolution_queue(
        handle, account_id, priority, reasons, status, first_seen_at,
        last_seen_at, next_export_at, last_batch_id, resolved_at
      ) VALUES (?, ?, 95, ?, 'pending', ?, ?, ?, NULL, NULL)
      ON CONFLICT(handle) DO UPDATE SET
        account_id = excluded.account_id,
        priority = MAX(identity_resolution_queue.priority, excluded.priority),
        reasons = excluded.reasons,
        last_seen_at = MAX(identity_resolution_queue.last_seen_at, excluded.last_seen_at),
        next_export_at = MIN(identity_resolution_queue.next_export_at, excluded.next_export_at)
    `).run(account.handle, account.accountId, JSON.stringify(reasons), evaluatedAt, evaluatedAt, evaluatedAt);
  }
}

function evaluateAndProjectAdmission(input: {
  readonly database: DatabaseSync;
  readonly jobs?: AutomationJobStore;
  readonly traderId: string;
  readonly decisionAt: number;
}): string {
  const historyStore = createCandidateHistoryStore(input.database);
  const evidence = historyStore.evidenceForTrader(input.traderId);
  const snapshot = evaluateCandidateAdmission(evidence.map(item => ({
    tokenKey: item.tokenId,
    evidenceType: item.evidenceType as CandidateEvidenceType,
    evidenceAt: item.evidenceAt,
  })), input.decisionAt);
  const evidenceFingerprint = evidence.map(item => [item.evidenceId, item.evidenceType, item.sourceEventIds]).sort();
  const snapshotId = stableId("candidate-snapshot", [
    STRATEGY_VERSION,
    input.traderId,
    Math.floor(input.decisionAt / DAY_MS),
    evidenceFingerprint,
  ]);
  historyStore.saveAdmissionSnapshot({
    snapshotId,
    traderId: input.traderId,
    ...snapshot,
    strategyVersion: STRATEGY_VERSION,
    evaluatedAt: input.decisionAt,
  });
  if (snapshot.currentAdmission) {
    projectCurrentAdmission(input.database, input.traderId, input.decisionAt);
    if (input.jobs) {
      enqueueTraderAbilityEvaluation(input.jobs, input.traderId, input.decisionAt, input.decisionAt, `candidate:${snapshotId}`);
    }
  }
  return snapshotId;
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
  readonly database: DatabaseSync;
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
  const requests = createCandidateEvaluationRequestStore(input.database);
  const request = requests.request(subject, REQUEST_STRATEGY_VERSION, input.sourceKey, input.evaluatedAt);
  if (request.activeJobId || request.requestedRevision <= request.processedRevision) return;
  enqueueRequestedRevision(input.jobs, requests, request, input.now);
}

export function enqueueCandidateFactEvaluation(input: Parameters<typeof enqueueTokenJob>[0]): void {
  const subject = input.tokenId ?? `${input.chain}:${input.tokenAddress}`;
  const requests = createCandidateEvaluationRequestStore(input.database);
  const request = requests.request(subject, REQUEST_STRATEGY_VERSION, input.sourceKey, input.evaluatedAt);
  if (request.activeJobId || input.jobs.activeJobForSubject("candidate_evidence", subject)
    || request.requestedRevision <= request.processedRevision) return;
  enqueueRequestedRevision(input.jobs, requests, request, input.now);
}

function enqueueRequestedRevision(
  jobs: AutomationJobStore,
  requests: ReturnType<typeof createCandidateEvaluationRequestStore>,
  request: CandidateEvaluationRequest,
  now: number,
): void {
  const idempotencyKey = `candidate-evidence:${request.requestKey}:${request.requestedRevision}`;
  const jobId = stableId("candidate-evidence", [idempotencyKey]);
  jobs.enqueue({
    jobId,
    idempotencyKey,
    lane: "trader_backfill",
    jobType: "candidate_evidence",
    subjectKey: request.tokenId,
    priority: 82,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({
      tokenId: request.tokenId,
      evaluatedAt: request.requestedAt,
      requestKey: request.requestKey,
      targetRevision: request.requestedRevision,
    }),
    createdAt: now,
  });
  requests.bindJob(request.requestKey, jobId, request.requestedRevision, now);
}

async function dispatchChanges(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly cursor: string | null;
  readonly now: number;
}): Promise<AutomationExecutionResult> {
  const cursor = parseCursor(input.cursor);
  const admissionDay = Math.floor(input.now / DAY_MS);
  const admissionCursor = cursor.admissionDay === admissionDay ? cursor.admissionTraderId : "";
  const admissionRows = input.database.prepare(`
    SELECT DISTINCT trader_id AS traderId
    FROM candidate_evidence_v3
    WHERE trader_id > ?
    ORDER BY trader_id
    LIMIT ?
  `).all(admissionCursor, ADMISSION_RECONCILE_BATCH_SIZE) as Array<{ traderId: string }>;
  for (const row of admissionRows) {
    evaluateAndProjectAdmission({ database: input.database, jobs: input.jobs, traderId: row.traderId, decisionAt: input.now });
  }
  const nextAdmissionTraderId = admissionRows.length < ADMISSION_RECONCILE_BATCH_SIZE
    ? "\uffff"
    : admissionRows.at(-1)!.traderId;
  const checkpoint = (eventUpdatedAt: number, eventId: string, milestoneRowId: number) => JSON.stringify({
    eventUpdatedAt,
    eventId,
    milestoneRowId,
    admissionDay,
    admissionTraderId: nextAdmissionTraderId,
  });
  const activeJobs = input.jobs.runnableCount("candidate_evidence");
  if (activeJobs >= 2_000) {
    return {
      status: "checkpoint",
      cursor: checkpoint(cursor.eventUpdatedAt, cursor.eventId, cursor.milestoneRowId),
      retryAt: input.now + (admissionRows.length === ADMISSION_RECONCILE_BATCH_SIZE ? 0 : 5 * 60_000),
      diagnostic: `candidate evidence backpressure: ${activeJobs} active jobs; reconciled ${admissionRows.length} admissions`,
    };
  }
  const availableCapacity = 2_000 - activeJobs;
  const events = input.database.prepare(`
    SELECT canonical_event_id AS eventId, entity_id AS traderId, chain,
      token_address AS tokenAddress, side, amount_usd AS amountUsd,
      occurred_at AS occurredAt, updated_at AS updatedAt
    FROM canonical_trader_events
    WHERE (updated_at > ? OR (updated_at = ? AND canonical_event_id > ?))
      AND side = 'buy'
      AND amount_usd >= ?
      AND EXISTS (
        SELECT 1
        FROM token_milestone_crossings
        WHERE token_id =
          LOWER(canonical_trader_events.chain) || ':' ||
          CASE
            WHEN LOWER(canonical_trader_events.chain) = 'solana'
              THEN canonical_trader_events.token_address
            ELSE LOWER(canonical_trader_events.token_address)
          END
          AND crossed_at IS NOT NULL
      )
    ORDER BY updated_at, canonical_event_id
    LIMIT ?
  `).all(
    cursor.eventUpdatedAt,
    cursor.eventUpdatedAt,
    cursor.eventId,
    MINIMUM_CUMULATIVE_BUY_USD,
    Math.min(DISPATCH_BATCH_SIZE, availableCapacity),
  ) as Array<{
    eventId: string;
    traderId: string;
    chain: string;
    tokenAddress: string;
    side: string;
    amountUsd: number | null;
    occurredAt: number;
    updatedAt: number;
  }>;
  let eventUpdatedAt = cursor.eventUpdatedAt;
  let eventId = cursor.eventId;
  for (const event of events) {
    enqueueTokenJob({
      database: input.database,
      jobs: input.jobs,
      chain: event.chain,
      tokenAddress: event.tokenAddress,
      traderId: event.traderId,
      sourceKey: stableId("event-business-state", [
        event.eventId,
        event.traderId,
        event.chain,
        event.tokenAddress,
        event.side,
        event.amountUsd,
        event.occurredAt,
      ]),
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
      database: input.database,
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
    cursor: checkpoint(eventUpdatedAt, eventId, milestoneRowId),
    retryAt: input.now + (events.length === DISPATCH_BATCH_SIZE || milestones.length === DISPATCH_BATCH_SIZE ? 0 : DISPATCH_INTERVAL_MS),
    diagnostic: `candidate evidence dispatch: ${events.length} events, ${milestones.length} milestones, ${admissionRows.length} admissions`,
  };
}

async function evaluateToken(input: {
  readonly database: DatabaseSync;
  readonly jobs?: AutomationJobStore;
  readonly recovery?: CandidateSourceRecoveryPlanner;
  readonly payload: CandidateEvidencePayload;
  readonly evaluatedAt: number;
  readonly decisionAt: number;
}): Promise<AutomationExecutionResult> {
  const token = resolveToken(input.database, input.payload);
  if (!token) {
    const tokenId = input.payload.tokenId ?? `${input.payload.chain ?? "unknown"}:${input.payload.tokenAddress ?? "unknown"}`;
    const recoveryJobIds = input.recovery && input.payload.chain && input.payload.tokenAddress
      ? input.recovery.plan({ reasonCode: "missing_token_identity", tokenId, chain: input.payload.chain, tokenAddress: input.payload.tokenAddress }).recoveryJobIds
      : [];
    return {
      status: "waiting_source",
      retryAt: input.decisionAt + SOURCE_RETRY_MS,
      diagnostic: "historical token metadata is not available",
      sourceBlock: { reasonCode: "missing_token_identity", context: { tokenId, evaluatedAt: input.evaluatedAt }, recoveryJobIds },
      outcome: {
        status: "deferred", reasonCode: "missing_token_identity",
        inputCount: 1, producedCount: 0, deferredCount: 1,
      },
    };
  }

  let milestones = input.database.prepare(`
    SELECT milestone_id AS milestoneId, market_cap_usd AS marketCapUsd, crossed_at AS crossedAt
    FROM token_milestone_crossings
    WHERE token_id = ?
    ORDER BY market_cap_usd, crossed_at
  `).all(token.tokenId) as unknown as MilestoneRow[];
  if (milestones.length === 0) {
    const historyStore = createCandidateHistoryStore(input.database);
    for (const milestone of CANDIDATE_MILESTONES) {
      const marketCapUsd = milestone.marketCapUsd;
      const observed = input.database.prepare(`
        SELECT event_id AS eventId, occurred_at AS crossedAt
        FROM trader_events
        WHERE LOWER(chain) = LOWER(?)
          AND (
            (LOWER(?) = 'solana' AND token_address = ?)
            OR (LOWER(?) <> 'solana' AND LOWER(token_address) = LOWER(?))
          )
          AND market_cap_usd >= ?
        ORDER BY occurred_at, event_id
        LIMIT 1
      `).get(
        token.chain,
        token.chain,
        token.tokenAddress,
        token.chain,
        token.tokenAddress,
        marketCapUsd,
      ) as { eventId: string; crossedAt: number } | undefined;
      if (!observed) continue;
      historyStore.saveMilestoneCrossing({
        milestoneId: `${token.tokenId}:${marketCapUsd}`,
        tokenId: token.tokenId,
        marketCapUsd,
        crossedAt: observed.crossedAt,
        precision: "estimated",
        source: "trader_event_market_cap",
        sourceEventIds: [observed.eventId],
        strategyVersion: "candidate-event-facts-v1",
      });
    }
    milestones = input.database.prepare(`
      SELECT milestone_id AS milestoneId, market_cap_usd AS marketCapUsd, crossed_at AS crossedAt
      FROM token_milestone_crossings
      WHERE token_id = ?
      ORDER BY market_cap_usd, crossed_at
    `).all(token.tokenId) as unknown as MilestoneRow[];
  }
  if (milestones.length === 0) {
    const recoveryJobIds = input.recovery?.plan({
      reasonCode: "missing_milestone",
      tokenId: token.tokenId,
      chain: token.chain,
      tokenAddress: token.tokenAddress,
    }).recoveryJobIds ?? [];
    return {
      status: "waiting_source",
      retryAt: input.decisionAt + SOURCE_RETRY_MS,
      diagnostic: "token milestone data is not available",
      sourceBlock: { reasonCode: "missing_milestone", context: { tokenId: token.tokenId, evaluatedAt: input.evaluatedAt }, recoveryJobIds },
      outcome: {
        status: "deferred", reasonCode: "missing_milestone",
        inputCount: 1, producedCount: 0, deferredCount: 1,
      },
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
      retryAt: input.decisionAt + SOURCE_RETRY_MS,
      diagnostic: "canonical early buy events are not available",
      sourceBlock: { reasonCode: "missing_early_trades", context: { tokenId: token.tokenId, evaluatedAt: input.evaluatedAt }, recoveryJobIds },
      outcome: {
        status: "deferred", reasonCode: "missing_early_trades",
        inputCount: 1, producedCount: 0, deferredCount: 1,
      },
    };
  }

  const prices = input.database.prepare(`
    SELECT observed_at AS observedAt, price_usd AS priceUsd
    FROM market_observations
    WHERE chain = ? AND token_address = ? AND observed_at <= ?
    ORDER BY observed_at
  `).all(token.chain, token.tokenAddress, input.decisionAt) as unknown as PriceRow[];
  if (prices.length === 0) {
    const recoveryJobIds = input.recovery?.plan({
      reasonCode: "missing_market_history",
      tokenId: token.tokenId,
      chain: token.chain,
      tokenAddress: token.tokenAddress,
    }).recoveryJobIds ?? [];
    return {
      status: "waiting_source",
      retryAt: input.decisionAt + SOURCE_RETRY_MS,
      diagnostic: "token price history is not available",
      sourceBlock: { reasonCode: "missing_market_history", context: { tokenId: token.tokenId, evaluatedAt: input.evaluatedAt }, recoveryJobIds },
      outcome: {
        status: "deferred", reasonCode: "missing_market_history",
        inputCount: 1, producedCount: 0, deferredCount: 1,
      },
    };
  }

  const historyStore = createCandidateHistoryStore(input.database);
  const writePort = createSqliteAddressRadarWritePort(input.database);
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
      const writeResult = writePort.saveCandidateEvidence({
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
      if (writeResult !== "unchanged") persisted += 1;
    }

    evaluateAndProjectAdmission({
      database: input.database,
      ...(input.jobs ? { jobs: input.jobs } : {}),
      traderId,
      decisionAt: input.decisionAt,
    });
  }

  return {
    status: "completed",
    diagnostic: `candidate evidence persisted for ${persisted}/${eventsByTrader.size} traders`,
    outcome: persisted > 0
      ? {
          status: "produced",
          inputCount: eventsByTrader.size,
          producedCount: persisted,
          deferredCount: 0,
        }
      : {
          status: "no_output",
          reasonCode: "evidence_below_threshold",
          inputCount: eventsByTrader.size,
          producedCount: 0,
          deferredCount: 0,
          diagnostic: { eligibleTraderCount: eventsByTrader.size },
        },
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
  const requests = createCandidateEvaluationRequestStore(input.database);
  return {
    jobType: "candidate_evidence",
    async execute(job) {
      const payload = parsePayload(job.payload);
      const evaluatedAt = payload.evaluatedAt ?? now();
      if (payload.mode === "dispatch") {
        if (!input.jobs) return { status: "terminal", diagnostic: "candidate evidence dispatcher requires a job store" };
        return dispatchChanges({ database: input.database, jobs: input.jobs, cursor: job.cursor, now: now() });
      }
      const result = await evaluateToken({
        database: input.database,
        ...(input.jobs ? { jobs: input.jobs } : {}),
        ...(input.recovery ? { recovery: input.recovery } : {}),
        payload,
        evaluatedAt,
        decisionAt: now(),
      });
      if (input.jobs && payload.requestKey && payload.targetRevision && (result.status === "completed" || result.status === "terminal")) {
        const completed = requests.complete(payload.requestKey, job.jobId, payload.targetRevision, result.outcome?.status ?? result.status, now());
        if (completed.needsFollowUp) enqueueRequestedRevision(input.jobs, requests, completed, now());
      }
      return result;
    },
  };
}
