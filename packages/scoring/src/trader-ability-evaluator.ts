import { normalizeAddressRadarTokenAddress, type TraderAbilityWindow, type TraderOutcomeHorizon, type TraderTokenOutcome, type TraderTokenSample } from "@address-radar/domain";

import { isCandidateEvidenceType } from "./candidate-tier-policy.js";
import { scoreTraderAbility, type TraderAbilityScore } from "./scoring.js";

const DAY_MS = 24 * 60 * 60_000;

export interface TraderDiscoveryEvidence {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly discoveryType: string;
  readonly discoveredAt: number;
}

export interface TraderAbilityMetrics {
  readonly totalSamples: number;
  readonly validSamples: number;
  readonly coverageRate: number;
  readonly wins: number;
  readonly winRate: number;
  readonly meanReturn: number;
  readonly medianReturn: number;
  readonly hit1_5xRate: number;
  readonly hit2xRate: number;
  readonly hit5xRate: number;
  readonly hit10xRate: number;
  readonly independentHighMultipleCases: number;
  readonly medianMfe: number;
  readonly medianMae: number;
  readonly capturedReturn: number;
  readonly earlyEntryRate: number;
  readonly singleWinDependency: number;
  readonly recentValidity: number;
}

export interface TraderAbilityEvaluation {
  readonly metrics: TraderAbilityMetrics;
  readonly score: TraderAbilityScore;
}

export function evaluateTraderAbility(input: {
  readonly samples: readonly TraderTokenSample[];
  readonly outcomes: readonly TraderTokenOutcome[];
  readonly discoveries: readonly TraderDiscoveryEvidence[];
  readonly asOf: number;
  readonly window: TraderAbilityWindow;
  readonly preferredHorizon: TraderOutcomeHorizon;
}): TraderAbilityEvaluation {
  const since = windowStart(input.window, input.asOf);
  const samples = input.samples.filter(sample => sample.sampleStatus === "included" && sample.firstBuyAt >= since && sample.firstBuyAt <= input.asOf);
  const sampleKeys = new Set(samples.map(sample => tokenKey(sample.chain, sample.tokenAddress)));
  const sampleIds = new Set(samples.map(sample => sample.sampleId));
  const outcomes = latestOutcomes(input.outcomes.filter(outcome => sampleIds.has(outcome.sampleId)
    && outcome.horizon === input.preferredHorizon
    && outcome.coverageStatus === "complete"
    && outcome.computedAt <= input.asOf
    && outcome.closeMultiple !== null));
  const returns = outcomes.map(outcome => outcome.closeMultiple!);
  const positiveGains = returns.map(value => Math.max(0, value - 1));
  const totalPositiveGain = sum(positiveGains);
  const highMultipleTokens = new Set(input.discoveries
    .filter(discovery => discovery.discoveredAt <= input.asOf
      && sampleKeys.has(tokenKey(discovery.chain, discovery.tokenAddress))
      && isCandidateEvidenceType(discovery.discoveryType))
    .map(discovery => tokenKey(discovery.chain, discovery.tokenAddress)));
  const recentOutcomes = outcomes.filter(outcome => {
    const sample = samples.find(value => value.sampleId === outcome.sampleId);
    return sample !== undefined && sample.firstBuyAt >= input.asOf - 7 * DAY_MS;
  });
  const rate = (select: (outcome: TraderTokenOutcome) => boolean): number => outcomes.length === 0 ? 0 : outcomes.filter(select).length / outcomes.length;
  const metrics: TraderAbilityMetrics = Object.freeze({
    totalSamples: samples.length,
    validSamples: outcomes.length,
    coverageRate: samples.length === 0 ? 0 : outcomes.length / samples.length,
    wins: returns.filter(value => value > 1).length,
    winRate: returns.length === 0 ? 0 : returns.filter(value => value > 1).length / returns.length,
    meanReturn: mean(returns),
    medianReturn: median(returns),
    hit1_5xRate: rate(outcome => outcome.hit1_5x === true),
    hit2xRate: rate(outcome => outcome.hit2x === true),
    hit5xRate: rate(outcome => outcome.hit5x === true),
    hit10xRate: rate(outcome => outcome.hit10x === true),
    independentHighMultipleCases: highMultipleTokens.size,
    medianMfe: median(outcomes.flatMap(outcome => outcome.mfeMultiple === null ? [] : [outcome.mfeMultiple])),
    medianMae: median(outcomes.flatMap(outcome => outcome.maeMultiple === null ? [] : [outcome.maeMultiple])),
    capturedReturn: mean(outcomes.flatMap(outcome => outcome.capturedMultiple === null ? [] : [outcome.capturedMultiple])),
    earlyEntryRate: samples.length === 0 ? 0 : samples.filter(sample => (sample.weightedEntryMarketCapUsd ?? Number.POSITIVE_INFINITY) <= 100_000).length / samples.length,
    singleWinDependency: totalPositiveGain === 0 ? 1 : Math.max(...positiveGains) / totalPositiveGain,
    recentValidity: recentOutcomes.length === 0 ? (returns.length === 0 ? 0 : returns.filter(value => value > 1).length / returns.length) : recentOutcomes.filter(outcome => outcome.closeMultiple! > 1).length / recentOutcomes.length,
  });
  return Object.freeze({ metrics, score: scoreTraderAbility(metrics) });
}

export function sampleConfidence(validSamples: number): number {
  if (!Number.isSafeInteger(validSamples) || validSamples < 0) throw new Error("validSamples must be a non-negative integer");
  if (validSamples < 5) return 0.35;
  if (validSamples < 10) return 0.5;
  if (validSamples < 20) return 0.7;
  if (validSamples < 50) return 0.85;
  return 1;
}

function windowStart(window: TraderAbilityWindow, asOf: number): number {
  if (window === "lifetime") return 0;
  return asOf - Number.parseInt(window, 10) * DAY_MS;
}

function tokenKey(chain: string, tokenAddress: string): string {
  return `${chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(chain, tokenAddress)}`;
}

function latestOutcomes(outcomes: readonly TraderTokenOutcome[]): readonly TraderTokenOutcome[] {
  const latestBySampleAndHorizon = new Map<string, TraderTokenOutcome>();
  for (const outcome of outcomes) {
    const key = `${outcome.sampleId}:${outcome.horizon}`;
    const current = latestBySampleAndHorizon.get(key);
    if (!current || outcome.computedAt >= current.computedAt) latestBySampleAndHorizon.set(key, outcome);
  }
  return [...latestBySampleAndHorizon.values()];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : round(sum(values) / values.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
