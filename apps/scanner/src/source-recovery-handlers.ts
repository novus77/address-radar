import type { DatabaseSync } from "node:sqlite";

import type { GeckoTerminalClient, TokenMarketProvider } from "@address-radar/collectors";
import type {
  AutomationJobStore,
  CandidateHistoryStore,
  SourceLedgerStore,
  TokenFactPrecision,
  TokenFactStatus,
  TokenFactStore,
  TokenFactType,
} from "@address-radar/database";
import { CANDIDATE_MILESTONES } from "@address-radar/scoring";

import {
  RetryableRecoveryError,
  TerminalRecoveryError,
  type RecoveryHandlers,
} from "./recovery-runtime.js";

const HOUR_MS = 60 * 60_000;
const GECKO_TERMINAL_CALLS_PER_MINUTE = 8;
const MAX_HISTORY_PAGES = 2;

interface FomoMilestoneLookupProducer {
  enqueue(input: {
    readonly chainId: string;
    readonly tokenAddress: string;
    readonly requestedAt: number;
    readonly purpose?: "milestone_backfill";
    readonly milestoneId?: string;
    readonly beforeAt?: number;
    readonly cursor?: string;
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

  const prerequisiteReady = (tokenId: string): boolean => {
    const token = tokenParts(tokenId, "");
    const milestone = input.database.prepare(`
      SELECT 1 AS present FROM token_milestone_crossings
      WHERE token_id = ? AND precision != 'unavailable' AND crossed_at IS NOT NULL
      LIMIT 1
    `).get(tokenId);
    const price = input.database.prepare(`
      SELECT 1 AS present FROM market_observations
      WHERE chain = ? AND token_address = ? AND price_usd > 0
      LIMIT 1
    `).get(token.chain, token.tokenAddress);
    return Boolean(milestone && price);
  };

  return Object.freeze({
    async market_enrichment({ job }) {
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      const market = await input.marketProvider.lookup(token.chain, token.tokenAddress);
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
      return { reEvaluate: { kind: "token" as const, key: job.subjectKey } };
    },

    async market_history({ job, consumeBudget }) {
      if (!input.historicalMarketProvider) throw new RetryableRecoveryError("historical_market_provider_unavailable");
      if (job.chain === "robinhood") throw new TerminalRecoveryError("historical_market_chain_unsupported");
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      const range = historyRange(input.database, job.subjectKey, token.chain, token.tokenAddress, observedAt);
      if (!range) throw new TerminalRecoveryError("historical_market_range_unavailable");
      const usageWindow = String(Math.floor(observedAt / 60_000));
      const consume = (): void => consumeBudget({
        provider: "geckoterminal",
        usageWindow,
        units: 1,
        limit: GECKO_TERMINAL_CALLS_PER_MINUTE,
        retryAt: (Math.floor(observedAt / 60_000) + 1) * 60_000,
      });
      consume();
      const pool = await input.historicalMarketProvider.topPool(job.chain, token.tokenAddress);
      if (!pool) {
        if (job.attemptCount >= 3) throw new TerminalRecoveryError("historical_market_pool_unavailable");
        throw new RetryableRecoveryError("historical_market_pool_unavailable");
      }
      const candles = new Map<number, number>();
      let beforeTimestamp = range.toAt + HOUR_MS;
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        consume();
        const batch = await input.historicalMarketProvider.ohlcv(job.chain, pool.poolAddress, {
          timeframe: "hour",
          tokenSide: pool.tokenSide,
          aggregate: 1,
          beforeTimestamp,
          limit: 1_000,
        });
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
      const ordered = [...candles].sort((left, right) => left[0] - right[0]);
      if (ordered.length === 0 || ordered[0]![0] > range.fromAt) {
        if (job.attemptCount >= 3) throw new TerminalRecoveryError("historical_market_coverage_unavailable");
        throw new RetryableRecoveryError("historical_market_coverage_unavailable");
      }
      saveHistoricalPrices(input.database, token.chain, token.tokenAddress, ordered);
      saveFact("price_history", job.subjectKey, "available", "exact", "geckoterminal_ohlcv", observedAt, ordered[0]![0], ordered.at(-1)![0]);
      return { reEvaluate: { kind: "token" as const, key: job.subjectKey } };
    },

    async milestone_early_buyers({ job }) {
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
        return { reEvaluate: { kind: "token" as const, key: job.subjectKey } };
      }
      await input.fomoProducer.enqueue({
        chainId: token.chain,
        tokenAddress: token.tokenAddress,
        requestedAt: now(),
        purpose: "milestone_backfill",
        milestoneId: milestone.milestoneId,
        beforeAt: milestone.crossedAt,
      });
      throw new RetryableRecoveryError("early_trade_lookup_queued");
    },

    async historical_research({ job }) {
      if (!prerequisiteReady(job.subjectKey)) {
        throw new RetryableRecoveryError("historical_research_pending");
      }
      const token = tokenParts(job.subjectKey, job.chain);
      const observedAt = now();
      const priceRange = input.database.prepare(`SELECT MIN(observed_at) AS coverageStartAt, MAX(observed_at) AS coverageEndAt FROM market_observations WHERE chain=? AND token_address=? AND price_usd>0`).get(token.chain, token.tokenAddress) as { coverageStartAt: number | null; coverageEndAt: number | null };
      saveFact("price_history", job.subjectKey, "partial", "derived", "market_observations", observedAt, priceRange.coverageStartAt, priceRange.coverageEndAt);
      const milestoneRange = input.database.prepare(`SELECT MIN(crossed_at) AS coverageStartAt, MAX(crossed_at) AS coverageEndAt FROM token_milestone_crossings WHERE token_id=? AND precision!='unavailable' AND crossed_at IS NOT NULL`).get(job.subjectKey) as { coverageStartAt: number | null; coverageEndAt: number | null };
      saveFact("milestone_crossings", job.subjectKey, "partial", "estimated", "token_milestone_crossings", observedAt, milestoneRange.coverageStartAt, milestoneRange.coverageEndAt);
      return { reEvaluate: { kind: "token" as const, key: job.subjectKey } };
    },

    async fomo_token_history({ job }) {
      const token = tokenParts(job.subjectKey, job.chain);
      await input.fomoProducer.enqueue({ chainId: token.chain, tokenAddress: token.tokenAddress, requestedAt: now() });
      if (job.attemptCount >= 12) throw new TerminalRecoveryError("fomo_token_history_unavailable");
      throw new RetryableRecoveryError("fomo_token_history_queued");
    },

    async identity_resolution({ job }) {
      const mapping = input.database.prepare(`
        SELECT 1 AS present FROM entity_wallet_identities
        WHERE entity_id = ? OR address = ? LIMIT 1
      `).get(job.subjectKey, job.subjectKey);
      if (!mapping) throw new RetryableRecoveryError("identity_resolution_pending");
      return { reEvaluate: { kind: "trader" as const, key: job.subjectKey } };
    },

    async rpc_gap() {
      throw new RetryableRecoveryError("rpc_gap_requires_provider_replay");
    },
  });
}

function historyRange(database: DatabaseSync, tokenId: string, chain: string, tokenAddress: string, fallbackTo: number): { readonly fromAt: number; readonly toAt: number } | null {
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

function saveHistoricalPrices(database: DatabaseSync, chain: string, tokenAddress: string, prices: readonly (readonly [number, number])[]): void {
  const insert = database.prepare(`
    INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
    VALUES (?, ?, ?, ?, 'geckoterminal_ohlcv')
    ON CONFLICT(chain, token_address, observed_at, source)
    DO UPDATE SET price_usd = excluded.price_usd
  `);
  const nested = database.isTransaction;
  if (!nested) database.exec("BEGIN IMMEDIATE");
  try {
    for (const [observedAt, priceUsd] of prices) insert.run(chain, tokenAddress, observedAt, priceUsd);
    if (!nested) database.exec("COMMIT");
  } catch (error) {
    if (!nested && database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function reconcileCandidateSourceRecovery(input: { readonly database: DatabaseSync; readonly ledger: SourceLedgerStore; readonly now?: () => number }): { readonly resolvedBlocks: number; readonly enqueued: number } {
  const updatedAt = (input.now ?? Date.now)();
  const resolved = input.database.prepare(`
    UPDATE automation_job_blocks
    SET resolved_at = COALESCE((SELECT completed_at FROM automation_jobs WHERE automation_jobs.job_id = automation_job_blocks.job_id), ?), updated_at = ?
    WHERE resolved_at IS NULL AND job_id IN (
      SELECT job_id FROM automation_jobs WHERE status NOT IN ('blocked_source', 'waiting_source')
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
}
