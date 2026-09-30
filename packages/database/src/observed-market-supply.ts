import type { DatabaseSync } from "node:sqlite";

export function resolveObservedMarketSupply(input: {
  readonly database: DatabaseSync;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly asOf: number;
}) {
  const address = input.chain === "solana" ? input.tokenAddress.trim() : input.tokenAddress.trim().toLowerCase();
  const row = input.database.prepare(`SELECT snapshot_id, observed_at, price_usd, market_cap_usd FROM token_market_snapshots
    WHERE token_id=? AND source='dexscreener' AND observed_at BETWEEN ? AND ?
      AND price_usd>0 AND market_cap_usd>0 AND json_valid(payload)
      AND json_extract(payload,'$.marketCapBasis')='market_cap'
    ORDER BY observed_at DESC, snapshot_id LIMIT 1`).get(`${input.chain}:${address}`, Math.max(0, input.asOf - 86_400_000), input.asOf) as
    { snapshot_id: string; observed_at: number; price_usd: number; market_cap_usd: number } | undefined;
  if (!row) return null;
  const supply = row.market_cap_usd / row.price_usd;
  if (!Number.isFinite(supply) || supply <= 0) return null;
  return Object.freeze({ supply, source: "local_market_snapshot", snapshotId: row.snapshot_id, observedAt: row.observed_at });
}
