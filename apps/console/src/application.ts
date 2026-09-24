import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { normalizeFomoHandle, normalizeWalletAddress } from "@address-radar/domain";
import { analyzeWalletPositions, type WalletAnalysisPosition } from "@address-radar/domain";
import { migrateAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";

import { createManualResolutionService } from "@address-radar/identity";


export interface ConsoleResult {
  readonly status: number;
  readonly body: unknown;
}

export interface AddressConsoleApplication {
  handle(method: string, pathname: string, body?: unknown): ConsoleResult;
  subscribe(listener: (event: unknown) => void): () => void;
  close(): void;
}

const allowedStates = new Set(["candidate", "probation", "active", "elite", "degraded", "suspended"]);
const allowedTagCategories = ["source", "ability", "style"] as const;

const typedTags = (input: Record<string, unknown>, category: typeof allowedTagCategories[number]): string[] => {
  const value = input[`${category}Tags`];
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim().toLowerCase())
    .filter(item => item.startsWith(`${category}.`) && item.length <= 96))];
};

const stringList = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))]
  : [];

export const createAddressConsoleApplication = (databasePath = ":memory:"): AddressConsoleApplication => {
  const database = new DatabaseSync(databasePath);
  migrateAddressRadarDatabase(database);
  const resolutionRepository = openAddressRadarRepository(databasePath);
  const resolutionService = createManualResolutionService({ repository: resolutionRepository });
  const listeners = new Set<(event: unknown) => void>();

  const rows = (sql: string, ...params: SQLInputValue[]): unknown[] => database.prepare(sql).all(...params);
  const audit = (action: string, payload: unknown): void => {
    const event = { auditId: randomUUID(), action, actor: "developer", payload, occurredAt: Date.now() };
    database.prepare("INSERT INTO operator_audit_log(audit_id, action, actor, payload, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.auditId, event.action, event.actor, JSON.stringify(payload), event.occurredAt);
    for (const listener of listeners) listener(event);
  };

  const read = (pathname: string): ConsoleResult | null => {
    if (pathname === "/api/v1/overview") {
      const count = (table: string): number => Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
      const delivered = Number((database.prepare("SELECT COUNT(*) AS count FROM broadcast_records").get() as { count: number }).count);
      const formalTraders = Number((database.prepare("SELECT COUNT(*) AS count FROM trader_entities WHERE lifecycle IN ('probation', 'active', 'elite', 'degraded') OR manual = 1 OR locked = 1").get() as { count: number }).count);
      const candidateCount = Number((database.prepare(`
        SELECT COUNT(DISTINCT d.account_id) AS count
        FROM candidate_discoveries d
        JOIN entity_accounts ea ON ea.account_id = d.account_id
        JOIN trader_entities e ON e.entity_id = ea.entity_id
        WHERE e.lifecycle = 'candidate'
      `).get() as { count: number }).count);
      return { status: 200, body: { traders: formalTraders, candidates: candidateCount, aggregations: count("token_evaluation_state"), broadcasts: delivered, outcomes: delivered } };
    }
    if (pathname === "/api/v1/traders") return { status: 200, body: rows(`
      SELECT e.entity_id AS entityId, e.lifecycle,
        CASE e.lifecycle WHEN 'probation' THEN 'observing' ELSE e.lifecycle END AS lifecycleStatus,
        e.manual, e.locked, e.updated_at AS updatedAt,
        p.display_name AS displayName, p.priority, p.notes, p.monitoring_enabled AS monitoringEnabled,
        GROUP_CONCAT(DISTINCT CASE WHEN ea.source != 'manual_wallet' THEN a.handle END) AS handles,
        (SELECT GROUP_CONCAT(w.address, '|') FROM entity_accounts eaw JOIN wallet_identities w ON w.account_id = eaw.account_id WHERE eaw.entity_id = e.entity_id AND w.chain_family = 'solana') AS solanaAddresses,
        (SELECT GROUP_CONCAT(w.address, '|') FROM entity_accounts eaw JOIN wallet_identities w ON w.account_id = eaw.account_id WHERE eaw.entity_id = e.entity_id AND w.chain_family = 'evm') AS evmAddresses,
        (SELECT GROUP_CONCAT(DISTINCT lo.window) FROM entity_accounts eal JOIN leaderboard_observations lo ON lo.account_id = eal.account_id WHERE eal.entity_id = e.entity_id) AS leaderboardWindows,
        (SELECT GROUP_CONCAT(DISTINCT d.discovery_type) FROM entity_accounts ead JOIN candidate_discoveries d ON d.account_id = ead.account_id WHERE ead.entity_id = e.entity_id) AS discoveryTypes,
        (SELECT GROUP_CONCAT(tag, '|') FROM trader_tags t WHERE t.entity_id = e.entity_id AND t.category = 'source') AS sourceTags,
        (SELECT GROUP_CONCAT(tag, '|') FROM trader_tags t WHERE t.entity_id = e.entity_id AND t.category = 'ability') AS abilityTags,
        (SELECT GROUP_CONCAT(tag, '|') FROM trader_tags t WHERE t.entity_id = e.entity_id AND t.category = 'style') AS styleTags,
        COALESCE(
          (SELECT adjusted_quality FROM trader_ability_snapshots s WHERE s.entity_id = e.entity_id ORDER BY as_of DESC LIMIT 1),
          (SELECT quality FROM trader_score_snapshots s WHERE s.entity_id = e.entity_id ORDER BY recorded_at DESC LIMIT 1)
        ) AS quality,
        COALESCE(
          (SELECT json_extract(metrics, '$.validSamples') FROM trader_ability_snapshots s WHERE s.entity_id = e.entity_id ORDER BY as_of DESC LIMIT 1),
          (SELECT sample_count FROM trader_score_snapshots s WHERE s.entity_id = e.entity_id ORDER BY recorded_at DESC LIMIT 1)
        ) AS sampleCount
      FROM trader_entities e
      LEFT JOIN trader_profiles p ON p.entity_id = e.entity_id
      LEFT JOIN entity_accounts ea ON ea.entity_id = e.entity_id
      LEFT JOIN fomo_accounts a ON a.account_id = ea.account_id
      WHERE e.lifecycle IN ('probation', 'active', 'elite', 'degraded') OR e.manual = 1 OR e.locked = 1
      GROUP BY e.entity_id
      ORDER BY COALESCE(quality, -1) DESC, e.updated_at DESC
    `) };
    const traderMatch = pathname.match(/^\/api\/v1\/traders\/([^/]+)$/);
    if (traderMatch) {
      const entityId = decodeURIComponent(traderMatch[1] ?? "");
      const entity = database.prepare("SELECT e.entity_id AS entityId, e.lifecycle, CASE e.lifecycle WHEN 'probation' THEN 'observing' ELSE e.lifecycle END AS lifecycleStatus, e.manual, e.locked, e.created_at AS createdAt, e.updated_at AS updatedAt, p.display_name AS displayName, p.priority, p.notes, p.monitoring_enabled AS monitoringEnabled FROM trader_entities e LEFT JOIN trader_profiles p ON p.entity_id = e.entity_id WHERE e.entity_id = ?").get(entityId);
      if (!entity) return { status: 404, body: { error: "trader_not_found" } };
      return { status: 200, body: {
        entity,
        accounts: rows(`SELECT a.account_id AS accountId, CASE WHEN ea.source = 'manual_wallet' THEN NULL ELSE a.handle END AS handle, ea.confidence, ea.source FROM entity_accounts ea JOIN fomo_accounts a ON a.account_id = ea.account_id WHERE ea.entity_id = ?`, entityId),
        wallets: rows(`SELECT w.chain_family AS chainFamily, w.address, w.confidence, w.source, w.last_observed_at AS lastObservedAt FROM entity_accounts ea JOIN wallet_identities w ON w.account_id = ea.account_id WHERE ea.entity_id = ?`, entityId),
        tags: rows("SELECT category, tag, created_at AS createdAt FROM trader_tags WHERE entity_id = ? ORDER BY category, tag", entityId),
        leaderboards: rows(`SELECT a.handle, l.window, l.rank, l.profit_usd AS profitUsd, l.observed_at AS observedAt FROM entity_accounts ea JOIN fomo_accounts a ON a.account_id = ea.account_id JOIN leaderboard_observations l ON l.account_id = ea.account_id WHERE ea.entity_id = ? ORDER BY l.observed_at DESC, l.rank ASC LIMIT 100`, entityId),
        discoveries: rows(`SELECT a.handle, d.discovery_type AS discoveryType, d.payload, d.discovered_at AS discoveredAt FROM entity_accounts ea JOIN fomo_accounts a ON a.account_id = ea.account_id JOIN candidate_discoveries d ON d.account_id = ea.account_id WHERE ea.entity_id = ? ORDER BY d.discovered_at DESC`, entityId),
        lifecycleEvents: rows(`SELECT previous_state AS previousState, next_state AS nextState, reasons, strategy_version AS strategyVersion, occurred_at AS occurredAt FROM trader_lifecycle_events WHERE entity_id = ? ORDER BY occurred_at DESC`, entityId),
        scores: rows("SELECT snapshot_id AS snapshotId, strategy_version AS strategyVersion, window, quality, components, sample_count AS sampleCount, recorded_at AS recordedAt FROM trader_score_snapshots WHERE entity_id = ? ORDER BY recorded_at DESC", entityId),
        abilitySnapshots: rows("SELECT snapshot_id AS snapshotId, window, as_of AS asOf, strategy_version AS strategyVersion, raw_quality AS rawQuality, adjusted_quality AS adjustedQuality, sample_confidence AS sampleConfidence, coverage_confidence AS coverageConfidence, metrics, components, styles, created_at AS createdAt FROM trader_ability_snapshots WHERE entity_id = ? ORDER BY as_of DESC", entityId),
        tokenSamples: rows("SELECT sample_id AS sampleId, chain, token_address AS tokenAddress, first_buy_at AS firstBuyAt, last_activity_at AS lastActivityAt, weighted_entry_price_usd AS weightedEntryPriceUsd, weighted_entry_market_cap_usd AS weightedEntryMarketCapUsd, total_buy_usd AS totalBuyUsd, total_sell_usd AS totalSellUsd, lifecycle_stage_at_entry AS lifecycleStageAtEntry, source_state AS sourceState, sample_status AS sampleStatus, exclusion_reason AS exclusionReason FROM trader_token_samples WHERE entity_id = ? ORDER BY first_buy_at DESC", entityId),
        tokenOutcomes: rows("SELECT o.sample_id AS sampleId, o.horizon, o.close_multiple AS closeMultiple, o.mfe_multiple AS mfeMultiple, o.mae_multiple AS maeMultiple, o.captured_multiple AS capturedMultiple, o.hit_2x AS hit2x, o.hit_5x AS hit5x, o.hit_10x AS hit10x, o.coverage_status AS coverageStatus, o.computed_at AS computedAt FROM trader_token_outcomes o JOIN trader_token_samples s ON s.sample_id = o.sample_id WHERE s.entity_id = ? ORDER BY o.computed_at DESC, o.target_at DESC", entityId),
        events: rows("SELECT event_id AS eventId, chain, token_address AS tokenAddress, side, amount_usd AS amountUsd, market_cap_usd AS marketCapUsd, occurred_at AS occurredAt, source FROM trader_events WHERE entity_id = ? ORDER BY occurred_at DESC LIMIT 200", entityId),
      } };
    }
    if (pathname === "/api/v1/candidates") return { status: 200, body: rows(`
      SELECT d.account_id AS accountId, a.handle, e.entity_id AS entityId, e.lifecycle,
        GROUP_CONCAT(DISTINCT d.discovery_type) AS discoveryTypes,
        GROUP_CONCAT(DISTINCT json_extract(d.payload, '$.chain')) AS chains,
        (SELECT d2.discovery_type FROM candidate_discoveries d2
          WHERE d2.account_id = d.account_id
          ORDER BY COALESCE(CAST(json_extract(d2.payload, '$.tierRank') AS INTEGER), 0) DESC, d2.discovered_at DESC
          LIMIT 1) AS strongestEvidenceType,
        COUNT(DISTINCT LOWER(json_extract(d.payload, '$.chain')) || ':' ||
          CASE WHEN LOWER(json_extract(d.payload, '$.chain')) = 'solana'
            THEN json_extract(d.payload, '$.tokenAddress')
            ELSE LOWER(json_extract(d.payload, '$.tokenAddress')) END) AS distinctTokenCount,
        COUNT(DISTINCT d.discovery_id) AS progressionRecordCount,
        MAX(CAST(json_extract(d.payload, '$.maximumOpportunity') AS REAL)) AS strongestOpportunityMultiple,
        MAX(d.discovered_at) AS discoveredAt,
        (SELECT GROUP_CONCAT(w.address, '|') FROM wallet_identities w WHERE w.account_id = d.account_id AND w.chain_family = 'solana') AS solanaAddresses,
        (SELECT GROUP_CONCAT(w.address, '|') FROM wallet_identities w WHERE w.account_id = d.account_id AND w.chain_family = 'evm') AS evmAddresses
      FROM candidate_discoveries d
      JOIN fomo_accounts a ON a.account_id = d.account_id
      JOIN entity_accounts ea ON ea.account_id = d.account_id
      JOIN trader_entities e ON e.entity_id = ea.entity_id
      WHERE e.lifecycle = 'candidate'
      GROUP BY d.account_id, a.handle, e.entity_id, e.lifecycle
      ORDER BY discoveredAt DESC
    `) };
    if (pathname === "/api/v1/backtests") return { status: 200, body: rows(`
      SELECT snapshot_id AS snapshotId, entity_id AS entityId, strategy_version AS strategyVersion,
        window, raw_quality AS rawQuality, adjusted_quality AS adjustedQuality,
        sample_confidence AS sampleConfidence, coverage_confidence AS coverageConfidence,
        json_extract(metrics, '$.validSamples') AS validSamples,
        json_extract(metrics, '$.hit10xRate') AS hit10xRate,
        metrics, components, styles, as_of AS asOf
      FROM trader_ability_snapshots ORDER BY as_of DESC LIMIT 500
    `) };
    if (pathname === "/api/v1/aggregations") return { status: 200, body: rows(`
      SELECT e.token_id AS tokenId, e.chain, e.token_address AS tokenAddress,
        e.action, e.signal_family AS signalFamily, e.lifecycle_stage AS lifecycleStage,
        e.score AS currentScore, e.participant_count AS participantCount,
        e.total_buy_usd AS totalBuyUsd, e.source_state AS sourceState,
        e.window_ms AS windowMs, e.missing_conditions AS missingConditions,
        (SELECT GROUP_CONCAT(DISTINCT fa.handle)
          FROM address_signal_evidence se
          JOIN entity_accounts ea ON ea.entity_id = se.entity_id
          JOIN fomo_accounts fa ON fa.account_id = ea.account_id
          WHERE se.chain = e.chain AND se.token_address = e.token_address
            AND se.occurred_at >= e.updated_at - e.window_ms
        ) AS participantHandles,
        COALESCE(a.broadcast_count, 0) AS broadcastCount, e.updated_at AS updatedAt
      FROM token_evaluation_state e
      LEFT JOIN token_aggregation_state a ON a.token_id = e.token_id
      ORDER BY e.updated_at DESC LIMIT 500
    `) };
    const aggregationMatch = pathname.match(/^\/api\/v1\/aggregations\/([^/]+)\/([^/]+)$/);
    if (aggregationMatch) {
      const chain = decodeURIComponent(aggregationMatch[1] ?? "");
      const tokenAddress = decodeURIComponent(aggregationMatch[2] ?? "");
      const aggregation = database.prepare("SELECT token_id AS tokenId, chain, token_address AS tokenAddress, current_score AS currentScore, peak_score AS peakScore, broadcast_count AS broadcastCount, updated_at AS updatedAt FROM token_aggregation_state WHERE chain = ? AND token_address = ?").get(chain, tokenAddress) as { tokenId: string } | undefined;
      if (!aggregation) return { status: 404, body: { error: "aggregation_not_found" } };
      return { status: 200, body: { aggregation, broadcasts: rows("SELECT broadcast_id AS broadcastId, broadcast_number AS broadcastNumber, strategy_version AS strategyVersion, score, triggered_at AS triggeredAt, payload FROM broadcast_records WHERE token_id = ? ORDER BY broadcast_number", aggregation.tokenId) } };
    }
    if (pathname === "/api/v1/outcomes") return { status: 200, body: database.prepare(`
      SELECT broadcast_number AS sequence, broadcast_id AS signalId, token_id AS tokenId,
        json_extract(payload, '$.publicSignal.category') AS opportunityType,
        score AS overallScore, triggered_at AS publishedAt, payload
      FROM broadcast_records ORDER BY triggered_at DESC, broadcast_number DESC LIMIT 500
    `).all() };
    if (pathname === "/api/v1/milestone-backfills/summary") {
      const summary = database.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable
        FROM milestone_backfill_jobs
      `).get() as Record<string, number | null>;
      const evaluation = database.prepare(`
        SELECT COUNT(DISTINCT milestone_id) AS evaluated,
          COALESCE(SUM(qualified_candidate_count), 0) AS qualifiedCandidates,
          MAX(evaluated_at) AS latestEvaluatedAt
        FROM milestone_evaluations
        WHERE evaluation_id IN (SELECT evaluation_id FROM milestone_evaluations e2 WHERE e2.milestone_id = milestone_evaluations.milestone_id ORDER BY evaluated_at DESC LIMIT 1)
      `).get() as Record<string, number | null>;
      return { status: 200, body: Object.fromEntries([...Object.entries(summary), ...Object.entries(evaluation)].map(([key, value]) => [key, Number(value ?? 0)])) };
    }
    if (pathname === "/api/v1/milestone-backfills") return { status: 200, body: rows(`
      SELECT j.job_id AS jobId, j.milestone_id AS milestoneId, j.chain, j.token_address AS tokenAddress,
        j.status, j.source, j.attempt_count AS attemptCount, j.coverage_start_at AS coverageStartAt,
        j.coverage_end_at AS coverageEndAt, j.records_seen AS recordsSeen, j.records_inserted AS recordsInserted,
        j.last_error AS lastError, j.updated_at AS updatedAt, j.completed_at AS completedAt,
        m.market_cap_usd AS milestoneMarketCapUsd, m.reached_at AS reachedAt,
        (SELECT e.coverage_status FROM milestone_evaluations e WHERE e.milestone_id = j.milestone_id ORDER BY e.evaluated_at DESC LIMIT 1) AS coverageStatus,
        (SELECT e.eligible_buy_count FROM milestone_evaluations e WHERE e.milestone_id = j.milestone_id ORDER BY e.evaluated_at DESC LIMIT 1) AS eligibleBuyCount,
        (SELECT e.qualified_candidate_count FROM milestone_evaluations e WHERE e.milestone_id = j.milestone_id ORDER BY e.evaluated_at DESC LIMIT 1) AS qualifiedCandidateCount,
        (SELECT e.evaluated_at FROM milestone_evaluations e WHERE e.milestone_id = j.milestone_id ORDER BY e.evaluated_at DESC LIMIT 1) AS evaluatedAt,
        (SELECT MAX(CAST(json_extract(d.payload, '$.maximumOpportunity') AS REAL)) FROM candidate_discoveries d WHERE json_extract(d.payload, '$.chain') = j.chain AND json_extract(d.payload, '$.tokenAddress') = j.token_address) AS highestProvenMultiple
      FROM milestone_backfill_jobs j
      JOIN token_milestones m ON m.milestone_id = j.milestone_id
      ORDER BY m.reached_at DESC, j.created_at DESC
    `) };
    if (pathname === "/api/v1/identity-queue") {
      return { status: 200, body: resolutionRepository.identityResolutionQueue(500) };
}
    if (pathname === "/api/v1/identity-conflicts") return { status: 200, body: resolutionRepository.identityConflicts() };
    if (pathname === "/api/v1/monitoring-registry") {
      const summary = database.prepare(`
        SELECT
          COUNT(DISTINCT w.account_id || ':' || w.chain_family || ':' || w.address) AS walletCount,
          COUNT(DISTINCT CASE WHEN w.chain_family = 'evm' THEN w.account_id || ':' || w.address END) AS evmWalletCount,
          COUNT(DISTINCT CASE WHEN w.chain_family = 'solana' THEN w.account_id || ':' || w.address END) AS solanaWalletCount,
          MAX(w.last_observed_at) AS latestWalletUpdateAt
        FROM wallet_identities w
        JOIN entity_accounts ea ON ea.account_id = w.account_id
        JOIN trader_entities e ON e.entity_id = ea.entity_id
        WHERE e.lifecycle != 'suspended'
      `).get() as Record<string, number | null>;
      const outbox = database.prepare(`
        SELECT COUNT(*) AS eventCount,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
          MAX(published_at) AS latestPublishedAt
        FROM monitoring_registry_outbox
      `).get() as Record<string, number | null>;
      const registry = database.prepare("SELECT version, updated_at AS updatedAt FROM monitoring_registry_state WHERE singleton = 1").get() as Record<string, number | null> | undefined;
      const consumer = database.prepare("SELECT applied_version AS appliedVersion, applied_at AS appliedAt FROM monitoring_registry_consumers WHERE consumer = 'wallet-monitor'").get() as Record<string, number | null> | undefined;
      const body = Object.fromEntries([...Object.entries(summary), ...Object.entries(outbox), ...Object.entries(registry ?? {}), ...Object.entries(consumer ?? {})].map(([key, value]) => [key, Number(value ?? 0)]));
      return { status: 200, body: { ...body, syncPending: Number(body.version ?? 0) > Number(body.appliedVersion ?? 0) } };
    }
    if (pathname === "/api/v1/wallet-analyses") return { status: 200, body: rows(`
      SELECT analysis_id AS analysisId, chain_family AS chainFamily, address, display_name AS displayName,
        fomo_handle AS fomoHandle, status, requested_sample_count AS requestedSampleCount,
        valid_sample_count AS validSampleCount, coverage_rate AS coverageRate, metrics,
        last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt, reviewed_at AS reviewedAt
      FROM wallet_analysis_jobs ORDER BY created_at DESC LIMIT 500
    `) };
    if (pathname === "/api/v1/config") return { status: 200, body: rows("SELECT strategy_version AS strategyVersion, payload, created_at AS createdAt FROM strategy_config_versions ORDER BY created_at DESC") };
    if (pathname === "/api/v1/audit") return { status: 200, body: rows("SELECT audit_id AS auditId, action, actor, payload, occurred_at AS occurredAt FROM operator_audit_log ORDER BY occurred_at DESC LIMIT 500") };
    return null;
  };

  return {
    handle(method, pathname, body) {
      if (method === "GET") return read(pathname) ?? { status: 404, body: { error: "not_found" } };
      const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
      if (method === "POST" && pathname === "/api/v1/identity-batches") {
        const maxSize = typeof input.maxSize === "number" ? input.maxSize : 25;
        try {
          const result = resolutionService.createBatch({ batchId: typeof input.batchId === "string" && input.batchId.trim() ? input.batchId.trim() : randomUUID(), maxSize });
          return { status: 201, body: result };
        } catch (error) {
          return { status: 400, body: { error: error instanceof Error ? error.message : "invalid_batch_request" } };
        }
      }
      if (method === "POST" && pathname === "/api/v1/identity-imports") {
        if (typeof input.batchId !== "string" || !Array.isArray(input.items)) return { status: 400, body: { error: "batch_id_and_items_required" } };
        try {
          const result = resolutionService.importMappings({
            importId: typeof input.importId === "string" && input.importId.trim() ? input.importId.trim() : randomUUID(),
            batchId: input.batchId,
            importedAt: Date.now(),
            items: input.items as Parameters<typeof resolutionService.importMappings>[0]["items"],
          });
          return { status: 200, body: result };
        } catch (error) {
          return { status: 400, body: { error: error instanceof Error ? error.message : "invalid_identity_import" } };
        }
      }
      if (method === "POST" && pathname === "/api/v1/identity-imports/direct") {
        if (!Array.isArray(input.items) || input.items.length === 0) return { status: 400, body: { error: "identity_items_required" } };
        try {
          const importedAt = Date.now();
          const items = input.items.map(item => {
            const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
            const handle = typeof record.handle === "string" ? record.handle : "";
            const wallets: { family: "evm" | "solana"; address: string }[] = [];
            if (typeof record.evmAddress === "string" && record.evmAddress.trim()) wallets.push({ family: "evm", address: record.evmAddress });
            if (typeof record.solanaAddress === "string" && record.solanaAddress.trim()) wallets.push({ family: "solana", address: record.solanaAddress });
            return { handle, observedAt: importedAt, source: "fomolens_manual" as const, wallets };
          });
          return { status: 200, body: resolutionService.importDirectMappings({ importId: randomUUID(), importedAt, items }) };
        } catch (error) {
          return { status: 400, body: { error: error instanceof Error ? error.message : "invalid_identity_import" } };
        }
      }
      if (method === "POST" && pathname === "/api/v1/wallet-analyses") {
        const chainFamily = input.chainFamily === "evm" || input.chainFamily === "solana" ? input.chainFamily : null;
        const address = typeof input.address === "string" && chainFamily ? normalizeWalletAddress(chainFamily, input.address) : "";
        const requestedSampleCount = typeof input.requestedSampleCount === "number" ? input.requestedSampleCount : 300;
        if (!chainFamily || !address) return { status: 400, body: { error: "chain_family_and_address_required" } };
        if (!Number.isSafeInteger(requestedSampleCount) || requestedSampleCount < 1 || requestedSampleCount > 300) return { status: 400, body: { error: "requested_sample_count_invalid" } };
        const now = Date.now();
        const analysisId = randomUUID();
        const positions = Array.isArray(input.positions) ? input.positions as WalletAnalysisPosition[] : null;
        const metrics = positions ? analyzeWalletPositions({ requestedSamples: requestedSampleCount, positions }) : null;
        const status = metrics ? metrics.validSamples > 0 ? "review_required" : "insufficient_data" : "collecting";
        database.prepare(`
          INSERT INTO wallet_analysis_jobs(
            analysis_id, chain_family, address, display_name, fomo_handle, status,
            requested_sample_count, valid_sample_count, coverage_rate, metrics, last_error,
            created_at, updated_at, reviewed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
        `).run(
          analysisId,
          chainFamily,
          address,
          typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : null,
          typeof input.fomoHandle === "string" && input.fomoHandle.trim() ? normalizeFomoHandle(input.fomoHandle) : null,
          status,
          requestedSampleCount,
          metrics?.validSamples ?? 0,
          metrics?.coverageRate ?? 0,
          metrics ? JSON.stringify(metrics) : null,
          now,
          now,
        );
        audit("wallet_analysis.create", { analysisId, chainFamily, address, requestedSampleCount, status });
        return { status: 201, body: { analysisId, chainFamily, address, status, metrics } };
      }
      const walletAnalysisResultMatch = pathname.match(/^\/api\/v1\/wallet-analyses\/([^/]+)\/result$/);
      if (method === "PUT" && walletAnalysisResultMatch) {
        if (!Array.isArray(input.positions)) return { status: 400, body: { error: "positions_required" } };
        const analysisId = decodeURIComponent(walletAnalysisResultMatch[1] ?? "");
        const job = database.prepare("SELECT requested_sample_count AS requestedSampleCount FROM wallet_analysis_jobs WHERE analysis_id = ?").get(analysisId) as { requestedSampleCount: number } | undefined;
        if (!job) return { status: 404, body: { error: "wallet_analysis_not_found" } };
        const metrics = analyzeWalletPositions({ requestedSamples: job.requestedSampleCount, positions: input.positions as WalletAnalysisPosition[] });
        const status = metrics.validSamples > 0 ? "review_required" : "insufficient_data";
        const now = Date.now();
        database.prepare("UPDATE wallet_analysis_jobs SET status = ?, valid_sample_count = ?, coverage_rate = ?, metrics = ?, last_error = NULL, updated_at = ? WHERE analysis_id = ?")
          .run(status, metrics.validSamples, metrics.coverageRate, JSON.stringify(metrics), now, analysisId);
        audit("wallet_analysis.result", { analysisId, status, validSamples: metrics.validSamples, coverageRate: metrics.coverageRate });
        return { status: 200, body: { analysisId, status, metrics } };
      }
      const walletAnalysisAcceptMatch = pathname.match(/^\/api\/v1\/wallet-analyses\/([^/]+)\/accept$/);
      if (method === "POST" && walletAnalysisAcceptMatch) {
        const analysisId = decodeURIComponent(walletAnalysisAcceptMatch[1] ?? "");
        const entityId = typeof input.entityId === "string" ? input.entityId.trim() : "";
        if (!entityId) return { status: 400, body: { error: "entity_id_required" } };
        const account = database.prepare("SELECT account_id AS accountId FROM entity_accounts WHERE entity_id = ? ORDER BY last_observed_at DESC LIMIT 1").get(entityId) as { accountId: string } | undefined;
        if (!account) return { status: 404, body: { error: "trader_not_found" } };
        const job = database.prepare("SELECT chain_family AS chainFamily, address, status FROM wallet_analysis_jobs WHERE analysis_id = ?").get(analysisId) as { chainFamily: "evm" | "solana"; address: string; status: string } | undefined;
        if (!job) return { status: 404, body: { error: "wallet_analysis_not_found" } };
        if (job.status !== "review_required") return { status: 409, body: { error: "wallet_analysis_not_reviewable" } };
        const owner = resolutionRepository.walletOwner(job.chainFamily, job.address);
        if (owner && owner !== account.accountId) return { status: 409, body: { error: "wallet_identity_conflict", chainFamily: job.chainFamily, address: job.address } };
        const now = Date.now();
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare("INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, ?, 'confirmed', 'manual_analysis', ?, ?) ON CONFLICT(account_id, chain_family, address) DO UPDATE SET confidence = 'confirmed', source = 'manual_analysis', last_observed_at = excluded.last_observed_at")
            .run(account.accountId, job.chainFamily, job.address, now, now);
          database.prepare("UPDATE trader_profiles SET monitoring_enabled = 1, onchain_monitoring_enabled = 1, updated_at = ? WHERE entity_id = ?").run(now, entityId);
          database.prepare("UPDATE trader_entities SET lifecycle = CASE WHEN lifecycle = 'candidate' THEN 'probation' ELSE lifecycle END, updated_at = ? WHERE entity_id = ?").run(now, entityId);
          database.prepare("UPDATE wallet_analysis_jobs SET status = 'accepted', reviewed_at = ?, updated_at = ? WHERE analysis_id = ?").run(now, now, analysisId);
          database.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(now);
          database.prepare("INSERT INTO monitoring_registry_outbox(event_id, entity_id, event_type, payload, status, created_at, published_at) VALUES (?, ?, 'wallet_analysis.accepted', ?, 'published', ?, ?)")
            .run(randomUUID(), entityId, JSON.stringify({ analysisId, entityId, accountId: account.accountId, wallet: { family: job.chainFamily, address: job.address } }), now, now);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        audit("wallet_analysis.accept", { analysisId, entityId, chainFamily: job.chainFamily, address: job.address });
        return { status: 200, body: { analysisId, entityId, status: "accepted", monitoringEnabled: true } };
      }
      const walletAnalysisDecisionMatch = pathname.match(/^\/api\/v1\/wallet-analyses\/([^/]+)\/(reject|insufficient)$/);
      if (method === "POST" && walletAnalysisDecisionMatch) {
        const analysisId = decodeURIComponent(walletAnalysisDecisionMatch[1] ?? "");
        const status = walletAnalysisDecisionMatch[2] === "reject" ? "rejected" : "insufficient_data";
        const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
        const now = Date.now();
        const changed = database.prepare("UPDATE wallet_analysis_jobs SET status = ?, last_error = ?, reviewed_at = ?, updated_at = ? WHERE analysis_id = ? AND status IN ('review_required', 'collecting', 'insufficient_data')")
          .run(status, reason, now, now, analysisId).changes;
        if (!changed) return { status: 409, body: { error: "wallet_analysis_not_reviewable" } };
        audit("wallet_analysis.review", { analysisId, status, reason });
        return { status: 200, body: { analysisId, status } };
      }
      const conflictMatch = pathname.match(/^\/api\/v1\/identity-conflicts\/([^/]+)$/);
      if (method === "PUT" && conflictMatch) {
        const decision = input.decision;
        if (decision !== "accepted" && decision !== "rejected") return { status: 400, body: { error: "invalid_conflict_decision" } };
        const conflictId = decodeURIComponent(conflictMatch[1] ?? "");
        const resolution = typeof input.resolution === "string" && input.resolution.trim() ? input.resolution.trim() : `developer_${decision}`;
        const conflict = resolutionRepository.resolveIdentityConflict({ conflictId, decision, resolution, occurredAt: Date.now() });
        if (!conflict) return { status: 404, body: { error: "identity_conflict_not_found" } };
        audit("identity.conflict_resolve", { conflictId, decision, resolution });
        return { status: 200, body: conflict };
      }
      if (method === "POST" && pathname === "/api/v1/traders/manual") {
        const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
        const rawHandle = typeof input.fomoHandle === "string" ? input.fomoHandle.trim() : typeof input.handle === "string" ? input.handle.trim() : "";
        const evmAddresses = stringList(input.evmAddresses ?? (typeof input.evmAddress === "string" ? [input.evmAddress] : []));
        const solanaAddresses = stringList(input.solanaAddresses ?? (typeof input.solanaAddress === "string" ? [input.solanaAddress] : []));
        if (!displayName) return { status: 400, body: { error: "display_name_required" } };
        if (!rawHandle && evmAddresses.length === 0 && solanaAddresses.length === 0) return { status: 400, body: { error: "identity_required" } };
        const now = Date.now();
        const identityId = randomUUID();
        const handle = rawHandle ? normalizeFomoHandle(rawHandle) : `wallet-${identityId}`;
        const existingAccount = rawHandle ? database.prepare("SELECT account_id AS accountId FROM fomo_accounts WHERE handle = ? COLLATE NOCASE").get(handle) as { accountId: string } | undefined : undefined;
        const accountId = typeof input.accountId === "string" ? input.accountId : existingAccount?.accountId ?? `manual-account:${identityId}`;
        const existingEntity = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? ORDER BY last_observed_at DESC LIMIT 1").get(accountId) as { entityId: string } | undefined;
        const entityId = typeof input.entityId === "string" ? input.entityId : existingEntity?.entityId ?? `manual-entity:${identityId}`;
        const wallets = [
          ...evmAddresses.map(address => ({ family: "evm" as const, address: normalizeWalletAddress("evm", address) })),
          ...solanaAddresses.map(address => ({ family: "solana" as const, address: normalizeWalletAddress("solana", address) })),
        ];
        for (const wallet of wallets) {
          const owner = resolutionRepository.walletOwner(wallet.family, wallet.address);
          if (owner && owner !== accountId) return { status: 409, body: { error: "wallet_identity_conflict", chainFamily: wallet.family, address: wallet.address } };
        }
        const priority = input.priority === "important" ? "important" : "normal";
        const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null;
        const tags: Array<{ category: typeof allowedTagCategories[number]; tag: string }> = allowedTagCategories.flatMap(category => typedTags(input, category).map(tag => ({ category, tag })));
        if (!tags.some(item => item.category === "source")) tags.push({ category: "source", tag: "source.manual" });
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare("INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET handle = excluded.handle, last_seen_at = excluded.last_seen_at").run(accountId, handle, now, now);
          database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES (?, 'probation', 1, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET manual = 1, locked = excluded.locked, lifecycle = CASE WHEN trader_entities.lifecycle = 'candidate' THEN 'probation' ELSE trader_entities.lifecycle END, updated_at = excluded.updated_at").run(entityId, Number(priority === "important"), now, now);
          database.prepare("INSERT INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, 'confirmed', ?, ?, ?) ON CONFLICT(entity_id, account_id) DO UPDATE SET confidence = 'confirmed', source = excluded.source, last_observed_at = excluded.last_observed_at").run(entityId, accountId, rawHandle ? "manual" : "manual_wallet", now, now);
          database.prepare("INSERT INTO trader_profiles(entity_id, display_name, priority, notes, monitoring_enabled, fomo_monitoring_enabled, onchain_monitoring_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET display_name = excluded.display_name, priority = excluded.priority, notes = excluded.notes, monitoring_enabled = 1, fomo_monitoring_enabled = excluded.fomo_monitoring_enabled, onchain_monitoring_enabled = excluded.onchain_monitoring_enabled, updated_at = excluded.updated_at")
            .run(entityId, displayName, priority, notes, Number(Boolean(rawHandle)), Number(wallets.length > 0), now, now);
          const attach = database.prepare("INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, ?, 'confirmed', 'manual', ?, ?) ON CONFLICT(account_id, chain_family, address) DO UPDATE SET confidence = 'confirmed', source = 'manual', last_observed_at = excluded.last_observed_at");
          for (const wallet of wallets) attach.run(accountId, wallet.family, wallet.address, now, now);
          const addTag = database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, ?, ?, ?)");
          for (const tag of tags) addTag.run(entityId, tag.category, tag.tag, now);
          database.prepare("INSERT INTO monitoring_registry_outbox(event_id, entity_id, event_type, payload, status, created_at, published_at) VALUES (?, ?, 'identity.created', ?, 'published', ?, ?)")
            .run(`identity-registry:${entityId}:${now}`, entityId, JSON.stringify({ entityId, accountId, wallets, lifecycle: "probation" }), now, now);
          database.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(now);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        audit("trader.manual_add", { entityId, accountId, displayName, fomoHandle: rawHandle ? handle : null, wallets, tags });
        return { status: 201, body: { entityId, accountId, displayName, fomoHandle: rawHandle ? handle : null, lifecycleStatus: "observing" } };
      }
      const stateMatch = pathname.match(/^\/api\/v1\/traders\/([^/]+)\/state$/);
      if (method === "PUT" && stateMatch) {
        const lifecycle = typeof input.lifecycle === "string" ? input.lifecycle : "";
        if (!allowedStates.has(lifecycle)) return { status: 400, body: { error: "invalid_lifecycle" } };
        const entityId = decodeURIComponent(stateMatch[1] ?? "");
        const changed = database.prepare("UPDATE trader_entities SET lifecycle = ?, updated_at = ? WHERE entity_id = ?").run(lifecycle, Date.now(), entityId).changes;
        if (!changed) return { status: 404, body: { error: "trader_not_found" } };
        audit("trader.state_update", { entityId, lifecycle });
        return { status: 200, body: { entityId, lifecycle } };
      }
      const lockMatch = pathname.match(/^\/api\/v1\/traders\/([^/]+)\/lock$/);
      if (method === "PUT" && lockMatch) {
        if (typeof input.locked !== "boolean") return { status: 400, body: { error: "locked_required" } };
        const entityId = decodeURIComponent(lockMatch[1] ?? "");
        const changed = database.prepare("UPDATE trader_entities SET locked = ?, updated_at = ? WHERE entity_id = ?").run(Number(input.locked), Date.now(), entityId).changes;
        if (!changed) return { status: 404, body: { error: "trader_not_found" } };
        audit("trader.lock_update", { entityId, locked: input.locked });
        return { status: 200, body: { entityId, locked: input.locked } };
      }
      const promoteMatch = pathname.match(/^\/api\/v1\/candidates\/([^/]+)\/promote$/);
      if (method === "POST" && promoteMatch) {
        const discoveryId = decodeURIComponent(promoteMatch[1] ?? "");
        const candidate = database.prepare("SELECT account_id AS accountId FROM candidate_discoveries WHERE discovery_id = ?").get(discoveryId) as { accountId: string } | undefined;
        if (!candidate) return { status: 404, body: { error: "candidate_not_found" } };
        const existing = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? LIMIT 1").get(candidate.accountId) as { entityId: string } | undefined;
        const entityId = existing?.entityId ?? `candidate-entity:${candidate.accountId}`;
        const now = Date.now();
        database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES (?, 'probation', 0, 0, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET lifecycle = 'probation', updated_at = excluded.updated_at").run(entityId, now, now);
        database.prepare("INSERT OR IGNORE INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, 'medium', 'candidate_promotion', ?, ?)").run(entityId, candidate.accountId, now, now);
        audit("candidate.promote", { discoveryId, entityId, accountId: candidate.accountId });
        return { status: 200, body: { discoveryId, entityId } };
      }
      const backfillRetryMatch = pathname.match(/^\/api\/v1\/milestone-backfills\/([^/]+)\/retry$/);
      if (method === "POST" && backfillRetryMatch) {
        const jobId = decodeURIComponent(backfillRetryMatch[1] ?? "");
        const job = database.prepare("SELECT status FROM milestone_backfill_jobs WHERE job_id = ?").get(jobId) as { status: string } | undefined;
        if (!job) return { status: 404, body: { error: "milestone_backfill_not_found" } };
        if (!new Set(["failed", "unavailable", "partial"]).has(job.status)) return { status: 409, body: { error: "milestone_backfill_not_retryable" } };
        const now = Date.now();
        database.prepare("UPDATE milestone_backfill_jobs SET status = 'pending', next_attempt_at = ?, last_error = NULL, completed_at = NULL, updated_at = ? WHERE job_id = ?").run(now, now, jobId);
        audit("milestone_backfill.retry", { jobId, previousStatus: job.status });
        return { status: 200, body: { jobId, status: "pending", updatedAt: now } };
      }
      if (method === "PUT" && pathname === "/api/v1/config") {
        const strategyVersion = typeof input.strategyVersion === "string" ? input.strategyVersion.trim() : "";
        if (!strategyVersion) return { status: 400, body: { error: "strategy_version_required" } };
        const payload = input.payload ?? {};
        const now = Date.now();
        database.prepare("INSERT INTO strategy_config_versions(strategy_version, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(strategy_version) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at").run(strategyVersion, JSON.stringify(payload), now);
        audit("config.update", { strategyVersion, payload });
        return { status: 200, body: { strategyVersion, payload, createdAt: now } };
      }
      return { status: 404, body: { error: "not_found" } };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      resolutionRepository.close();
      database.close();
    },
  };
};
