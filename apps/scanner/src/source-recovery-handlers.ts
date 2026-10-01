import { resolveConsumerMarketHistoryRequestRange } from "@address-radar/database";
import type { DatabaseSync } from "node:sqlite";

import type { GeckoTerminalClient, HistoricalTokenPriceClient, TokenMarketProvider } from "@address-radar/collectors";
import { createGeckoMilestoneProvider } from "@address-radar/collectors";
import type {
  AutomationJobStore,
  CandidateHistoryStore,
  SourceLedgerStore,
  TokenFactPrecision,
  TokenFactStatus,
  TokenFactStore,
  TokenFactType,
} from "@address-radar/database";
import { resolveObservedMarketSupply, withAddressRadarWriteTransaction } from "@address-radar/database";
import { CANDIDATE_MILESTONES } from "@address-radar/scoring";

import {
  RetryableRecoveryError,
  TerminalRecoveryError,
  WaitingRecoveryResultError,
  type RecoveryHandlers,
} from "./recovery-runtime.js";
import type { RecoveryPostcondition } from "./recovery-postcondition.js";
import { verifyRecoveryFactReadiness } from "./recovery-fact-readiness.js";
import { hasHistoricalPriceCoverage, mergeHistoricalPrices } from "./price-recovery-coverage.js";
import { milestoneRecoveryGap } from "./milestone-recovery-policy.js";
import { parseRecoveryHandoff, recoveryHandoffAction } from "./recovery-handoff.js";
import { retainPartialHistoricalPrices } from "./partial-historical-price-recovery.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const GECKO_TERMINAL_CALLS_PER_MINUTE = 8;
const DEFILLAMA_CALLS_PER_MINUTE = 20;
const MAX_HISTORY_PAGES = 2;
const MAX_MILESTONE_HISTORY_PAGES = 4;

interface FomoMilestoneLookupProducer {
  enqueue(input: {
    readonly chainId: string;
    readonly tokenAddress: string;
    readonly requestedAt: number;
    readonly purpose?: "milestone_backfill";
    readonly milestoneId?: string;
    readonly beforeAt?: number;
    readonly cursor?: string;
    readonly lookupRevision?: number;
  }): Promise<unknown>;
}

const tokenParts = (tokenId: string, fallbackChain: string) => {
  const separator = tokenId.indexOf(":");
  if (separator <= 0 || separator === tokenId.length - 1) {
    throw new RetryableRecoveryError(`invalid_token_id:${tokenId}`);
  }
  return Object.freeze({
    chain: tokenId.slice(0, separator) || fallbackChain,
    tokenAddress: tokenId.slice(separator + 1),
  });
};

