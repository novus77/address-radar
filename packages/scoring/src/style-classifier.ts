import type { TraderStyle } from "@address-radar/domain";

export interface TraderStyleMetrics {
  readonly medianEntryMarketCapUsd: number;
  readonly medianTokenAgeMs: number;
  readonly medianHoldingMs: number;
  readonly relativePositionSize: number;
  readonly leaderRate: number;
  readonly momentumEntryRate: number;
  readonly narrativeEntryRate: number;
  readonly highMultipleRate?: number;
  readonly oldTokenEntryRate?: number;
}

export type TraderStyleScores = Readonly<Record<TraderStyle, number>>;

export function classifyTraderStyles(metrics: TraderStyleMetrics): TraderStyleScores {
  const marketCapEarly = 1 - clamp(metrics.medianEntryMarketCapUsd / 1_000_000);
  const tokenAgeEarly = 1 - clamp(metrics.medianTokenAgeMs / (6 * 60 * 60_000));
  const scalper = 1 - clamp(metrics.medianHoldingMs / (2 * 60 * 60_000));
  const swing = triangular(metrics.medianHoldingMs, 6 * 60 * 60_000, 72 * 60 * 60_000);
  return Object.freeze({
    EARLY_LAUNCH: round((marketCapEarly + tokenAgeEarly) / 2),
    HIGH_MULTIPLE: round(clamp(metrics.highMultipleRate ?? 0)),
    MOMENTUM: round(clamp(metrics.momentumEntryRate)),
    HIGH_CAP: round(clamp(metrics.medianEntryMarketCapUsd / 5_000_000)),
    LARGE_CAP: round(clamp(metrics.medianEntryMarketCapUsd / 5_000_000)),
    OLD_TOKEN_MOMENTUM: round(clamp(metrics.oldTokenEntryRate ?? 0)),
    CONCENTRATED: round(clamp(metrics.relativePositionSize)),
    SCALPER: round(scalper),
    SWING: round(swing),
    NARRATIVE: round(clamp(metrics.narrativeEntryRate)),
    LEADER: round(clamp(metrics.leaderRate)),
    FOLLOWER: round(clamp(1 - metrics.leaderRate)),
  });
}

function triangular(value: number, peak: number, end: number): number {
  if (value <= 0 || value >= end) return 0;
  return value <= peak ? clamp(value / peak) : clamp((end - value) / (end - peak));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
