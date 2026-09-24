export { createCanonicalTrader } from "./canonical-trader.js";
export type { CanonicalTrader, CanonicalTraderWallet, MonitoringCoverage } from "./canonical-trader.js";
export { normalizeFomoHandle, normalizeWalletAddress, strongestIdentityConfidence } from "./identity.js";
export { decideLifecycleWithReason } from "./lifecycle.js";
export type { LifecycleDecision, LifecycleInput } from "./lifecycle.js";
export type {
  ChainFamily, EntityAccountLinkInput, FomoAccount, FomoAccountInput, IdentityConfidence,
  TraderEntityInput, TraderEvent, TraderEventSource, TraderLifecycle, TraderScoreSnapshot,
  TraderSide, TraderStyle, WalletIdentity, WalletIdentityInput,
} from "./model.js";
export { evaluateBroadcast, OUTCOME_HORIZONS } from "./outcomes.js";
export type { OutcomeBroadcast, OutcomeHorizon, OutcomeObservation, OutcomePricePoint } from "./outcomes.js";
export { addressRadarBroadcastId, addressRadarTokenId, normalizeAddressRadarTokenAddress } from "./rebroadcast.js";
export { classifyTokenLifecycle, signalFamilyForStage } from "./token-lifecycle.js";
export type { AddressSignalFamily, TokenLifecycleStage } from "./token-lifecycle.js";
export { TRADER_OUTCOME_HORIZONS } from "./trader-history.js";
export type {
  MarketObservation, OutcomeCoverageStatus, TraderAbilitySnapshot, TraderAbilityWindow,
  TraderBackfillJob, TraderBackfillStatus, TraderOutcomeHorizon, TraderSampleSourceState,
  TraderSampleStatus, TraderStyleCounts, TraderTokenOutcome, TraderTokenSample,
} from "./trader-history.js";
export { analyzeWalletPositions } from "./wallet-analysis.js";
export type { WalletAnalysisMetrics, WalletAnalysisPosition } from "./wallet-analysis.js";
export { normalizeManualResolutionHandle, normalizeManualWalletMapping } from "./wallet-mapping.js";
export type { ManualWalletMapping } from "./wallet-mapping.js";
