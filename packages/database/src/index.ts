export { migrateAddressRadarDatabase } from "./migrations.js";
export type { AddressRadarMigrationOptions } from "./migrations.js";
export { createAutomationJobStore } from "./automation-job-store.js";
export type {
  AutomationQueueMetrics,
  AutomationQueueTypeMetrics,
  AutomationJobInput,
  AutomationQueueSnapshot,
  AutomationJobStore,
  AutomationJobStoreOptions,
} from "./automation-job-store.js";
export {
  ADDRESS_RADAR_BUSY_TIMEOUT_MS,
  ADDRESS_RADAR_WRITE_RETRY_DURATION_MS,
  configureAddressRadarDatabase,
  openAddressRadarDatabase,
  withAddressRadarWriteTransaction,
} from "./connection.js";
export type { WriteTransactionOptions } from "./connection.js";
export { createCandidateEvaluationRequestStore, initializeCandidateEvaluationRequestSchema } from "./candidate-evaluation-request-store.js";
export type { CandidateEvaluationRequest } from "./candidate-evaluation-request-store.js";
export { openAddressRadarRepository } from "./repository.js";
export {
  drainResolvedWalletAutomationOutbox,
  IDENTITY_WALLET_BACKFILL_STRATEGY_VERSION,
  materializeLegacyWalletIdentities,
  reconcileResolvedWalletAutomationJobs,
  recordResolvedWalletAutomation,
} from "./identity-automation.js";
export type { ResolvedWalletAutomationInput } from "./identity-automation.js";
export type {
  AddressEvidenceSource,
  AddressEvidenceSourceState,
  AddressRadarRepository,
  AddressSignalEvidence,
  AutomaticIdentityConflict,
  AutomaticIdentityResolutionCompletion,
  BroadcastRecord,
  CandidateDiscoveryInput,
  CommitTokenBroadcastInput,
  CommitTokenBroadcastResult,
  SignalOutboxRecord,
  LegacySignalOutboxReview,
  CollectorDeadLetter,
  IdentityConflictRecord,
  IdentityResolutionBatchRecord,
  IdentityResolutionCache,
  IdentityResolutionQueueInput,
  IdentityResolutionQueueRecord,
  HistoricalBackfillPartition,
  HistoricalBackfillQueryKind,
  HistoricalBackfillStatus,
  LeaderboardObservationInput,
  LeaderboardWindow,
  MilestoneBackfillCompletion,
  MilestoneBackfillJob,
  MilestoneBackfillSource,
  MilestoneBackfillStatus,
  MilestoneCoverageStatus,
  MilestoneEvaluation,
  SuccessfulAutomaticIdentityResolutionInput,
  TokenAggregationStateRecord,
  TokenEvaluationRecord,
  TokenMilestoneInput,
  TokenMilestoneRecord,
  TraderEntityRecord,
  TraderLifecycleEventRecord,
  TraderPopulationAuditRecord,
  WalletMappingObservationInput,
  WalletAnalysisReviewDecision,
  WalletAnalysisReviewResult,
} from "./repository.js";
export { initializeAddressRadarSchema } from "./schema.js";
export { createCandidateHistoryStore, initializeCandidateHistorySchema } from "./candidate-history-store.js";
export type { CandidateEvidenceWriteResult, CandidateHistoryStore } from "./candidate-history-store.js";
export { createSqliteAddressRadarWritePort } from "./write-port.js";
export type { AddressRadarWritePort } from "./write-port.js";
export { createSourceLedgerStore, initializeSourceLedgerSchema } from "./source-ledger-store.js";
export type {
  RecoveryJobRecord,
  RecoveryJobStatus,
  RecoveryJobType,
  SourceCursorRecord,
  SourceHealthRecord,
  SourceLedgerStore,
} from "./source-ledger-store.js";
export { createTokenFactStore, initializeTokenFactSchema } from "./token-fact-store.js";
export type {
  TokenFactAttempt,
  TokenFactAttemptOutcome,
  TokenFactPrecision,
  TokenFactRecord,
  TokenFactStatus,
  TokenFactStore,
  TokenFactTransition,
  TokenFactType,
} from "./token-fact-store.js";
export { createCanonicalRegistryStore, initializeCanonicalRegistrySchema, SUPPORTED_CHAIN_IDS } from "./canonical-registry-store.js";
export type {
  CanonicalChainId,
  CanonicalChainRecord,
  CanonicalMarketInput,
  CanonicalRegistryStore,
  CanonicalTokenInput,
  ChainFamily,
  MarketType,
} from "./canonical-registry-store.js";
export { createTraderAutomationStore } from "./trader-automation-store.js";
export type {
  TraderAutomationStateInput,
  TraderAutomationStore,
  TraderAutomationSubject,
  TraderAutomationWallet,
  TraderCoverageUpdate,
} from "./trader-automation-store.js";
export {
  createAutomationOutcomeStore,
  initializeAutomationOutcomeSchema,
} from "./automation-outcome-store.js";
export type {
  AutomationJobOutcomeRecord,
  AutomationOutcomeStatus,
  RecordAutomationJobOutcomeInput,
  ReturnTypeOfCreateAutomationOutcomeStore,
} from "./automation-outcome-store.js";
export {
  createRecoveryFactLinkStore,
  initializeRecoveryFactLinkSchema,
} from "./recovery-fact-link-store.js";
export type {
  RecoveryFactLink,
  RecoveryFactLinkStatus,
  ReturnTypeOfCreateRecoveryFactLinkStore,
} from "./recovery-fact-link-store.js";
export {
  createSourceEnrichmentStore,
  initializeSourceEnrichmentSchema,
} from "./source-enrichment-store.js";
export type { SourceObservationEnrichment } from "./source-enrichment-store.js";
export {
  createWalletCoverageStore,
  initializeWalletCoverageSchema,
} from "./wallet-coverage-store.js";
export type { WalletChainCoverage, WalletCoverageStatus } from "./wallet-coverage-store.js";

export { createSharedProviderRequestGate } from "./shared-provider-request-gate.js";
export { resolveObservedMarketSupply } from "./observed-market-supply.js";
export { createFactDemandStore, initializeFactDemandSchema } from "./fact-demand-store.js";
export type { PersistedFactDemand } from "./fact-demand-store.js";
export { readConsumerMarketHistoryRange, resolveConsumerMarketHistoryRequestRange, listUnscheduledConsumerHistoryTokens } from "./consumer-history-recovery.js";
export { listConsumerHistoryWakeupNeeds } from "./consumer-history-recovery.js";
export {
  initializeConsumerHistoryWakeupSchema, consumerHistoryFingerprint,
  recordConsumerHistoryObservation, recordConsumerHistoryDispatch,
} from "./consumer-history-wakeup-store.js";
export { listConsumerHistoryRangeRechecks } from "./consumer-history-recovery.js";
export {
  initializeConsumerHistoryRecoverySchema,hasConsumerHistoryRequestCoverage,reconsiderConsumerHistoryRecovery,
} from "./consumer-history-range-store.js";

export { initializeExecutionRevisionSchema, EXECUTION_REVISION_SCHEMA_SQL, createExecutionRevisionStore, withExecutionRevisionContext, executionRevisionForDemand } from "./execution-revision-store.js";

export { EVENT_PROJECTION_EXECUTION_SCHEMA_SQL, initializeEventProjectionExecutionSchema } from "./event-projection-execution-store.js";

export { CANDIDATE_EXECUTION_AUDIT_SCHEMA_SQL } from "./candidate-history-store.js";
export { TRUSTED_FOMO_ACCOUNT_SQL } from "./identity-trust.js";
