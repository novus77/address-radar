import { randomUUID } from "node:crypto";

import {
  addressRadarBroadcastId,
  addressRadarTokenId,
  normalizeAddressRadarTokenAddress,
  normalizeFomoHandle,
  normalizeWalletAddress,
  strongestIdentityConfidence,
  type AddressSignalFamily,
  type EntityAccountLinkInput,
  type FomoAccount,
  type FomoAccountInput,
  type MarketObservation,
  type OutcomeObservation,
  type TokenLifecycleStage,
  type TraderAbilitySnapshot,
  type TraderAbility,
  type TraderAbilityWindow,
  type TraderBackfillJob,
  type TraderEntityInput,
  type TraderLifecycle,
  type TraderEvent,
  type TraderScoreSnapshot,
  type TraderTokenOutcome,
  type TraderTokenSample,
  type WalletIdentityInput,
} from "@address-radar/domain";
import { matchCanonicalTraderEvent, type BundleDiagnostics, type TokenAggregationRepository, type WalletBundleRelation } from "@address-radar/aggregation";
import type { RuntimeQualityRepository, RuntimeQualitySnapshot } from "@address-radar/observability";
import { migrateAddressRadarDatabase } from "./migrations.js";
import { openAddressRadarDatabase } from "./connection.js";
import { recordResolvedWalletAutomation } from "./identity-automation.js";

export type AddressEvidenceSource = "fomo" | "onchain";
export type AddressEvidenceSourceState = "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN" | "UNKNOWN";
export interface AddressSignalEvidence {
  readonly eventId: string;
  readonly entityId: string;
  readonly contribution: number;
  readonly occurredAt: number;
  readonly source?: AddressEvidenceSource;
  readonly side?: "buy" | "sell";
  readonly amountUsd?: number | null;
  readonly lifecycleStage?: TokenLifecycleStage;
  readonly traderTags?: readonly string[];
  readonly dedupeKey?: string;
}

export type LeaderboardWindow = "24h" | "30d";
export interface LeaderboardObservationInput { readonly accountId: string; readonly window: LeaderboardWindow; readonly rank: number; readonly profitUsd: number | null; readonly observedAt: number }

export interface IdentityResolutionCache {
  readonly handle: string;
  readonly status: "resolved" | "not_observed" | "deferred";
  readonly accountId: string | null;
  readonly expiresAt: number;
  readonly nextAttemptAt: number;
  readonly attemptCount: number;
  readonly payload: string | null;
  readonly updatedAt: number;
}

export interface TokenMilestoneInput { readonly milestoneId: string; readonly chain: string; readonly tokenAddress: string; readonly marketCapUsd: number; readonly reachedAt: number; readonly payload: string }
export interface CandidateDiscoveryInput { readonly discoveryId: string; readonly accountId: string; readonly discoveryType: string; readonly payload: string; readonly discoveredAt: number }
export interface TraderEntityRecord { readonly entityId: string; readonly lifecycle: TraderEntityInput["lifecycle"]; readonly manual: boolean; readonly locked: boolean; readonly createdAt: number; readonly updatedAt: number }
export interface TraderPopulationAuditRecord { readonly current30dAccountIds: readonly string[]; readonly admitToObservation: number; readonly suspend24hOnly: number; readonly genuineCandidates: number; readonly historical24hObservations: number }

export interface TraderLifecycleEventRecord { readonly lifecycleEventId: string; readonly entityId: string; readonly previousState: TraderEntityInput["lifecycle"]; readonly nextState: TraderEntityInput["lifecycle"]; readonly reasons: readonly string[]; readonly strategyVersion: string; readonly occurredAt: number }
export interface TokenAggregationStateRecord { readonly tokenId: string; readonly chain: string; readonly tokenAddress: string; readonly currentScore: number; readonly peakScore: number; readonly broadcastCount: number; readonly updatedAt: number; readonly consumedEvidenceIds: readonly string[]; readonly consumedEconomicKeys: readonly string[] }
export interface TokenEvaluationRecord { readonly tokenId: string; readonly chain: string; readonly tokenAddress: string; readonly action: "observe" | "broadcast" | "rebroadcast"; readonly signalFamily: AddressSignalFamily | null; readonly lifecycleStage: TokenLifecycleStage; readonly score: number; readonly participantCount: number; readonly totalBuyUsd: number; readonly sourceState: AddressEvidenceSourceState; readonly windowMs: number; readonly missingConditions: readonly string[]; readonly bundleDiagnostics?: BundleDiagnostics; readonly updatedAt: number }
export interface BroadcastRecord { readonly broadcastId: string; readonly tokenId: string; readonly broadcastNumber: number; readonly strategyVersion: string; readonly score: number; readonly triggeredAt: number; readonly payload: unknown }
export interface CommitTokenBroadcastInput { readonly chain: string; readonly tokenAddress: string; readonly expectedPreviousBroadcastCount: number; readonly strategyVersion: string; readonly score: number; readonly triggeredAt: number; readonly evidenceIds: readonly string[]; readonly economicKeys: readonly string[]; readonly evaluation: Omit<TokenEvaluationRecord, "tokenId">; readonly payload: unknown; readonly publicSignal: unknown }
export interface CommitTokenBroadcastResult { readonly inserted: boolean; readonly broadcastNumber: number }
export interface SignalOutboxRecord { readonly outboxId: string; readonly broadcastId: string; readonly tokenId: string; readonly broadcastSequence: number; readonly payload: unknown; readonly status: "pending" | "processing" | "delivered"; readonly attemptCount: number; readonly nextRetryAt: number; readonly lastError: string | null; readonly claimedBy: string | null; readonly claimedAt: number | null; readonly claimToken: string | null; readonly claimGeneration: number; readonly leaseExpiresAt: number | null; readonly deliveredAt: number | null; readonly createdAt: number }
export interface LegacySignalOutboxReview { readonly reviewId: string; readonly broadcastId: string; readonly tokenId: string; readonly broadcastSequence: number; readonly idempotencyKey: string; readonly payload: unknown; readonly status: "legacy_review" | "approved" | "dead_letter"; readonly validationStatus: "valid" | "legacy_unreplayable" | "invalid"; readonly reason: string; readonly createdAt: number; readonly reviewedAt: number | null; readonly decision: "approved" | "skipped" | null; readonly decidedBy: string | null; readonly decisionReason: string | null; readonly decidedAt: number | null }
export interface CollectorDeadLetter { readonly deadLetterId: string; readonly sourcePath: string; readonly byteOffset: number; readonly contentHash: string; readonly error: string; readonly rawPayload: string; readonly recordedAt: number }
export interface IdentityResolutionQueueInput { readonly handle: string; readonly accountId: string; readonly priority: number; readonly reason: string; readonly observedAt: number }
export interface IdentityResolutionQueueRecord { readonly handle: string; readonly accountId: string; readonly priority: number; readonly reasons: readonly string[]; readonly status: "pending" | "exported" | "resolved" | "not_found" | "conflict"; readonly firstSeenAt: number; readonly lastSeenAt: number; readonly nextExportAt: number; readonly lastBatchId: string | null; readonly resolvedAt: number | null }
export interface IdentityResolutionBatchRecord { readonly batchId: string; readonly createdAt: number; readonly maxSize: number; readonly status: "exported" | "partially_imported" | "imported"; readonly importedAt: number | null; readonly items: readonly IdentityResolutionQueueRecord[] }
export interface WalletMappingObservationInput { readonly observationId: string; readonly importId: string; readonly batchId: string | null; readonly handle: string; readonly accountId: string; readonly chainFamily: "solana" | "evm"; readonly address: string; readonly provider: string; readonly observedAt: number; readonly importedAt: number }
export interface IdentityConflictRecord { readonly conflictId: string; readonly handle: string; readonly accountId: string; readonly chainFamily: "solana" | "evm"; readonly address: string; readonly conflictingAccountId: string; readonly status: "pending" | "accepted" | "rejected"; readonly payload: unknown; readonly createdAt: number; readonly resolvedAt: number | null; readonly resolution: string | null }
export interface SuccessfulAutomaticIdentityResolutionInput { readonly account: FomoAccountInput; readonly wallets: readonly WalletIdentityInput[]; readonly cache: IdentityResolutionCache; readonly occurredAt: number }
export interface AutomaticIdentityConflict { readonly conflictId: string; readonly chainFamily: "solana" | "evm"; readonly address: string; readonly conflictingAccountId: string }
export type AutomaticIdentityResolutionCompletion =
  | { readonly kind: "completed"; readonly entityId: string | null }
  | { readonly kind: "conflict"; readonly conflicts: readonly AutomaticIdentityConflict[] };
export type WalletAnalysisReviewDecision =
  | { readonly decision: "accept"; readonly analysisId: string; readonly entityId: string; readonly reviewedAt: number; readonly account?: { readonly accountId: string; readonly handle: string } }
  | { readonly decision: "reject"; readonly analysisId: string; readonly reviewedAt: number };
export type WalletAnalysisReviewResult =
  | { readonly status: "accepted"; readonly entityId: string }
  | { readonly status: "rejected" }
  | { readonly status: "conflict"; readonly conflictingEntityId: string; readonly conflictingAccountId?: string };

export interface AddressRadarRepository extends TokenAggregationRepository, RuntimeQualityRepository {
  upsertFomoAccount(input: FomoAccountInput): void;
  attachWallet(input: WalletIdentityInput): void;
  account(accountId: string): FomoAccount | null;
  accountByHandle(handle: string): FomoAccount | null;
  entityForAccount(accountId: string): string | null;
  upsertTraderEntity(input: TraderEntityInput): void;
  ensureTraderEntity(input: TraderEntityInput): void;
  admitHistoricalWalletCandidate(input: { readonly traderId: string; readonly chain: string; readonly address: string; readonly observedAt: number; readonly strategyVersion: string }): void;
  admitManualTrader(input: {
    readonly entityId: string;
    readonly displayName: string;
    readonly wallets: readonly { readonly family: "solana" | "evm"; readonly address: string }[];
    readonly abilities: readonly TraderAbility[];
    readonly observedAt: number;
  }): void;
  admitLeaderboardTrader(input: { readonly entityId: string; readonly accountId: string; readonly observedAt: number }): void;
  traderPopulationAudit(): TraderPopulationAuditRecord;
  reconcileLeaderboardPopulation(input: { readonly current30dAccountIds: readonly string[]; readonly observedAt: number }): { readonly admitted: number; readonly suspended: number };
  linkAccountToEntity(input: EntityAccountLinkInput): void;
  insertTraderEvent(event: TraderEvent): { readonly inserted: boolean };
  eventsForEntity(entityId: string): readonly TraderEvent[];
  eventsForToken(chain: string, tokenAddress: string): readonly TraderEvent[];
  traderEntity(entityId: string): TraderEntityRecord | null;
  traderEntityIdsWithEvents(): readonly string[];
  identityResolution(handle: string): IdentityResolutionCache | null;
  saveIdentityResolution(input: IdentityResolutionCache): void;
  recordLeaderboardObservation(input: LeaderboardObservationInput): void;
  leaderboardWindows(accountId: string): readonly LeaderboardWindow[];
  saveTraderScoreSnapshot(snapshot: TraderScoreSnapshot, styles: Readonly<Record<string, number>>): void;
  latestTraderScore(entityId: string, window: TraderScoreSnapshot["window"]): TraderScoreSnapshot | null;
  recordLifecycleEvent(event: TraderLifecycleEventRecord): void;
  lifecycleEvents(entityId: string): readonly TraderLifecycleEventRecord[];
  updateTraderLifecycle(entityId: string, lifecycle: TraderEntityInput["lifecycle"], updatedAt: number): void;
  upsertTraderTokenSample(sample: TraderTokenSample): void;
  traderTokenSample(entityId: string, chain: string, tokenAddress: string): TraderTokenSample | null;
  traderTokenSamples(entityId: string, since?: number): readonly TraderTokenSample[];
  saveMarketObservation(chain: string, tokenAddress: string, observation: MarketObservation): void;
  marketObservations(chain: string, tokenAddress: string, from: number, to: number): readonly MarketObservation[];
  saveTraderTokenOutcome(outcome: TraderTokenOutcome): void;
  traderTokenOutcomes(sampleId: string): readonly TraderTokenOutcome[];
  maturePendingOutcomes(now: number, limit: number): readonly TraderTokenOutcome[];
  saveTraderAbilitySnapshot(snapshot: TraderAbilitySnapshot): void;
  latestTraderAbility(entityId: string, window: TraderAbilityWindow): TraderAbilitySnapshot | null;
  enqueueTraderBackfill(job: TraderBackfillJob): void;
  claimTraderBackfill(now: number): TraderBackfillJob | null;
  completeTraderBackfill(jobId: string, coverage: Readonly<Record<string, number>>, completedAt: number): void;
  failTraderBackfill(jobId: string, error: string, cursor: string | null, nextAttemptAt: number): void;
  recordTokenMilestone(input: TokenMilestoneInput): { readonly inserted: boolean };
  tokenMilestones(): readonly TokenMilestoneRecord[];
  milestonesForToken(chain: string, tokenAddress: string): readonly TokenMilestoneRecord[];
  enqueueMilestoneBackfill(job: MilestoneBackfillJob): { readonly inserted: boolean };
  claimMilestoneBackfill(now: number): MilestoneBackfillJob | null;
  completeMilestoneBackfill(jobId: string, result: MilestoneBackfillCompletion): void;
  failMilestoneBackfill(jobId: string, error: string, cursor: string | null, nextAttemptAt: number, unavailable: boolean): void;
  milestoneBackfillJobs(): readonly MilestoneBackfillJob[];
  saveMilestoneEvaluation(evaluation: MilestoneEvaluation): void;
  latestMilestoneEvaluation(milestoneId: string): MilestoneEvaluation | null;
  enqueueHistoricalBackfillPartition(partition: HistoricalBackfillPartition): { readonly inserted: boolean };
  claimHistoricalBackfillPartition(now: number, leaseMs: number): HistoricalBackfillPartition | null;
  checkpointHistoricalBackfillPartition(partitionId: string, input: { readonly executionId: string; readonly nextOffset: number; readonly rowCount: number; readonly watermark: number; readonly updatedAt: number }): void;
  completeHistoricalBackfillPartition(partitionId: string, input: { readonly executionId: string; readonly rowCount: number; readonly watermark: number; readonly completedAt: number }): void;
  failHistoricalBackfillPartition(partitionId: string, error: string, nextRetryAt: number): void;
  historicalBackfillPartitions(): readonly HistoricalBackfillPartition[];
  recordHistoricalCreditUsage(usageDay: string, creditsUsed: number, updatedAt: number): void;
  historicalCreditsUsed(usageDay: string): number;
  advanceHistoricalWatermark(chain: string, queryKind: HistoricalBackfillQueryKind, watermark: number, updatedAt: number): void;
  historicalWatermark(chain: string, queryKind: HistoricalBackfillQueryKind): number | null;
  saveCandidateDiscovery(input: CandidateDiscoveryInput): void;
  activateDiscoveredCandidate(accountId: string, updatedAt: number): string | null;
  candidateDiscoveries(accountId: string): readonly CandidateDiscoveryInput[];
  candidateDiscoveriesForEntity(entityId: string): readonly CandidateDiscoveryInput[];
  saveAddressSignalEvidence(chain: string, tokenAddress: string, evidence: AddressSignalEvidence): void;
  addressSignalEvidenceForToken(chain: string, tokenAddress: string, since: number): readonly AddressSignalEvidence[];
  saveTokenEvaluation(input: Omit<TokenEvaluationRecord, "tokenId">): void;
  tokenEvaluationState(chain: string, tokenAddress: string): TokenEvaluationRecord | null;
  tokenAggregationState(chain: string, tokenAddress: string): TokenAggregationStateRecord | null;
  commitTokenBroadcast(input: CommitTokenBroadcastInput): CommitTokenBroadcastResult;
  broadcasts(tokenId: string): readonly BroadcastRecord[];
  pendingSignalOutbox(): readonly SignalOutboxRecord[];
  claimSignalOutbox(input: { readonly workerId: string; readonly now: number; readonly leaseMs: number }): SignalOutboxRecord | null;
  markSignalOutboxDelivered(input: { readonly outboxId: string; readonly claimToken: string; readonly deliveredAt: number }): boolean;
  failSignalOutbox(input: { readonly outboxId: string; readonly claimToken: string; readonly nextRetryAt: number; readonly error: string }): boolean;
  deadLetterSignalOutbox(input: { readonly outboxId: string; readonly claimToken: string; readonly error: string }): boolean;
  legacySignalOutboxReviews(): readonly LegacySignalOutboxReview[];
  approveLegacySignalOutbox(input: { readonly reviewId: string; readonly operator: string; readonly reason: string; readonly decidedAt: number }): boolean;
  skipLegacySignalOutbox(input: { readonly reviewId: string; readonly operator: string; readonly reason: string; readonly decidedAt: number }): boolean;
  recordCollectorDeadLetter(input: CollectorDeadLetter): boolean;
  collectorDeadLetters(sourcePath: string): readonly CollectorDeadLetter[];
  saveOutcomeObservation(observation: OutcomeObservation, observedAt: number): void;
  outcomesForBroadcast(broadcastId: string): readonly OutcomeObservation[];
  enqueueIdentityResolution(input: IdentityResolutionQueueInput): void;
  backfillUnresolvedIdentities(): number;
  reconcileAutomaticIdentityResolutions(currentLeaderboardAccountIds: readonly string[]): number;
  identityResolutionQueue(limit: number): readonly IdentityResolutionQueueRecord[];
  pendingIdentityResolutions(now: number, limit: number): readonly IdentityResolutionQueueRecord[];
  createIdentityResolutionBatch(input: { readonly batchId: string; readonly createdAt: number; readonly maxSize: number; readonly cooldownMs: number }): IdentityResolutionBatchRecord;
  identityResolutionBatch(batchId: string): IdentityResolutionBatchRecord | null;
  walletOwner(chainFamily: "solana" | "evm", address: string): string | null;
  saveWalletMappingObservation(input: WalletMappingObservationInput): void;
  markIdentityResolution(handle: string, status: "resolved" | "not_found" | "conflict", occurredAt: number): void;
  completeIdentityResolution(handle: string, accountId: string, occurredAt: number): string | null;
  completeAutomaticIdentityResolution(input: SuccessfulAutomaticIdentityResolutionInput): AutomaticIdentityResolutionCompletion;
  reconcileIdentityResolution(handle: string, accountId: string, occurredAt: number): string | null;
  completeIdentityAdmission(accountId: string, occurredAt: number): string | null;
  markIdentityResolutionBatch(batchId: string, status: "partially_imported" | "imported", importedAt: number): void;
  createIdentityConflict(input: IdentityConflictRecord): void;
  identityConflicts(status?: IdentityConflictRecord["status"]): readonly IdentityConflictRecord[];
  resolveIdentityConflict(input: { readonly conflictId: string; readonly decision: "accepted" | "rejected"; readonly resolution: string; readonly occurredAt: number }): IdentityConflictRecord | null;
  reviewWalletAnalysisDecision(input: WalletAnalysisReviewDecision): WalletAnalysisReviewResult;
  recordOperatorAudit(input: { readonly auditId: string; readonly action: string; readonly actor: string; readonly payload: unknown; readonly occurredAt: number }): void;
  runInTransaction<T>(operation: () => T): T;
  close(): void;
}

