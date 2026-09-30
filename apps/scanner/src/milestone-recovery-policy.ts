export function milestoneRecoveryGap(input: { readonly poolFound: boolean; readonly supplyAvailable: boolean; readonly candleCount: number }): string {
  if (!input.poolFound) return "historical_milestone_pool_missing";
  if (!input.supplyAvailable) return "historical_milestone_supply_unavailable";
  if (input.candleCount === 0) return "historical_milestone_coverage_missing";
  // Current supply estimates and a bounded pool scan cannot prove historical absence.
  return "historical_milestone_crossing_unverified";
}
