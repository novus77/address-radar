export interface WalletAnalysisPosition {
  readonly tokenId: string;
  readonly enteredAt: number;
  readonly investedUsd: number;
  readonly realizedValueUsd: number;
  readonly remainingValueUsd: number;
  readonly peakValueUsd: number;
  readonly holdingDurationMs: number;
  readonly maximumDrawdownRatio: number;
  readonly earlyEntry: boolean;
  readonly largeBuy: boolean;
}

export interface WalletAnalysisMetrics {
  readonly requestedSamples: number;
  readonly validSamples: number;
  readonly coverageRate: number;
  readonly profitableRate: number;
  readonly hit1_5xRate: number;
  readonly hit2xRate: number;
  readonly hit3xRate: number;
  readonly hit5xRate: number;
  readonly hit10xRate: number;
  readonly meanPeakMultiple: number;
  readonly medianPeakMultiple: number;
  readonly meanRealizedMultiple: number;
  readonly medianRealizedMultiple: number;
  readonly meanHoldingDurationMs: number;
  readonly medianHoldingDurationMs: number;
  readonly earlyEntryRate: number;
  readonly largeBuyRate: number;
  readonly medianMaximumDrawdownRatio: number;
  readonly unsoldPositionRate: number;
}

export function analyzeWalletPositions(input: {
  readonly requestedSamples: number;
  readonly positions: readonly WalletAnalysisPosition[];
}): WalletAnalysisMetrics {
  if (!Number.isSafeInteger(input.requestedSamples) || input.requestedSamples < 1 || input.requestedSamples > 300) throw new Error("requestedSamples must be between 1 and 300");
  const positions = input.positions
    .filter(position => position.investedUsd > 0
      && position.realizedValueUsd >= 0
      && position.remainingValueUsd >= 0
      && position.peakValueUsd >= 0
      && position.holdingDurationMs >= 0
      && position.maximumDrawdownRatio >= 0
      && position.maximumDrawdownRatio <= 1)
    .slice(0, input.requestedSamples);
  const validSamples = positions.length;
  if (validSamples === 0) return emptyMetrics(input.requestedSamples);

  const realizedMultiples = positions.map(position => (position.realizedValueUsd + position.remainingValueUsd) / position.investedUsd);
  const peakMultiples = positions.map(position => position.peakValueUsd / position.investedUsd);
  const holdingDurations = positions.map(position => position.holdingDurationMs);
  const drawdowns = positions.map(position => position.maximumDrawdownRatio);
  const rate = (values: readonly number[], predicate: (value: number) => boolean): number => round(values.filter(predicate).length / validSamples);

  return Object.freeze({
    requestedSamples: input.requestedSamples,
    validSamples,
    coverageRate: round(validSamples / input.requestedSamples),
    profitableRate: rate(realizedMultiples, value => value > 1),
    hit1_5xRate: rate(peakMultiples, value => value >= 1.5),
    hit2xRate: rate(peakMultiples, value => value >= 2),
    hit3xRate: rate(peakMultiples, value => value >= 3),
    hit5xRate: rate(peakMultiples, value => value >= 5),
    hit10xRate: rate(peakMultiples, value => value >= 10),
    meanPeakMultiple: mean(peakMultiples),
    medianPeakMultiple: median(peakMultiples),
    meanRealizedMultiple: mean(realizedMultiples),
    medianRealizedMultiple: median(realizedMultiples),
    meanHoldingDurationMs: mean(holdingDurations),
    medianHoldingDurationMs: median(holdingDurations),
    earlyEntryRate: round(positions.filter(position => position.earlyEntry).length / validSamples),
    largeBuyRate: round(positions.filter(position => position.largeBuy).length / validSamples),
    medianMaximumDrawdownRatio: median(drawdowns),
    unsoldPositionRate: round(positions.filter(position => position.remainingValueUsd > 0).length / validSamples),
  });
}

function emptyMetrics(requestedSamples: number): WalletAnalysisMetrics {
  return Object.freeze({
    requestedSamples,
    validSamples: 0,
    coverageRate: 0,
    profitableRate: 0,
    hit1_5xRate: 0,
    hit2xRate: 0,
    hit3xRate: 0,
    hit5xRate: 0,
    hit10xRate: 0,
    meanPeakMultiple: 0,
    medianPeakMultiple: 0,
    meanRealizedMultiple: 0,
    medianRealizedMultiple: 0,
    meanHoldingDurationMs: 0,
    medianHoldingDurationMs: 0,
    earlyEntryRate: 0,
    largeBuyRate: 0,
    medianMaximumDrawdownRatio: 0,
    unsoldPositionRate: 0,
  });
}

function mean(values: readonly number[]): number {
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return round(ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
