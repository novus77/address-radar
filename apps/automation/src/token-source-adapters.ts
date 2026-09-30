import type { DatabaseSync } from "node:sqlite";

export const HISTORICAL_TOKEN_CHAINS = Object.freeze([
  "solana",
  "bsc",
  "eth",
  "base",
  "robinhood",
] as const);

export type HistoricalTokenChain = typeof HISTORICAL_TOKEN_CHAINS[number];

export interface HistoricalTokenPartition {
  readonly partitionId: string;
  readonly chain: HistoricalTokenChain;
  readonly weekStart: number;
  readonly weekEnd: number;
  readonly cursor: string | null;
}

export interface HistoricalTokenCandidate {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly symbol?: string | null;
  readonly imageUrl?: string | null;
  readonly firstTradeAt?: number | null;
  readonly firstReached1mAt: number;
  readonly peakMarketCapUsd: number;
  readonly source?: string;
  readonly sourceQueryId?: string | null;
}

export type HistoricalTokenPage =
  | {
    readonly status: "ready";
    readonly tokens: readonly HistoricalTokenCandidate[];
    readonly nextCursor: string | null;
  }
  | {
    readonly status: "waiting_source";
    readonly reason: string;
    readonly retryAt: number;
  };

export interface HistoricalTokenSource {
  readonly name: string;
  discover(
    partition: HistoricalTokenPartition,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<HistoricalTokenPage>;
}

export function canonicalHistoricalChain(value: string): HistoricalTokenChain | null {
  switch (value.trim().toLowerCase()) {
    case "sol":
    case "solana":
      return "solana";
    case "bnb":
    case "binance":
    case "bsc":
      return "bsc";
    case "ethereum":
    case "eth":
      return "eth";
    case "base":
      return "base";
    case "robinhood":
      return "robinhood";
    default:
      return null;
  }
}

export function canonicalHistoricalAddress(
  chain: HistoricalTokenChain,
  address: string,
): string {
  const trimmed = address.trim();
  return chain === "solana" ? trimmed : trimmed.toLowerCase();
}

export function createSqliteHistoricalTokenSource(input: {
  readonly database: DatabaseSync;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
}): HistoricalTokenSource {
  const now = input.now ?? Date.now;
  const retryDelayMs = input.retryDelayMs ?? 15 * 60_000;
  return Object.freeze({
    name: "sqlite-multi-source",
    async discover(partition, cursor, signal) {
      if (signal.aborted) throw signal.reason ?? new Error("Aborted");
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid token source cursor");
      const rows = input.database.prepare(`
        SELECT chain, token_address AS tokenAddress, symbol, image_url AS imageUrl,
          first_trade_at AS firstTradeAt, first_reached_1m_at AS firstReached1mAt,
          peak_market_cap_usd AS peakMarketCapUsd, source, source_query_id AS sourceQueryId
        FROM historical_tokens
        WHERE (CASE LOWER(chain)
          WHEN 'sol' THEN 'solana'
          WHEN 'ethereum' THEN 'eth'
          WHEN 'bnb' THEN 'bsc'
          WHEN 'binance' THEN 'bsc'
          ELSE LOWER(chain)
        END) = ?
          AND first_reached_1m_at >= ?
          AND first_reached_1m_at < ?
        ORDER BY first_reached_1m_at, token_id
        LIMIT 51 OFFSET ?
      `).all(partition.chain, partition.weekStart, partition.weekEnd, offset) as Array<{
        chain: string;
        tokenAddress: string;
        symbol: string | null;
        imageUrl: string | null;
        firstTradeAt: number | null;
        firstReached1mAt: number;
        peakMarketCapUsd: number;
        source: string;
        sourceQueryId: string | null;
      }>;
      if (offset === 0 && rows.length === 0) {
        return Object.freeze({
          status: "waiting_source" as const,
          reason: "historical_source_result_missing",
          retryAt: now() + retryDelayMs,
        });
      }
      const tokens = rows.slice(0, 50);
      return Object.freeze({
        status: "ready" as const,
        tokens: Object.freeze(tokens),
        nextCursor: rows.length > 50 ? String(offset + tokens.length) : null,
      });
    },
  } satisfies HistoricalTokenSource);
}
