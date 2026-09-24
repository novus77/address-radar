export interface CanonicalEventCandidate {
  readonly canonicalEventId: string;
  readonly amountUsd: number | null;
  readonly sourceStatus: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN";
}

export function matchCanonicalTraderEvent(
  candidates: readonly CanonicalEventCandidate[],
  source: "fomo" | "onchain",
  amountUsd: number | null,
): CanonicalEventCandidate | null {
  const opposite = source === "onchain" ? "FOMO_ONLY" : "ONCHAIN_ONLY";
  return candidates.find(candidate => candidate.sourceStatus === opposite && compatibleEconomicAmount(candidate.amountUsd, amountUsd)) ?? null;
}

function compatibleEconomicAmount(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / scale <= 0.05;
}
