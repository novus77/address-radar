import type { MarketObservation, TraderOutcomeHorizon, TraderTokenOutcome } from "@address-radar/domain";

export interface TraderTokenOutcomeEvaluationInput {
  readonly sampleId: string;
  readonly horizon: TraderOutcomeHorizon;
  readonly entryAt: number;
  readonly entryPriceUsd: number;
  readonly targetAt: number;
  readonly maximumObservationDelayMs: number;
  readonly observations: readonly MarketObservation[];
  readonly capturedMultiple: number | null;
  readonly computedAt: number;
}

export function evaluateTraderTokenOutcome(input: TraderTokenOutcomeEvaluationInput): TraderTokenOutcome {
  assertInput(input);
  if (input.computedAt < input.targetAt + input.maximumObservationDelayMs) return emptyOutcome(input, "pending");

  const eligible = input.observations
    .filter(observation => observation.observedAt >= input.entryAt
      && observation.observedAt <= input.targetAt + input.maximumObservationDelayMs
      && Number.isFinite(observation.priceUsd)
      && observation.priceUsd > 0)
    .sort((left, right) => left.observedAt - right.observedAt);
  const close = eligible.find(observation => observation.observedAt >= input.targetAt);
  if (!close) return emptyOutcome(input, "unavailable");

  const path = eligible.filter(observation => observation.observedAt <= close.observedAt);
  const multiples = path.map(observation => observation.priceUsd / input.entryPriceUsd);
  const hit = (threshold: number): boolean => multiples.some(value => value >= threshold);
  const hitTime = (threshold: number): number | null => {
    const observation = path.find(item => item.priceUsd / input.entryPriceUsd >= threshold);
    return observation ? observation.observedAt - input.entryAt : null;
  };

  return Object.freeze({
    sampleId: input.sampleId,
    horizon: input.horizon,
    targetAt: input.targetAt,
    observedAt: close.observedAt,
    closeMultiple: round(close.priceUsd / input.entryPriceUsd),
    mfeMultiple: round(Math.max(...multiples)),
    maeMultiple: round(Math.min(...multiples)),
    capturedMultiple: input.capturedMultiple === null ? null : round(input.capturedMultiple),
    hit1_5x: hit(1.5),
    hit2x: hit(2),
    hit5x: hit(5),
    hit10x: hit(10),
    timeTo1_5xMs: hitTime(1.5),
    timeTo2xMs: hitTime(2),
    timeTo5xMs: hitTime(5),
    timeTo10xMs: hitTime(10),
    coverageStatus: "complete",
    source: close.source,
    computedAt: input.computedAt,
  });
}

function emptyOutcome(input: TraderTokenOutcomeEvaluationInput, coverageStatus: "pending" | "unavailable"): TraderTokenOutcome {
  return Object.freeze({
    sampleId: input.sampleId,
    horizon: input.horizon,
    targetAt: input.targetAt,
    observedAt: null,
    closeMultiple: null,
    mfeMultiple: null,
    maeMultiple: null,
    capturedMultiple: input.capturedMultiple,
    hit1_5x: null,
    hit2x: null,
    hit5x: null,
    hit10x: null,
    timeTo1_5xMs: null,
    timeTo2xMs: null,
    timeTo5xMs: null,
    timeTo10xMs: null,
    coverageStatus,
    source: null,
    computedAt: input.computedAt,
  });
}

function assertInput(input: TraderTokenOutcomeEvaluationInput): void {
  if (!input.sampleId.trim()) throw new Error("sampleId is required");
  if (!Number.isFinite(input.entryPriceUsd) || input.entryPriceUsd <= 0) throw new Error("entryPriceUsd must be positive");
  for (const [name, value] of [["entryAt", input.entryAt], ["targetAt", input.targetAt], ["computedAt", input.computedAt], ["maximumObservationDelayMs", input.maximumObservationDelayMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  if (input.targetAt <= input.entryAt) throw new Error("targetAt must be after entryAt");
  if (input.capturedMultiple !== null && (!Number.isFinite(input.capturedMultiple) || input.capturedMultiple < 0)) throw new Error("capturedMultiple must be non-negative");
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
