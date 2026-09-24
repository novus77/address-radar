export type CandidatePromotionState = "candidate" | "probation" | "active";

export function proposeCandidateState(input: {
  readonly independentHighMultipleCases: number;
  readonly sampleCount: number;
  readonly adjustedQuality: number;
}): CandidatePromotionState {
  if (input.independentHighMultipleCases >= 3 && input.sampleCount >= 10 && input.adjustedQuality >= 0.7) return "active";
  if (input.independentHighMultipleCases >= 2) return "probation";
  return "candidate";
}
