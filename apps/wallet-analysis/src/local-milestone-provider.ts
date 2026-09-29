import type { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_MARKET_CAP_THRESHOLDS_USD,
  type GeckoMilestoneProvider,
  type MilestoneReconstructionResult,
  type ReconstructMilestonesInput,
  type ReconstructedMilestone,
} from "./gecko-milestone-provider.js";

interface MarketSnapshotRow {
  readonly observedAt: number;
  readonly marketCapUsd: number;
}

export function createLocalMilestoneProvider(input: {
  readonly database: DatabaseSync;
  readonly thresholdsUsd?: readonly number[];
}): GeckoMilestoneProvider {
  const thresholds = [...(input.thresholdsUsd ?? DEFAULT_MARKET_CAP_THRESHOLDS_USD)].sort((left, right) => left - right);
  return Object.freeze({
    async reconstruct(request: ReconstructMilestonesInput): Promise<MilestoneReconstructionResult> {
      const address = request.chain === "solana" ? request.tokenAddress.trim() : request.tokenAddress.trim().toLowerCase();
      const tokenId = `${request.chain}:${address}`;
      const rows = input.database.prepare(`
        SELECT observed_at AS observedAt, market_cap_usd AS marketCapUsd
        FROM token_market_snapshots
        WHERE token_id = ? AND observed_at >= ? AND observed_at <= ?
          AND market_cap_usd IS NOT NULL AND market_cap_usd > 0
        ORDER BY observed_at, snapshot_id
      `).all(tokenId, request.fromTimestamp, request.toTimestamp) as unknown as MarketSnapshotRow[];
      if (rows.length === 0) {
        return Object.freeze({ status: "not_found", poolAddress: null, supplyEstimate: null, supplyBasis: null, milestones: [], candleCount: 0 });
      }
      const milestones = thresholds.flatMap((thresholdUsd): readonly ReconstructedMilestone[] => {
        const crossing = rows.find((row) => row.marketCapUsd >= thresholdUsd);
        return crossing ? [Object.freeze({
          thresholdUsd,
          crossedAt: crossing.observedAt,
          estimatedMarketCapUsd: crossing.marketCapUsd,
          source: "local_market_snapshot" as const,
          precision: "observed_market_cap" as const,
        })] : [];
      });
      return Object.freeze({
        status: milestones.length > 0 ? "available" : "insufficient_market_data",
        poolAddress: null,
        supplyEstimate: null,
        supplyBasis: null,
        milestones,
        candleCount: rows.length,
      });
    },
  });
}
