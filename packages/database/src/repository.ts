import { DatabaseSync } from "node:sqlite";

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
  type TraderAbilityWindow,
  type TraderBackfillJob,
  type TraderEntityInput,
  type TraderEvent,
  type TraderScoreSnapshot,
  type TraderTokenOutcome,
  type TraderTokenSample,
  type WalletIdentityInput,
} from "@address-radar/domain";
import { migrateAddressRadarDatabase } from "./migrations.js";

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
export interface TokenAggregationStateRecord { readonly tokenId: string; readonly chain: string; readonly tokenAddress: string; readonly currentScore: number; readonly peakScore: number; readonly broadcastCount: number; readonly updatedAt: number; readonly consumedEvidenceIds: readonly string[] }
export interface TokenEvaluationRecord { readonly tokenId: string; readonly chain: string; readonly tokenAddress: string; readonly action: "observe" | "broadcast" | "rebroadcast"; readonly signalFamily: AddressSignalFamily | null; readonly lifecycleStage: TokenLifecycleStage; readonly score: number; readonly participantCount: number; readonly totalBuyUsd: number; readonly sourceState: AddressEvidenceSourceState; readonly windowMs: number; readonly missingConditions: readonly string[]; readonly updatedAt: number }
export interface BroadcastRecord { readonly broadcastId: string; readonly tokenId: string; readonly broadcastNumber: number; readonly strategyVersion: string; readonly score: number; readonly triggeredAt: number; readonly payload: unknown }
export interface CommitTokenBroadcastInput { readonly chain: string; readonly tokenAddress: string; readonly expectedPreviousBroadcastCount: number; readonly strategyVersion: string; readonly score: number; readonly triggeredAt: number; readonly evidenceIds: readonly string[]; readonly payload: unknown }
export interface CommitTokenBroadcastResult { readonly inserted: boolean; readonly broadcastNumber: number }
export interface IdentityResolutionQueueInput { readonly handle: string; readonly accountId: string; readonly priority: number; readonly reason: string; readonly observedAt: number }
export interface IdentityResolutionQueueRecord { readonly handle: string; readonly accountId: string; readonly priority: number; readonly reasons: readonly string[]; readonly status: "pending" | "exported" | "resolved" | "not_found" | "conflict"; readonly firstSeenAt: number; readonly lastSeenAt: number; readonly nextExportAt: number; readonly lastBatchId: string | null; readonly resolvedAt: number | null }
export interface IdentityResolutionBatchRecord { readonly batchId: string; readonly createdAt: number; readonly maxSize: number; readonly status: "exported" | "partially_imported" | "imported"; readonly importedAt: number | null; readonly items: readonly IdentityResolutionQueueRecord[] }
export interface WalletMappingObservationInput { readonly observationId: string; readonly importId: string; readonly batchId: string | null; readonly handle: string; readonly accountId: string; readonly chainFamily: "solana" | "evm"; readonly address: string; readonly provider: string; readonly observedAt: number; readonly importedAt: number }
export interface IdentityConflictRecord { readonly conflictId: string; readonly handle: string; readonly accountId: string; readonly chainFamily: "solana" | "evm"; readonly address: string; readonly conflictingAccountId: string; readonly status: "pending" | "accepted" | "rejected"; readonly payload: unknown; readonly createdAt: number; readonly resolvedAt: number | null; readonly resolution: string | null }

export interface AddressRadarRepository {
  upsertFomoAccount(input: FomoAccountInput): void;
  attachWallet(input: WalletIdentityInput): void;
  account(accountId: string): FomoAccount | null;
  accountByHandle(handle: string): FomoAccount | null;
  entityForAccount(accountId: string): string | null;
  upsertTraderEntity(input: TraderEntityInput): void;
  ensureTraderEntity(input: TraderEntityInput): void;
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
  completeIdentityAdmission(accountId: string, occurredAt: number): string | null;
  markIdentityResolutionBatch(batchId: string, status: "partially_imported" | "imported", importedAt: number): void;
  createIdentityConflict(input: IdentityConflictRecord): void;
  identityConflicts(status?: IdentityConflictRecord["status"]): readonly IdentityConflictRecord[];
  resolveIdentityConflict(input: { readonly conflictId: string; readonly decision: "accepted" | "rejected"; readonly resolution: string; readonly occurredAt: number }): IdentityConflictRecord | null;
  recordOperatorAudit(input: { readonly auditId: string; readonly action: string; readonly actor: string; readonly payload: unknown; readonly occurredAt: number }): void;
  close(): void;
}