const parseStoredPayload = (payload: string): unknown => {
  try { return JSON.parse(payload) as unknown; } catch { return payload; }
};

const hasUndecidedEarlierReview = (database: DatabaseSync, tokenId: string, broadcastSequence: number): boolean => Boolean(
  database.prepare("SELECT 1 FROM signal_outbox_migration_review WHERE token_id = ? AND broadcast_sequence < ? AND decision IS NULL LIMIT 1").get(tokenId, broadcastSequence),
);

const toSignalOutboxRecord = (row: Record<string, unknown>): SignalOutboxRecord => Object.freeze({
  outboxId: row.outbox_id as string,
  broadcastId: row.broadcast_id as string,
  tokenId: row.token_id as string,
  broadcastSequence: row.broadcast_sequence as number,
  payload: parseStoredPayload(row.payload as string),
  status: row.status as SignalOutboxRecord["status"],
  attemptCount: row.attempt_count as number,
  nextRetryAt: row.next_retry_at as number,
  lastError: row.last_error as string | null,
  claimedBy: row.claimed_by as string | null,
  claimedAt: row.claimed_at as number | null,
  claimToken: row.claim_token as string | null,
  claimGeneration: row.claim_generation as number,
  leaseExpiresAt: row.lease_expires_at as number | null,
  deliveredAt: row.delivered_at as number | null,
  createdAt: row.created_at as number,
});

