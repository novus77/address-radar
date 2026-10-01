import type { DatabaseSync } from "node:sqlite";
import type { HistoricalTokenPriceResult } from "@address-radar/collectors";

const HOUR_MS = 3_600_000;

export function readHistoricalPricePage(
  database: DatabaseSync,
  tokenId: string,
  range: { readonly fromAt: number; readonly toAt: number },
): HistoricalTokenPriceResult | null {
  const separator = tokenId.indexOf(":");
  const chain = tokenId.slice(0, separator);
  const address = tokenId.slice(separator + 1);
  const count = (range.toAt - range.fromAt) / HOUR_MS + 1;
  if (separator <= 0 || !address || !["solana", "eth", "bsc", "base"].includes(chain) ||
      !Number.isSafeInteger(range.fromAt) || range.fromAt < 0 || !Number.isSafeInteger(range.toAt) ||
      !Number.isInteger(count) || count < 1 || count > 500) return null;

  const prices = database.prepare(`SELECT observed_at AS observedAt, price_usd AS priceUsd
    FROM market_observations WHERE chain = ? AND token_address = ? AND source = 'defillama_chart'
      AND observed_at BETWEEN ? AND ? ORDER BY observed_at`).all(
    chain, chain === "solana" ? address : address.toLowerCase(), range.fromAt, range.toAt,
  ) as unknown as { observedAt: number; priceUsd: number }[];
  if (prices.length !== count || !prices.every((point, index) =>
    point.observedAt === range.fromAt + index * HOUR_MS && Number.isFinite(point.priceUsd) && point.priceUsd > 0)) return null;

  const attempt = database.prepare(`SELECT payload FROM token_fact_attempts
    WHERE token_id = ? AND fact_type = 'price_history' AND provider = 'defillama_chart'
      AND outcome IN ('available', 'partial') AND facts_written > 0
      AND coverage_start_at <= ? AND coverage_end_at >= ?
    ORDER BY finished_at DESC, attempt_id DESC LIMIT 1`).get(tokenId, range.fromAt, range.toAt) as
    { payload: string | null } | undefined;
  if (!attempt?.payload) return null;
  let confidence: unknown;
  try { confidence = (JSON.parse(attempt.payload) as { confidence?: unknown } | null)?.confidence; }
  catch { return null; }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  return Object.freeze({ source: "defillama_chart", confidence,
    prices: Object.freeze(prices.map(point => Object.freeze({ ...point }))) });
}
