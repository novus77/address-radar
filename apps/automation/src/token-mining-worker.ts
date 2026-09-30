import type { DatabaseSync } from "node:sqlite";

import type { AutomationJobStore } from "@address-radar/database";

import type { AutomationHandler } from "./scheduler.js";
import {
  canonicalHistoricalAddress,
  canonicalHistoricalChain,
  type HistoricalTokenCandidate,
  type HistoricalTokenChain,
  type HistoricalTokenPartition,
  type HistoricalTokenSource,
} from "./token-source-adapters.js";

const STRATEGY_VERSION = "historical-token-mining-v1";

export function createTokenMiningWorker(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly source: HistoricalTokenSource;
  readonly now?: () => number;
}): AutomationHandler {
  const now = input.now ?? Date.now;
  return Object.freeze<AutomationHandler>({
    jobType: "historical_token_partition",
    async execute(job, signal) {
      const partition = parsePartition(job.payload);
      const currentTime = now();
      input.database.prepare(`
        UPDATE historical_token_partitions
        SET status = 'running', source_name = ?, last_error = NULL, updated_at = ?
        WHERE partition_id = ?
      `).run(input.source.name, currentTime, partition.partitionId);
      try {
        const page = await input.source.discover(partition, job.cursor, signal);
        if (page.status === "waiting_source") {
          input.database.prepare(`
            UPDATE historical_token_partitions
            SET status = 'waiting_source', next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE partition_id = ?
          `).run(page.retryAt, page.reason, currentTime, partition.partitionId);
          return Object.freeze({
            status: "waiting_source" as const,
            diagnostic: page.reason,
            retryAt: page.retryAt,
          });
        }
        if (page.tokens.length > 50) throw new Error("Historical token page exceeds 50 tokens");
        const unique = canonicalPage(page.tokens, partition.chain);
        for (const token of unique) processToken(input, partition, token, currentTime);
        input.database.prepare(`
          UPDATE historical_token_partitions
          SET token_count = (
                SELECT COUNT(*) FROM historical_token_mining_jobs
                WHERE partition_id = ?
              ),
              status = ?, cursor = ?, next_attempt_at = ?, last_error = NULL,
              updated_at = ?, completed_at = ?
          WHERE partition_id = ?
        `).run(
          partition.partitionId,
          page.nextCursor === null ? "completed" : "queued",
          page.nextCursor,
          currentTime,
          currentTime,
          page.nextCursor === null ? currentTime : null,
          partition.partitionId,
        );
        return page.nextCursor === null
          ? Object.freeze({ status: "completed" as const })
          : Object.freeze({ status: "checkpoint" as const, cursor: page.nextCursor, retryAt: currentTime });
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        input.database.prepare(`
          UPDATE historical_token_partitions
          SET status = 'retryable', next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE partition_id = ?
        `).run(currentTime + 60_000, diagnostic, currentTime, partition.partitionId);
        return Object.freeze({
          status: "retryable" as const,
          diagnostic,
          retryAt: currentTime + 60_000,
        });
      }
    },
  });
}