export function createSourceRecoveryHandlers(input: {
  readonly database: DatabaseSync;
  readonly ledger: SourceLedgerStore;
  readonly jobs: AutomationJobStore;
  readonly history: CandidateHistoryStore;
  readonly facts: TokenFactStore;
  readonly marketProvider: TokenMarketProvider;
  readonly historicalMarketProvider?: GeckoTerminalClient;
  readonly historicalPriceFallback?: HistoricalTokenPriceClient;
  readonly fomoProducer: FomoMilestoneLookupProducer;
  readonly now?: () => number;
}): RecoveryHandlers {
  const now = input.now ?? Date.now;

  const saveFact = (factType: TokenFactType, tokenId: string, status: TokenFactStatus, precision: TokenFactPrecision, source: string, observedAt: number, coverageStartAt: number | null = null, coverageEndAt: number | null = null): void => {
    input.facts.ensure(tokenId, factType, "token-facts-v1", observedAt);
    let current = input.facts.fact(tokenId, factType)!;
    if (current.status === "available" && status !== "available") return;
    if (current.status === "terminal_unavailable") {
      current = input.facts.transition({ tokenId, factType, status: "scheduled", reopenTerminal: true, terminalReason: null, nextAttemptAt: observedAt, strategyVersion: "token-facts-v1", updatedAt: observedAt });
    }
    input.facts.transition({ tokenId, factType, status, precision, primarySource: source, coverageStartAt, coverageEndAt, observedAt, knownAt: observedAt, nextAttemptAt: null, terminalReason: null, strategyVersion: "token-facts-v1", updatedAt: observedAt });
  };

  const factPostcondition = (factType: TokenFactType, tokenId: string): RecoveryPostcondition => ({
    factType,
    factKey: tokenId,
    verify() {
      const asOf = now();
      const token = factType === "price_history" ? tokenParts(tokenId, "") : null;
      return verifyRecoveryFactReadiness({
        database: input.database, facts: input.facts, factType, tokenId, asOf,
        ...(token ? { priceRange: historyRange(input.database, tokenId, token.chain, token.tokenAddress, asOf) } : {}),
      });
    },
  });

  return Object.freeze({
    async market_enrichment({ job, signal, assertActive }) {
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      const market = await input.marketProvider.lookup(token.chain, token.tokenAddress, signal);
      assertActive?.();
      if (!market || market.priceUsd == null || !Number.isFinite(market.priceUsd) || market.priceUsd <= 0) {
        throw new RetryableRecoveryError("market_price_unavailable");
      }
      input.ledger.saveTokenObservation({
        tokenId: job.subjectKey,
        chain: token.chain,
        tokenAddress: token.tokenAddress,
        observedAt,
        identityStatus: "resolved",
        marketStatus: "resolved",
        symbol: market.symbol ?? null,
        imageUrl: market.imageUrl ?? null,
        marketCapUsd: market.marketCapUsd,
        launchedAt: market.launchedAt ?? market.createdAt ?? null,
      });
      input.ledger.saveTokenMarketSnapshot({
        snapshotId: `recovery:market:${job.subjectKey}:${observedAt}`,
        tokenId: job.subjectKey,
        source: "dexscreener",
        observedAt,
        priceUsd: market.priceUsd,
        marketCapUsd: market.marketCapUsd,
        liquidityUsd: market.liquidityUsd,
        payload: market,
      });
      saveFact("market_identity", job.subjectKey, "available", "page_observed", "dexscreener", observedAt);
      saveFact("price_history", job.subjectKey, "partial", "page_observed", "dexscreener", observedAt, observedAt, observedAt);
      const snapshotId = `recovery:market:${job.subjectKey}:${observedAt}`;
      input.database.prepare(`
        INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
        VALUES (?, ?, ?, ?, 'recovery_market')
        ON CONFLICT(chain, token_address, observed_at, source)
        DO UPDATE SET price_usd = excluded.price_usd
      `).run(token.chain, token.tokenAddress, observedAt, market.priceUsd);
      if (market.marketCapUsd != null && Number.isFinite(market.marketCapUsd) && market.marketCapUsd > 0) {
        let milestoneWritten = false;
        for (const milestone of CANDIDATE_MILESTONES) {
          if (market.marketCapUsd < milestone.marketCapUsd) continue;
          input.history.saveMilestoneCrossing({
            milestoneId: `${job.subjectKey}:${milestone.marketCapUsd}`,
            tokenId: job.subjectKey,
            marketCapUsd: milestone.marketCapUsd,
            crossedAt: observedAt,
            precision: "estimated",
            source: "recovery_market_snapshot",
            sourceEventIds: [snapshotId],
            strategyVersion: "candidate-market-recovery-v1",
          });
          milestoneWritten = true;
        }
        if (milestoneWritten) saveFact("milestone_crossings", job.subjectKey, "partial", "estimated", "recovery_market_snapshot", observedAt, observedAt, observedAt);
      }
      if (market.marketCapUsd != null && market.marketCapUsd >= 1_000_000) {
        input.history.saveHistoricalToken({
          tokenId: job.subjectKey,
          chain: token.chain,
          tokenAddress: token.tokenAddress,
          symbol: market.symbol ?? null,
          imageUrl: market.imageUrl ?? null,
          firstTradeAt: market.createdAt ?? market.launchedAt ?? null,
          firstReached1mAt: observedAt,
          peakMarketCapUsd: market.marketCapUsd,
          source: "recovery_dexscreener",
          sourceQueryId: null,
          provenance: { observedAt },
        });
      }
      return { reEvaluate: { kind: "token" as const, key: job.subjectKey }, postcondition: factPostcondition("market_identity", job.subjectKey) };
    },

    async market_history({ job, consumeBudget, signal, assertActive }) {
      if (!input.historicalMarketProvider && !input.historicalPriceFallback) throw new RetryableRecoveryError("historical_market_provider_unavailable");
      if (job.chain === "robinhood") throw new TerminalRecoveryError("historical_market_chain_unsupported");
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      const range = historyRange(input.database, job.subjectKey, token.chain, token.tokenAddress, observedAt);
      if (!range) throw new TerminalRecoveryError("historical_market_range_unavailable");
      const local = localHistoricalPrices(input.database, token.chain, token.tokenAddress, range);
      if (hasEntryCoverage(local, range)) {
        saveFact("price_history", job.subjectKey, "available", "derived", "market_observations", observedAt, local[0]![0], local.at(-1)![0]);
        return { reEvaluate: { kind: "token" as const, key: job.subjectKey }, postcondition: factPostcondition("price_history", job.subjectKey) };
      }
      const consumeGecko = (): void => {
        const budgetAt = now();
        consumeBudget({
          provider: "geckoterminal",
          usageWindow: String(Math.floor(budgetAt / 60_000)),
          units: 1,
          limit: GECKO_TERMINAL_CALLS_PER_MINUTE,
          retryAt: (Math.floor(budgetAt / 60_000) + 1) * 60_000,
        });
      };
      const candles = new Map<number, number>();
      let source = "geckoterminal_ohlcv";
      let primaryError: unknown = null;
      if (input.historicalMarketProvider) {
        try {
          consumeGecko();
          const pool = await input.historicalMarketProvider.topPool(job.chain, token.tokenAddress, signal);
          assertActive?.();
          if (pool) {
            let beforeTimestamp = range.toAt + HOUR_MS;
            for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
              consumeGecko();
              const batch = await input.historicalMarketProvider.ohlcv(job.chain, pool.poolAddress, {
                timeframe: "hour",
                tokenSide: pool.tokenSide,
                aggregate: 1,
                beforeTimestamp,
                limit: 1_000,
              }, signal);
              assertActive?.();
              if (batch.length === 0) break;
              for (const candle of batch) {
                if (candle.timestamp <= range.toAt && candle.timestamp >= range.fromAt - HOUR_MS && candle.close > 0) {
                  candles.set(candle.timestamp, candle.close);
                }
              }
              const earliest = Math.min(...batch.map(candle => candle.timestamp));
              if (earliest <= range.fromAt || earliest >= beforeTimestamp) break;
              beforeTimestamp = earliest;
            }
          }
        } catch (error) {
          primaryError = error;
        }
      }
      assertActive?.();
      const primaryPrices = mergeHistoricalPrices([...candles], [], range);
      saveHistoricalPrices(input.database, token.chain, token.tokenAddress, primaryPrices, source);
      let ordered = mergeHistoricalPrices(local, primaryPrices, range);
      if (!hasEntryCoverage(ordered, range) && input.historicalPriceFallback) {
        const budgetAt = now();
        consumeBudget({
          provider: "defillama",
          usageWindow: String(Math.floor(budgetAt / 60_000)),
          units: 1,
          limit: DEFILLAMA_CALLS_PER_MINUTE,
          retryAt: (Math.floor(budgetAt / 60_000) + 1) * 60_000,
        });
        const fallback = await retainPartialHistoricalPrices(
          input.historicalPriceFallback.chart(job.chain, token.tokenAddress, range, signal),
          { database: input.database, tokenId: job.subjectKey, now },
        );
        assertActive?.();
        const fallbackPrices = mergeHistoricalPrices(fallback.prices.map(point => [point.observedAt, point.priceUsd] as const), [], range);
        saveHistoricalPrices(input.database, token.chain, token.tokenAddress, fallbackPrices, fallback.source);
        ordered = mergeHistoricalPrices(ordered, fallbackPrices, range);
        if (fallbackPrices.length > 0) source = "market_observations";
      }
      if (!hasEntryCoverage(ordered, range)) {
        if (primaryError !== null && !input.historicalPriceFallback) throw primaryError;
        if (ordered.length > 0) saveFact("price_history", job.subjectKey, "partial", "derived", "market_observations", observedAt, ordered[0]![0], ordered.at(-1)![0]);
        throw new RetryableRecoveryError("historical_market_coverage_unavailable");
      }
      assertActive?.();
      saveFact("price_history", job.subjectKey, "available", "derived", source, observedAt, ordered[0]![0], ordered.at(-1)![0]);
      return { reEvaluate: { kind: "token" as const, key: job.subjectKey }, postcondition: factPostcondition("price_history", job.subjectKey) };
    },

    async milestone_early_buyers({ job, assertActive, checkpoint }) {
      assertActive?.();
      const token = tokenParts(job.subjectKey, job.chain);
      const milestone = input.database.prepare(`
        SELECT milestone_id AS milestoneId, crossed_at AS crossedAt
        FROM token_milestone_crossings
        WHERE token_id = ? AND precision != 'unavailable' AND crossed_at IS NOT NULL
        ORDER BY market_cap_usd, crossed_at LIMIT 1
      `).get(job.subjectKey) as { milestoneId: string; crossedAt: number } | undefined;
      if (!milestone) throw new RetryableRecoveryError("milestone_missing_before_early_trade_recovery");
      const event = input.database.prepare(`
        SELECT 1 AS present FROM canonical_trader_events
        WHERE chain = ? AND token_address = ? AND side = 'buy' AND occurred_at <= ?
        LIMIT 1
      `).get(token.chain, token.tokenAddress, milestone.crossedAt);
      if (event) {
        saveFact("early_trades", job.subjectKey, "available", "exact", "canonical_trader_events", now(), null, milestone.crossedAt);
        return { reEvaluate: { kind: "token" as const, key: job.subjectKey }, postcondition: factPostcondition("early_trades", job.subjectKey) };
      }
      const pending = parseRecoveryHandoff(job.cursor);
      const submittedAt = now();
      let lookupRevision = 0;
      let checkAt = submittedAt + 30 * 60_000;
      if (pending && pending.milestoneId === milestone.milestoneId && pending.beforeAt === milestone.crossedAt) {
        const result = input.database.prepare(`
          SELECT outcome, message FROM token_fact_attempts
          WHERE token_id=? AND fact_type='early_trades' AND provider='fomo_lookup'
            AND json_extract(payload, '$.lookupId')=?
          ORDER BY finished_at DESC LIMIT 1
        `).get(job.subjectKey, pending.lookupId) as { outcome: string; message: string | null } | undefined;
        const action = recoveryHandoffAction(pending, submittedAt, Boolean(result));
        if (action.action === "wait") throw new WaitingRecoveryResultError(result?.message ?? action.reason, action.retryAt);
        lookupRevision = action.lookupRevision;
        checkAt = action.retryAt;
      }
      const queued = await input.fomoProducer.enqueue({
        chainId: token.chain,
        tokenAddress: token.tokenAddress,
        requestedAt: now(),
        purpose: "milestone_backfill",
        milestoneId: milestone.milestoneId,
        beforeAt: milestone.crossedAt,
        lookupRevision,
      });
      assertActive?.();
      const request = queued && typeof queued === "object" ? (queued as { request?: { lookupId?: unknown } }).request : null;
      if (!request || typeof request.lookupId !== "string" || !request.lookupId.trim()) throw new RetryableRecoveryError("early_trade_request_identity_missing");
      checkpoint(JSON.stringify({ kind: "fomo_milestone_lookup", lookupId: request.lookupId, milestoneId: milestone.milestoneId, beforeAt: milestone.crossedAt, submittedAt, checkAt, lookupRevision }));
      throw new WaitingRecoveryResultError("waiting_result", checkAt);
    },

    async historical_research({ job, consumeBudget, signal, assertActive }) {
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      let milestoneRange = input.database.prepare(`
        SELECT MIN(crossed_at) AS coverageStartAt, MAX(crossed_at) AS coverageEndAt
        FROM token_milestone_crossings
        WHERE token_id=? AND precision!='unavailable' AND crossed_at IS NOT NULL
      `).get(job.subjectKey) as { coverageStartAt: number | null; coverageEndAt: number | null };
      if (milestoneRange.coverageStartAt === null) {
        if (!input.historicalMarketProvider) {
          throw new RetryableRecoveryError("historical_milestone_provider_unavailable");
        }
        const consumeGecko = (): void => consumeBudget({
          provider: "geckoterminal",
          usageWindow: String(Math.floor(now() / 60_000)),
          units: 1,
          limit: GECKO_TERMINAL_CALLS_PER_MINUTE,
          retryAt: (Math.floor(now() / 60_000) + 1) * 60_000,
        });
        const bounds = input.database.prepare(`
          SELECT COALESCE(
            (SELECT first_trade_at FROM historical_tokens WHERE token_id=?),
            (SELECT launched_at FROM token_observation_state WHERE token_id=?),
            ?
          ) AS fromAt
        `).get(job.subjectKey, job.subjectKey, Math.max(0, observedAt - 60 * DAY_MS)) as { fromAt: number };
        const client = input.historicalMarketProvider;
        const budgeted: GeckoTerminalClient = {
          topPool: async (...args) => { consumeGecko(); const value = await client.topPool(...args); assertActive?.(); return value; },
          ...(client.pools ? { pools: async (...args: Parameters<NonNullable<GeckoTerminalClient["pools"]>>) => { consumeGecko(); const value = await client.pools!(...args); assertActive?.(); return value; } } : {}),
          ohlcv: async (...args) => { consumeGecko(); const value = await client.ohlcv(...args); assertActive?.(); return value; },
          trades: (...args) => client.trades(...args),
        };
        const reconstruction = await createGeckoMilestoneProvider({ client: budgeted, resolveSupply: async request => resolveObservedMarketSupply({ database: input.database, chain: request.chain, tokenAddress: request.tokenAddress, asOf: request.toTimestamp }), maxPages: MAX_MILESTONE_HISTORY_PAGES, maxPools: 3,
          thresholdsUsd: CANDIDATE_MILESTONES.map(milestone => milestone.marketCapUsd) }).reconstruct({ chain: job.chain, tokenAddress: token.tokenAddress,
          fromTimestamp: Math.max(bounds.fromAt, observedAt - 60 * DAY_MS, 0), toTimestamp: observedAt, ...(signal ? { signal } : {}) });
        assertActive?.();
        let inserted = 0;
        for (const crossing of reconstruction.milestones) {
          // FDV-derived estimates are not historical circulating market-cap evidence.
          if (crossing.supplyBasis === "fdv") continue;
          input.history.saveMilestoneCrossing({
            milestoneId: `${job.subjectKey}:${crossing.thresholdUsd}`,
            tokenId: job.subjectKey,
            marketCapUsd: crossing.thresholdUsd,
            crossedAt: crossing.crossedAt,
            precision: "estimated",
            source: "gecko_terminal_ohlcv",
            sourceEventIds: [JSON.stringify({ pool: crossing.poolAddress, bucketStartAt: crossing.crossedAt, bucketEndAt: crossing.bucketEndAt, supplyBasis: crossing.supplyBasis, supplyEvidence: crossing.supplyEvidence, precision: crossing.precision })],
            strategyVersion: "candidate-market-recovery-v3",
          });
          inserted += 1;
        }
        if (inserted === 0) throw new RetryableRecoveryError(milestoneRecoveryGap({ poolFound: reconstruction.poolAddress !== null,
          supplyAvailable: reconstruction.supplyEstimate !== null && reconstruction.supplyBasis !== "fdv", candleCount: reconstruction.candleCount }));
        milestoneRange = input.database.prepare(`
          SELECT MIN(crossed_at) AS coverageStartAt, MAX(crossed_at) AS coverageEndAt
          FROM token_milestone_crossings
          WHERE token_id=? AND precision!='unavailable' AND crossed_at IS NOT NULL
        `).get(job.subjectKey) as { coverageStartAt: number | null; coverageEndAt: number | null };
      }
      const priceRange = input.database.prepare(`SELECT MIN(observed_at) AS coverageStartAt, MAX(observed_at) AS coverageEndAt FROM market_observations WHERE chain=? AND token_address=? AND price_usd>0`).get(token.chain, token.tokenAddress) as { coverageStartAt: number | null; coverageEndAt: number | null };
      saveFact("price_history", job.subjectKey, "partial", "derived", "market_observations", observedAt, priceRange.coverageStartAt, priceRange.coverageEndAt);
      saveFact("milestone_crossings", job.subjectKey, "partial", "estimated", "token_milestone_crossings", observedAt, milestoneRange.coverageStartAt, milestoneRange.coverageEndAt);
      return { reEvaluate: { kind: "token" as const, key: job.subjectKey }, postcondition: factPostcondition("milestone_crossings", job.subjectKey) };
    },

    async fomo_token_history({ job, assertActive }) {
      assertActive?.();
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      const range = historyRange(input.database, job.subjectKey, token.chain, token.tokenAddress, observedAt);
      if (range) {
        const local = localHistoricalPrices(input.database, token.chain, token.tokenAddress, range);
        if (hasEntryCoverage(local, range)) {
          saveFact("price_history", job.subjectKey, "available", "derived", "market_observations", observedAt, local[0]![0], local.at(-1)![0]);
          return { reEvaluate: { kind: "token" as const, key: job.subjectKey }, postcondition: factPostcondition("price_history", job.subjectKey) };
        }
      }
      await input.fomoProducer.enqueue({ chainId: token.chain, tokenAddress: token.tokenAddress, requestedAt: observedAt });
      assertActive?.();
      if (job.attemptCount >= 12) throw new TerminalRecoveryError("fomo_token_history_unavailable");
      throw new RetryableRecoveryError("fomo_token_history_queued");
    },

    async identity_resolution({ job }) {
      const mapping = input.database.prepare(`
        SELECT 1 AS present FROM entity_wallet_identities
        WHERE entity_id = ? OR address = ? LIMIT 1
      `).get(job.subjectKey, job.subjectKey);
      if (!mapping) throw new RetryableRecoveryError("identity_resolution_pending");
      return { reEvaluate: { kind: "trader" as const, key: job.subjectKey }, postcondition: factPostcondition("trader_attribution", job.subjectKey) };
    },

    async rpc_gap() {
      throw new RetryableRecoveryError("rpc_gap_requires_provider_replay");
    },
  });
}

