export { aggregateEvidenceWindow } from "./evidence.js";
export type {
  AddressEvidenceSource,
  AddressEvidenceSourceState,
  AddressSignalEvidence,
  AggregatedTraderEvidence,
  TokenAggregationPrevious,
  TokenEvidenceSnapshot,
} from "./evidence.js";
export { createTokenLifecycleResolver } from "./token-lifecycle-resolver.js";
export type { TokenCreationProvider, TokenLaunchProvider, TokenLifecycleResolver } from "./token-lifecycle-resolver.js";
export { createTokenAggregationService, DEGRADED_TRADER_DISCOUNT } from "./service.js";
export type { AggregationDecision } from "./service.js";
export type { SignalTraderProfile, TokenAggregationRepository, TokenAggregationState, TokenEvaluationInput } from "./repository.js";
export { matchCanonicalTraderEvent } from "./canonical.js";
export type { CanonicalEventCandidate } from "./canonical.js";
