const DAY_MS = 24 * 60 * 60 * 1000;
export const FORWARD_CAPTURE_EXTENSION_MS = 7 * DAY_MS;
export const FORWARD_OPPORTUNITY_WINDOW_MS = 30 * DAY_MS;
export const FORWARD_MARKET_CAP_TIERS = [100000, 200000, 300000, 500000, 1000000] as const;
export type ForwardMarketCapTier = typeof FORWARD_MARKET_CAP_TIERS[number];

export function forwardDecimal(value: string): string {
  if (value.length > 512 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid forward decimal");
  const [whole = "", fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return integer + (decimals ? "." + decimals : "");
}

function positive(value: string): string {
  const result = forwardDecimal(value);
  if (result === "0") throw new Error("Expected a positive forward decimal");
  return result;
}

function clock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid forward timestamp");
}

export function forwardInitialCaptureDeadline(firstDiscoveredAt: number): number {
  clock(firstDiscoveredAt);
  const deadline = firstDiscoveredAt + FORWARD_CAPTURE_EXTENSION_MS;
  clock(deadline);
  return deadline;
}

export function forwardExtendedCaptureDeadline(currentDeadline: number, occurredAt: number): number {
  clock(currentDeadline);
  return Math.max(currentDeadline, forwardInitialCaptureDeadline(occurredAt));
}

export function forwardReachedMarketCapTiers(marketCapUsd: string): readonly ForwardMarketCapTier[] {
  const amount = BigInt(forwardDecimal(marketCapUsd).split(".")[0]!);
  return FORWARD_MARKET_CAP_TIERS.filter(tier => amount >= BigInt(tier));
}

export function forwardQualifyingBuyAmount(amountUsd: string): boolean {
  return BigInt(forwardDecimal(amountUsd).split(".")[0]!) >= 50n;
}

export type ForwardOpportunityAssessment =
  | { status: "deferred"; reasonCode: "missing_execution_basis" | "missing_valid_peak" | "price_pending_review" | "window_elapsed_unverified" }
  | { status: "observing"; tier: 0 }
  | { status: "confirmed"; tier: 3 | 5 };

export function assessForwardOpportunity(input: {
  boughtAt: number;
  now: number;
  entryPriceUsd: string | null;
  entryBasisVerified: boolean;
  peak: { priceUsd: string; occurredAt: number; verification: "validated" | "pending_review" } | null;
}): ForwardOpportunityAssessment {
  clock(input.boughtAt);
  clock(input.now);
  const deadline = input.boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS;
  clock(deadline);
  if (input.boughtAt > input.now) throw new Error("Future forward purchase");
  if (!input.entryBasisVerified || input.entryPriceUsd === null) {
    return { status: "deferred", reasonCode: "missing_execution_basis" };
  }
  const entry = positive(input.entryPriceUsd);
  if (!input.peak) return { status: "deferred", reasonCode: input.now >= deadline ? "window_elapsed_unverified" : "missing_valid_peak" };
  clock(input.peak.occurredAt);
  if (input.peak.occurredAt > input.now) throw new Error("Future forward peak");
  if (input.peak.verification !== "validated") return { status: "deferred", reasonCode: "price_pending_review" };
  if (input.peak.occurredAt < input.boughtAt || input.peak.occurredAt >= deadline) {
    return { status: "deferred", reasonCode: input.now >= deadline ? "window_elapsed_unverified" : "missing_valid_peak" };
  }
  const peak = positive(input.peak.priceUsd);
  const [entryWhole = "", entryFraction = ""] = entry.split(".");
  const [peakWhole = "", peakFraction = ""] = peak.split(".");
  const scaledPeak = BigInt(peakWhole + peakFraction) * 10n ** BigInt(entryFraction.length);
  const scaledEntry = BigInt(entryWhole + entryFraction) * 10n ** BigInt(peakFraction.length);
  if (scaledPeak >= scaledEntry * 5n) return { status: "confirmed", tier: 5 };
  if (scaledPeak >= scaledEntry * 3n) return { status: "confirmed", tier: 3 };
  if (input.now >= deadline) return { status: "deferred", reasonCode: "window_elapsed_unverified" };
  return { status: "observing", tier: 0 };
}