function historyRange(database: DatabaseSync, tokenId: string, chain: string, tokenAddress: string, fallbackTo: number): { readonly fromAt: number; readonly toAt: number } | null {
  const consumer = resolveConsumerMarketHistoryRequestRange(database, tokenId, fallbackTo);
  if (consumer) return consumer;
  const legacy = legacyHistoryRange(database, tokenId, chain, tokenAddress, fallbackTo);
  const validLegacy = legacy && Number.isSafeInteger(legacy.fromAt) && Number.isSafeInteger(legacy.toAt)
    && legacy.fromAt >= 0 && legacy.toAt >= legacy.fromAt && legacy.fromAt <= fallbackTo
    ? { fromAt: legacy.fromAt, toAt: Math.min(legacy.toAt, fallbackTo) } : null;
  return validLegacy;
}

function legacyHistoryRange(database: DatabaseSync, tokenId: string, chain: string, tokenAddress: string, fallbackTo: number): { readonly fromAt: number; readonly toAt: number } | null {
  const event = database.prepare(`
    SELECT MIN(occurred_at) AS fromAt FROM canonical_trader_events
    WHERE chain = ? AND token_address = ? AND side = 'buy'
  `).get(chain, tokenAddress) as { fromAt: number | null };
  if (event.fromAt === null) return null;
  const blocked = database.prepare(`
    SELECT MAX(CAST(json_extract(payload, '$.evaluatedAt') AS INTEGER)) AS toAt
    FROM automation_jobs
    WHERE job_type = 'candidate_evidence' AND subject_key = ?
  `).get(tokenId) as { toAt: number | null };
  const milestone = database.prepare(`
    SELECT MAX(crossed_at) AS toAt FROM token_milestone_crossings
    WHERE token_id = ? AND crossed_at IS NOT NULL
  `).get(tokenId) as { toAt: number | null };
  return Object.freeze({ fromAt: event.fromAt, toAt: Math.max(event.fromAt, blocked.toAt ?? milestone.toAt ?? fallbackTo) });
}

