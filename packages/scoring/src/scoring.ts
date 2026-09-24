export const ADDRESS_SCORE_V1_WEIGHTS = Object.freeze({
  profitQuality: 0.25,
  earlyDiscovery: 0.25,
  consistency: 0.20,
  riskControl: 0.15,
  leadership: 0.10,
  recentForm: 0.05,
});

export const ADDRESS_SCORE_V2_WEIGHTS = Object.freeze({
  repeatableAlpha: 0.30,
  earlyDiscovery: 0.20,
  capturedPerformance: 0.20,
  consistency: 0.15,
  riskControl: 0.10,
  recentForm: 0.05,
});

export interface TraderAbilityScoreInput {
  readonly validSamples: number;
  readonly coverageRate: number;
  readonly hit2xRate: number;
  readonly hit5xRate: number;
  readonly hit10xRate: number;
  readonly independentHighMultipleCases: number;
  readonly earlyEntryRate: number;
  readonly capturedReturn: number;
  readonly singleWinDependency: number;
  readonly medianMae: number;
  readonly recentValidity: number;
}

export interface TraderAbilityScore {
  readonly rawQuality: number;
  readonly adjustedQuality: number;
  readonly sampleConfidence: number;
  readonly coverageConfidence: number;
  readonly components: Readonly<Record<keyof typeof ADDRESS_SCORE_V2_WEIGHTS, number>>;
}

export function scoreTraderAbility(metrics: TraderAbilityScoreInput): TraderAbilityScore {
  const confidence = abilitySampleConfidence(metrics.validSamples);
  const coverageConfidence = 0.5 + 0.5 * clamp(metrics.coverageRate);
  const highMultipleReliability = metrics.independentHighMultipleCases / (metrics.independentHighMultipleCases + 2);
  const components = Object.freeze({
    repeatableAlpha: clamp(0.4 * metrics.hit2xRate + 0.35 * metrics.hit5xRate + 0.15 * metrics.hit10xRate + 0.1 * highMultipleReliability),
    earlyDiscovery: clamp(metrics.earlyEntryRate),
    capturedPerformance: clamp(Math.log2(Math.max(0, metrics.capturedReturn) + 1) / Math.log2(11)),
    consistency: clamp(1 - metrics.singleWinDependency),
    riskControl: clamp(metrics.medianMae),
    recentForm: clamp(metrics.recentValidity),
  });
  const rawQuality = round(Object.entries(ADDRESS_SCORE_V2_WEIGHTS).reduce((total, [key, weight]) => total + components[key as keyof typeof components] * weight, 0));
  return Object.freeze({ rawQuality, adjustedQuality: round(rawQuality * confidence * coverageConfidence), sampleConfidence: confidence, coverageConfidence: round(coverageConfidence), components });
}

function abilitySampleConfidence(validSamples: number): number {
  if (validSamples < 5) return 0.35;
  if (validSamples < 10) return 0.5;
  if (validSamples < 20) return 0.7;
  if (validSamples < 50) return 0.85;
  return 1;
}

export interface TraderPerformanceMetrics {
  readonly samples: number;
  readonly wins: number;
  readonly medianReturn: number;
  readonly tenXCases: number;
  readonly recentLosses: number;
  readonly earlyEntryRate: number;
  readonly maxDrawdown: number;
  readonly leaderRate: number;
  readonly singleWinDependency: number;
}

export interface TraderScore {
  readonly quality: number;
  readonly components: Readonly<Record<keyof typeof ADDRESS_SCORE_V1_WEIGHTS, number>>;
  readonly sampleCount: number;
}

export function scoreTrader(metrics: TraderPerformanceMetrics): TraderScore {
  if (!Number.isSafeInteger(metrics.samples) || metrics.samples < 0 || !Number.isSafeInteger(metrics.wins) || metrics.wins < 0 || metrics.wins > metrics.samples) throw new Error("Invalid trader sample counts");
  const adjustedWinRate = (metrics.wins + 2) / (metrics.samples + 4);
  const normalizedMedianReturn = clamp(Math.log2(Math.max(0, metrics.medianReturn) + 1) / Math.log2(11));
  const highMultipleReliability = metrics.tenXCases / (metrics.tenXCases + 2);
  const lossRate = metrics.samples === 0 ? 0.5 : metrics.recentLosses / metrics.samples;
  const components = Object.freeze({
    profitQuality: clamp(0.6 * adjustedWinRate + 0.4 * normalizedMedianReturn),
    earlyDiscovery: clamp(0.6 * metrics.earlyEntryRate + 0.4 * highMultipleReliability),
    consistency: clamp(1 - metrics.singleWinDependency),
    riskControl: clamp(0.7 * (1 - metrics.maxDrawdown) + 0.3 * (1 - lossRate)),
    leadership: clamp(metrics.leaderRate),
    recentForm: clamp(1 - lossRate),
  });
  const quality = Object.entries(ADDRESS_SCORE_V1_WEIGHTS).reduce((total, [key, weight]) => total + components[key as keyof typeof components] * weight, 0);
  return Object.freeze({ quality: round(quality), components, sampleCount: metrics.samples });
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