export function openAddressRadarRepository(databasePath: string): AddressRadarRepository {
  const database = openAddressRadarDatabase(databasePath);
  migrateAddressRadarDatabase(database);

  const transaction = <T>(operation: () => T): T => {
    if (database.isTransaction) return operation();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const markIdentityResolutionInTransaction = (
    handle: string,
    status: "resolved" | "not_found" | "conflict",
    occurredAt: number,
  ): void => {
    database.prepare(`
      UPDATE identity_resolution_queue SET status = ?, resolved_at = ?, next_export_at = ? WHERE handle = ?
    `).run(status, status === "resolved" ? occurredAt : null, status === "resolved" ? occurredAt : occurredAt + 12 * 60 * 60_000, normalizeFomoHandle(handle));
  };

  const synchronizeTraderSignalProfile = (entityId: string, updatedAt: number): void => {
    const facts = database.prepare(`
      SELECT e.lifecycle,
        EXISTS(SELECT 1 FROM trader_ability_snapshots a WHERE a.entity_id = e.entity_id) AS hasAbility,
        (EXISTS(SELECT 1 FROM entity_accounts ea WHERE ea.entity_id = e.entity_id AND ea.confidence = 'confirmed')
          OR EXISTS(SELECT 1 FROM entity_wallet_identities ew WHERE ew.entity_id = e.entity_id AND ew.confidence = 'confirmed')) AS mapped,
        EXISTS(
          SELECT 1 FROM entity_accounts ea JOIN wallet_identities w ON w.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id AND ea.confidence = 'confirmed' AND w.confidence = 'confirmed'
        ) OR EXISTS(
          SELECT 1 FROM entity_wallet_identities ew
          WHERE ew.entity_id = e.entity_id AND ew.confidence = 'confirmed'
        ) AS hasWallet
      FROM trader_entities e WHERE e.entity_id = ?
    `).get(entityId) as { lifecycle: TraderLifecycle; hasAbility: number; mapped: number; hasWallet: number } | undefined;
    if (!facts) return;
    const monitoringEnabled = facts.hasAbility === 1 && facts.mapped === 1 && ["active", "elite", "degraded"].includes(facts.lifecycle);
    const next = { monitoringEnabled, fomoMonitoringEnabled: monitoringEnabled, onchainMonitoringEnabled: monitoringEnabled && facts.hasWallet === 1 };
    const current = database.prepare("SELECT monitoring_enabled AS monitoringEnabled, fomo_monitoring_enabled AS fomoMonitoringEnabled, onchain_monitoring_enabled AS onchainMonitoringEnabled FROM trader_profiles WHERE entity_id = ?").get(entityId) as { monitoringEnabled: number; fomoMonitoringEnabled: number; onchainMonitoringEnabled: number } | undefined;
    if (current && current.monitoringEnabled === Number(next.monitoringEnabled) && current.fomoMonitoringEnabled === Number(next.fomoMonitoringEnabled) && current.onchainMonitoringEnabled === Number(next.onchainMonitoringEnabled)) return;
    database.prepare(`
      INSERT INTO trader_profiles(entity_id, display_name, priority, notes, monitoring_enabled, fomo_monitoring_enabled, onchain_monitoring_enabled, created_at, updated_at)
      VALUES (?, ?, 'normal', NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET monitoring_enabled = excluded.monitoring_enabled,
        fomo_monitoring_enabled = excluded.fomo_monitoring_enabled,
        onchain_monitoring_enabled = excluded.onchain_monitoring_enabled,
        updated_at = MAX(trader_profiles.updated_at, excluded.updated_at)
    `).run(entityId, entityId, Number(next.monitoringEnabled), Number(next.fomoMonitoringEnabled), Number(next.onchainMonitoringEnabled), updatedAt, updatedAt);
  };

  const completeIdentityAdmissionInTransaction = (accountId: string, occurredAt: number): string | null => {
    const entity = database.prepare(`
      SELECT e.entity_id AS entityId, e.lifecycle
      FROM trader_entities e
      JOIN entity_accounts ea ON ea.entity_id = e.entity_id
      WHERE ea.account_id = ?
      ORDER BY ea.last_observed_at DESC
      LIMIT 1
    `).get(accountId) as { entityId: string; lifecycle: TraderEntityInput["lifecycle"] } | undefined;
    if (!entity) return null;
    const walletCount = Number((database.prepare("SELECT COUNT(*) AS count FROM wallet_identities WHERE account_id = ?").get(accountId) as { count: number }).count);
    if (walletCount === 0) return null;
    const nextLifecycle = entity.lifecycle === "candidate" || entity.lifecycle === "suspended" ? "probation" : entity.lifecycle;
        if (nextLifecycle !== entity.lifecycle) {
      database.prepare("UPDATE trader_entities SET lifecycle = ?, updated_at = ? WHERE entity_id = ?").run(nextLifecycle, occurredAt, entity.entityId);
      database.prepare(`
        INSERT OR IGNORE INTO trader_lifecycle_events(
          lifecycle_event_id, entity_id, previous_state, next_state, reasons, strategy_version, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`identity-admission:${entity.entityId}:${occurredAt}`, entity.entityId, entity.lifecycle, nextLifecycle, JSON.stringify(["identity_resolved"]), "identity-admission-v1", occurredAt);
        }
    const wallets = database.prepare(`
      SELECT chain_family AS chainFamily, address
      FROM wallet_identities
      WHERE account_id = ?
      ORDER BY chain_family, address
    `).all(accountId) as Array<{ chainFamily: "solana" | "evm"; address: string }>;
    for (const wallet of wallets) {
      recordResolvedWalletAutomation(database, {
        traderId: entity.entityId,
        accountId,
        chainFamily: wallet.chainFamily,
        address: wallet.address,
        occurredAt,
      });
    }
    synchronizeTraderSignalProfile(entity.entityId, occurredAt);
    return entity.entityId;
  };

  const admitDirectEntityWalletInTransaction = (entityId: string, chainFamily: "solana" | "evm", rawAddress: string, occurredAt: number): void => {
    const address = normalizeWalletAddress(chainFamily, rawAddress);
    const entity = database.prepare("SELECT lifecycle FROM trader_entities WHERE entity_id = ?").get(entityId) as { lifecycle: TraderEntityInput["lifecycle"] } | undefined;
    if (!entity) throw new Error(`Trader entity not found: ${entityId}`);
    database.prepare(`
      INSERT INTO entity_wallet_identities(entity_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
      VALUES (?, ?, ?, 'confirmed', 'wallet_analysis_review', ?, ?)
      ON CONFLICT(entity_id, chain_family, address) DO UPDATE SET
        confidence = 'confirmed', source = excluded.source,
        last_observed_at = MAX(entity_wallet_identities.last_observed_at, excluded.last_observed_at)
    `).run(entityId, chainFamily, address, occurredAt, occurredAt);
    const nextLifecycle = entity.lifecycle === "candidate" || entity.lifecycle === "suspended" ? "probation" : entity.lifecycle;
    if (nextLifecycle !== entity.lifecycle) {
      database.prepare("UPDATE trader_entities SET lifecycle = ?, updated_at = ? WHERE entity_id = ?").run(nextLifecycle, occurredAt, entityId);
      database.prepare(`
        INSERT OR IGNORE INTO trader_lifecycle_events(
          lifecycle_event_id, entity_id, previous_state, next_state, reasons, strategy_version, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(`wallet-admission:${entityId}:${occurredAt}`, entityId, entity.lifecycle, nextLifecycle, JSON.stringify(["wallet_identity_confirmed"]), "wallet-analysis-review-v1", occurredAt);
    }
    synchronizeTraderSignalProfile(entityId, occurredAt);
    recordResolvedWalletAutomation(database, {
      traderId: entityId,
      accountId: entityId,
      chainFamily,
      address,
      occurredAt,
    });
  };

  const completeIdentityResolutionInTransaction = (handle: string, accountId: string, occurredAt: number): string | null => {
    const normalizedHandle = normalizeFomoHandle(handle);
    const queued = database.prepare(`
      SELECT account_id AS accountId, status
      FROM identity_resolution_queue
      WHERE handle = ?
    `).get(normalizedHandle) as { accountId: string; status: IdentityResolutionQueueRecord["status"] } | undefined;
    if (!queued) throw new Error(`Identity resolution queue entry not found for ${normalizedHandle}`);
    if (queued.accountId !== accountId) throw new Error(`Identity resolution account mismatch for ${normalizedHandle}`);

    const updated = database.prepare(`
      UPDATE identity_resolution_queue
      SET status = 'resolved', resolved_at = ?, next_export_at = ?
      WHERE handle = ? AND account_id = ?
    `).run(occurredAt, occurredAt, normalizedHandle, accountId);
    if (updated.changes !== 1) throw new Error(`Identity resolution queue update failed for ${normalizedHandle}`);

    return completeIdentityAdmissionInTransaction(accountId, occurredAt);
  };

  const repository: AddressRadarRepository = {
    upsertFomoAccount(input) {
      assertId(input.accountId, "accountId");
      const handle = normalizeFomoHandle(input.handle);
      assertTimestamp(input.firstSeenAt, "firstSeenAt");
      assertTimestamp(input.lastSeenAt, "lastSeenAt");
      if (input.lastSeenAt < input.firstSeenAt) throw new Error("lastSeenAt must not precede firstSeenAt");
      database.prepare(`
        INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          handle = excluded.handle,
          first_seen_at = MIN(fomo_accounts.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(fomo_accounts.last_seen_at, excluded.last_seen_at)
      `).run(input.accountId, handle, input.firstSeenAt, input.lastSeenAt);
    },

    attachWallet(input) {
      assertId(input.accountId, "accountId");
      assertTimestamp(input.observedAt, "observedAt");
      const address = normalizeWalletAddress(input.chainFamily, input.address);
      const existing = database.prepare(`
        SELECT confidence, first_observed_at
        FROM wallet_identities
        WHERE account_id = ? AND chain_family = ? AND address = ?
      `).get(input.accountId, input.chainFamily, address) as { confidence: WalletIdentityInput["confidence"]; first_observed_at: number } | undefined;
      const confidence = existing ? strongestIdentityConfidence(existing.confidence, input.confidence) : input.confidence;
      database.prepare(`
        INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, chain_family, address) DO UPDATE SET
          confidence = excluded.confidence,
          source = excluded.source,
          last_observed_at = MAX(wallet_identities.last_observed_at, excluded.last_observed_at)
      `).run(input.accountId, input.chainFamily, address, confidence, input.source, existing?.first_observed_at ?? input.observedAt, input.observedAt);
      const entities = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ?").all(input.accountId) as Array<{ entityId: string }>;
      for (const entity of entities) {
        database.prepare(`
          INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at)
          VALUES (?, 'realtime', ?)
          ON CONFLICT(trader_id) DO UPDATE SET
            policy = 'realtime', updated_at = excluded.updated_at
          WHERE trader_monitoring_policy.policy != 'off'
        `).run(entity.entityId, input.observedAt);
        database.prepare(`
          INSERT INTO trader_coverage_state(
            trader_id, tier, coverage_state, last_covered_at,
            next_evaluation_at, strategy_version, updated_at
          ) VALUES (?, 'T2', 'queued', NULL, ?, 'trader-automation-v1', ?)
          ON CONFLICT(trader_id) DO UPDATE SET
            tier = CASE WHEN trader_coverage_state.tier = 'T3' THEN 'T2' ELSE trader_coverage_state.tier END,
            coverage_state = CASE WHEN trader_coverage_state.coverage_state = 'unseen' THEN 'queued' ELSE trader_coverage_state.coverage_state END,
            next_evaluation_at = MIN(trader_coverage_state.next_evaluation_at, excluded.next_evaluation_at),
            updated_at = MAX(trader_coverage_state.updated_at, excluded.updated_at)
        `).run(entity.entityId, input.observedAt, input.observedAt);
        synchronizeTraderSignalProfile(entity.entityId, input.observedAt);
      }
    },

    account(accountId) {
      const row = database.prepare("SELECT * FROM fomo_accounts WHERE account_id = ?").get(accountId) as AccountRow | undefined;
      if (!row) return null;
      const wallets = (database.prepare("SELECT * FROM wallet_identities WHERE account_id = ? ORDER BY first_observed_at, CASE chain_family WHEN 'solana' THEN 0 ELSE 1 END, address").all(accountId) as WalletRow[]).map(wallet => Object.freeze({
        accountId: wallet.account_id,
        chainFamily: wallet.chain_family,
        address: wallet.address,
        confidence: wallet.confidence,
        source: wallet.source,
        observedAt: wallet.last_observed_at,
        firstObservedAt: wallet.first_observed_at,
        lastObservedAt: wallet.last_observed_at,
      }));
      return Object.freeze({ accountId: row.account_id, handle: row.handle, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, wallets: Object.freeze(wallets) });
    },

    accountByHandle(handle) {
      const normalized = normalizeFomoHandle(handle);
      const row = database.prepare("SELECT account_id AS accountId FROM fomo_accounts WHERE handle = ? COLLATE NOCASE").get(normalized) as { accountId: string } | undefined;
      return row ? repository.account(row.accountId) : null;
    },

    entityForAccount(accountId) {
      const row = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? ORDER BY last_observed_at DESC LIMIT 1").get(accountId) as { entityId: string } | undefined;
      return row?.entityId ?? null;
    },

    upsertTraderEntity(input) {
      assertId(input.entityId, "entityId");
      assertTimestamp(input.createdAt, "createdAt");
      assertTimestamp(input.updatedAt, "updatedAt");
      database.prepare(`
        INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          lifecycle = excluded.lifecycle,
          manual = excluded.manual,
          locked = excluded.locked,
          updated_at = MAX(trader_entities.updated_at, excluded.updated_at)
      `).run(input.entityId, input.lifecycle, Number(input.manual), Number(input.locked), input.createdAt, input.updatedAt);
      synchronizeTraderSignalProfile(input.entityId, input.updatedAt);
    },

    ensureTraderEntity(input) {
      assertId(input.entityId, "entityId");
      assertTimestamp(input.createdAt, "createdAt");
      assertTimestamp(input.updatedAt, "updatedAt");
      database.prepare(`
        INSERT OR IGNORE INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.entityId, input.lifecycle, Number(input.manual), Number(input.locked), input.createdAt, input.updatedAt);
    },

    admitHistoricalWalletCandidate(input) {
      assertId(input.traderId, "traderId");
      assertTimestamp(input.observedAt, "observedAt");
      const chain = input.chain.trim().toLowerCase();
      const chainFamily = chain === "solana" ? "solana" : "evm";
      const address = normalizeWalletAddress(chainFamily, input.address);
      transaction(() => {
        database.prepare(`
          INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
          VALUES (?, 'candidate', 0, 0, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET updated_at = MAX(trader_entities.updated_at, excluded.updated_at)
        `).run(input.traderId, input.observedAt, input.observedAt);
        database.prepare(`
          INSERT INTO entity_wallet_identities(entity_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
          VALUES (?, ?, ?, 'high', 'historical_milestone', ?, ?)
          ON CONFLICT(entity_id, chain_family, address) DO UPDATE SET
            confidence = 'high', source = 'historical_milestone',
            last_observed_at = MAX(entity_wallet_identities.last_observed_at, excluded.last_observed_at)
        `).run(input.traderId, chainFamily, address, input.observedAt, input.observedAt);
        database.prepare(`
          INSERT INTO trader_sources(entity_id, source_key, first_observed_at, last_observed_at, payload)
          VALUES (?, 'milestone', ?, ?, ?)
          ON CONFLICT(entity_id, source_key) DO UPDATE SET
            last_observed_at = MAX(trader_sources.last_observed_at, excluded.last_observed_at),
            payload = excluded.payload
        `).run(input.traderId, input.observedAt, input.observedAt, JSON.stringify({ chain, strategyVersion: input.strategyVersion }));
        database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, 'source', 'source.milestone_discovery', ?)").run(input.traderId, input.observedAt);
        recordResolvedWalletAutomation(database, { traderId: input.traderId, accountId: input.traderId, chainFamily, address, occurredAt: input.observedAt });
        database.prepare(`
          INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at)
          VALUES (?, 'periodic', ?)
          ON CONFLICT(trader_id) DO UPDATE SET
            policy = CASE WHEN trader_monitoring_policy.policy = 'off' THEN 'off' ELSE 'periodic' END,
            updated_at = MAX(trader_monitoring_policy.updated_at, excluded.updated_at)
        `).run(input.traderId, input.observedAt);
        database.prepare(`
          INSERT INTO trader_coverage_state(trader_id, tier, coverage_state, last_covered_at, next_evaluation_at, strategy_version, updated_at)
          VALUES (?, 'T2', 'queued', NULL, ?, ?, ?)
          ON CONFLICT(trader_id) DO UPDATE SET
            next_evaluation_at = MIN(trader_coverage_state.next_evaluation_at, excluded.next_evaluation_at),
            strategy_version = excluded.strategy_version,
            updated_at = MAX(trader_coverage_state.updated_at, excluded.updated_at)
        `).run(input.traderId, input.observedAt, input.strategyVersion, input.observedAt);
      });
    },

    admitManualTrader(input) {
      assertId(input.entityId, "entityId");
      assertTimestamp(input.observedAt, "observedAt");
      const displayName = input.displayName.trim();
      if (!displayName || displayName.length > 128) throw new Error("displayName must be non-empty and at most 128 characters");
      if (input.wallets.length === 0) throw new Error("At least one wallet is required");
      transaction(() => {
        database.prepare(`
          INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
          VALUES (?, 'probation', 1, 1, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET
            lifecycle = CASE WHEN trader_entities.lifecycle IN ('candidate', 'suspended') THEN 'probation' ELSE trader_entities.lifecycle END,
            manual = 1,
            locked = 1,
            updated_at = MAX(trader_entities.updated_at, excluded.updated_at)
        `).run(input.entityId, input.observedAt, input.observedAt);
        database.prepare(`
          INSERT INTO trader_profiles(entity_id, display_name, priority, notes, monitoring_enabled, fomo_monitoring_enabled, onchain_monitoring_enabled, created_at, updated_at)
          VALUES (?, ?, 'important', NULL, 1, 0, 1, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET
            display_name = excluded.display_name,
            priority = 'important',
            monitoring_enabled = 1,
            onchain_monitoring_enabled = 1,
            updated_at = MAX(trader_profiles.updated_at, excluded.updated_at)
        `).run(input.entityId, displayName, input.observedAt, input.observedAt);
        database.prepare(`
          INSERT INTO trader_sources(entity_id, source_key, first_observed_at, last_observed_at, payload)
          VALUES (?, 'manual', ?, ?, '{}')
          ON CONFLICT(entity_id, source_key) DO UPDATE SET
            last_observed_at = MAX(trader_sources.last_observed_at, excluded.last_observed_at)
        `).run(input.entityId, input.observedAt, input.observedAt);
        database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, 'source', 'source.manual', ?)")
          .run(input.entityId, input.observedAt);
        for (const ability of new Set(input.abilities)) {
          database.prepare(`
            INSERT INTO trader_abilities(entity_id, ability_key, confidence, sample_count, evidence_window, assigned_at, last_evaluated_at)
            VALUES (?, ?, 1, 0, 'manual', ?, ?)
            ON CONFLICT(entity_id, ability_key, evidence_window) DO UPDATE SET
              confidence = 1,
              last_evaluated_at = MAX(trader_abilities.last_evaluated_at, excluded.last_evaluated_at)
          `).run(input.entityId, ability, input.observedAt, input.observedAt);
        }
        for (const wallet of input.wallets) admitDirectEntityWalletInTransaction(input.entityId, wallet.family, wallet.address, input.observedAt);
        database.prepare(`
          INSERT OR IGNORE INTO trader_lifecycle_audit(audit_id, entity_id, from_state, to_state, reason_code, reason_text, actor, occurred_at)
          VALUES (?, ?, 'unresolved', 'observing', 'manual_wallet_added', '手动添加的钱包已进入观察', 'developer', ?)
        `).run(`manual-admission:${input.entityId}:${input.observedAt}`, input.entityId, input.observedAt);
        repository.recordOperatorAudit({
          auditId: `manual-trader:${input.entityId}:${input.observedAt}`,
          action: "identity.manual_trader_created",
          actor: "developer",
          payload: { entityId: input.entityId, walletCount: input.wallets.length, abilities: input.abilities },
          occurredAt: input.observedAt,
        });
      });
    },

    admitLeaderboardTrader(input) {
      assertId(input.entityId, "entityId");
      assertId(input.accountId, "accountId");
      assertTimestamp(input.observedAt, "observedAt");
      const existingOwner = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ?").get(input.accountId) as { entityId: string } | undefined;
      if (existingOwner && existingOwner.entityId !== input.entityId) throw new Error(`Entity account conflict: ${input.accountId} is already linked to ${existingOwner.entityId}`);
      transaction(() => {
        database.prepare(`
          INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
          VALUES (?, 'probation', 0, 0, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET
            lifecycle = CASE
              WHEN trader_entities.lifecycle IN ('candidate', 'suspended') THEN 'probation'
              ELSE trader_entities.lifecycle
            END,
            updated_at = MAX(trader_entities.updated_at, excluded.updated_at)
        `).run(input.entityId, input.observedAt, input.observedAt);
        database.prepare(`
          INSERT INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at)
          VALUES (?, ?, 'high', 'fomo_leaderboard_30d', ?, ?)
          ON CONFLICT(entity_id, account_id) DO UPDATE SET
            confidence = 'high',
            source = 'fomo_leaderboard_30d',
            last_observed_at = MAX(entity_accounts.last_observed_at, excluded.last_observed_at)
        `).run(input.entityId, input.accountId, input.observedAt, input.observedAt);
        database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, 'source', 'source.30d_top100', ?)").run(input.entityId, input.observedAt);
      });
    },

    traderPopulationAudit() {
      const currentRows = database.prepare(`
        SELECT account_id AS accountId
        FROM leaderboard_observations
        WHERE window = '30d'
          AND observed_at = (SELECT MAX(observed_at) FROM leaderboard_observations WHERE window = '30d')
        ORDER BY account_id
      `).all() as Array<{ accountId: string }>;
      const current30dAccountIds = currentRows.map(row => row.accountId);
      const current = new Set(current30dAccountIds);
      const entities = database.prepare(`
        SELECT e.entity_id AS entityId, e.lifecycle, e.manual, e.locked,
          GROUP_CONCAT(ea.account_id, '|') AS accountIds
        FROM trader_entities e
        LEFT JOIN entity_accounts ea ON ea.entity_id = e.entity_id
        GROUP BY e.entity_id
      `).all() as Array<{ entityId: string; lifecycle: TraderEntityInput["lifecycle"]; manual: number; locked: number; accountIds: string | null }>;
      const hasDiscovery = database.prepare(`
        SELECT 1 FROM entity_accounts ea
        JOIN candidate_discoveries d ON d.account_id = ea.account_id
        WHERE ea.entity_id = ? LIMIT 1
      `);
      let admitToObservation = 0;
      let suspend24hOnly = 0;
      for (const entity of entities) {
        const isCurrent = (entity.accountIds?.split("|") ?? []).some(accountId => current.has(accountId));
        if (isCurrent) {
          if (entity.lifecycle === "candidate" || entity.lifecycle === "suspended") admitToObservation += 1;
          continue;
        }
        if (entity.manual === 1 || entity.locked === 1 || hasDiscovery.get(entity.entityId)) continue;
        if (entity.lifecycle !== "suspended") suspend24hOnly += 1;
      }
      const genuineCandidates = Number((database.prepare(`
        SELECT COUNT(DISTINCT d.account_id) AS count
        FROM candidate_discoveries d
        JOIN entity_accounts ea ON ea.account_id = d.account_id
        JOIN trader_entities e ON e.entity_id = ea.entity_id
        WHERE e.lifecycle = 'candidate'
      `).get() as { count: number }).count);
      const historical24hObservations = Number((database.prepare("SELECT COUNT(*) AS count FROM leaderboard_observations WHERE window = '24h'").get() as { count: number }).count);
      return Object.freeze({ current30dAccountIds: Object.freeze(current30dAccountIds), admitToObservation, suspend24hOnly, genuineCandidates, historical24hObservations });
    },

    reconcileLeaderboardPopulation(input) {
      assertTimestamp(input.observedAt, "observedAt");
      return transaction(() => {
        const current = new Set(input.current30dAccountIds);
        const entities = database.prepare(`
          SELECT e.entity_id AS entityId, e.lifecycle, e.manual, e.locked,
            GROUP_CONCAT(ea.account_id, '|') AS accountIds
          FROM trader_entities e
          LEFT JOIN entity_accounts ea ON ea.entity_id = e.entity_id
          GROUP BY e.entity_id
        `).all() as Array<{ entityId: string; lifecycle: TraderEntityInput["lifecycle"]; manual: number; locked: number; accountIds: string | null }>;
        const hasDiscovery = database.prepare(`
          SELECT 1 FROM entity_accounts ea
          JOIN candidate_discoveries d ON d.account_id = ea.account_id
          WHERE ea.entity_id = ? LIMIT 1
        `);
        const update = database.prepare("UPDATE trader_entities SET lifecycle = ?, updated_at = ? WHERE entity_id = ?");
        let admitted = 0;
        let suspended = 0;
        for (const entity of entities) {
          const isCurrent = (entity.accountIds?.split("|") ?? []).some(accountId => current.has(accountId));
          if (isCurrent) {
            if (entity.lifecycle === "candidate" || entity.lifecycle === "suspended") {
              update.run("probation", input.observedAt, entity.entityId);
              admitted += 1;
            }
            continue;
          }
          if (entity.manual === 1 || entity.locked === 1 || hasDiscovery.get(entity.entityId)) continue;
          if (entity.lifecycle !== "suspended") {
            update.run("suspended", input.observedAt, entity.entityId);
            suspended += 1;
          }
        }
        return Object.freeze({ admitted, suspended });
      });
    },

    linkAccountToEntity(input) {
      assertTimestamp(input.observedAt, "observedAt");
      const owner = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ?").get(input.accountId) as { entityId: string } | undefined;
      if (owner && owner.entityId !== input.entityId) throw new Error(`Entity account conflict: ${input.accountId} is already linked to ${owner.entityId}`);
      const existing = database.prepare("SELECT confidence, first_observed_at FROM entity_accounts WHERE entity_id = ? AND account_id = ?").get(input.entityId, input.accountId) as { confidence: EntityAccountLinkInput["confidence"]; first_observed_at: number } | undefined;
      const confidence = existing ? strongestIdentityConfidence(existing.confidence, input.confidence) : input.confidence;
      database.prepare(`
        INSERT INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id, account_id) DO UPDATE SET
          confidence = excluded.confidence,
          source = excluded.source,
          last_observed_at = MAX(entity_accounts.last_observed_at, excluded.last_observed_at)
      `).run(input.entityId, input.accountId, confidence, input.source, existing?.first_observed_at ?? input.observedAt, input.observedAt);
      synchronizeTraderSignalProfile(input.entityId, input.observedAt);
    },

    insertTraderEvent(event) {
      validateTraderEvent(event);
      const result = database.prepare(`
        INSERT OR IGNORE INTO trader_events(
          event_id, account_id, entity_id, chain, token_address, side,
          amount_usd, price_usd, market_cap_usd, token_age_ms,
          occurred_at, collected_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.eventId, event.accountId, event.entityId, event.chain, event.tokenAddress, event.side, event.amountUsd, event.priceUsd, event.marketCapUsd, event.tokenAgeMs, event.occurredAt, event.collectedAt, event.source);
      if (event.priceUsd !== null && event.priceUsd > 0) {
        database.prepare(`
          INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(chain, token_address, observed_at, source)
          DO UPDATE SET price_usd = excluded.price_usd
        `).run(
          event.chain.toLowerCase(),
          normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress),
          event.occurredAt,
          event.priceUsd,
          `trader_event:${event.source}`,
        );
      }
      const sourceFamily = event.source === "onchain_wallet" ? "onchain" : "fomo";
      const sourceStatus = sourceFamily === "onchain" ? "ONCHAIN_ONLY" : "FOMO_ONLY";
      const observationId = sourceFamily === "fomo"
        ? `observation:${event.eventId}`
        : `observation:onchain:${event.eventId}`;
      const observation = database.prepare(`
          INSERT OR IGNORE INTO raw_trader_observations(
            observation_id, event_id, entity_id, source_family, chain, token_address,
            side, amount_usd, occurred_at, payload, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(observationId, event.eventId, event.entityId, sourceFamily, event.chain.toLowerCase(), normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress), event.side, event.amountUsd, event.occurredAt, JSON.stringify(event), event.collectedAt);
      if (observation.changes === 1) {
        const candidates = database.prepare(`
          SELECT canonical_event_id AS canonicalEventId, amount_usd AS amountUsd, source_status AS sourceStatus
          FROM canonical_trader_events
          WHERE entity_id = ? AND chain = ? AND token_address = ? AND side = ?
            AND occurred_at BETWEEN ? AND ?
          ORDER BY ABS(occurred_at - ?) ASC
        `).all(event.entityId, event.chain.toLowerCase(), normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress), event.side, event.occurredAt - 30_000, event.occurredAt + 30_000, event.occurredAt) as Array<{ canonicalEventId: string; amountUsd: number | null; sourceStatus: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN" }>;
        const matched = matchCanonicalTraderEvent(candidates, sourceFamily, event.amountUsd);
        const canonicalEventId = matched?.canonicalEventId ?? `canonical:${event.eventId}`;
        if (matched) {
          database.prepare("UPDATE canonical_trader_events SET source_status = 'FOMO_AND_ONCHAIN', amount_usd = COALESCE(amount_usd, ?), updated_at = ? WHERE canonical_event_id = ?")
            .run(event.amountUsd, event.collectedAt, canonicalEventId);
        } else {
          database.prepare(`
            INSERT INTO canonical_trader_events(
              canonical_event_id, entity_id, chain, token_address, side, amount_usd,
              occurred_at, source_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(canonicalEventId, event.entityId, event.chain.toLowerCase(), normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress), event.side, event.amountUsd, event.occurredAt, sourceStatus, event.collectedAt);
        }
        database.prepare("INSERT OR IGNORE INTO canonical_trader_event_observations(canonical_event_id, observation_id) VALUES (?, ?)").run(canonicalEventId, observationId);
      }
      return Object.freeze({ inserted: result.changes === 1 });
    },

    eventsForEntity(entityId) {
      const rows = database.prepare("SELECT * FROM trader_events WHERE entity_id = ? ORDER BY occurred_at, event_id").all(entityId) as TraderEventRow[];
      return Object.freeze(rows.map(toTraderEvent));
    },

    eventsForToken(chain, tokenAddress) {
      const rows = database.prepare("SELECT * FROM trader_events WHERE chain = ? AND token_address = ? ORDER BY occurred_at, event_id").all(chain, tokenAddress) as TraderEventRow[];
      return Object.freeze(rows.map(toTraderEvent));
    },

    traderEntity(entityId) {
      const row = database.prepare("SELECT * FROM trader_entities WHERE entity_id = ?").get(entityId) as TraderEntityRow | undefined;
      return row ? Object.freeze({ entityId: row.entity_id, lifecycle: row.lifecycle, manual: row.manual === 1, locked: row.locked === 1, createdAt: row.created_at, updatedAt: row.updated_at }) : null;
    },

    upsertTraderSignalProfile(input) {
      database.prepare(`
        INSERT INTO trader_profiles(entity_id, display_name, priority, notes, monitoring_enabled, fomo_monitoring_enabled, onchain_monitoring_enabled, created_at, updated_at)
        VALUES (?, ?, 'normal', NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET monitoring_enabled = excluded.monitoring_enabled,
          fomo_monitoring_enabled = excluded.fomo_monitoring_enabled,
          onchain_monitoring_enabled = excluded.onchain_monitoring_enabled,
          updated_at = MAX(trader_profiles.updated_at, excluded.updated_at)
      `).run(input.entityId, input.entityId, Number(input.monitoringEnabled), Number(input.fomoMonitoringEnabled), Number(input.onchainMonitoringEnabled), input.updatedAt, input.updatedAt);
      database.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(input.updatedAt);
    },

    traderSignalProfile(entityId) {
      const row = database.prepare(`
        SELECT e.entity_id AS entityId, e.lifecycle,
          (EXISTS(SELECT 1 FROM entity_accounts ea WHERE ea.entity_id = e.entity_id AND ea.confidence = 'confirmed')
            OR EXISTS(SELECT 1 FROM entity_wallet_identities ew WHERE ew.entity_id = e.entity_id AND ew.confidence IN ('high', 'confirmed'))) AS mapped,
          COALESCE(p.monitoring_enabled, 0) AS monitoringEnabled,
          COALESCE(p.fomo_monitoring_enabled, 0) AS fomoMonitoringEnabled,
          COALESCE(p.onchain_monitoring_enabled, 0) AS onchainMonitoringEnabled,
          ability.ability_stage AS abilityStage,
          ability.bundle_risk_state AS bundleRiskState,
          ability.valid_samples AS validSamples,
          ability.total_samples AS totalSamples,
          ability.win_rate AS winRate
        FROM trader_entities e
        LEFT JOIN trader_profiles p ON p.entity_id = e.entity_id
        LEFT JOIN trader_repeatable_ability_snapshots ability ON ability.snapshot_id = (
          SELECT snapshot_id FROM trader_repeatable_ability_snapshots latest
          WHERE latest.entity_id = e.entity_id AND latest.window = '30d'
          ORDER BY latest.evaluated_at DESC, latest.snapshot_id DESC LIMIT 1
        )
        WHERE e.entity_id = ?
      `).get(entityId) as { entityId: string; lifecycle: TraderLifecycle; mapped: number; monitoringEnabled: number; fomoMonitoringEnabled: number; onchainMonitoringEnabled: number; abilityStage: "discovered" | "candidate" | "stable" | "degraded" | null; bundleRiskState: "none" | "single_cluster" | "bundle_risk" | null; validSamples: number | null; totalSamples: number | null; winRate: number | null } | undefined;
      if (!row) return null;
      const coverage = row.totalSamples && row.totalSamples > 0 ? (row.validSamples ?? 0) / row.totalSamples : 0;
      const stageBase = row.abilityStage === "stable" ? 0.72
        : row.abilityStage === "candidate" ? 0.52
          : row.abilityStage === "degraded" ? 0.42
            : row.abilityStage === "discovered" ? 0.3 : null;
      const signalContribution = stageBase === null ? undefined : Math.max(0, Math.min(1,
        stageBase + 0.18 * Math.max(0, Math.min(1, row.winRate ?? 0)) + 0.1 * Math.max(0, Math.min(1, coverage)),
      )) * (row.bundleRiskState === "bundle_risk" ? 0.45 : row.bundleRiskState === "single_cluster" ? 0.8 : 1);
      const abilityTags = [
        ...(row.abilityStage === "stable" ? ["REPEATABLE_ALPHA"] : []),
        ...(row.bundleRiskState === "bundle_risk" ? ["BUNDLE_RISK"] : []),
      ];
      return Object.freeze({
        entityId: row.entityId,
        lifecycle: row.lifecycle,
        mapped: row.mapped === 1,
        monitoringEnabled: row.monitoringEnabled === 1,
        fomoMonitoringEnabled: row.fomoMonitoringEnabled === 1,
        onchainMonitoringEnabled: row.onchainMonitoringEnabled === 1,
        ...(row.abilityStage ? { abilityStage: row.abilityStage } : {}),
        ...(signalContribution === undefined ? {} : { signalContribution }),
        abilityTags: Object.freeze(abilityTags),
      });
    },

    traderEntityIdsWithEvents() {
      const rows = database.prepare("SELECT DISTINCT entity_id AS entityId FROM trader_events ORDER BY entity_id").all() as { entityId: string }[];
      return Object.freeze(rows.map(row => row.entityId));
    },

    recordLeaderboardObservation(input) {
      if (!Number.isSafeInteger(input.rank) || input.rank < 1 || input.rank > 100) throw new Error("Leaderboard rank must be between 1 and 100");
      assertTimestamp(input.observedAt, "observedAt");
      if (input.profitUsd !== null && !Number.isFinite(input.profitUsd)) throw new Error("profitUsd must be finite or null");
      database.prepare("INSERT OR REPLACE INTO leaderboard_observations(account_id, window, rank, profit_usd, observed_at) VALUES (?, ?, ?, ?, ?)").run(input.accountId, input.window, input.rank, input.profitUsd, input.observedAt);
    },

    leaderboardWindows(accountId) {
      const rows = database.prepare("SELECT DISTINCT window FROM leaderboard_observations WHERE account_id = ? ORDER BY CASE window WHEN '24h' THEN 0 ELSE 1 END").all(accountId) as { window: LeaderboardWindow }[];
      return Object.freeze(rows.map(row => row.window));
    },

    saveTraderScoreSnapshot(snapshot, styles) {
      transaction(() => {
        database.prepare("INSERT INTO trader_score_snapshots(snapshot_id, entity_id, strategy_version, window, quality, components, sample_count, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(snapshot.snapshotId, snapshot.entityId, snapshot.strategyVersion, snapshot.window, snapshot.quality, JSON.stringify(snapshot.components), snapshot.sampleCount, snapshot.recordedAt);
        const statement = database.prepare("INSERT INTO trader_style_scores(snapshot_id, style, score) VALUES (?, ?, ?)");
        for (const [style, score] of Object.entries(styles)) statement.run(snapshot.snapshotId, style, score);
      });
    },

    latestTraderScore(entityId, window) {
      const row = database.prepare("SELECT * FROM trader_score_snapshots WHERE entity_id = ? AND window = ? ORDER BY recorded_at DESC, snapshot_id DESC LIMIT 1").get(entityId, window) as TraderScoreRow | undefined;
      return row ? Object.freeze({ snapshotId: row.snapshot_id, entityId: row.entity_id, strategyVersion: row.strategy_version, window: row.window, quality: row.quality, components: JSON.parse(row.components), sampleCount: row.sample_count, recordedAt: row.recorded_at }) : null;
    },

    recordLifecycleEvent(event) {
      database.prepare("INSERT INTO trader_lifecycle_events(lifecycle_event_id, entity_id, previous_state, next_state, reasons, strategy_version, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.lifecycleEventId, event.entityId, event.previousState, event.nextState, JSON.stringify(event.reasons), event.strategyVersion, event.occurredAt);
    },

    lifecycleEvents(entityId) {
      const rows = database.prepare("SELECT * FROM trader_lifecycle_events WHERE entity_id = ? ORDER BY occurred_at, lifecycle_event_id").all(entityId) as LifecycleEventRow[];
      return Object.freeze(rows.map(row => Object.freeze({ lifecycleEventId: row.lifecycle_event_id, entityId: row.entity_id, previousState: row.previous_state, nextState: row.next_state, reasons: Object.freeze(JSON.parse(row.reasons)), strategyVersion: row.strategy_version, occurredAt: row.occurred_at })));
    },

    upsertTraderTokenSample(sample) {
      database.prepare(`
        INSERT INTO trader_token_samples(
          sample_id, entity_id, chain, token_address, first_buy_at, last_activity_at,
          weighted_entry_price_usd, weighted_entry_market_cap_usd, total_buy_usd,
          total_sell_usd, realized_value_usd, remaining_cost_usd, launch_at,
          lifecycle_stage_at_entry, source_state, sample_status, exclusion_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id, chain, token_address) DO UPDATE SET
          first_buy_at = MIN(trader_token_samples.first_buy_at, excluded.first_buy_at),
          last_activity_at = MAX(trader_token_samples.last_activity_at, excluded.last_activity_at),
          weighted_entry_price_usd = excluded.weighted_entry_price_usd,
          weighted_entry_market_cap_usd = excluded.weighted_entry_market_cap_usd,
          total_buy_usd = excluded.total_buy_usd,
          total_sell_usd = excluded.total_sell_usd,
          realized_value_usd = excluded.realized_value_usd,
          remaining_cost_usd = excluded.remaining_cost_usd,
          launch_at = COALESCE(trader_token_samples.launch_at, excluded.launch_at),
          lifecycle_stage_at_entry = excluded.lifecycle_stage_at_entry,
          source_state = excluded.source_state,
          sample_status = excluded.sample_status,
          exclusion_reason = excluded.exclusion_reason,
          updated_at = MAX(trader_token_samples.updated_at, excluded.updated_at)
      `).run(
        sample.sampleId, sample.entityId, sample.chain, sample.tokenAddress,
        sample.firstBuyAt, sample.lastActivityAt, sample.weightedEntryPriceUsd,
        sample.weightedEntryMarketCapUsd, sample.totalBuyUsd, sample.totalSellUsd,
        sample.realizedValueUsd, sample.remainingCostUsd, sample.launchAt,
        sample.lifecycleStageAtEntry, sample.sourceState, sample.sampleStatus,
        sample.exclusionReason, sample.createdAt, sample.updatedAt,
      );
    },

    traderTokenSample(entityId, chain, tokenAddress) {
      const row = database.prepare("SELECT * FROM trader_token_samples WHERE entity_id = ? AND chain = ? AND token_address = ?").get(entityId, chain, tokenAddress) as TraderTokenSampleRow | undefined;
      return row ? toTraderTokenSample(row) : null;
    },

    traderTokenSamples(entityId, since) {
      const rows = (since === undefined
        ? database.prepare("SELECT * FROM trader_token_samples WHERE entity_id = ? ORDER BY first_buy_at, sample_id").all(entityId)
        : database.prepare("SELECT * FROM trader_token_samples WHERE entity_id = ? AND first_buy_at >= ? ORDER BY first_buy_at, sample_id").all(entityId, since)) as TraderTokenSampleRow[];
      return Object.freeze(rows.map(toTraderTokenSample));
    },

    saveMarketObservation(chain, tokenAddress, observation) {
      database.prepare(`
        INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chain, token_address, observed_at, source) DO UPDATE SET price_usd = excluded.price_usd
      `).run(chain, tokenAddress, observation.observedAt, observation.priceUsd, observation.source);
      const automationJobsAvailable = database.prepare(`
        SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'
      `).get();
      if (automationJobsAvailable) {
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE job_type = 'candidate_evidence' AND subject_key = ?
            AND status IN ('blocked_source', 'waiting_source')
        `).run(observation.observedAt, observation.observedAt, `${chain}:${tokenAddress}`);
      }
    },

    marketObservations(chain, tokenAddress, from, to) {
      const rows = database.prepare(`
        SELECT observed_at, price_usd, source FROM market_observations
        WHERE chain = ? AND token_address = ? AND observed_at >= ? AND observed_at <= ?
        ORDER BY observed_at, source
      `).all(chain, tokenAddress, from, to) as MarketObservationRow[];
      return Object.freeze(rows.map(row => Object.freeze({ observedAt: row.observed_at, priceUsd: row.price_usd, source: row.source })));
    },

    saveTraderTokenOutcome(outcome) {
      database.prepare(`
        INSERT INTO trader_token_outcomes(
          sample_id, horizon, target_at, observed_at, close_multiple, mfe_multiple,
          mae_multiple, captured_multiple, hit_1_5x, hit_2x, hit_5x, hit_10x,
          time_to_1_5x_ms, time_to_2x_ms, time_to_5x_ms, time_to_10x_ms,
          coverage_status, source, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sample_id, horizon) DO UPDATE SET
          target_at = excluded.target_at, observed_at = excluded.observed_at,
          close_multiple = excluded.close_multiple, mfe_multiple = excluded.mfe_multiple,
          mae_multiple = excluded.mae_multiple, captured_multiple = excluded.captured_multiple,
          hit_1_5x = excluded.hit_1_5x, hit_2x = excluded.hit_2x,
          hit_5x = excluded.hit_5x, hit_10x = excluded.hit_10x,
          time_to_1_5x_ms = excluded.time_to_1_5x_ms, time_to_2x_ms = excluded.time_to_2x_ms,
          time_to_5x_ms = excluded.time_to_5x_ms, time_to_10x_ms = excluded.time_to_10x_ms,
          coverage_status = excluded.coverage_status, source = excluded.source,
          computed_at = excluded.computed_at
      `).run(
        outcome.sampleId, outcome.horizon, outcome.targetAt, outcome.observedAt,
        outcome.closeMultiple, outcome.mfeMultiple, outcome.maeMultiple,
        outcome.capturedMultiple, nullableBoolean(outcome.hit1_5x), nullableBoolean(outcome.hit2x),
        nullableBoolean(outcome.hit5x), nullableBoolean(outcome.hit10x), outcome.timeTo1_5xMs,
        outcome.timeTo2xMs, outcome.timeTo5xMs, outcome.timeTo10xMs,
        outcome.coverageStatus, outcome.source, outcome.computedAt,
      );
    },

    traderTokenOutcomes(sampleId) {
      const rows = database.prepare("SELECT * FROM trader_token_outcomes WHERE sample_id = ? ORDER BY target_at, horizon").all(sampleId) as TraderTokenOutcomeRow[];
      return Object.freeze(rows.map(toTraderTokenOutcome));
    },

    maturePendingOutcomes(now, limit) {
      const rows = database.prepare(`
        SELECT * FROM trader_token_outcomes
        WHERE coverage_status = 'pending' AND target_at <= ?
        ORDER BY target_at, sample_id LIMIT ?
      `).all(now, limit) as TraderTokenOutcomeRow[];
      return Object.freeze(rows.map(toTraderTokenOutcome));
    },

    saveTraderAbilitySnapshot(snapshot) {
      database.prepare(`
        INSERT INTO trader_ability_snapshots(
          snapshot_id, entity_id, window, as_of, strategy_version, raw_quality,
          adjusted_quality, sample_confidence, coverage_confidence, metrics,
          components, styles, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.snapshotId, snapshot.entityId, snapshot.window, snapshot.asOf,
        snapshot.strategyVersion, snapshot.rawQuality, snapshot.adjustedQuality,
        snapshot.sampleConfidence, snapshot.coverageConfidence, JSON.stringify(snapshot.metrics),
        JSON.stringify(snapshot.components), JSON.stringify(snapshot.styles), snapshot.createdAt,
      );
      synchronizeTraderSignalProfile(snapshot.entityId, snapshot.createdAt);
    },

    latestTraderAbility(entityId, window) {
      const row = database.prepare(`
        SELECT * FROM trader_ability_snapshots
        WHERE entity_id = ? AND window = ? ORDER BY as_of DESC, snapshot_id DESC LIMIT 1
      `).get(entityId, window) as TraderAbilitySnapshotRow | undefined;
      return row ? toTraderAbilitySnapshot(row) : null;
    },

    enqueueTraderBackfill(job) {
      database.prepare(`
        INSERT OR IGNORE INTO trader_backfill_jobs(
          job_id, entity_id, status, cursor, attempt_count, coverage, last_error,
          next_attempt_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.jobId, job.entityId, job.status, job.cursor, job.attemptCount,
        JSON.stringify(job.coverage), job.lastError ?? null, job.nextAttemptAt,
        job.completedAt ?? null, job.createdAt, job.updatedAt,
      );
    },

    claimTraderBackfill(now) {
      return transaction(() => {
        const row = database.prepare(`
          SELECT * FROM trader_backfill_jobs
          WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at, job_id LIMIT 1
        `).get(now) as TraderBackfillJobRow | undefined;
        if (!row) return null;
        database.prepare(`
          UPDATE trader_backfill_jobs
          SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
          WHERE job_id = ?
        `).run(now, row.job_id);
        const claimed = database.prepare("SELECT * FROM trader_backfill_jobs WHERE job_id = ?").get(row.job_id) as TraderBackfillJobRow;
        return toTraderBackfillJob(claimed);
      });
    },

    completeTraderBackfill(jobId, coverage, completedAt) {
      database.prepare(`
        UPDATE trader_backfill_jobs
        SET status = 'completed', coverage = ?, last_error = NULL,
            completed_at = ?, updated_at = ? WHERE job_id = ?
      `).run(JSON.stringify(coverage), completedAt, completedAt, jobId);
    },

    failTraderBackfill(jobId, error, cursor, nextAttemptAt) {
      database.prepare(`
        UPDATE trader_backfill_jobs
        SET status = 'failed', last_error = ?, cursor = ?, next_attempt_at = ?, updated_at = ?
        WHERE job_id = ?
      `).run(error, cursor, nextAttemptAt, nextAttemptAt, jobId);
    },

    updateTraderLifecycle(entityId, lifecycle, updatedAt) {
      const changed = database.prepare("UPDATE trader_entities SET lifecycle = ?, updated_at = ? WHERE entity_id = ?").run(lifecycle, updatedAt, entityId).changes;
      if (changed !== 1) throw new Error("Trader entity not found");
      synchronizeTraderSignalProfile(entityId, updatedAt);
    },

    recordTokenMilestone(input) {
      const result = database.prepare("INSERT OR IGNORE INTO token_milestones(milestone_id, chain, token_address, market_cap_usd, reached_at, payload) VALUES (?, ?, ?, ?, ?, ?)").run(input.milestoneId, input.chain, input.tokenAddress, input.marketCapUsd, input.reachedAt, input.payload);
      return Object.freeze({ inserted: result.changes === 1 });
    },

    tokenMilestones() {
      const rows = database.prepare("SELECT * FROM token_milestones ORDER BY reached_at, milestone_id").all() as Record<string, unknown>[];
      return Object.freeze(rows.map(row => Object.freeze({ milestoneId: row.milestone_id as string, chain: row.chain as string, tokenAddress: row.token_address as string, marketCapUsd: row.market_cap_usd as number, reachedAt: row.reached_at as number, payload: row.payload as string })));
    },

    milestonesForToken(chain, tokenAddress) {
      const rows = database.prepare("SELECT * FROM token_milestones WHERE chain = ? AND token_address = ? ORDER BY reached_at, milestone_id").all(chain, tokenAddress) as Record<string, unknown>[];
      return Object.freeze(rows.map(row => Object.freeze({ milestoneId: row.milestone_id as string, chain: row.chain as string, tokenAddress: row.token_address as string, marketCapUsd: row.market_cap_usd as number, reachedAt: row.reached_at as number, payload: row.payload as string })));
    },

    enqueueMilestoneBackfill(job) {
      const result = database.prepare("INSERT OR IGNORE INTO milestone_backfill_jobs(job_id, milestone_id, chain, token_address, status, source, cursor, attempt_count, next_attempt_at, coverage_start_at, coverage_end_at, records_seen, records_inserted, last_error, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(job.jobId, job.milestoneId, job.chain, job.tokenAddress, job.status, job.source, job.cursor, job.attemptCount, job.nextAttemptAt, job.coverageStartAt, job.coverageEndAt, job.recordsSeen, job.recordsInserted, job.lastError, job.createdAt, job.updatedAt, job.completedAt);
      return Object.freeze({ inserted: result.changes === 1 });
    },

    claimMilestoneBackfill(now) {
      return transaction(() => {
        const row = database.prepare("SELECT * FROM milestone_backfill_jobs WHERE status IN ('pending', 'failed') AND next_attempt_at <= $now ORDER BY next_attempt_at, created_at, job_id LIMIT 1").get({ $now: now }) as Record<string, unknown> | undefined;
        if (!row) return null;
        database.prepare("UPDATE milestone_backfill_jobs SET status = 'running', attempt_count = attempt_count + 1, updated_at = $now WHERE job_id = $jobId").run({ $now: now, $jobId: row.job_id as string });
        return toMilestoneBackfillJob(database.prepare("SELECT * FROM milestone_backfill_jobs WHERE job_id = $jobId").get({ $jobId: row.job_id as string }) as Record<string, unknown>);
      });
    },

    completeMilestoneBackfill(jobId, result) {
      database.prepare("UPDATE milestone_backfill_jobs SET status = ?, coverage_start_at = ?, coverage_end_at = ?, records_seen = ?, records_inserted = ?, last_error = NULL, completed_at = ?, updated_at = ? WHERE job_id = ?").run(result.status, result.coverageStartAt, result.coverageEndAt, result.recordsSeen, result.recordsInserted, result.completedAt, result.completedAt, jobId);
    },

    failMilestoneBackfill(jobId, error, cursor, nextAttemptAt, unavailable) {
      database.prepare("UPDATE milestone_backfill_jobs SET status = ?, last_error = ?, cursor = ?, next_attempt_at = ?, updated_at = ? WHERE job_id = ?").run(unavailable ? "unavailable" : "failed", error, cursor, nextAttemptAt, nextAttemptAt, jobId);
    },

    milestoneBackfillJobs() {
      return Object.freeze((database.prepare("SELECT * FROM milestone_backfill_jobs ORDER BY created_at, job_id").all() as Record<string, unknown>[]).map(toMilestoneBackfillJob));
    },

    saveMilestoneEvaluation(evaluation) {
      database.prepare("INSERT OR IGNORE INTO milestone_evaluations(evaluation_id, milestone_id, strategy_version, event_watermark, eligible_buy_count, evaluated_account_count, qualified_candidate_count, coverage_status, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(evaluation.evaluationId, evaluation.milestoneId, evaluation.strategyVersion, evaluation.eventWatermark, evaluation.eligibleBuyCount, evaluation.evaluatedAccountCount, evaluation.qualifiedCandidateCount, evaluation.coverageStatus, evaluation.evaluatedAt);
    },

    latestMilestoneEvaluation(milestoneId) {
      const row = database.prepare("SELECT * FROM milestone_evaluations WHERE milestone_id = ? ORDER BY evaluated_at DESC, evaluation_id DESC LIMIT 1").get(milestoneId) as Record<string, unknown> | undefined;
      return row ? toMilestoneEvaluation(row) : null;
    },

    enqueueHistoricalBackfillPartition(partition) {
      const result = database.prepare(`
        INSERT OR IGNORE INTO historical_backfill_partitions(
          partition_id, query_kind, chain, day_start, day_end, token_addresses, status,
          execution_id, next_offset, row_count, attempt_count, watermark, next_retry_at,
          lease_expires_at, last_error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(partition.partitionId, partition.queryKind, partition.chain, partition.dayStart, partition.dayEnd,
        JSON.stringify(partition.tokenAddresses), partition.status, partition.executionId, partition.nextOffset,
        partition.rowCount, partition.attemptCount, partition.watermark, partition.nextRetryAt,
        partition.leaseExpiresAt, partition.lastError, partition.createdAt, partition.updatedAt, partition.completedAt);
      return Object.freeze({ inserted: result.changes === 1 });
    },

    claimHistoricalBackfillPartition(now, leaseMs) {
      return transaction(() => {
        database.prepare(`
          UPDATE historical_backfill_partitions
          SET status = 'pending', lease_expires_at = NULL, next_retry_at = MIN(next_retry_at, ?), updated_at = ?
          WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        `).run(now, now, now);
        if (database.prepare("SELECT 1 FROM historical_backfill_partitions WHERE status = 'running' LIMIT 1").get()) return null;
        const row = database.prepare(`
          SELECT * FROM historical_backfill_partitions
          WHERE status IN ('pending', 'failed') AND next_retry_at <= ?
          ORDER BY
            COALESCE((
              SELECT MAX(completed.completed_at)
              FROM historical_backfill_partitions completed
              WHERE completed.chain = historical_backfill_partitions.chain
                AND completed.query_kind = historical_backfill_partitions.query_kind
                AND completed.status = 'completed'
            ), 0),
            day_start, next_retry_at, partition_id
          LIMIT 1
        `).get(now) as Record<string, unknown> | undefined;
        if (!row) return null;
        database.prepare(`
          UPDATE historical_backfill_partitions
          SET status = 'running', attempt_count = attempt_count + 1, lease_expires_at = ?, updated_at = ?
          WHERE partition_id = ?
        `).run(now + leaseMs, now, row.partition_id as string);
        return toHistoricalBackfillPartition(database.prepare("SELECT * FROM historical_backfill_partitions WHERE partition_id = ?").get(row.partition_id as string) as Record<string, unknown>);
      });
    },

    checkpointHistoricalBackfillPartition(partitionId, input) {
      database.prepare(`
        UPDATE historical_backfill_partitions
        SET status = 'pending', execution_id = ?, next_offset = ?, row_count = ?, watermark = ?,
            next_retry_at = ?, lease_expires_at = NULL, last_error = NULL, updated_at = ?
        WHERE partition_id = ? AND status = 'running'
      `).run(input.executionId, input.nextOffset, input.rowCount, input.watermark, input.updatedAt, input.updatedAt, partitionId);
    },

    completeHistoricalBackfillPartition(partitionId, input) {
      database.prepare(`
        UPDATE historical_backfill_partitions
        SET status = 'completed', execution_id = ?, next_offset = NULL, row_count = ?, watermark = ?,
            lease_expires_at = NULL, last_error = NULL, completed_at = ?, updated_at = ?
        WHERE partition_id = ? AND status = 'running'
      `).run(input.executionId, input.rowCount, input.watermark, input.completedAt, input.completedAt, partitionId);
    },

    failHistoricalBackfillPartition(partitionId, error, nextRetryAt) {
      database.prepare(`
        UPDATE historical_backfill_partitions
        SET status = 'failed', last_error = ?, next_retry_at = ?, lease_expires_at = NULL, updated_at = ?
        WHERE partition_id = ? AND status = 'running'
      `).run(error, nextRetryAt, nextRetryAt, partitionId);
    },

    historicalBackfillPartitions() {
      return Object.freeze((database.prepare("SELECT * FROM historical_backfill_partitions ORDER BY created_at, partition_id").all() as Record<string, unknown>[]).map(toHistoricalBackfillPartition));
    },

    recordHistoricalCreditUsage(usageDay, creditsUsed, updatedAt) {
      if (!Number.isSafeInteger(creditsUsed) || creditsUsed < 0) throw new Error("Historical credits must be a nonnegative integer");
      database.prepare(`
        INSERT INTO historical_backfill_credit_usage(usage_day, credits_used, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(usage_day) DO UPDATE SET credits_used = historical_backfill_credit_usage.credits_used + excluded.credits_used, updated_at = excluded.updated_at
      `).run(usageDay, creditsUsed, updatedAt);
    },

    historicalCreditsUsed(usageDay) {
      const row = database.prepare("SELECT credits_used AS creditsUsed FROM historical_backfill_credit_usage WHERE usage_day = ?").get(usageDay) as { creditsUsed: number } | undefined;
      return row?.creditsUsed ?? 0;
    },

    advanceHistoricalWatermark(chain, queryKind, watermark, updatedAt) {
      database.prepare(`
        INSERT INTO historical_backfill_watermarks(chain, query_kind, watermark, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(chain, query_kind) DO UPDATE SET watermark = MAX(historical_backfill_watermarks.watermark, excluded.watermark), updated_at = excluded.updated_at
      `).run(chain, queryKind, watermark, updatedAt);
    },

    historicalWatermark(chain, queryKind) {
      const row = database.prepare("SELECT watermark FROM historical_backfill_watermarks WHERE chain = ? AND query_kind = ?").get(chain, queryKind) as { watermark: number } | undefined;
      return row?.watermark ?? null;
    },

    saveCandidateDiscovery(input) {
      database.prepare("INSERT OR IGNORE INTO candidate_discoveries(discovery_id, account_id, discovery_type, payload, discovered_at) VALUES (?, ?, ?, ?, ?)").run(input.discoveryId, input.accountId, input.discoveryType, input.payload, input.discoveredAt);
      const entity = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? ORDER BY last_observed_at DESC LIMIT 1").get(input.accountId) as { entityId: string } | undefined;
      if (entity) {
        database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, 'source', 'source.milestone_discovery', ?)").run(entity.entityId, input.discoveredAt);
        if (input.discoveryType.startsWith("market_cap_")) {
          database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, 'ability', ?, ?)").run(entity.entityId, input.discoveryType.replace("market_cap_", "ability."), input.discoveredAt);
        }
      }
    },

    activateDiscoveredCandidate(accountId, updatedAt) {
      assertId(accountId, "accountId");
      assertTimestamp(updatedAt, "updatedAt");
      const row = (database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? ORDER BY first_observed_at LIMIT 1").get(accountId)
        ?? database.prepare("SELECT entity_id AS entityId FROM trader_entities WHERE entity_id = ?").get(`fomo:${accountId}`)) as { entityId: string } | undefined;
      if (!row) return null;
      database.prepare("UPDATE trader_entities SET lifecycle = 'candidate', updated_at = ? WHERE entity_id = ? AND lifecycle = 'suspended'").run(updatedAt, row.entityId);
      return row.entityId;
    },

    candidateDiscoveries(accountId) {
      const rows = database.prepare("SELECT * FROM candidate_discoveries WHERE account_id = ? ORDER BY discovered_at, discovery_id").all(accountId) as CandidateDiscoveryRow[];
      return Object.freeze(rows.map(row => Object.freeze({ discoveryId: row.discovery_id, accountId: row.account_id, discoveryType: row.discovery_type, payload: row.payload, discoveredAt: row.discovered_at })));
    },

    candidateDiscoveriesForEntity(entityId) {
      const rows = database.prepare(`
        SELECT d.discovery_id, d.account_id, d.discovery_type, d.payload, d.discovered_at
        FROM entity_accounts ea JOIN candidate_discoveries d ON d.account_id = ea.account_id
        WHERE ea.entity_id = ? ORDER BY d.discovered_at, d.discovery_id
      `).all(entityId) as CandidateDiscoveryRow[];
      return Object.freeze(rows.map(row => Object.freeze({ discoveryId: row.discovery_id, accountId: row.account_id, discoveryType: row.discovery_type, payload: row.payload, discoveredAt: row.discovered_at })));
    },

    identityResolution(handle) {
      const row = database.prepare("SELECT * FROM identity_resolution_jobs WHERE handle = ?").get(normalizeFomoHandle(handle)) as IdentityResolutionRow | undefined;
      return row ? Object.freeze({ handle: row.handle, status: row.status, accountId: row.account_id, expiresAt: row.expires_at, nextAttemptAt: row.next_attempt_at, attemptCount: row.attempt_count, payload: row.payload, updatedAt: row.updated_at }) : null;
    },

    saveIdentityResolution(input) {
      database.prepare(`
        INSERT INTO identity_resolution_jobs(handle, status, account_id, expires_at, next_attempt_at, attempt_count, payload, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(handle) DO UPDATE SET
          status = excluded.status, account_id = excluded.account_id, expires_at = excluded.expires_at,
          next_attempt_at = excluded.next_attempt_at, attempt_count = excluded.attempt_count,
          payload = excluded.payload, updated_at = excluded.updated_at
      `).run(normalizeFomoHandle(input.handle), input.status, input.accountId, input.expiresAt, input.nextAttemptAt, input.attemptCount, input.payload, input.updatedAt);
    },

    saveAddressSignalEvidence(chain, tokenAddress, evidence) {
      const canonical = database.prepare(`
        SELECT links.canonical_event_id AS canonicalEventId
        FROM canonical_trader_event_observations links
        JOIN raw_trader_observations raw ON raw.observation_id = links.observation_id
        WHERE raw.event_id = ? LIMIT 1
      `).get(evidence.eventId) as { canonicalEventId: string } | undefined;
      database.prepare(`
        INSERT INTO address_signal_evidence(
          event_id, chain, token_address, entity_id, contribution, occurred_at,
          source, side, amount_usd, lifecycle_stage, trader_tags, dedupe_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          contribution = MAX(address_signal_evidence.contribution, excluded.contribution),
          source = COALESCE(excluded.source, address_signal_evidence.source),
          side = COALESCE(excluded.side, address_signal_evidence.side),
          amount_usd = COALESCE(excluded.amount_usd, address_signal_evidence.amount_usd),
          lifecycle_stage = COALESCE(excluded.lifecycle_stage, address_signal_evidence.lifecycle_stage),
          trader_tags = excluded.trader_tags,
          dedupe_key = COALESCE(excluded.dedupe_key, address_signal_evidence.dedupe_key)
      `).run(
        evidence.eventId,
        chain.toLowerCase(),
        normalizeAddressRadarTokenAddress(chain, tokenAddress),
        evidence.entityId,
        evidence.contribution,
        evidence.occurredAt,
        evidence.source ?? null,
        evidence.side ?? null,
        evidence.amountUsd ?? null,
        evidence.lifecycleStage ?? null,
        JSON.stringify(evidence.traderTags ?? []),
        canonical?.canonicalEventId ?? evidence.dedupeKey ?? null,
      );
    },

    addressSignalEvidenceForToken(chain, tokenAddress, since) {
      const records = database.prepare(`
        SELECT event_id AS eventId, entity_id AS entityId, contribution, occurred_at AS occurredAt,
          source, side, amount_usd AS amountUsd, lifecycle_stage AS lifecycleStage,
          trader_tags AS traderTags, dedupe_key AS dedupeKey
        FROM address_signal_evidence
        WHERE chain = ? AND token_address = ? AND occurred_at >= ?
        ORDER BY occurred_at, event_id
      `).all(chain.toLowerCase(), normalizeAddressRadarTokenAddress(chain, tokenAddress), since) as Array<{
        eventId: string;
        entityId: string;
        contribution: number;
        occurredAt: number;
        source: AddressSignalEvidence["source"] | null;
        side: AddressSignalEvidence["side"] | null;
        amountUsd: number | null;
        lifecycleStage: AddressSignalEvidence["lifecycleStage"] | null;
        traderTags: string;
        dedupeKey: string | null;
      }>;
      return Object.freeze(records.map(record => Object.freeze({
        eventId: record.eventId,
        entityId: record.entityId,
        contribution: record.contribution,
        occurredAt: record.occurredAt,
        ...(record.source ? { source: record.source } : {}),
        ...(record.side ? { side: record.side } : {}),
        amountUsd: record.amountUsd,
        ...(record.lifecycleStage ? { lifecycleStage: record.lifecycleStage } : {}),
        traderTags: Object.freeze(JSON.parse(record.traderTags) as string[]),
        ...(record.dedupeKey ? { dedupeKey: record.dedupeKey } : {}),
      })));
    },

    recordWalletBundlePairs(chain, tokenAddress, pairs) {
      if (pairs.length === 0) return;
      const tokenId = addressRadarTokenId(chain, tokenAddress);
      transaction(() => {
        const statement = database.prepare(`
          INSERT INTO wallet_bundle_pair_tokens(pair_key, token_id, chain, left_entity_id, right_entity_id, min_delta_ms, first_observed_at, last_observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pair_key, token_id) DO UPDATE SET
            min_delta_ms = MIN(wallet_bundle_pair_tokens.min_delta_ms, excluded.min_delta_ms),
            first_observed_at = MIN(wallet_bundle_pair_tokens.first_observed_at, excluded.first_observed_at),
            last_observed_at = MAX(wallet_bundle_pair_tokens.last_observed_at, excluded.last_observed_at)
        `);
        for (const pair of pairs) statement.run(pair.pairKey, tokenId, chain.toLowerCase(), pair.leftEntityId, pair.rightEntityId, pair.deltaMs, pair.observedAt, pair.observedAt);
      });
    },

    walletBundleRelations(entityIds) {
      const selected = new Set(entityIds);
      if (selected.size < 2) return Object.freeze([]);
      const rows = database.prepare(`
        SELECT pair_key AS pairKey, left_entity_id AS leftEntityId, right_entity_id AS rightEntityId,
          COUNT(*) AS distinctTokenCount, MIN(min_delta_ms) AS deltaMs, MAX(last_observed_at) AS observedAt
        FROM wallet_bundle_pair_tokens
        GROUP BY pair_key, left_entity_id, right_entity_id
      `).all() as Array<Omit<WalletBundleRelation, "recurring">>;
      return Object.freeze(rows.filter(row => selected.has(row.leftEntityId) && selected.has(row.rightEntityId)).map(row => Object.freeze({ ...row, recurring: row.distinctTokenCount >= 2 })));
    },

    saveTokenEvaluation(input) {
      const tokenId = addressRadarTokenId(input.chain, input.tokenAddress);
      database.prepare(`
        INSERT INTO token_evaluation_state(
          token_id, chain, token_address, action, signal_family, lifecycle_stage,
          score, participant_count, total_buy_usd, source_state, window_ms,
          missing_conditions, bundle_diagnostics, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          action = excluded.action,
          signal_family = excluded.signal_family,
          lifecycle_stage = excluded.lifecycle_stage,
          score = excluded.score,
          participant_count = excluded.participant_count,
          total_buy_usd = excluded.total_buy_usd,
          source_state = excluded.source_state,
          window_ms = excluded.window_ms,
          missing_conditions = excluded.missing_conditions,
          bundle_diagnostics = excluded.bundle_diagnostics,
          updated_at = excluded.updated_at
      `).run(
        tokenId,
        input.chain.toLowerCase(),
        normalizeAddressRadarTokenAddress(input.chain, input.tokenAddress),
        input.action,
        input.signalFamily,
        input.lifecycleStage,
        input.score,
        input.participantCount,
        input.totalBuyUsd,
        input.sourceState,
        input.windowMs,
        JSON.stringify(input.missingConditions),
        JSON.stringify(input.bundleDiagnostics ?? {}),
        input.updatedAt,
      );
    },

    tokenEvaluationState(chain, tokenAddress) {
      const row = database.prepare(`
        SELECT token_id AS tokenId, chain, token_address AS tokenAddress, action,
          signal_family AS signalFamily, lifecycle_stage AS lifecycleStage, score,
          participant_count AS participantCount, total_buy_usd AS totalBuyUsd,
          source_state AS sourceState, window_ms AS windowMs,
          missing_conditions AS missingConditions, bundle_diagnostics AS bundleDiagnostics, updated_at AS updatedAt
        FROM token_evaluation_state
        WHERE token_id = ?
      `).get(addressRadarTokenId(chain, tokenAddress)) as (Omit<TokenEvaluationRecord, "missingConditions" | "bundleDiagnostics"> & { missingConditions: string; bundleDiagnostics: string }) | undefined;
      return row ? Object.freeze({ ...row, missingConditions: Object.freeze(JSON.parse(row.missingConditions) as string[]), bundleDiagnostics: Object.freeze(JSON.parse(row.bundleDiagnostics) as BundleDiagnostics) }) : null;
    },

    tokenAggregationState(chain, tokenAddress) {
      const tokenId = addressRadarTokenId(chain, tokenAddress);
      const row = database.prepare(`
        SELECT
          token_id AS tokenId,
          chain,
          token_address AS tokenAddress,
          current_score AS currentScore,
          peak_score AS peakScore,
          broadcast_count AS broadcastCount,
          updated_at AS updatedAt
        FROM token_aggregation_state
        WHERE token_id = ?
      `).get(tokenId) as Omit<TokenAggregationStateRecord, "consumedEvidenceIds"> | undefined;
      if (!row) return null;
      const consumed = database.prepare(`
        SELECT ec.event_id AS eventId
        FROM evidence_consumption ec
        JOIN broadcast_records br ON br.broadcast_id = ec.broadcast_id
        WHERE br.token_id = ?
        ORDER BY ec.consumed_at, ec.event_id
      `).all(tokenId) as Array<{ eventId: string }>;
      const economic = database.prepare(`
        SELECT dedupe_key AS dedupeKey FROM economic_evidence_consumption
        WHERE broadcast_id IN (SELECT broadcast_id FROM broadcast_records WHERE token_id = ?)
        ORDER BY consumed_at, dedupe_key
      `).all(tokenId) as Array<{ dedupeKey: string }>;
      return Object.freeze({ ...row, consumedEvidenceIds: Object.freeze(consumed.map(item => item.eventId)), consumedEconomicKeys: Object.freeze(economic.map(item => item.dedupeKey)) });
    },

    commitTokenBroadcast(input) {
      return transaction(() => {
        const tokenId = addressRadarTokenId(input.chain, input.tokenAddress);
        const current = database.prepare("SELECT broadcast_count AS broadcastCount FROM token_aggregation_state WHERE token_id = ?").get(tokenId) as { broadcastCount: number } | undefined;
        const currentCount = current?.broadcastCount ?? 0;
        if (currentCount !== input.expectedPreviousBroadcastCount || input.evidenceIds.length === 0) {
          return Object.freeze({ inserted: false, broadcastNumber: currentCount });
        }
        const alreadyConsumed = input.evidenceIds.some(eventId => database.prepare("SELECT 1 FROM evidence_consumption WHERE event_id = ?").get(eventId))
          || input.economicKeys.some(key => database.prepare("SELECT 1 FROM economic_evidence_consumption WHERE dedupe_key = ?").get(key));
        if (alreadyConsumed) return Object.freeze({ inserted: false, broadcastNumber: currentCount });

        const broadcastNumber = currentCount + 1;
        const broadcastId = addressRadarBroadcastId(tokenId, broadcastNumber);
        database.prepare(`
          INSERT INTO token_aggregation_state(token_id, chain, token_address, current_score, peak_score, broadcast_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(token_id) DO UPDATE SET
            current_score = excluded.current_score,
            peak_score = MAX(token_aggregation_state.peak_score, excluded.peak_score),
            broadcast_count = excluded.broadcast_count,
            updated_at = excluded.updated_at
        `).run(tokenId, input.chain.toLowerCase(), normalizeAddressRadarTokenAddress(input.chain, input.tokenAddress), input.score, input.score, broadcastNumber, input.triggeredAt);
        database.prepare(`
          INSERT INTO broadcast_records(broadcast_id, token_id, broadcast_number, strategy_version, score, triggered_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(broadcastId, tokenId, broadcastNumber, input.strategyVersion, input.score, input.triggeredAt, JSON.stringify(input.payload));
        const consume = database.prepare("INSERT INTO evidence_consumption(event_id, broadcast_id, consumed_at) VALUES (?, ?, ?)");
        for (const eventId of input.evidenceIds) consume.run(eventId, broadcastId, input.triggeredAt);
        const consumeEconomic = database.prepare("INSERT INTO economic_evidence_consumption(dedupe_key, broadcast_id, consumed_at) VALUES (?, ?, ?)");
        for (const key of input.economicKeys) consumeEconomic.run(key, broadcastId, input.triggeredAt);
        const evaluation = input.evaluation;
        database.prepare(`
          INSERT INTO token_evaluation_state(token_id, chain, token_address, action, signal_family, lifecycle_stage, score, participant_count, total_buy_usd, source_state, window_ms, missing_conditions, bundle_diagnostics, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(token_id) DO UPDATE SET action = excluded.action, signal_family = excluded.signal_family,
            lifecycle_stage = excluded.lifecycle_stage, score = excluded.score, participant_count = excluded.participant_count,
            total_buy_usd = excluded.total_buy_usd, source_state = excluded.source_state, window_ms = excluded.window_ms,
            missing_conditions = excluded.missing_conditions, bundle_diagnostics = excluded.bundle_diagnostics, updated_at = excluded.updated_at
        `).run(tokenId, input.chain.toLowerCase(), normalizeAddressRadarTokenAddress(input.chain, input.tokenAddress), evaluation.action, evaluation.signalFamily, evaluation.lifecycleStage, evaluation.score, evaluation.participantCount, evaluation.totalBuyUsd, evaluation.sourceState, evaluation.windowMs, JSON.stringify(evaluation.missingConditions), JSON.stringify(evaluation.bundleDiagnostics ?? {}), evaluation.updatedAt);
        database.prepare(`
          INSERT INTO signal_outbox(outbox_id, broadcast_id, token_id, broadcast_sequence, payload, status, attempt_count, next_retry_at, last_error, claimed_by, claimed_at, delivered_at, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?)
        `).run(`outbox:${broadcastId}`, broadcastId, tokenId, broadcastNumber, JSON.stringify(input.publicSignal), input.triggeredAt, input.triggeredAt);
        return Object.freeze({ inserted: true, broadcastNumber });
      });
    },

    pendingSignalOutbox() {
      const rows = database.prepare("SELECT * FROM signal_outbox WHERE status = 'pending' ORDER BY created_at, token_id, broadcast_sequence").all() as Array<Record<string, unknown>>;
      return Object.freeze(rows.map(toSignalOutboxRecord));
    },

    claimSignalOutbox(input) {
      return transaction(() => {
        database.prepare("UPDATE signal_outbox SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL WHERE status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?").run(input.now);
        const candidate = database.prepare(`
          SELECT candidate.outbox_id AS outboxId FROM signal_outbox candidate
          WHERE candidate.status = 'pending' AND candidate.next_retry_at <= ?
            AND NOT EXISTS (SELECT 1 FROM signal_outbox earlier WHERE earlier.token_id = candidate.token_id AND earlier.broadcast_sequence < candidate.broadcast_sequence AND earlier.status != 'delivered')
            AND NOT EXISTS (SELECT 1 FROM signal_outbox_migration_review review WHERE review.token_id = candidate.token_id AND review.broadcast_sequence < candidate.broadcast_sequence AND review.decision IS NULL)
          ORDER BY candidate.created_at, candidate.token_id, candidate.broadcast_sequence LIMIT 1
        `).get(input.now) as { outboxId: string } | undefined;
        if (!candidate) return null;
        const claimToken = randomUUID();
        const changed = database.prepare("UPDATE signal_outbox SET status = 'processing', claimed_by = ?, claimed_at = ?, claim_token = ?, claim_generation = claim_generation + 1, lease_expires_at = ?, attempt_count = attempt_count + 1 WHERE outbox_id = ? AND status = 'pending'").run(input.workerId, input.now, claimToken, input.now + input.leaseMs, candidate.outboxId);
        if (changed.changes !== 1) return null;
        const row = database.prepare("SELECT * FROM signal_outbox WHERE outbox_id = ?").get(candidate.outboxId) as Record<string, unknown>;
        return toSignalOutboxRecord(row);
      });
    },

    markSignalOutboxDelivered(input) {
      return database.prepare("UPDATE signal_outbox SET status = 'delivered', delivered_at = ?, claimed_by = NULL, claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL, last_error = NULL WHERE outbox_id = ? AND status = 'processing' AND claim_token = ?").run(input.deliveredAt, input.outboxId, input.claimToken).changes === 1;
    },

    failSignalOutbox(input) {
      return database.prepare("UPDATE signal_outbox SET status = 'pending', next_retry_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL WHERE outbox_id = ? AND status = 'processing' AND claim_token = ?").run(input.nextRetryAt, input.error.slice(0, 2_048), input.outboxId, input.claimToken).changes === 1;
    },

    deadLetterSignalOutbox(input) {
      return database.prepare("UPDATE signal_outbox SET status = 'pending', next_retry_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL WHERE outbox_id = ? AND status = 'processing' AND claim_token = ?").run(Number.MAX_SAFE_INTEGER, `dead_letter:${input.error}`.slice(0, 2_048), input.outboxId, input.claimToken).changes === 1;
    },

    legacySignalOutboxReviews() {
      const rows = database.prepare("SELECT review_id AS reviewId, broadcast_id AS broadcastId, token_id AS tokenId, broadcast_sequence AS broadcastSequence, idempotency_key AS idempotencyKey, payload, status, validation_status AS validationStatus, reason, created_at AS createdAt, reviewed_at AS reviewedAt, decision, decided_by AS decidedBy, decision_reason AS decisionReason, decided_at AS decidedAt FROM signal_outbox_migration_review ORDER BY review_id").all() as Array<Record<string, unknown>>;
      return Object.freeze(rows.map(row => Object.freeze({ ...row, payload: parseStoredPayload(row.payload as string) })) as unknown as LegacySignalOutboxReview[]);
    },

    approveLegacySignalOutbox(input) {
      return transaction(() => {
        if (!input.operator.trim() || !input.reason.trim()) return false;
        const row = database.prepare("SELECT * FROM signal_outbox_migration_review WHERE review_id = ? AND status = 'legacy_review' AND validation_status = 'valid' AND decision IS NULL").get(input.reviewId) as { broadcast_id: string; token_id: string; broadcast_sequence: number; payload: string } | undefined;
        if (!row || hasUndecidedEarlierReview(database, row.token_id, row.broadcast_sequence)) return false;
        const inserted = database.prepare(`
          INSERT OR IGNORE INTO signal_outbox(outbox_id, broadcast_id, token_id, broadcast_sequence, payload, status, attempt_count, next_retry_at, last_error, claimed_by, claimed_at, claim_token, claim_generation, lease_expires_at, delivered_at, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?)
        `).run(`outbox:${row.broadcast_id}`, row.broadcast_id, row.token_id, row.broadcast_sequence, row.payload, input.decidedAt, input.decidedAt);
        if (inserted.changes !== 1) return false;
        database.prepare("UPDATE signal_outbox_migration_review SET status = 'approved', reviewed_at = ?, decision = 'approved', decided_by = ?, decision_reason = ?, decided_at = ? WHERE review_id = ?").run(input.decidedAt, input.operator.trim(), input.reason.trim(), input.decidedAt, input.reviewId);
        return true;
      });
    },

    skipLegacySignalOutbox(input) {
      return transaction(() => {
        if (!input.operator.trim() || !input.reason.trim()) return false;
        const row = database.prepare("SELECT token_id AS tokenId, broadcast_sequence AS broadcastSequence FROM signal_outbox_migration_review WHERE review_id = ? AND decision IS NULL").get(input.reviewId) as { tokenId: string; broadcastSequence: number } | undefined;
        if (!row || hasUndecidedEarlierReview(database, row.tokenId, row.broadcastSequence)) return false;
        return database.prepare("UPDATE signal_outbox_migration_review SET reviewed_at = ?, decision = 'skipped', decided_by = ?, decision_reason = ?, decided_at = ? WHERE review_id = ? AND decision IS NULL").run(input.decidedAt, input.operator.trim(), input.reason.trim(), input.decidedAt, input.reviewId).changes === 1;
      });
    },

    recordCollectorDeadLetter(input) {
      return database.prepare("INSERT OR IGNORE INTO collector_dead_letters(dead_letter_id, source_path, byte_offset, content_hash, error, raw_payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.deadLetterId, input.sourcePath, input.byteOffset, input.contentHash, input.error.slice(0, 2_048), input.rawPayload.slice(0, 4_096), input.recordedAt).changes === 1;
    },

    collectorDeadLetters(sourcePath) {
      const rows = database.prepare("SELECT dead_letter_id AS deadLetterId, source_path AS sourcePath, byte_offset AS byteOffset, content_hash AS contentHash, error, raw_payload AS rawPayload, recorded_at AS recordedAt FROM collector_dead_letters WHERE source_path = ? ORDER BY byte_offset").all(sourcePath) as unknown as CollectorDeadLetter[];
      return Object.freeze(rows.map(row => Object.freeze(row)));
    },

    broadcasts(tokenId) {
      const rows = database.prepare(`
        SELECT broadcast_id AS broadcastId, token_id AS tokenId, broadcast_number AS broadcastNumber,
          strategy_version AS strategyVersion, score, triggered_at AS triggeredAt, payload
        FROM broadcast_records
        WHERE token_id = ?
        ORDER BY broadcast_number
      `).all(tokenId) as Array<Omit<BroadcastRecord, "payload"> & { payload: string }>;
      return Object.freeze(rows.map(row => Object.freeze({ ...row, payload: JSON.parse(row.payload) as unknown })));
    },

    saveRuntimeQualitySnapshot(snapshot) {
      database.prepare("INSERT INTO runtime_quality_snapshots(payload, recorded_at) VALUES (?, ?)").run(JSON.stringify(snapshot), snapshot.recordedAt);
    },

    latestRuntimeQualitySnapshot() {
      const row = database.prepare("SELECT payload FROM runtime_quality_snapshots ORDER BY snapshot_id DESC LIMIT 1").get() as { payload: string } | undefined;
      return row ? Object.freeze(JSON.parse(row.payload) as RuntimeQualitySnapshot) : null;
    },

    saveOutcomeObservation(observation, observedAt) {
      database.prepare(`
        INSERT INTO outcome_observations(broadcast_id, horizon, payload, observed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(broadcast_id, horizon) DO UPDATE SET
          payload = excluded.payload,
          observed_at = excluded.observed_at
      `).run(observation.broadcastId, observation.horizon, JSON.stringify(observation), observedAt);
    },

    outcomesForBroadcast(broadcastId) {
      const rows = database.prepare(`
        SELECT payload FROM outcome_observations
        WHERE broadcast_id = ?
        ORDER BY CASE horizon WHEN '1h' THEN 1 WHEN '6h' THEN 2 WHEN '24h' THEN 3 WHEN '3d' THEN 4 WHEN '7d' THEN 5 END
      `).all(broadcastId) as Array<{ payload: string }>;
      return Object.freeze(rows.map(row => Object.freeze(JSON.parse(row.payload) as OutcomeObservation)));
    },

    enqueueIdentityResolution(input) {
      const handle = normalizeFomoHandle(input.handle);
      if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100) throw new Error("priority must be an integer between 0 and 100");
      assertTimestamp(input.observedAt, "observedAt");
      const existing = database.prepare("SELECT reasons FROM identity_resolution_queue WHERE handle = ?").get(handle) as { reasons: string } | undefined;
      const reasons = [...new Set([...(existing ? JSON.parse(existing.reasons) as string[] : []), input.reason])].sort();
      database.prepare(`
        INSERT INTO identity_resolution_queue(handle, account_id, priority, reasons, status, first_seen_at, last_seen_at, next_export_at, last_batch_id, resolved_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)
        ON CONFLICT(handle) DO UPDATE SET
          account_id = excluded.account_id,
          priority = MAX(identity_resolution_queue.priority, excluded.priority),
          reasons = excluded.reasons,
          last_seen_at = MAX(identity_resolution_queue.last_seen_at, excluded.last_seen_at)
      `).run(handle, input.accountId, input.priority, JSON.stringify(reasons), input.observedAt, input.observedAt, input.observedAt);
    },

    backfillUnresolvedIdentities() {
      const unresolved = database.prepare(`
        SELECT a.account_id AS accountId, a.handle, a.last_seen_at AS lastSeenAt,
          CASE
            WHEN EXISTS (SELECT 1 FROM leaderboard_observations l WHERE l.account_id = a.account_id AND l.window = '24h') THEN 90
            WHEN EXISTS (SELECT 1 FROM leaderboard_observations l WHERE l.account_id = a.account_id AND l.window = '30d') THEN 85
            ELSE 50
          END AS priority
        FROM fomo_accounts a
        WHERE EXISTS (SELECT 1 FROM entity_accounts ea WHERE ea.account_id = a.account_id)
          AND NOT EXISTS (SELECT 1 FROM wallet_identities w WHERE w.account_id = a.account_id)
      `).all() as Array<{ accountId: string; handle: string; lastSeenAt: number; priority: number }>;
      for (const item of unresolved) repository.enqueueIdentityResolution({
        handle: item.handle,
        accountId: item.accountId,
        priority: item.priority,
        reason: "missing_wallet_identity",
        observedAt: item.lastSeenAt,
      });
      return unresolved.length;
    },

    reconcileAutomaticIdentityResolutions(currentLeaderboardAccountIds) {
      return transaction(() => {
        const current = new Set(currentLeaderboardAccountIds);
        const removableReasons = new Set([
          "leaderboard_24h",
          "leaderboard_30d",
          "leaderboard_top100",
          "live_fomo_trader",
          "live_trade",
          "missing_wallet_identity",
        ]);
        const rows = database.prepare("SELECT handle, account_id AS accountId, reasons FROM identity_resolution_queue").all() as Array<{ handle: string; accountId: string; reasons: string }>;
        const removeBatchItems = database.prepare("DELETE FROM identity_resolution_batch_items WHERE handle = ?");
        const remove = database.prepare("DELETE FROM identity_resolution_queue WHERE handle = ?");
        let removed = 0;
        for (const row of rows) {
          const reasons = JSON.parse(row.reasons) as string[];
          if (current.has(row.accountId) || reasons.some(reason => !removableReasons.has(reason))) continue;
          removeBatchItems.run(row.handle);
          removed += Number(remove.run(row.handle).changes);
        }
        return removed;
      });
    },

    identityResolutionQueue(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
      const rows = database.prepare(`
        SELECT * FROM identity_resolution_queue
        ORDER BY CASE status WHEN 'conflict' THEN 0 WHEN 'pending' THEN 1 WHEN 'exported' THEN 2 WHEN 'not_found' THEN 3 ELSE 4 END,
          priority DESC, last_seen_at DESC, handle ASC
        LIMIT ?
      `).all(limit) as IdentityResolutionQueueRow[];
      return Object.freeze(rows.map(toIdentityResolutionQueueRecord));
    },

    pendingIdentityResolutions(now, limit) {
      assertTimestamp(now, "now");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
      const rows = database.prepare(`
        SELECT * FROM identity_resolution_queue
        WHERE status IN ('pending', 'exported', 'not_found') AND resolved_at IS NULL AND next_export_at <= ?
        ORDER BY priority DESC, first_seen_at ASC, handle ASC
        LIMIT ?
      `).all(now, limit) as IdentityResolutionQueueRow[];
      return Object.freeze(rows.map(toIdentityResolutionQueueRecord));
    },

    createIdentityResolutionBatch(input) {
      assertId(input.batchId, "batchId");
      assertTimestamp(input.createdAt, "createdAt");
      if (!Number.isSafeInteger(input.maxSize) || input.maxSize < 1 || input.maxSize > 50) throw new Error("maxSize must be between 1 and 50");
      if (!Number.isSafeInteger(input.cooldownMs) || input.cooldownMs < 1) throw new Error("cooldownMs must be positive");
      return transaction(() => {
        const eligible = repository.pendingIdentityResolutions(input.createdAt, input.maxSize);
        database.prepare("INSERT INTO identity_resolution_batches(batch_id, created_at, max_size, status, imported_at) VALUES (?, ?, ?, 'exported', NULL)").run(input.batchId, input.createdAt, input.maxSize);
        const insertItem = database.prepare("INSERT INTO identity_resolution_batch_items(batch_id, handle, ordinal) VALUES (?, ?, ?)");
        const markExported = database.prepare("UPDATE identity_resolution_queue SET status = 'exported', next_export_at = ?, last_batch_id = ? WHERE handle = ?");
        eligible.forEach((item, index) => {
          insertItem.run(input.batchId, item.handle, index + 1);
          markExported.run(input.createdAt + input.cooldownMs, input.batchId, item.handle);
        });
        return repository.identityResolutionBatch(input.batchId)!;
      });
    },

    identityResolutionBatch(batchId) {
      const batch = database.prepare("SELECT * FROM identity_resolution_batches WHERE batch_id = ?").get(batchId) as IdentityResolutionBatchRow | undefined;
      if (!batch) return null;
      const items = database.prepare(`
        SELECT q.* FROM identity_resolution_batch_items i
        JOIN identity_resolution_queue q ON q.handle = i.handle
        WHERE i.batch_id = ? ORDER BY i.ordinal
      `).all(batchId) as IdentityResolutionQueueRow[];
      return Object.freeze({ batchId: batch.batch_id, createdAt: batch.created_at, maxSize: batch.max_size, status: batch.status, importedAt: batch.imported_at, items: Object.freeze(items.map(toIdentityResolutionQueueRecord)) });
    },

    walletOwner(chainFamily, address) {
      const row = database.prepare("SELECT account_id AS accountId FROM wallet_identities WHERE chain_family = ? AND address = ? ORDER BY confidence DESC, first_observed_at ASC LIMIT 1").get(chainFamily, address) as { accountId: string } | undefined;
      return row?.accountId ?? null;
    },

    saveWalletMappingObservation(input) {
      database.prepare(`
        INSERT OR IGNORE INTO wallet_mapping_observations(
          observation_id, import_id, batch_id, handle, account_id, chain_family, address, provider, observed_at, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.observationId, input.importId, input.batchId, normalizeFomoHandle(input.handle), input.accountId, input.chainFamily, input.address, input.provider, input.observedAt, input.importedAt);
    },

    markIdentityResolution(handle, status, occurredAt) {
      markIdentityResolutionInTransaction(handle, status, occurredAt);
    },

    completeIdentityResolution(handle, accountId, occurredAt) {
      assertId(accountId, "accountId");
      assertTimestamp(occurredAt, "occurredAt");
      return transaction(() => completeIdentityResolutionInTransaction(handle, accountId, occurredAt));
    },

    completeAutomaticIdentityResolution(input) {
      assertTimestamp(input.occurredAt, "occurredAt");
      return transaction(() => {
        const handle = normalizeFomoHandle(input.cache.handle);
        const queued = database.prepare(`
          SELECT account_id AS accountId
          FROM identity_resolution_queue
          WHERE handle = ?
        `).get(handle) as { accountId: string } | undefined;
        if (!queued) throw new Error(`Identity resolution queue entry not found for ${handle}`);
        if (queued.accountId !== input.account.accountId) throw new Error(`Identity resolution account mismatch for ${handle}`);

        repository.upsertFomoAccount(input.account);
        const wallets = input.wallets.map((wallet) => ({
          ...wallet,
          address: normalizeWalletAddress(wallet.chainFamily, wallet.address),
        }));
        const conflictsByAddress = new Map<string, { wallet: WalletIdentityInput; owner: string; conflictId: string }>();
        for (const wallet of wallets) {
          const owner = repository.walletOwner(wallet.chainFamily, wallet.address);
          if (owner && owner !== input.account.accountId) {
            const key = `${wallet.chainFamily}:${wallet.address}`;
            conflictsByAddress.set(key, {
              wallet,
              owner,
              conflictId: `automatic-identity-conflict:${handle}:${wallet.chainFamily}:${wallet.address}:${owner}`,
            });
          }
        }
        const conflicts = [...conflictsByAddress.values()];

        for (const wallet of wallets) {
          if (!conflicts.some((conflict) => conflict.wallet.chainFamily === wallet.chainFamily && conflict.wallet.address === wallet.address)) {
            repository.attachWallet(wallet);
          }
        }

        if (conflicts.length > 0) {
          database.prepare("DELETE FROM identity_resolution_jobs WHERE handle = ?").run(handle);
          for (const conflict of conflicts) {
            database.prepare(`
              INSERT INTO identity_conflicts(
                conflict_id, handle, account_id, chain_family, address, conflicting_account_id,
                status, payload, created_at, resolved_at, resolution
              ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
              ON CONFLICT(conflict_id) DO UPDATE SET
                handle = excluded.handle,
                account_id = excluded.account_id,
                chain_family = excluded.chain_family,
                address = excluded.address,
                conflicting_account_id = excluded.conflicting_account_id,
                status = 'pending',
                payload = excluded.payload,
                created_at = excluded.created_at,
                resolved_at = NULL,
                resolution = NULL
            `).run(
              conflict.conflictId,
              handle,
              input.account.accountId,
              conflict.wallet.chainFamily,
              conflict.wallet.address,
              conflict.owner,
              JSON.stringify({ source: "fomoscan", observedAt: conflict.wallet.observedAt }),
              input.occurredAt,
            );
            const actionable = database.prepare("SELECT status FROM identity_conflicts WHERE conflict_id = ?").get(conflict.conflictId) as { status: IdentityConflictRecord["status"] } | undefined;
            if (actionable?.status !== "pending") throw new Error(`Identity conflict is not actionable: ${conflict.conflictId}`);
          }
          const updated = database.prepare(`
            UPDATE identity_resolution_queue
            SET status = 'conflict', resolved_at = NULL, next_export_at = ?
            WHERE handle = ? AND account_id = ?
          `).run(input.occurredAt + 12 * 60 * 60_000, handle, input.account.accountId);
          if (updated.changes !== 1) throw new Error(`Identity resolution queue update failed for ${handle}`);
          return Object.freeze({
            kind: "conflict" as const,
            conflicts: Object.freeze(conflicts.map((conflict) => Object.freeze({
              conflictId: conflict.conflictId,
              chainFamily: conflict.wallet.chainFamily,
              address: conflict.wallet.address,
              conflictingAccountId: conflict.owner,
            }))),
          });
        }

        repository.saveIdentityResolution(input.cache);
        return Object.freeze({
          kind: "completed" as const,
          entityId: completeIdentityResolutionInTransaction(input.cache.handle, input.account.accountId, input.occurredAt),
        });
      });
    },

    reconcileIdentityResolution(handle, accountId, occurredAt) {
      assertId(accountId, "accountId");
      assertTimestamp(occurredAt, "occurredAt");
      const queued = database.prepare("SELECT 1 AS found FROM identity_resolution_queue WHERE handle = ?").get(normalizeFomoHandle(handle));
      if (!queued) return null;
      return transaction(() => completeIdentityResolutionInTransaction(handle, accountId, occurredAt));
    },

    completeIdentityAdmission(accountId, occurredAt) {
      assertId(accountId, "accountId");
      assertTimestamp(occurredAt, "occurredAt");
      return transaction(() => completeIdentityAdmissionInTransaction(accountId, occurredAt));
    },

    markIdentityResolutionBatch(batchId, status, importedAt) {
      database.prepare("UPDATE identity_resolution_batches SET status = ?, imported_at = ? WHERE batch_id = ?").run(status, importedAt, batchId);
    },

    createIdentityConflict(input) {
      database.prepare(`
        INSERT OR IGNORE INTO identity_conflicts(conflict_id, handle, account_id, chain_family, address, conflicting_account_id, status, payload, created_at, resolved_at, resolution)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.conflictId, normalizeFomoHandle(input.handle), input.accountId, input.chainFamily, input.address, input.conflictingAccountId, input.status, JSON.stringify(input.payload), input.createdAt, input.resolvedAt, input.resolution);
    },

    identityConflicts(status) {
      const rows = (status
        ? database.prepare("SELECT * FROM identity_conflicts WHERE status = ? ORDER BY created_at, conflict_id").all(status)
        : database.prepare("SELECT * FROM identity_conflicts ORDER BY created_at, conflict_id").all()) as IdentityConflictRow[];
      return Object.freeze(rows.map(toIdentityConflictRecord));
    },

    resolveIdentityConflict(input) {
      assertId(input.conflictId, "conflictId");
      assertTimestamp(input.occurredAt, "occurredAt");
      const conflict = database.prepare("SELECT * FROM identity_conflicts WHERE conflict_id = ?").get(input.conflictId) as IdentityConflictRow | undefined;
      if (!conflict) return null;
      if (conflict.status !== "pending") return toIdentityConflictRecord(conflict);
      transaction(() => {
        if (input.decision === "accepted") {
          const address = normalizeWalletAddress(conflict.chain_family, conflict.address);
          database.prepare(`
            DELETE FROM wallet_identities
            WHERE chain_family = ? AND address = ? AND account_id <> ?
          `).run(conflict.chain_family, address, conflict.account_id);
          repository.attachWallet({ accountId: conflict.account_id, chainFamily: conflict.chain_family, address, confidence: "confirmed", source: "fomolens_manual_review", observedAt: input.occurredAt });
          completeIdentityResolutionInTransaction(conflict.handle, conflict.account_id, input.occurredAt);
        } else {
          markIdentityResolutionInTransaction(conflict.handle, "not_found", input.occurredAt);
        }
        database.prepare("UPDATE identity_conflicts SET status = ?, resolved_at = ?, resolution = ? WHERE conflict_id = ?")
          .run(input.decision, input.occurredAt, input.resolution, input.conflictId);
      });
      return repository.identityConflicts().find(item => item.conflictId === input.conflictId) ?? null;
    },

    reviewWalletAnalysisDecision(input) {
      assertId(input.analysisId, "analysisId");
      assertTimestamp(input.reviewedAt, "reviewedAt");
      return transaction(() => {
        const job = database.prepare(`
          SELECT analysis_id AS analysisId, chain_family AS chainFamily, address, status
          FROM wallet_analysis_jobs WHERE analysis_id = ?
        `).get(input.analysisId) as { analysisId: string; chainFamily: "solana" | "evm"; address: string; status: string } | undefined;
        if (!job) throw new Error("Wallet analysis not found");
        if (job.status !== "review_required") {
          if (input.decision === "accept" && job.status === "accepted") {
            const address = normalizeWalletAddress(job.chainFamily, job.address);
            const persisted = database.prepare(`
              SELECT ew.entity_id AS entityId, NULL AS accountId, NULL AS handle
              FROM entity_wallet_identities ew
              WHERE ew.chain_family = ? AND ew.address = ?
              UNION ALL
              SELECT ea.entity_id AS entityId, w.account_id AS accountId, f.handle
              FROM wallet_identities w
              JOIN entity_accounts ea ON ea.account_id = w.account_id
              JOIN fomo_accounts f ON f.account_id = w.account_id
              WHERE w.chain_family = ? AND w.address = ?
              LIMIT 1
            `).get(job.chainFamily, address, job.chainFamily, address) as { entityId: string; accountId: string | null; handle: string | null } | undefined;
            if (!persisted) throw new Error("Persisted wallet analysis admission is incomplete");
            const accountMatches = input.account
              ? persisted.accountId === input.account.accountId && persisted.handle?.toLowerCase() === input.account.handle.toLowerCase()
              : persisted.accountId === null;
            if (persisted.entityId !== input.entityId || !accountMatches) throw new Error("Review request does not match persisted admission");
            return Object.freeze({ status: "accepted" as const, entityId: persisted.entityId });
          }
          if (input.decision === "reject" && job.status === "rejected") return Object.freeze({ status: "rejected" as const });
          throw new Error(`Wallet analysis decision already finalized as ${job.status}`);
        }
        if (input.decision === "reject") {
          const updated = database.prepare("UPDATE wallet_analysis_jobs SET status = 'rejected', reviewed_at = ?, updated_at = ? WHERE analysis_id = ? AND status = 'review_required'").run(input.reviewedAt, input.reviewedAt, input.analysisId);
          if (updated.changes !== 1) throw new Error("Concurrent wallet analysis decision");
          repository.recordOperatorAudit({ auditId: `wallet-analysis-reject:${input.analysisId}`, action: "wallet_analysis.reject", actor: "developer", payload: { analysisId: input.analysisId }, occurredAt: input.reviewedAt });
          return Object.freeze({ status: "rejected" as const });
        }

        assertId(input.entityId, "entityId");
        const address = normalizeWalletAddress(job.chainFamily, job.address);
        const existingAccountEntity = input.account
          ? database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? ORDER BY confidence = 'confirmed' DESC, last_observed_at DESC LIMIT 1").get(input.account.accountId) as { entityId: string } | undefined
          : undefined;
        if (existingAccountEntity && existingAccountEntity.entityId !== input.entityId) {
          database.prepare(`
            INSERT OR IGNORE INTO wallet_identity_conflicts(
              conflict_id, analysis_id, chain_family, address, requested_entity_id,
              conflicting_entity_id, status, payload, created_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
          `).run(`wallet-analysis-account-conflict:${input.analysisId}:${existingAccountEntity.entityId}`, input.analysisId, job.chainFamily, address, input.entityId, existingAccountEntity.entityId, JSON.stringify({ source: "wallet_analysis_review", account: input.account }), input.reviewedAt);
          return Object.freeze({ status: "conflict" as const, conflictingEntityId: existingAccountEntity.entityId, conflictingAccountId: input.account!.accountId });
        }
        const directOwner = database.prepare("SELECT entity_id AS entityId FROM entity_wallet_identities WHERE chain_family = ? AND address = ?").get(job.chainFamily, address) as { entityId: string } | undefined;
        const rawAccountOwner = database.prepare("SELECT account_id AS accountId FROM wallet_identities WHERE chain_family = ? AND address = ? ORDER BY confidence DESC, first_observed_at LIMIT 1").get(job.chainFamily, address) as { accountId: string } | undefined;
        const accountOwner = database.prepare(`
          SELECT ea.entity_id AS entityId, w.account_id AS accountId
          FROM wallet_identities w JOIN entity_accounts ea ON ea.account_id = w.account_id
          WHERE w.chain_family = ? AND w.address = ? ORDER BY w.confidence DESC LIMIT 1
        `).get(job.chainFamily, address) as { entityId: string; accountId: string } | undefined;
        if (input.account && rawAccountOwner && rawAccountOwner.accountId !== input.account.accountId) {
          repository.upsertFomoAccount({ accountId: input.account.accountId, handle: input.account.handle, firstSeenAt: input.reviewedAt, lastSeenAt: input.reviewedAt });
          repository.createIdentityConflict({ conflictId: `wallet-analysis-conflict:${input.analysisId}:${rawAccountOwner.accountId}`, handle: input.account.handle, accountId: input.account.accountId, chainFamily: job.chainFamily, address, conflictingAccountId: rawAccountOwner.accountId, status: "pending", payload: { analysisId: input.analysisId, source: "wallet_analysis_review" }, createdAt: input.reviewedAt, resolvedAt: null, resolution: null });
          return Object.freeze({ status: "conflict" as const, conflictingEntityId: accountOwner?.entityId ?? rawAccountOwner.accountId, conflictingAccountId: rawAccountOwner.accountId });
        }
        const conflictingEntityId = directOwner?.entityId !== input.entityId ? directOwner?.entityId
          : accountOwner?.entityId !== input.entityId ? accountOwner?.entityId : undefined;
        if (conflictingEntityId) {
          database.prepare(`
            INSERT OR IGNORE INTO wallet_identity_conflicts(
              conflict_id, analysis_id, chain_family, address, requested_entity_id,
              conflicting_entity_id, status, payload, created_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
          `).run(`wallet-analysis-conflict:${input.analysisId}:${conflictingEntityId}`, input.analysisId, job.chainFamily, address, input.entityId, conflictingEntityId, JSON.stringify({ source: "wallet_analysis_review", account: input.account ?? null }), input.reviewedAt);
          return Object.freeze({ status: "conflict" as const, conflictingEntityId, ...(accountOwner?.accountId ? { conflictingAccountId: accountOwner.accountId } : {}) });
        }

        repository.ensureTraderEntity({ entityId: input.entityId, lifecycle: "candidate", manual: true, locked: false, createdAt: input.reviewedAt, updatedAt: input.reviewedAt });
        if (input.account) {
          repository.upsertFomoAccount({ accountId: input.account.accountId, handle: input.account.handle, firstSeenAt: input.reviewedAt, lastSeenAt: input.reviewedAt });
          repository.saveWalletMappingObservation({ observationId: `wallet-analysis:${input.analysisId}:${input.account.accountId}`, importId: `wallet-analysis:${input.analysisId}`, batchId: null, handle: input.account.handle, accountId: input.account.accountId, chainFamily: job.chainFamily, address, provider: "wallet_analysis_review", observedAt: input.reviewedAt, importedAt: input.reviewedAt });
          repository.linkAccountToEntity({ accountId: input.account.accountId, entityId: input.entityId, confidence: "confirmed", source: "wallet_analysis_review", observedAt: input.reviewedAt });
          repository.attachWallet({ accountId: input.account.accountId, chainFamily: job.chainFamily, address, confidence: "confirmed", source: "wallet_analysis_review", observedAt: input.reviewedAt });
          const admitted = completeIdentityAdmissionInTransaction(input.account.accountId, input.reviewedAt);
          if (admitted !== input.entityId) throw new Error("Unable to complete wallet analysis admission");
        } else {
          admitDirectEntityWalletInTransaction(input.entityId, job.chainFamily, address, input.reviewedAt);
        }
        const updated = database.prepare("UPDATE wallet_analysis_jobs SET status = 'accepted', reviewed_at = ?, updated_at = ? WHERE analysis_id = ? AND status = 'review_required'").run(input.reviewedAt, input.reviewedAt, input.analysisId);
        if (updated.changes !== 1) throw new Error("Concurrent wallet analysis decision");
        repository.recordOperatorAudit({ auditId: `wallet-analysis-accept:${input.analysisId}`, action: "wallet_analysis.accept", actor: "developer", payload: { analysisId: input.analysisId, accountId: input.account?.accountId ?? null, entityId: input.entityId }, occurredAt: input.reviewedAt });
        return Object.freeze({ status: "accepted" as const, entityId: input.entityId });
      });
    },

    recordOperatorAudit(input) {
      database.prepare("INSERT INTO operator_audit_log(audit_id, action, actor, payload, occurred_at) VALUES (?, ?, ?, ?, ?)").run(input.auditId, input.action, input.actor, JSON.stringify(input.payload), input.occurredAt);
    },

    runInTransaction(operation) {
      return transaction(operation);
    },

    close() {
      database.close();
    },
  };
  return Object.freeze(repository);
}

function validateTraderEvent(event: TraderEvent): void {
  for (const [field, value] of Object.entries({ eventId: event.eventId, accountId: event.accountId, entityId: event.entityId, chain: event.chain, tokenAddress: event.tokenAddress })) assertId(value, field);
  assertTimestamp(event.occurredAt, "occurredAt");
  assertTimestamp(event.collectedAt, "collectedAt");
  for (const [field, value] of Object.entries({ amountUsd: event.amountUsd, priceUsd: event.priceUsd, marketCapUsd: event.marketCapUsd, tokenAgeMs: event.tokenAgeMs })) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${field} must be null or a non-negative number`);
  }
}

function assertId(value: string, field: string): void {
  if (!value.trim() || value.length > 256) throw new Error(`${field} must be non-empty and at most 256 characters`);
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
}

function toTraderEvent(row: TraderEventRow): TraderEvent {
  return Object.freeze({
    eventId: row.event_id,
    accountId: row.account_id,
    entityId: row.entity_id,
    chain: row.chain,
    tokenAddress: row.token_address,
    side: row.side,
    amountUsd: row.amount_usd,
    priceUsd: row.price_usd,
    marketCapUsd: row.market_cap_usd,
    tokenAgeMs: row.token_age_ms,
    occurredAt: row.occurred_at,
    collectedAt: row.collected_at,
    source: row.source,
  });
}

type AccountRow = { account_id: string; handle: string; first_seen_at: number; last_seen_at: number };
type WalletRow = { account_id: string; chain_family: WalletIdentityInput["chainFamily"]; address: string; confidence: WalletIdentityInput["confidence"]; source: string; first_observed_at: number; last_observed_at: number };
type CandidateDiscoveryRow = { discovery_id: string; account_id: string; discovery_type: string; payload: string; discovered_at: number };
type TraderScoreRow = { snapshot_id: string; entity_id: string; strategy_version: string; window: TraderScoreSnapshot["window"]; quality: number; components: string; sample_count: number; recorded_at: number };
type LifecycleEventRow = { lifecycle_event_id: string; entity_id: string; previous_state: TraderEntityInput["lifecycle"]; next_state: TraderEntityInput["lifecycle"]; reasons: string; strategy_version: string; occurred_at: number };
type IdentityResolutionRow = { handle: string; status: IdentityResolutionCache["status"]; account_id: string | null; expires_at: number; next_attempt_at: number; attempt_count: number; payload: string | null; updated_at: number };
type TraderEventRow = { event_id: string; account_id: string; entity_id: string; chain: string; token_address: string; side: TraderEvent["side"]; amount_usd: number | null; price_usd: number | null; market_cap_usd: number | null; token_age_ms: number | null; occurred_at: number; collected_at: number; source: TraderEvent["source"] };
type TraderEntityRow = { entity_id: string; lifecycle: TraderEntityInput["lifecycle"]; manual: number; locked: number; created_at: number; updated_at: number };
type TraderTokenSampleRow = { sample_id: string; entity_id: string; chain: string; token_address: string; first_buy_at: number; last_activity_at: number; weighted_entry_price_usd: number | null; weighted_entry_market_cap_usd: number | null; total_buy_usd: number; total_sell_usd: number; realized_value_usd: number; remaining_cost_usd: number; launch_at: number | null; lifecycle_stage_at_entry: string; source_state: TraderTokenSample["sourceState"]; sample_status: TraderTokenSample["sampleStatus"]; exclusion_reason: string | null; created_at: number; updated_at: number };
type MarketObservationRow = { observed_at: number; price_usd: number; source: string };
type TraderTokenOutcomeRow = { sample_id: string; horizon: TraderTokenOutcome["horizon"]; target_at: number; observed_at: number | null; close_multiple: number | null; mfe_multiple: number | null; mae_multiple: number | null; captured_multiple: number | null; hit_1_5x: number | null; hit_2x: number | null; hit_5x: number | null; hit_10x: number | null; time_to_1_5x_ms: number | null; time_to_2x_ms: number | null; time_to_5x_ms: number | null; time_to_10x_ms: number | null; coverage_status: TraderTokenOutcome["coverageStatus"]; source: string | null; computed_at: number };
type TraderAbilitySnapshotRow = { snapshot_id: string; entity_id: string; window: TraderAbilityWindow; as_of: number; strategy_version: string; raw_quality: number; adjusted_quality: number; sample_confidence: number; coverage_confidence: number; metrics: string; components: string; styles: string; created_at: number };
type TraderBackfillJobRow = { job_id: string; entity_id: string; status: TraderBackfillJob["status"]; cursor: string | null; attempt_count: number; coverage: string; last_error: string | null; next_attempt_at: number; completed_at: number | null; created_at: number; updated_at: number };

function toTraderTokenSample(row: TraderTokenSampleRow): TraderTokenSample {
  return Object.freeze({ sampleId: row.sample_id, entityId: row.entity_id, chain: row.chain, tokenAddress: row.token_address, firstBuyAt: row.first_buy_at, lastActivityAt: row.last_activity_at, weightedEntryPriceUsd: row.weighted_entry_price_usd, weightedEntryMarketCapUsd: row.weighted_entry_market_cap_usd, totalBuyUsd: row.total_buy_usd, totalSellUsd: row.total_sell_usd, realizedValueUsd: row.realized_value_usd, remainingCostUsd: row.remaining_cost_usd, launchAt: row.launch_at, lifecycleStageAtEntry: row.lifecycle_stage_at_entry, sourceState: row.source_state, sampleStatus: row.sample_status, exclusionReason: row.exclusion_reason, createdAt: row.created_at, updatedAt: row.updated_at });
}

function toTraderTokenOutcome(row: TraderTokenOutcomeRow): TraderTokenOutcome {
  return Object.freeze({ sampleId: row.sample_id, horizon: row.horizon, targetAt: row.target_at, observedAt: row.observed_at, closeMultiple: row.close_multiple, mfeMultiple: row.mfe_multiple, maeMultiple: row.mae_multiple, capturedMultiple: row.captured_multiple, hit1_5x: toNullableBoolean(row.hit_1_5x), hit2x: toNullableBoolean(row.hit_2x), hit5x: toNullableBoolean(row.hit_5x), hit10x: toNullableBoolean(row.hit_10x), timeTo1_5xMs: row.time_to_1_5x_ms, timeTo2xMs: row.time_to_2x_ms, timeTo5xMs: row.time_to_5x_ms, timeTo10xMs: row.time_to_10x_ms, coverageStatus: row.coverage_status, source: row.source, computedAt: row.computed_at });
}

function toTraderAbilitySnapshot(row: TraderAbilitySnapshotRow): TraderAbilitySnapshot {
  return Object.freeze({ snapshotId: row.snapshot_id, entityId: row.entity_id, window: row.window, asOf: row.as_of, strategyVersion: row.strategy_version, rawQuality: row.raw_quality, adjustedQuality: row.adjusted_quality, sampleConfidence: row.sample_confidence, coverageConfidence: row.coverage_confidence, metrics: Object.freeze(JSON.parse(row.metrics) as Record<string, number>), components: Object.freeze(JSON.parse(row.components) as Record<string, number>), styles: Object.freeze(JSON.parse(row.styles) as Record<string, number>), createdAt: row.created_at });
}

function toTraderBackfillJob(row: TraderBackfillJobRow): TraderBackfillJob {
  return Object.freeze({ jobId: row.job_id, entityId: row.entity_id, status: row.status, cursor: row.cursor, attemptCount: row.attempt_count, coverage: Object.freeze(JSON.parse(row.coverage) as Record<string, number>), lastError: row.last_error, nextAttemptAt: row.next_attempt_at, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at });
}

function nullableBoolean(value: boolean | null): number | null {
  return value === null ? null : Number(value);
}

function toNullableBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

type IdentityResolutionQueueRow = {
  handle: string;
  account_id: string;
  priority: number;
  reasons: string;
  status: IdentityResolutionQueueRecord["status"];
  first_seen_at: number;
  last_seen_at: number;
  next_export_at: number;
  last_batch_id: string | null;
  resolved_at: number | null;
};

type IdentityResolutionBatchRow = {
  batch_id: string;
  created_at: number;
  max_size: number;
  status: IdentityResolutionBatchRecord["status"];
  imported_at: number | null;
};

function toIdentityResolutionQueueRecord(row: IdentityResolutionQueueRow): IdentityResolutionQueueRecord {
  return Object.freeze({
    handle: row.handle,
    accountId: row.account_id,
    priority: row.priority,
    reasons: Object.freeze(JSON.parse(row.reasons) as string[]),
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    nextExportAt: row.next_export_at,
    lastBatchId: row.last_batch_id,
    resolvedAt: row.resolved_at,
  });
}

type IdentityConflictRow = {
  conflict_id: string;
  handle: string;
  account_id: string;
  chain_family: IdentityConflictRecord["chainFamily"];
  address: string;
  conflicting_account_id: string;
  status: IdentityConflictRecord["status"];
  payload: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
};

function toIdentityConflictRecord(row: IdentityConflictRow): IdentityConflictRecord {
  return Object.freeze({
    conflictId: row.conflict_id,
    handle: row.handle,
    accountId: row.account_id,
    chainFamily: row.chain_family,
    address: row.address,
    conflictingAccountId: row.conflicting_account_id,
    status: row.status,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  });
}
export type MilestoneBackfillSource = "local_journal" | "fomo_token_page";
export type MilestoneBackfillStatus = "pending" | "running" | "completed" | "partial" | "failed" | "unavailable";
export type MilestoneCoverageStatus = "complete" | "partial" | "unavailable";
export interface TokenMilestoneRecord { readonly milestoneId: string; readonly chain: string; readonly tokenAddress: string; readonly marketCapUsd: number; readonly reachedAt: number; readonly payload: string; }
export interface MilestoneBackfillJob { readonly jobId: string; readonly milestoneId: string; readonly chain: string; readonly tokenAddress: string; readonly status: MilestoneBackfillStatus; readonly source: MilestoneBackfillSource; readonly cursor: string | null; readonly attemptCount: number; readonly nextAttemptAt: number; readonly coverageStartAt: number | null; readonly coverageEndAt: number | null; readonly recordsSeen: number; readonly recordsInserted: number; readonly lastError: string | null; readonly createdAt: number; readonly updatedAt: number; readonly completedAt: number | null; }
export interface MilestoneBackfillCompletion { readonly coverageStartAt: number | null; readonly coverageEndAt: number | null; readonly recordsSeen: number; readonly recordsInserted: number; readonly status: "completed" | "partial"; readonly completedAt: number; }
export interface MilestoneEvaluation { readonly evaluationId: string; readonly milestoneId: string; readonly strategyVersion: string; readonly eventWatermark: number; readonly eligibleBuyCount: number; readonly evaluatedAccountCount: number; readonly qualifiedCandidateCount: number; readonly coverageStatus: MilestoneCoverageStatus; readonly evaluatedAt: number; }
export type HistoricalBackfillQueryKind = "token_universe" | "milestone_crossings" | "pre_milestone_trades";
export type HistoricalBackfillStatus = "pending" | "running" | "completed" | "failed";
export interface HistoricalBackfillPartition { readonly partitionId: string; readonly queryKind: HistoricalBackfillQueryKind; readonly chain: string; readonly dayStart: number; readonly dayEnd: number; readonly tokenAddresses: readonly string[]; readonly status: HistoricalBackfillStatus; readonly executionId: string | null; readonly nextOffset: number | null; readonly rowCount: number; readonly attemptCount: number; readonly watermark: number | null; readonly nextRetryAt: number; readonly leaseExpiresAt: number | null; readonly lastError: string | null; readonly createdAt: number; readonly updatedAt: number; readonly completedAt: number | null; }

const toMilestoneBackfillJob = (row: Record<string, unknown>): MilestoneBackfillJob => Object.freeze({ jobId: row.job_id as string, milestoneId: row.milestone_id as string, chain: row.chain as string, tokenAddress: row.token_address as string, status: row.status as MilestoneBackfillJob["status"], source: row.source as MilestoneBackfillJob["source"], cursor: row.cursor as string | null, attemptCount: row.attempt_count as number, nextAttemptAt: row.next_attempt_at as number, coverageStartAt: row.coverage_start_at as number | null, coverageEndAt: row.coverage_end_at as number | null, recordsSeen: row.records_seen as number, recordsInserted: row.records_inserted as number, lastError: row.last_error as string | null, createdAt: row.created_at as number, updatedAt: row.updated_at as number, completedAt: row.completed_at as number | null });
const toMilestoneEvaluation = (row: Record<string, unknown>): MilestoneEvaluation => Object.freeze({ evaluationId: row.evaluation_id as string, milestoneId: row.milestone_id as string, strategyVersion: row.strategy_version as string, eventWatermark: row.event_watermark as number, eligibleBuyCount: row.eligible_buy_count as number, evaluatedAccountCount: row.evaluated_account_count as number, qualifiedCandidateCount: row.qualified_candidate_count as number, coverageStatus: row.coverage_status as MilestoneEvaluation["coverageStatus"], evaluatedAt: row.evaluated_at as number });
const toHistoricalBackfillPartition = (row: Record<string, unknown>): HistoricalBackfillPartition => Object.freeze({ partitionId: row.partition_id as string, queryKind: row.query_kind as HistoricalBackfillQueryKind, chain: row.chain as string, dayStart: row.day_start as number, dayEnd: row.day_end as number, tokenAddresses: Object.freeze(JSON.parse(row.token_addresses as string) as string[]), status: row.status as HistoricalBackfillStatus, executionId: row.execution_id as string | null, nextOffset: row.next_offset as number | null, rowCount: row.row_count as number, attemptCount: row.attempt_count as number, watermark: row.watermark as number | null, nextRetryAt: row.next_retry_at as number, leaseExpiresAt: row.lease_expires_at as number | null, lastError: row.last_error as string | null, createdAt: row.created_at as number, updatedAt: row.updated_at as number, completedAt: row.completed_at as number | null });
import type { DatabaseSync } from "node:sqlite";