function localHistoricalPrices(database: DatabaseSync, chain: string, tokenAddress: string, range: { readonly fromAt: number; readonly toAt: number }): Array<readonly [number, number]> {
  const rows = database.prepare(`
    SELECT observed_at AS observedAt, price_usd AS priceUsd
    FROM market_observations
    WHERE chain = ? AND token_address = ? AND price_usd > 0
      AND observed_at BETWEEN ? AND ?
    ORDER BY observed_at
  `).all(chain, tokenAddress, Math.max(0, range.fromAt - HOUR_MS), range.toAt) as Array<{ observedAt: number; priceUsd: number }>;
  return rows.map(row => [row.observedAt, row.priceUsd] as const);
}

function hasEntryCoverage(prices: readonly (readonly [number, number])[], range: { readonly fromAt: number; readonly toAt: number }): boolean {
  return hasHistoricalPriceCoverage(prices, range);
}

function saveHistoricalPrices(database: DatabaseSync, chain: string, tokenAddress: string, prices: readonly (readonly [number, number])[], source = "geckoterminal_ohlcv"): void {
  const insert = database.prepare(`
    INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chain, token_address, observed_at, source)
    DO UPDATE SET price_usd = excluded.price_usd
  `);
  withAddressRadarWriteTransaction(database, () => {
    for (const [observedAt, priceUsd] of prices) insert.run(chain, tokenAddress, observedAt, priceUsd, source);
  }, { label: "save_historical_prices", maximumAttempts: 20, maximumDelayMs: 1_000 });
}

