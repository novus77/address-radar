export { aggregateEvidenceWindow } from "./evidence.js";
export type {
  AddressEvidenceSource,
  AddressEvidenceSourceState,
  AddressSignalEvidence,
  AggregatedTraderEvidence,
  TokenAggregationPrevious,
  TokenEvidenceSnapshot,
  BundleDiagnostics,
} from "./evidence.js";
export { applyWalletBundleGroups, detectTemporalBundlePairs, walletBundlePairKey, STRONG_BUNDLE_WINDOW_MS, SUSPECTED_BUNDLE_WINDOW_MS } from "./bundle.js";
export type { WalletBundlePairObservation, WalletBundleRelation } from "./bundle.js";
export { createTokenLifecycleResolver } from "./token-lifecycle-resolver.js";
export type { TokenCreationProvider, TokenLaunchProvider, TokenLifecycleResolver } from "./token-lifecycle-resolver.js";
export { createTokenAggregationService, DEGRADED_TRADER_DISCOUNT } from "./service.js";
export type { AggregationDecision } from "./service.js";
export type { SignalTraderProfile, TokenAggregationRepository, TokenAggregationState, TokenEvaluationInput } from "./repository.js";
export { matchCanonicalTraderEvent } from "./canonical.js";
export type { CanonicalEventCandidate } from "./canonical.js";
export { explainTokenMissingCondition } from "./status.js";