function processToken(
  input: {
    readonly database: DatabaseSync;
    readonly jobs: AutomationJobStore;
    readonly source: HistoricalTokenSource;
  },
  partition: HistoricalTokenPartition,
  token: HistoricalTokenCandidate & { readonly tokenId: string; readonly chain: HistoricalTokenChain },
  now: number,
): void {
  const existing = input.database.prepare(`
    SELECT token_id AS tokenId
    FROM historical_tokens
    WHERE (CASE LOWER(chain)
      WHEN 'sol' THEN 'solana'
      WHEN 'ethereum' THEN 'eth'
      WHEN 'bnb' THEN 'bsc'
      WHEN 'binance' THEN 'bsc'
      ELSE LOWER(chain)
    END) = ?
      AND (CASE WHEN LOWER(chain) IN ('sol', 'solana')
        THEN token_address ELSE LOWER(token_address) END) = ?
    LIMIT 1
  `).get(token.chain, token.tokenAddress) as { tokenId: string } | undefined;
  const tokenId = existing?.tokenId ?? token.tokenId;
  if (existing) {
    input.database.prepare(`
      UPDATE historical_tokens
      SET first_reached_1m_at = MIN(first_reached_1m_at, ?),
          peak_market_cap_usd = MAX(peak_market_cap_usd, ?),
          symbol = COALESCE(symbol, ?), image_url = COALESCE(image_url, ?)
      WHERE token_id = ?
    `).run(token.firstReached1mAt, token.peakMarketCapUsd, token.symbol ?? null, token.imageUrl ?? null, tokenId);
  } else {
    input.database.prepare(`
      INSERT INTO historical_tokens(
        token_id, chain, token_address, symbol, image_url, first_trade_at,
        first_reached_1m_at, peak_market_cap_usd, source, source_query_id, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenId,
      token.chain,
      token.tokenAddress,
      token.symbol ?? null,
      token.imageUrl ?? null,
      token.firstTradeAt ?? null,
      token.firstReached1mAt,
      token.peakMarketCapUsd,
      token.source ?? input.source.name,
      token.sourceQueryId ?? null,
      JSON.stringify([input.source.name, partition.partitionId]),
    );
  }
  const verification = input.database.prepare(`
    SELECT status, exact_ca_match AS exactCaMatch
    FROM historical_token_verifications WHERE token_id = ?
  `).get(tokenId) as { status: string; exactCaMatch: number | null } | undefined;
  const eligible = verification?.status === "confirmed" && verification.exactCaMatch === 1;
  const status = eligible ? "evidence_pending" : "verification_pending";
  input.database.prepare(`
    INSERT INTO historical_token_mining_jobs(
      mining_job_id, partition_id, token_id, chain, token_address, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_id) DO UPDATE SET
      status = excluded.status,
      updated_at = MAX(historical_token_mining_jobs.updated_at, excluded.updated_at)
  `).run(
    `${partition.partitionId}:${tokenId}`,
    partition.partitionId,
    tokenId,
    token.chain,
    token.tokenAddress,
    status,
    now,
    now,
  );
  if (!eligible) return;
  const key = `candidate-evidence:token:${tokenId}:${STRATEGY_VERSION}`;
  input.jobs.enqueue({
    jobId: key,
    idempotencyKey: key,
    lane: "trader_backfill",
    jobType: "candidate_evidence",
    subjectKey: tokenId,
    priority: 20,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({
      tokenId,
      chain: token.chain,
      tokenAddress: token.tokenAddress,
      partitionId: partition.partitionId,
      strategyVersion: STRATEGY_VERSION,
    }),
    createdAt: now,
  });
}

function canonicalPage(
  tokens: readonly HistoricalTokenCandidate[],
  partitionChain: HistoricalTokenChain,
): readonly (HistoricalTokenCandidate & { tokenId: string; chain: HistoricalTokenChain })[] {
  const unique = new Map<string, HistoricalTokenCandidate & { tokenId: string; chain: HistoricalTokenChain }>();
  for (const token of tokens) {
    const chain = canonicalHistoricalChain(token.chain);
    if (chain !== partitionChain) continue;
    const tokenAddress = canonicalHistoricalAddress(chain, token.tokenAddress);
    const tokenId = `${chain}:${tokenAddress}`;
    unique.set(tokenId, { ...token, chain, tokenAddress, tokenId });
  }
  return Object.freeze([...unique.values()]);
}

function parsePartition(payload: string): HistoricalTokenPartition {
  const value = JSON.parse(payload) as Partial<HistoricalTokenPartition>;
  const chain = canonicalHistoricalChain(value.chain ?? "");
  if (!value.partitionId?.trim() || !chain) throw new Error("Invalid historical token partition");
  if (!Number.isSafeInteger(value.weekStart) || !Number.isSafeInteger(value.weekEnd)) {
    throw new Error("Invalid historical token partition window");
  }
  return Object.freeze({
    partitionId: value.partitionId,
    chain,
    weekStart: value.weekStart!,
    weekEnd: value.weekEnd!,
    cursor: typeof value.cursor === "string" ? value.cursor : null,
  });
}