export function reconcileCandidateSourceRecovery(input: { readonly database: DatabaseSync; readonly ledger: SourceLedgerStore; readonly now?: () => number }): { readonly resolvedBlocks: number; readonly enqueued: number } {
  const updatedAt = (input.now ?? Date.now)();
  return withAddressRadarWriteTransaction(input.database, () => {
  const resolved = input.database.prepare(`
    UPDATE automation_job_blocks
    SET resolved_at = COALESCE((SELECT completed_at FROM automation_jobs WHERE automation_jobs.job_id = automation_job_blocks.job_id), ?), updated_at = ?
    WHERE resolved_at IS NULL AND job_id IN (
      SELECT job_id FROM automation_jobs WHERE status NOT IN ('blocked_source', 'waiting_source')
    )
  `).run(updatedAt, updatedAt);
  input.database.prepare(`
    UPDATE recovery_jobs
    SET status = 'pending', attempt_count = 0, next_attempt_at = ?, lease_expires_at = NULL,
      last_error = NULL, updated_at = ?, completed_at = NULL
    WHERE job_type = 'market_history' AND status = 'dead_letter'
      AND last_error IN ('historical_market_coverage_unavailable', 'historical_market_pool_unavailable')
      AND EXISTS (
        SELECT 1
        FROM automation_jobs jobs
        JOIN automation_job_blocks blocks ON blocks.job_id = jobs.job_id
        WHERE jobs.job_type = 'candidate_evidence' AND jobs.status = 'blocked_source'
          AND jobs.subject_key = recovery_jobs.subject_key
          AND blocks.resolved_at IS NULL AND blocks.reason_code = 'missing_market_history'
      )
  `).run(updatedAt, updatedAt);
  const rows = input.database.prepare(`
    SELECT DISTINCT jobs.subject_key AS tokenId,
      substr(jobs.subject_key, 1, instr(jobs.subject_key, ':') - 1) AS chain
    FROM automation_jobs jobs
    JOIN automation_job_blocks blocks ON blocks.job_id = jobs.job_id
    WHERE jobs.job_type = 'candidate_evidence' AND jobs.status = 'blocked_source'
      AND blocks.resolved_at IS NULL AND blocks.reason_code = 'missing_market_history'
  `).all() as Array<{ tokenId: string; chain: string }>;
  let enqueued = 0;
  for (const row of rows) {
    const jobType = row.chain === "robinhood" ? "fomo_token_history" as const : "market_history" as const;
    const result = input.ledger.enqueueRecoveryJob({
      jobId: `recovery:${jobType}:${row.tokenId}`,
      jobType,
      chain: row.chain as Parameters<SourceLedgerStore["enqueueRecoveryJob"]>[0]["chain"],
      subjectKey: row.tokenId,
      priority: 25,
      cursor: null,
      nextAttemptAt: updatedAt,
      createdAt: updatedAt,
    });
    if (result.inserted) enqueued += 1;
  }
  return Object.freeze({ resolvedBlocks: Number(resolved.changes), enqueued });
  }, { label: "reconcile_candidate_source_recovery", maximumAttempts: 20, maximumDelayMs: 1_000 });
}
