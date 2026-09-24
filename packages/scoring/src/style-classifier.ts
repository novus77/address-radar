import type { TraderStyle } from "@address-radar/domain";

export interface TraderStyleMetrics {
  readonly medianEntryMarketCapUsd?: number;
  readonly medianTokenAgeMs?: number;
  readonly medianHoldingMs?: number;
  readonly relativePositionSize?: number;
  readonly leaderRate?: number;
  readonly momentumEntryRate?: number;
  readonly narrativeEntryRate?: number;
  readonly highMultipleRate?: number;
  readonly oldTokenEntryRate?: number;
}

export type TraderStyleScores = Readonly<Record<TraderStyle, number>>;

export function classifyTraderStyles(metrics: TraderStyleMetrics): TraderStyleScores {
  const marketCapEarly = metrics.medianEntryMarketCapUsd === undefined ? null : 1 - clamp(metrics.medianEntryMarketCapUsd / 1_000_000);
  const tokenAgeEarly = metrics.medianTokenAgeMs === undefined ? null : 1 - clamp(metrics.medianTokenAgeMs / (6 * 60 * 60_000));
  const earlyEvidence = [marketCapEarly, tokenAgeEarly].filter((value): value is number => value !== null);
  const scalper = metrics.medianHoldingMs === undefined ? 0 : 1 - clamp(metrics.medianHoldingMs / (2 * 60 * 60_000));
  const swing = metrics.medianHoldingMs === undefined ? 0 : triangular(metrics.medianHoldingMs, 6 * 60 * 60_000, 72 * 60 * 60_000);
  const leader = metrics.leaderRate === undefined ? null : clamp(metrics.leaderRate);
  return Object.freeze({
    EARLY_LAUNCH: round(earlyEvidence.length ? earlyEvidence.reduce((sum, value) => sum + value, 0) / earlyEvidence.length : 0),
    HIGH_MULTIPLE: round(clamp(metrics.highMultipleRate ?? 0)),
    MOMENTUM: round(clamp(metrics.momentumEntryRate ?? 0)),
    HIGH_CAP: round(metrics.medianEntryMarketCapUsd === undefined ? 0 : clamp(metrics.medianEntryMarketCapUsd / 5_000_000)),
    LARGE_CAP: round(metrics.medianEntryMarketCapUsd === undefined ? 0 : clamp(metrics.medianEntryMarketCapUsd / 5_000_000)),
    OLD_TOKEN_MOMENTUM: round(clamp(metrics.oldTokenEntryRate ?? 0)),
    CONCENTRATED: round(clamp(metrics.relativePositionSize ?? 0)),
    SCALPER: round(scalper),
    SWING: round(swing),
    NARRATIVE: round(clamp(metrics.narrativeEntryRate ?? 0)),
    LEADER: round(leader ?? 0),
    FOLLOWER: round(leader === null ? 0 : 1 - leader),
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