export function openAddressRadarRepository(databasePath: string): AddressRadarRepository {
  const database = new DatabaseSync(databasePath);
  migrateAddressRadarDatabase(database);

  const transaction = <T>(operation: () => T): T => {
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
    database.prepare(`
      INSERT OR IGNORE INTO monitoring_registry_outbox(event_id, entity_id, event_type, payload, status, created_at, published_at)
      VALUES (?, ?, 'identity.updated', ?, 'published', ?, ?)
    `).run(`identity-registry:${entity.entityId}:${occurredAt}`, entity.entityId, JSON.stringify({ entityId: entity.entityId, accountId, lifecycle: nextLifecycle }), occurredAt, occurredAt);
    database.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(occurredAt);
    return entity.entityId;
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

    admitLeaderboardTrader(input) {
      assertId(input.entityId, "entityId");
      assertId(input.accountId, "accountId");
      assertTimestamp(input.observedAt, "observedAt");
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
      if (result.changes === 1) {
        const sourceFamily = event.source === "onchain_wallet" ? "onchain" : "fomo";
        const sourceStatus = sourceFamily === "onchain" ? "ONCHAIN_ONLY" : "FOMO_ONLY";
        const observationId = `observation:${event.eventId}`;
        database.prepare(`
          INSERT OR IGNORE INTO raw_trader_observations(
            observation_id, event_id, entity_id, source_family, chain, token_address,
            side, amount_usd, occurred_at, payload, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(observationId, event.eventId, event.entityId, sourceFamily, event.chain.toLowerCase(), normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress), event.side, event.amountUsd, event.occurredAt, JSON.stringify(event), event.collectedAt);
        const candidates = database.prepare(`
          SELECT canonical_event_id AS canonicalEventId, amount_usd AS amountUsd, source_status AS sourceStatus
          FROM canonical_trader_events
          WHERE entity_id = ? AND chain = ? AND token_address = ? AND side = ?
            AND occurred_at BETWEEN ? AND ?
          ORDER BY ABS(occurred_at - ?) ASC
        `).all(event.entityId, event.chain.toLowerCase(), normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress), event.side, event.occurredAt - 30_000, event.occurredAt + 30_000, event.occurredAt) as Array<{ canonicalEventId: string; amountUsd: number | null; sourceStatus: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN" }>;
        const opposite = sourceFamily === "onchain" ? "FOMO_ONLY" : "ONCHAIN_ONLY";
        const matched = candidates.find(candidate => candidate.sourceStatus === opposite && compatibleEconomicAmount(candidate.amountUsd, event.amountUsd));
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

    saveTokenEvaluation(input) {
      const tokenId = addressRadarTokenId(input.chain, input.tokenAddress);
      database.prepare(`
        INSERT INTO token_evaluation_state(
          token_id, chain, token_address, action, signal_family, lifecycle_stage,
          score, participant_count, total_buy_usd, source_state, window_ms,
          missing_conditions, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.updatedAt,
      );
    },

    tokenEvaluationState(chain, tokenAddress) {
      const row = database.prepare(`
        SELECT token_id AS tokenId, chain, token_address AS tokenAddress, action,
          signal_family AS signalFamily, lifecycle_stage AS lifecycleStage, score,
          participant_count AS participantCount, total_buy_usd AS totalBuyUsd,
          source_state AS sourceState, window_ms AS windowMs,
          missing_conditions AS missingConditions, updated_at AS updatedAt
        FROM token_evaluation_state
        WHERE token_id = ?
      `).get(addressRadarTokenId(chain, tokenAddress)) as (Omit<TokenEvaluationRecord, "missingConditions"> & { missingConditions: string }) | undefined;
      return row ? Object.freeze({ ...row, missingConditions: Object.freeze(JSON.parse(row.missingConditions) as string[]) }) : null;
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
      return Object.freeze({ ...row, consumedEvidenceIds: Object.freeze(consumed.map(item => item.eventId)) });
    },

    commitTokenBroadcast(input) {
      return transaction(() => {
        const tokenId = addressRadarTokenId(input.chain, input.tokenAddress);
        const current = database.prepare("SELECT broadcast_count AS broadcastCount FROM token_aggregation_state WHERE token_id = ?").get(tokenId) as { broadcastCount: number } | undefined;
        const currentCount = current?.broadcastCount ?? 0;
        if (currentCount !== input.expectedPreviousBroadcastCount || input.evidenceIds.length === 0) {
          return Object.freeze({ inserted: false, broadcastNumber: currentCount });
        }
        const alreadyConsumed = input.evidenceIds.some(eventId => database.prepare("SELECT 1 FROM evidence_consumption WHERE event_id = ?").get(eventId));
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
        return Object.freeze({ inserted: true, broadcastNumber });
      });
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
      return transaction(() => {
        markIdentityResolutionInTransaction(handle, "resolved", occurredAt);
        return completeIdentityAdmissionInTransaction(accountId, occurredAt);
      });
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
          repository.attachWallet({ accountId: conflict.account_id, chainFamily: conflict.chain_family, address: conflict.address, confidence: "confirmed", source: "fomolens_manual_review", observedAt: input.occurredAt });
          markIdentityResolutionInTransaction(conflict.handle, "resolved", input.occurredAt);
          completeIdentityAdmissionInTransaction(conflict.account_id, input.occurredAt);
        } else {
          markIdentityResolutionInTransaction(conflict.handle, "not_found", input.occurredAt);
        }
        database.prepare("UPDATE identity_conflicts SET status = ?, resolved_at = ?, resolution = ? WHERE conflict_id = ?")
          .run(input.decision, input.occurredAt, input.resolution, input.conflictId);
      });
      return repository.identityConflicts().find(item => item.conflictId === input.conflictId) ?? null;
    },

    recordOperatorAudit(input) {
      database.prepare("INSERT INTO operator_audit_log(audit_id, action, actor, payload, occurred_at) VALUES (?, ?, ?, ?, ?)").run(input.auditId, input.action, input.actor, JSON.stringify(input.payload), input.occurredAt);
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

function compatibleEconomicAmount(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / scale <= 0.05;
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

const toMilestoneBackfillJob = (row: Record<string, unknown>): MilestoneBackfillJob => Object.freeze({ jobId: row.job_id as string, milestoneId: row.milestone_id as string, chain: row.chain as string, tokenAddress: row.token_address as string, status: row.status as MilestoneBackfillJob["status"], source: row.source as MilestoneBackfillJob["source"], cursor: row.cursor as string | null, attemptCount: row.attempt_count as number, nextAttemptAt: row.next_attempt_at as number, coverageStartAt: row.coverage_start_at as number | null, coverageEndAt: row.coverage_end_at as number | null, recordsSeen: row.records_seen as number, recordsInserted: row.records_inserted as number, lastError: row.last_error as string | null, createdAt: row.created_at as number, updatedAt: row.updated_at as number, completedAt: row.completed_at as number | null });
const toMilestoneEvaluation = (row: Record<string, unknown>): MilestoneEvaluation => Object.freeze({ evaluationId: row.evaluation_id as string, milestoneId: row.milestone_id as string, strategyVersion: row.strategy_version as string, eventWatermark: row.event_watermark as number, eligibleBuyCount: row.eligible_buy_count as number, evaluatedAccountCount: row.evaluated_account_count as number, qualifiedCandidateCount: row.qualified_candidate_count as number, coverageStatus: row.coverage_status as MilestoneEvaluation["coverageStatus"], evaluatedAt: row.evaluated_at as number });
