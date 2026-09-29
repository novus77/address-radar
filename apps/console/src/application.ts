import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SQLInputValue } from "node:sqlite";

import { CLOSED_LOOP_STAGES, normalizeFomoHandle, normalizeWalletAddress, type ClosedLoopStage } from "@address-radar/domain";
import { analyzeWalletPositions, type WalletAnalysisPosition } from "@address-radar/domain";
import { createAutomationJobStore, createSourceLedgerStore, migrateAddressRadarDatabase, openAddressRadarDatabase, openAddressRadarRepository, withAddressRadarWriteTransaction, type RecoveryJobType } from "@address-radar/database";

import { createManualResolutionService } from "@address-radar/identity";
import { explainTokenMissingCondition } from "@address-radar/aggregation";


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

const chainRegistry = Object.freeze([
  { id: "solana", labelZh: "Solana" },
  { id: "bsc", labelZh: "BSC" },
  { id: "eth", labelZh: "Ethereum" },
  { id: "base", labelZh: "Base" },
  { id: "robinhood", labelZh: "Robinhood" },
]);

const sourceHealthDiagnosticZh: Readonly<Record<string, string>> = Object.freeze({
  healthy: "运行正常",
  degraded: "数据推进变慢",
  rate_limited: "数据源限流，等待自动恢复",
  stale: "数据已陈旧，需要检查游标或连接",
  unavailable: "数据源当前不可用",
  misconfigured: "数据源配置不完整",
});

const fomoVerificationDiagnosticZh = (status: string, lastError?: unknown): string => {
  if (status === "queued") return "等待 Fomo 查询结果";
  if (status === "confirmed") return "Fomo 已确认并返回历史数据";
  if (status === "deferred" && lastError === "fomo_result_timeout") return "查询超时，已按退避计划重排";
  if (status === "deferred") return "查询暂缓，等待下一次重试";
  if (status === "pending") return "等待进入 Fomo 查询队列";
  if (status === "not_found") return "Fomo 未找到对应代币";
  if (status === "mismatch") return "查询结果与目标合约不一致";
  if (status === "unsupported") return "当前链暂不支持 Fomo 验证";
  return "Fomo 验证状态需要检查";
};

const automationStatusDiagnosticZh = (status: string, lastError?: unknown): string => {
  if (status === "pending") return "等待调度执行";
  if (status === "leased") return "任务已领取，等待开始执行";
  if (status === "running") return "任务正在执行";
  if (status === "completed") return "任务已经完成";
  if (status === "cancelled") return "任务已取消";
  const detail = String(lastError ?? "").toLowerCase();
  if (detail.includes("rate") || detail.includes("429")) return "数据源限流，系统将在冷却后自动重试";
  if (detail.includes("lock") || detail.includes("busy")) return "数据库写入繁忙，系统将自动重试";
  if (status === "waiting_source") return "上游数据尚未到达，等待自动补齐";
  if (status === "retryable") return "执行暂时失败，已进入自动重试队列";
  if (status === "terminal") return "自动重试已停止，需要开发者检查或手动重试";
  return "状态需要检查";
};

export const createAddressConsoleApplication = (databasePath = ":memory:"): AddressConsoleApplication => {
  const database = openAddressRadarDatabase(databasePath);
  migrateAddressRadarDatabase(database);
  const sourceLedger = createSourceLedgerStore(database);
  const resolutionRepository = openAddressRadarRepository(databasePath);
  const resolutionService = createManualResolutionService({ repository: resolutionRepository });
  const listeners = new Set<(event: unknown) => void>();

  const rows = (sql: string, ...params: SQLInputValue[]): unknown[] => database.prepare(sql).all(...params);
  const tableExists = (table: string): boolean => Boolean(database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table));
  const audit = (action: string, payload: unknown): void => {
    const event = { auditId: randomUUID(), action, actor: "developer", payload, occurredAt: Date.now() };
    database.prepare("INSERT INTO operator_audit_log(audit_id, action, actor, payload, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .run(event.auditId, event.action, event.actor, JSON.stringify(payload), event.occurredAt);
    for (const listener of listeners) listener(event);
  };

  const read = (pathname: string): ConsoleResult | null => {
    if (pathname === "/api/v2/chains") return { status: 200, body: { items: chainRegistry } };
    if (pathname === "/api/v2/operations/closed-loop") {
      const now = Date.now();
      const count = (sql: string, ...params: SQLInputValue[]): number => Number(
        (database.prepare(sql).get(...params) as { count: number | null }).count ?? 0,
      );
      const timestamp = (sql: string, ...params: SQLInputValue[]): string | null => {
        const value = (database.prepare(sql).get(...params) as { value: number | null }).value;
        return value === null ? null : new Date(Number(value)).toISOString();
      };
      const newCounts = (table: string, column: string, where = "1 = 1") => ({
        completed15m: count(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where} AND ${column} >= ?`, now - 15 * 60_000),
        completed1h: count(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where} AND ${column} >= ?`, now - 60 * 60_000),
        completed24h: count(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where} AND ${column} >= ?`, now - 24 * 60 * 60_000),
      });
      const metric = (stage: ClosedLoopStage, input: {
        readonly discovered: number;
        readonly eligible: number;
        readonly pending: number;
        readonly blocked: number;
        readonly completed: number;
        readonly terminal: number;
        readonly producedFacts: number;
        readonly oldestPendingAt?: string | null;
        readonly lastProgressAt?: string | null;
        readonly completed15m?: number;
        readonly completed1h?: number;
        readonly completed24h?: number;
        readonly untracked?: number;
        readonly drilldown: string;
      }) => Object.freeze({
        stage,
        discovered: input.discovered,
        eligible: input.eligible,
        pending: input.pending,
        blocked: input.blocked,
        completed: input.completed,
        terminal: input.terminal,
        producedFacts: input.producedFacts,
        completed15m: input.completed15m ?? 0,
        completed1h: input.completed1h ?? 0,
        completed24h: input.completed24h ?? 0,
        untracked: input.untracked ?? 0,
        oldestPendingAt: input.oldestPendingAt ?? null,
        lastProgressAt: input.lastProgressAt ?? null,
        drilldown: input.drilldown,
      });

      const tokens = count("SELECT COUNT(*) AS count FROM token_observation_state");
      const markets = count("SELECT COUNT(DISTINCT token_id) AS count FROM token_market_snapshots");
      const milestones = count("SELECT COUNT(DISTINCT token_id) AS count FROM token_milestone_crossings WHERE precision != 'unavailable' AND crossed_at IS NOT NULL");
      const unavailableMilestones = count("SELECT COUNT(DISTINCT token_id) AS count FROM token_milestone_crossings WHERE precision = 'unavailable'");
      const earlyFacts = count("SELECT COUNT(*) AS count FROM token_fact_status WHERE fact_type = 'early_trades' AND status IN ('available','partial','degraded')");
      const earlyPending = count("SELECT COUNT(*) AS count FROM token_fact_status WHERE fact_type = 'early_trades' AND status IN ('scheduled','fetching','retry_scheduled')");
      const earlyBlocked = count("SELECT COUNT(*) AS count FROM token_fact_status WHERE fact_type = 'early_trades' AND status = 'conflicted'");
      const earlyTerminal = count("SELECT COUNT(*) AS count FROM token_fact_status WHERE fact_type = 'early_trades' AND status = 'terminal_unavailable'");
      const earlyUntracked = Math.max(0, milestones - earlyFacts - earlyPending - earlyBlocked - earlyTerminal);
      const traders = count("SELECT COUNT(*) AS count FROM trader_entities");
      const resolvedTraders = count(`SELECT COUNT(*) AS count FROM (
        SELECT entity_id FROM entity_wallet_identities
        UNION SELECT ea.entity_id FROM entity_accounts ea JOIN wallet_identities w ON w.account_id = ea.account_id
      )`);
      const unresolvedIdentities = count("SELECT COUNT(*) AS count FROM identity_resolution_queue WHERE status = 'pending'");
      const evidenceTokens = count("SELECT COUNT(DISTINCT token_id) AS count FROM candidate_evidence_v3");
      const evidenceTraders = count("SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_evidence_v3");
      const abilityTraders = count("SELECT COUNT(DISTINCT entity_id) AS count FROM trader_repeatable_ability_snapshots");
      const admissionEvaluated = count("SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_admission_snapshots");
      const admitted = count("SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_admission_snapshots WHERE current_admission = 1");
      const monitored = count("SELECT COUNT(*) AS count FROM trader_monitoring_policy WHERE policy != 'off'");
      const coveredWallets = count("SELECT COUNT(DISTINCT identity_id) AS count FROM wallet_chain_coverage WHERE status IN ('healthy','complete')");
      const aggregations = count("SELECT COUNT(*) AS count FROM token_evaluation_state");
      const signals = count("SELECT COUNT(*) AS count FROM broadcast_records");
      const signalProjectionRequests = count("SELECT COUNT(*) AS count FROM signal_projection_requests");
      const signalProjectionPending = count(`
        SELECT COUNT(*) AS count FROM signal_projection_requests
        WHERE desired_revision > applied_revision
      `);
      const automationStage = (jobType: string, status: string): number => count(
        "SELECT COUNT(*) AS count FROM automation_jobs WHERE job_type = ? AND status = ?",
        jobType,
        status,
      );
      const stages = Object.freeze([
        metric("token_discovery", { discovered: tokens, eligible: tokens, pending: 0, blocked: 0, completed: tokens, terminal: 0, producedFacts: tokens, ...newCounts("token_observation_state", "last_observed_at"), lastProgressAt: timestamp("SELECT MAX(last_observed_at) AS value FROM token_observation_state"), drilldown: "/api/v2/historical-tokens" }),
        metric("market_history", { discovered: tokens, eligible: tokens, pending: Math.max(0, tokens - markets), blocked: 0, completed: markets, terminal: 0, producedFacts: markets, ...newCounts("token_market_snapshots", "observed_at"), lastProgressAt: timestamp("SELECT MAX(observed_at) AS value FROM token_market_snapshots"), drilldown: "/api/v2/discovery/fact-coverage" }),
        metric("milestone_confirmation", { discovered: markets, eligible: markets, pending: Math.max(0, markets - milestones - unavailableMilestones), blocked: 0, completed: milestones, terminal: unavailableMilestones, producedFacts: milestones, ...newCounts("token_milestone_crossings", "crossed_at", "precision != 'unavailable' AND crossed_at IS NOT NULL"), lastProgressAt: timestamp("SELECT MAX(crossed_at) AS value FROM token_milestone_crossings WHERE crossed_at IS NOT NULL"), drilldown: "/api/v2/historical-tokens" }),
        metric("early_trade_recovery", { discovered: milestones, eligible: milestones, pending: earlyPending + earlyUntracked, blocked: earlyBlocked, completed: earlyFacts, terminal: earlyTerminal, producedFacts: earlyFacts, ...newCounts("token_fact_status", "updated_at", "fact_type = 'early_trades' AND status IN ('available','partial','degraded')"), untracked: earlyUntracked, lastProgressAt: timestamp("SELECT MAX(updated_at) AS value FROM token_fact_status WHERE fact_type = 'early_trades'"), drilldown: "/api/v2/recovery/jobs" }),
        metric("identity_resolution", { discovered: traders, eligible: traders, pending: unresolvedIdentities, blocked: 0, completed: resolvedTraders, terminal: 0, producedFacts: resolvedTraders, lastProgressAt: timestamp("SELECT MAX(last_observed_at) AS value FROM entity_wallet_identities"), drilldown: "/api/v1/identity-queue" }),
        metric("candidate_evidence", { discovered: earlyFacts, eligible: earlyFacts, pending: automationStage("candidate_evidence", "pending") + automationStage("candidate_evidence", "retryable"), blocked: automationStage("candidate_evidence", "blocked_source"), completed: evidenceTokens, terminal: automationStage("candidate_evidence", "terminal"), producedFacts: count("SELECT COUNT(*) AS count FROM candidate_evidence_v3"), ...newCounts("automation_job_outcomes", "created_at", "job_type = 'candidate_evidence'"), lastProgressAt: timestamp("SELECT MAX(created_at) AS value FROM automation_job_outcomes WHERE job_type = 'candidate_evidence'"), drilldown: "/api/v2/candidates" }),
        metric("ability_evaluation", { discovered: evidenceTraders, eligible: evidenceTraders, pending: automationStage("ability_evaluation", "pending") + automationStage("ability_evaluation", "retryable"), blocked: automationStage("ability_evaluation", "blocked_source"), completed: abilityTraders, terminal: automationStage("ability_evaluation", "terminal"), producedFacts: abilityTraders, ...newCounts("trader_repeatable_ability_snapshots", "evaluated_at", "window = '30d'"), lastProgressAt: timestamp("SELECT MAX(evaluated_at) AS value FROM trader_repeatable_ability_snapshots"), drilldown: "/api/v2/backfill/traders" }),
        metric("candidate_admission", { discovered: abilityTraders, eligible: abilityTraders, pending: Math.max(0, abilityTraders - admissionEvaluated), blocked: 0, completed: admissionEvaluated, terminal: 0, producedFacts: admitted, ...newCounts("candidate_admission_snapshots", "evaluated_at"), lastProgressAt: timestamp("SELECT MAX(evaluated_at) AS value FROM candidate_admission_snapshots"), drilldown: "/api/v2/candidates" }),
        metric("wallet_monitoring", { discovered: monitored, eligible: monitored, pending: count("SELECT COUNT(*) AS count FROM wallet_chain_coverage WHERE status IN ('pending','running')"), blocked: count("SELECT COUNT(*) AS count FROM wallet_chain_coverage WHERE status IN ('blocked','degraded')"), completed: coveredWallets, terminal: count("SELECT COUNT(*) AS count FROM wallet_chain_coverage WHERE status = 'unsupported'"), producedFacts: count("SELECT COUNT(*) AS count FROM wallet_monitor_observations"), ...newCounts("wallet_chain_coverage", "last_success_at", "last_success_at IS NOT NULL"), lastProgressAt: timestamp("SELECT MAX(last_success_at) AS value FROM wallet_chain_coverage"), drilldown: "/api/v2/coverage/sources" }),
        metric("token_aggregation", { discovered: aggregations, eligible: aggregations, pending: 0, blocked: 0, completed: aggregations, terminal: 0, producedFacts: aggregations, ...newCounts("token_evaluation_state", "updated_at"), lastProgressAt: timestamp("SELECT MAX(updated_at) AS value FROM token_evaluation_state"), drilldown: "/api/v1/aggregations" }),
        metric("signal_readiness", { discovered: Math.max(signalProjectionRequests, aggregations), eligible: Math.max(signalProjectionRequests, aggregations), pending: signalProjectionPending, blocked: 0, completed: aggregations, terminal: 0, producedFacts: signals, ...newCounts("token_evaluation_state", "updated_at"), lastProgressAt: timestamp("SELECT MAX(updated_at) AS value FROM token_evaluation_state"), drilldown: "/api/v1/aggregations" }),
      ]);
      const missingStages = CLOSED_LOOP_STAGES.filter(stage => !stages.some(metricItem => metricItem.stage === stage));
      if (missingStages.length > 0) throw new Error(`Closed-loop metrics are incomplete: ${missingStages.join(",")}`);
      const outcomes = database.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN outcome = 'produced' THEN 1 ELSE 0 END) AS productive,
          SUM(CASE WHEN outcome = 'no_output' THEN 1 ELSE 0 END) AS noOutput
        FROM automation_job_outcomes WHERE created_at >= ?
      `).get(now - 24 * 60 * 60_000) as { total: number; productive: number | null; noOutput: number | null };
      const factClosure = database.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'satisfied' THEN 1 ELSE 0 END) AS satisfied,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'terminal' THEN 1 ELSE 0 END) AS terminal
        FROM recovery_fact_links
      `).get() as { total: number; satisfied: number | null; pending: number | null; terminal: number | null };
      const queue = createAutomationJobStore(database).metrics(now, 15 * 60_000);
      const walletCoverage = rows(`
        SELECT chain, provider, status, COUNT(*) AS count, MAX(last_success_at) AS lastSuccessAt,
          MAX(updated_at) AS updatedAt
        FROM wallet_chain_coverage GROUP BY chain, provider, status
        ORDER BY chain, provider, status
      `);
      const recoveryReasons = rows(`
        SELECT COALESCE(terminal_reason, status) AS reasonCode, COUNT(*) AS count
        FROM recovery_fact_links WHERE status != 'satisfied'
        GROUP BY COALESCE(terminal_reason, status) ORDER BY count DESC LIMIT 10
      `);
      const conflictWrites24h = count("SELECT COUNT(*) AS count FROM source_observation_conflicts WHERE last_seen_at >= ?", now - 24 * 60 * 60_000);
      return { status: 200, body: {
        updatedAt: now,
        stages,
        outcomes: {
          total24h: Number(outcomes.total ?? 0),
          productive24h: Number(outcomes.productive ?? 0),
          noOutput24h: Number(outcomes.noOutput ?? 0),
          productiveRate24h: Number(outcomes.total ?? 0) === 0 ? 0 : Number(outcomes.productive ?? 0) / Number(outcomes.total),
        },
        recoveryClosure: {
          total: Number(factClosure.total ?? 0),
          satisfied: Number(factClosure.satisfied ?? 0),
          pending: Number(factClosure.pending ?? 0),
          terminal: Number(factClosure.terminal ?? 0),
          rate: Number(factClosure.total ?? 0) === 0 ? 0 : Number(factClosure.satisfied ?? 0) / Number(factClosure.total),
          reasons: recoveryReasons,
        },
        queue: {
          ...queue,
          runnableDelta15m: queue.admitted - queue.completed,
          converging: queue.completed > queue.admitted,
        },
        walletCoverage,
        contention: {
          sqliteTelemetryAvailable: false,
          diagnosticZh: "SQLite 重试已在写事务层生效，进程级聚合遥测尚未上报",
          sourceConflictWrites24h: conflictWrites24h,
        },
      } };
    }
    if (pathname === "/api/v2/automation/overview") {
      const now = Date.now();
      const scalar = (sql: string): number => Number(
        (database.prepare(sql).get() as { count: number | null }).count ?? 0,
      );
      const optionalScalar = (table: string, sql: string): number =>
        tableExists(table) ? scalar(sql) : 0;
      const statusRows = rows(`
        SELECT status, COUNT(*) AS count FROM automation_jobs GROUP BY status ORDER BY status
      `) as Array<{ status: string; count: number }>;
      const laneRows = rows(`
        SELECT lane, COUNT(*) AS total,
          SUM(CASE WHEN status IN ('pending', 'waiting_source', 'blocked_source', 'retryable') THEN 1 ELSE 0 END) AS backlog,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
        FROM automation_jobs GROUP BY lane ORDER BY lane
      `) as Array<{ lane: string; total: number; backlog: number | null; completed: number | null }>;
      const backlog = scalar("SELECT COUNT(*) AS count FROM automation_jobs WHERE job_type <> 'identity_resolution' AND status IN ('pending', 'waiting_source', 'blocked_source', 'retryable')");
      const manualIdentityBacklog = optionalScalar(
        "identity_resolution_queue",
        "SELECT COUNT(*) AS count FROM identity_resolution_queue WHERE status = 'pending'",
      );
      const completed24h = scalar(`SELECT COUNT(*) AS count FROM automation_jobs WHERE status = 'completed' AND completed_at >= ${now - 24 * 60 * 60_000}`);
      const failed24h = scalar(`SELECT COUNT(*) AS count FROM automation_jobs WHERE status IN ('retryable', 'terminal') AND updated_at >= ${now - 24 * 60 * 60_000}`);
      const oldest = database.prepare(`
        SELECT MIN(created_at) AS createdAt FROM automation_jobs
        WHERE status IN ('pending', 'waiting_source', 'blocked_source', 'retryable')
      `).get() as { createdAt: number | null };
      const blockedReasons = rows(`
        SELECT reason_code AS reasonCode, COUNT(*) AS count, MIN(blocked_at) AS oldestBlockedAt
        FROM automation_job_blocks
        WHERE resolved_at IS NULL
        GROUP BY reason_code
        ORDER BY count DESC, reason_code LIMIT 20
      `);
      const recoveryJobProgress = rows(`
        SELECT job_type AS jobType, status, COUNT(*) AS count, MAX(updated_at) AS lastUpdatedAt
        FROM recovery_jobs
        GROUP BY job_type, status
        ORDER BY job_type, status
      `);
      const blockedToWoken = scalar("SELECT COUNT(*) AS count FROM automation_job_blocks WHERE resolved_at IS NOT NULL");
      const jobTypeProgress = rows(`
        SELECT job_type AS jobType,
          SUM(CASE WHEN status IN ('pending', 'leased', 'running', 'waiting_source', 'blocked_source', 'retryable') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          MAX(updated_at) AS lastUpdatedAt
        FROM automation_jobs GROUP BY job_type ORDER BY active DESC, job_type
      `);
      const sourceConflicts = tableExists("source_observation_conflicts") ? database.prepare(`
        SELECT COUNT(*) AS distinctConflicts, COALESCE(SUM(occurrence_count), 0) AS occurrences,
          MAX(last_seen_at) AS lastSeenAt
        FROM source_observation_conflicts
      `).get() as Record<string, unknown> : { distinctConflicts: 0, occurrences: 0, lastSeenAt: null };
      return {
        status: 200,
        body: {
          updatedAt: now,
          funnel: {
            observedFomoHandles: scalar("SELECT COUNT(*) AS count FROM fomo_accounts"),
            canonicalTraders: scalar("SELECT COUNT(*) AS count FROM trader_entities"),
            walletResolvedTraders: scalar(`
              SELECT COUNT(*) AS count FROM (
                SELECT entity_id FROM entity_wallet_identities
                UNION
                SELECT ea.entity_id
                FROM entity_accounts ea
                JOIN wallet_identities w ON w.account_id = ea.account_id
              ) resolved
            `),
            monitoringEligibleTraders: optionalScalar(
              "trader_monitoring_policy",
              "SELECT COUNT(*) AS count FROM trader_monitoring_policy WHERE policy != 'off'",
            ),
            initialBackfillQueued: optionalScalar(
              "automation_jobs",
              "SELECT COUNT(DISTINCT subject_key) AS count FROM automation_jobs WHERE job_type = 'initial_wallet_backfill'",
            ),
            initialBackfillCompleted: optionalScalar(
              "automation_jobs",
              "SELECT COUNT(DISTINCT subject_key) AS count FROM automation_jobs WHERE job_type = 'initial_wallet_backfill' AND status = 'completed'",
            ),
            periodicCoverageCurrent: optionalScalar(
              "trader_coverage_state",
              "SELECT COUNT(*) AS count FROM trader_coverage_state WHERE coverage_state = 'current'",
            ),
            candidateEvidenceTraders: optionalScalar(
              "candidate_evidence_v3",
              "SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_evidence_v3",
            ),
            admittedTraders: optionalScalar(
              "candidate_admission_snapshots",
              "SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_admission_snapshots WHERE current_admission = 1",
            ),
          },
          queue: {
            total: scalar("SELECT COUNT(*) AS count FROM automation_jobs"),
            backlog,
            automatedRepairBacklog: scalar("SELECT COUNT(*) AS count FROM automation_jobs WHERE lane = 'repair' AND job_type <> 'identity_resolution' AND status IN ('pending', 'waiting_source', 'blocked_source', 'retryable')"),
            manualIdentityBacklog,
            byStatus: Object.fromEntries(statusRows.map(item => [item.status, Number(item.count)])),
            lanes: laneRows.map(item => ({ ...item, backlog: Number(item.backlog ?? 0), completed: Number(item.completed ?? 0) })),
            oldestBacklogAt: oldest.createdAt,
            oldestBacklogAgeMs: oldest.createdAt === null ? 0 : Math.max(0, now - oldest.createdAt),
            completed24h,
            failed24h,
            failureRate24h: completed24h + failed24h === 0 ? 0 : failed24h / (completed24h + failed24h),
            estimatedDrainMs: completed24h === 0 ? null : Math.round(backlog / completed24h * 24 * 60 * 60_000),
            blockedReasons,
            blockedToWoken,
            recoveryJobProgress,
            jobTypeProgress,
            sourceConflicts,
          },
        },
      };
    }
    if (pathname === "/api/v2/backfill/traders") {
      const now = Date.now();
      const items = rows(`
        SELECT j.job_id AS jobId, j.subject_key AS traderId, j.lane, j.job_type AS jobType,
          j.status, j.priority, j.cursor, j.attempt_count AS attemptCount,
          j.next_attempt_at AS nextAttemptAt, j.lease_expires_at AS leaseExpiresAt,
          j.last_error AS lastError, j.created_at AS createdAt, j.updated_at AS updatedAt,
          j.completed_at AS completedAt,
          COALESCE((SELECT GROUP_CONCAT(a.handle, ', ') FROM entity_accounts ea JOIN fomo_accounts a ON a.account_id = ea.account_id WHERE ea.entity_id = j.subject_key), '') AS handles,
          c.tier, c.coverage_state AS coverageState, c.last_covered_at AS lastCoveredAt,
          c.next_evaluation_at AS nextEvaluationAt
        FROM automation_jobs j
        LEFT JOIN trader_coverage_state c ON c.trader_id = j.subject_key
        WHERE j.job_type IN ('initial_wallet_backfill', 'trader_backfill', 'trader_lightweight', 'ability_evaluation')
          AND j.subject_key NOT LIKE '%dispatcher%'
        ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'leased' THEN 1 WHEN 'retryable' THEN 2 WHEN 'waiting_source' THEN 3 WHEN 'pending' THEN 4 ELSE 5 END,
          j.priority DESC, j.updated_at DESC
        LIMIT 2000
      `).map(item => {
        const row = item as Record<string, unknown>;
        return Object.freeze({
          ...row,
          ageMs: Math.max(0, now - Number(row.createdAt ?? now)),
          diagnosticZh: automationStatusDiagnosticZh(String(row.status), row.lastError),
        });
      });
      return { status: 200, body: { updatedAt: now, total: items.length, items } };
    }
    const traderBackfillMatch = pathname.match(/^\/api\/v2\/backfill\/traders\/([^/]+)$/);
    if (traderBackfillMatch) {
      const traderId = decodeURIComponent(traderBackfillMatch[1] ?? "");
      const trader = database.prepare(`
        SELECT e.entity_id AS traderId, e.lifecycle, e.manual, e.locked,
          c.tier, c.coverage_state AS coverageState, c.last_covered_at AS lastCoveredAt,
          c.next_evaluation_at AS nextEvaluationAt, p.policy AS monitoringPolicy
        FROM trader_entities e
        LEFT JOIN trader_coverage_state c ON c.trader_id = e.entity_id
        LEFT JOIN trader_monitoring_policy p ON p.trader_id = e.entity_id
        WHERE e.entity_id = ?
      `).get(traderId) as Record<string, unknown> | undefined;
      if (!trader) return { status: 404, body: { error: "trader_not_found" } };
      return { status: 200, body: {
        trader,
        jobs: rows(`
          SELECT job_id AS jobId, lane, job_type AS jobType, status, priority, cursor,
            attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
            lease_expires_at AS leaseExpiresAt, last_error AS lastError,
            created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
          FROM automation_jobs WHERE subject_key = ? ORDER BY updated_at DESC
        `, traderId).map(item => {
          const row = item as Record<string, unknown>;
          return { ...row, diagnosticZh: automationStatusDiagnosticZh(String(row.status), row.lastError) };
        }),
        ability: rows(`
          SELECT window, ability_stage AS abilityStage, bundle_risk_state AS bundleRiskState,
            total_samples AS totalSamples, valid_samples AS validSamples,
            successful_distinct_tokens AS successfulDistinctTokens, win_rate AS winRate,
            sample_span_ms AS sampleSpanMs,
            maximum_single_token_profit_share AS maximumSingleTokenProfitShare,
            bundle_distinct_token_count AS bundleDistinctTokenCount,
            reason_codes AS reasonCodes, strategy_version AS strategyVersion,
            evaluated_at AS evaluatedAt
          FROM trader_repeatable_ability_snapshots
          WHERE entity_id = ? ORDER BY evaluated_at DESC, window
        `, traderId),
      } };
    }
    if (pathname === "/api/v2/mining/partitions") return { status: 200, body: { updatedAt: Date.now(), items: rows(`
      SELECT p.partition_id AS partitionId, p.chain, p.week_start AS weekStart,
        p.week_end AS weekEnd, p.status, p.source_name AS sourceName, p.cursor,
        p.token_count AS tokenCount, p.next_attempt_at AS nextAttemptAt,
        p.last_error AS lastError, p.created_at AS createdAt, p.updated_at AS updatedAt,
        p.completed_at AS completedAt,
        (SELECT COUNT(*) FROM historical_token_mining_jobs m WHERE m.partition_id = p.partition_id) AS miningTokenCount,
        (SELECT COUNT(*) FROM historical_token_mining_jobs m WHERE m.partition_id = p.partition_id AND m.status = 'completed') AS completedTokenCount
      FROM historical_token_partitions p ORDER BY p.week_start DESC, p.chain
    `).map(item => {
      const row = item as Record<string, unknown>;
      return { ...row, diagnosticZh: automationStatusDiagnosticZh(String(row.status), row.lastError) };
    }) } };
    if (pathname === "/api/v2/mining/tokens") return { status: 200, body: { updatedAt: Date.now(), items: rows(`
      SELECT m.mining_job_id AS miningJobId, m.partition_id AS partitionId,
        m.token_id AS tokenId, m.chain, m.token_address AS tokenAddress, m.status,
        h.symbol, h.image_url AS imageUrl, h.peak_market_cap_usd AS peakMarketCapUsd,
        m.created_at AS createdAt, m.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM candidate_evidence_v3 e WHERE e.token_id = m.token_id) AS evidenceCount
      FROM historical_token_mining_jobs m
      LEFT JOIN historical_tokens h ON h.token_id = m.token_id
      ORDER BY m.updated_at DESC LIMIT 3000
    `) } };
    if (pathname === "/api/v2/coverage/traders") return { status: 200, body: { updatedAt: Date.now(), items: rows(`
      SELECT e.entity_id AS traderId, e.lifecycle, c.tier, c.coverage_state AS coverageState,
        c.last_covered_at AS lastCoveredAt, c.next_evaluation_at AS nextEvaluationAt,
        c.strategy_version AS strategyVersion, p.policy AS monitoringPolicy,
        (SELECT COUNT(*) FROM entity_wallet_identities w WHERE w.entity_id = e.entity_id) AS walletCount,
        (SELECT ability_stage FROM trader_repeatable_ability_snapshots a WHERE a.entity_id = e.entity_id AND a.window = '30d' ORDER BY evaluated_at DESC LIMIT 1) AS abilityStage
      FROM trader_entities e
      LEFT JOIN trader_coverage_state c ON c.trader_id = e.entity_id
      LEFT JOIN trader_monitoring_policy p ON p.trader_id = e.entity_id
      ORDER BY COALESCE(c.next_evaluation_at, 0), e.entity_id
    `) } };
    if (pathname === "/api/v2/coverage/sources") {
      const now = Date.now();
      const runtime = database.prepare("SELECT payload FROM automation_runtime_snapshots ORDER BY captured_at DESC LIMIT 1").get() as { payload: string } | undefined;
      let runtimePayload: Record<string, unknown> = {};
      try { runtimePayload = runtime ? JSON.parse(runtime.payload) as Record<string, unknown> : {}; } catch { runtimePayload = {}; }
      const due = database.prepare(`
        SELECT MIN(next_evaluation_at) AS oldestDueAt FROM trader_coverage_state
        WHERE next_evaluation_at <= ? AND coverage_state != 'current'
      `).get(now) as { oldestDueAt: number | null };
      return { status: 200, body: {
        updatedAt: now,
        items: rows(`
          SELECT source, chain, state, last_attempt_at AS lastAttemptAt,
            last_success_at AS lastSuccessAt, last_event_at AS lastEventAt,
            consecutive_failures AS consecutiveFailures, latency_ms AS latencyMs,
            rate_limit_reset_at AS rateLimitResetAt, last_error_code AS lastErrorCode
          FROM source_health ORDER BY source, chain
        `).map(item => {
          const row = item as Record<string, unknown>;
          return { ...row, diagnosticZh: sourceHealthDiagnosticZh[String(row.state)] ?? "未知状态" };
        }),
        providerBudgets: runtimePayload.providerBudgets ?? null,
        sqliteContention: runtimePayload.sqliteContention ?? null,
        telemetryDiagnosticZh: runtime ? "已读取最新运行遥测" : "运行时尚未上报 Provider 预算与 SQLite 争用指标",
        dueWalletAgeMs: due.oldestDueAt === null ? 0 : Math.max(0, now - due.oldestDueAt),
      } };
    }
    if (pathname === "/api/v2/sources/health") {
      const items = rows(`
        SELECT source, chain, state, last_attempt_at AS lastAttemptAt,
          last_success_at AS lastSuccessAt, last_event_at AS lastEventAt,
          consecutive_failures AS consecutiveFailures, latency_ms AS latencyMs,
          rate_limit_reset_at AS rateLimitResetAt, cursor,
          last_error_code AS lastErrorCode
        FROM source_health ORDER BY source, chain
      `).map(item => {
        const row = item as Record<string, unknown>;
        return Object.freeze({ ...row, diagnosticZh: sourceHealthDiagnosticZh[String(row.state)] ?? "未知状态" });
      });
      return { status: 200, body: { updatedAt: Date.now(), items } };
    }
    if (pathname === "/api/v2/sources/cursors") return { status: 200, body: { updatedAt: Date.now(), items: rows(`
      SELECT source, chain, cursor, position, updated_at AS updatedAt
      FROM source_cursors ORDER BY source, chain
    `) } };
    if (pathname === "/api/v2/fomo-verification/quality") {
      let transfer: Readonly<Record<string, unknown>> | null = null;
      let transferDiagnosticZh = "尚未生成 Fomo 同步水位";
      try {
        const parsed = JSON.parse(readFileSync(join(dirname(databasePath), "fomo", "fomo-sync-status.json"), "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          transfer = Object.freeze(parsed as Record<string, unknown>);
          const generatedAt = Number(transfer.generatedAt ?? 0);
          transferDiagnosticZh = generatedAt > 0 && Date.now() - generatedAt <= 5 * 60_000
            ? "Fomo 同步水位正常更新"
            : "Fomo 同步水位已陈旧，需要检查定时器或跨端文件";
        }
      } catch {
        transfer = null;
      }
      const summary = database.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'queued' AND last_lookup_id IS NOT NULL THEN 1 ELSE 0 END) AS activeLookupCount,
          SUM(CASE WHEN last_error = 'fomo_result_timeout' THEN 1 ELSE 0 END) AS timedOutCount,
          SUM(CASE WHEN last_lookup_id IS NOT NULL AND result_received_at IS NOT NULL THEN 1 ELSE 0 END) AS correlatedResultCount,
          MIN(CASE WHEN status = 'queued' THEN queued_at ELSE NULL END) AS oldestQueuedAt,
          MAX(result_received_at) AS lastResultReceivedAt
        FROM historical_token_verifications
      `).get() as Record<string, number | null>;
      const statuses = rows(`
        SELECT status, last_error AS lastError, COUNT(*) AS count,
          MIN(queued_at) AS oldestQueuedAt,
          MAX(result_received_at) AS lastResultReceivedAt,
          MAX(updated_at) AS updatedAt
        FROM historical_token_verifications
        GROUP BY status, last_error
        ORDER BY status, last_error
      `).map(item => {
        const row = item as Record<string, unknown>;
        return Object.freeze({
          ...row,
          diagnosticZh: fomoVerificationDiagnosticZh(String(row.status), row.lastError),
        });
      });
      return { status: 200, body: {
        total: Number(summary.total ?? 0),
        activeLookupCount: Number(summary.activeLookupCount ?? 0),
        timedOutCount: Number(summary.timedOutCount ?? 0),
        correlatedResultCount: Number(summary.correlatedResultCount ?? 0),
        oldestQueuedAt: summary.oldestQueuedAt ?? null,
        lastResultReceivedAt: summary.lastResultReceivedAt ?? null,
        transfer,
        transferDiagnosticZh,
        statuses,
        updatedAt: Date.now(),
      } };
    }
    if (pathname === "/api/v2/projections/quality") {
      const summary = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM trader_events) AS canonicalEventCount,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedCount,
          SUM(CASE WHEN status = 'retryable' THEN 1 ELSE 0 END) AS retryableCount,
          SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS activeCount,
          SUM(CASE WHEN status = 'terminal_failed' THEN 1 ELSE 0 END) AS terminalFailureCount,
          MAX(CASE WHEN status = 'completed' THEN completed_at ELSE NULL END) AS lastCompletedAt
        FROM event_projections
      `).get() as Record<string, number | null>;
      const missing = database.prepare(`
        SELECT COUNT(*) AS count, MIN(event.occurred_at) AS oldestOccurredAt
        FROM trader_events event
        WHERE NOT EXISTS (
          SELECT 1 FROM event_projections projection
          WHERE projection.event_id = event.event_id
            AND projection.projection_type = 'address_signal_evidence_v1'
            AND projection.status = 'completed'
        )
      `).get() as { count: number | null; oldestOccurredAt: number | null };
      return { status: 200, body: {
        canonicalEventCount: Number(summary.canonicalEventCount ?? 0),
        completedCount: Number(summary.completedCount ?? 0),
        retryableCount: Number(summary.retryableCount ?? 0),
        activeCount: Number(summary.activeCount ?? 0),
        terminalFailureCount: Number(summary.terminalFailureCount ?? 0),
        missingSignalProjectionCount: Number(missing.count ?? 0),
        oldestMissingEventAt: missing.oldestOccurredAt ?? null,
        lastCompletedAt: summary.lastCompletedAt ?? null,
        updatedAt: Date.now(),
      } };
    }
    if (pathname === "/api/v2/discovery/token-funnel") {
      const scalar = (sql: string): number => Number((database.prepare(sql).get() as { count: number | null }).count ?? 0);
      return { status: 200, body: {
        raw: scalar("SELECT COUNT(*) AS count FROM token_observation_state"),
        identityResolved: scalar("SELECT COUNT(*) AS count FROM token_observation_state WHERE identity_status IN ('resolved', 'confirmed')"),
        marketResolved: scalar("SELECT COUNT(*) AS count FROM token_observation_state WHERE market_status IN ('resolved', 'confirmed')"),
        fomoConfirmed: scalar("SELECT COUNT(*) AS count FROM token_observation_state WHERE fomo_status = 'confirmed'"),
        milestoneObserved: scalar("SELECT COUNT(*) AS count FROM token_observation_state WHERE milestone_status = 'observed'"),
        earlyBuyerRecovered: scalar("SELECT COUNT(DISTINCT token_id) AS count FROM candidate_evidence_v3"),
        candidateEvidence: scalar("SELECT COUNT(DISTINCT token_id) AS count FROM candidate_evidence_v3"),
        aggregation: scalar("SELECT COUNT(*) AS count FROM token_evaluation_state"),
        qualifiedSignal: scalar("SELECT COUNT(*) AS count FROM broadcast_records"),
        updatedAt: Date.now(),
      } };
    }
    if (pathname === "/api/v2/discovery/fact-coverage") {
      const now = Date.now();
      const factCounts = rows(`
        SELECT fact_type AS factType, status, COUNT(*) AS count,
          MAX(CASE
            WHEN status IN ('available', 'partial') THEN COALESCE(observed_at, updated_at)
            ELSE NULL
          END) AS lastSuccessAt,
          MAX(updated_at) AS updatedAt
        FROM token_fact_status
        GROUP BY fact_type, status
        ORDER BY fact_type, status
      `);
      const attempts = rows(`
        SELECT provider, fact_type AS factType, outcome, COUNT(*) AS count,
          MAX(finished_at) AS lastFinishedAt
        FROM token_fact_attempts
        WHERE finished_at >= ?
        GROUP BY provider, fact_type, outcome
        ORDER BY provider, fact_type, outcome
      `, now - 24 * 60 * 60_000);
      const walletSources = tableExists("wallet_monitor_provider_status") && tableExists("wallet_monitor_observations") ? rows(`
        SELECT status.source, status.status,
          status.last_error AS lastError, status.updated_at AS updatedAt,
          COUNT(observation.event_id) AS observationCount,
          MAX(observation.occurred_at) AS lastObservationAt,
          COUNT(DISTINCT observation.wallet_address) AS observedWalletCount
        FROM wallet_monitor_provider_status status
        LEFT JOIN wallet_monitor_observations observation ON observation.source = status.source
          AND observation.orphaned_at IS NULL
        GROUP BY status.source, status.status, status.last_error, status.updated_at
        ORDER BY status.source
      `) : [];
      const walletAnalyses = rows(`
        SELECT status, COUNT(*) AS count,
          SUM(valid_sample_count) AS validSamples,
          AVG(coverage_rate) AS averageCoverage,
          MAX(updated_at) AS updatedAt
        FROM wallet_analysis_jobs GROUP BY status ORDER BY status
      `);
      const abilities = rows(`
        SELECT ability_stage AS abilityStage, COUNT(*) AS count,
          AVG(CASE WHEN total_samples > 0 THEN valid_samples * 1.0 / total_samples ELSE 0 END) AS averageCoverage,
          MAX(evaluated_at) AS evaluatedAt
        FROM trader_repeatable_ability_snapshots snapshot
        WHERE window = '30d' AND NOT EXISTS (
          SELECT 1 FROM trader_repeatable_ability_snapshots newer
          WHERE newer.entity_id = snapshot.entity_id AND newer.window = snapshot.window
            AND (newer.evaluated_at > snapshot.evaluated_at OR (newer.evaluated_at = snapshot.evaluated_at AND newer.snapshot_id > snapshot.snapshot_id))
        )
        GROUP BY ability_stage ORDER BY ability_stage
      `);
      const scalar = (sql: string): number => Number((database.prepare(sql).get() as { count: number | null }).count ?? 0);
      return { status: 200, body: {
        updatedAt: now,
        factCounts,
        attempts,
        walletSources,
        walletAnalyses,
        abilities,
        unresolvedDependencies: scalar(`
          SELECT COUNT(*) AS count
          FROM token_fact_dependencies d
          JOIN token_fact_status dependency
            ON dependency.token_id = d.token_id
           AND dependency.fact_type = d.depends_on_fact_type
          WHERE dependency.status NOT IN ('available', 'partial', 'degraded')
        `),
        unresolvedConflicts: scalar("SELECT COUNT(*) AS count FROM token_fact_conflicts WHERE status = 'open'"),
      } };
    }
    if (pathname === "/api/v2/discovery/trader-funnel") {
      const scalar = (sql: string): number => Number((database.prepare(sql).get() as { count: number | null }).count ?? 0);
      return { status: 200, body: {
        observed: scalar("SELECT COUNT(*) AS count FROM trader_entities"),
        identityResolved: scalar("SELECT COUNT(DISTINCT entity_id) AS count FROM entity_accounts"),
        walletObserved: scalar("SELECT COUNT(DISTINCT entity_id) AS count FROM entity_wallet_identities"),
        fomoObserved: scalar("SELECT COUNT(DISTINCT entity_id) AS count FROM entity_accounts"),
        candidateEvidence: scalar("SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_evidence_v3"),
        currentAdmitted: scalar("SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_admission_snapshots WHERE current_admission = 1"),
        updatedAt: Date.now(),
      } };
    }
    if (pathname === "/api/v2/recovery/jobs") return { status: 200, body: { updatedAt: Date.now(), items: rows(`
      SELECT job_id AS jobId, job_type AS jobType, chain, subject_key AS subjectKey,
        status, priority, cursor, attempt_count AS attemptCount,
        next_attempt_at AS nextAttemptAt, lease_expires_at AS leaseExpiresAt,
        last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt,
        completed_at AS completedAt
      FROM recovery_jobs ORDER BY priority, next_attempt_at, created_at, job_id LIMIT 1000
    `) } };
    if (pathname === "/api/v2/token-coverage") {
      const targetChains = ["solana", "bsc", "eth", "robinhood", "base"] as const;
      const groupedCounts = (table: string, addressColumn: string): Map<string, number> => {
        const items = rows(`
          SELECT LOWER(chain) AS chain,
            COUNT(DISTINCT CASE
              WHEN LOWER(chain) = 'solana' THEN ${addressColumn}
              ELSE LOWER(${addressColumn})
            END) AS count
          FROM ${table}
          WHERE LOWER(chain) IN ('solana', 'bsc', 'eth', 'robinhood', 'base')
          GROUP BY LOWER(chain)
        `) as Array<{ chain: string; count: number }>;
        return new Map(items.map(item => [item.chain, Number(item.count)]));
      };
      const observed = groupedCounts("trader_events", "token_address");
      const milestones = groupedCounts("token_milestones", "token_address");
      const historical = groupedCounts("historical_tokens", "token_address");
      const aggregated = groupedCounts("token_aggregation_state", "token_address");
      const partitions = rows(`
        SELECT LOWER(chain) AS chain,
          SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM historical_backfill_partitions
        WHERE LOWER(chain) IN ('solana', 'bsc', 'eth', 'robinhood', 'base')
        GROUP BY LOWER(chain)
      `) as Array<{ chain: string; pending: number | null; failed: number | null }>;
      const partitionCounts = new Map(partitions.map(item => [item.chain, item]));
      return { status: 200, body: {
        updatedAt: Date.now(),
        items: targetChains.map(chain => ({
          chain,
          observedTokenCount: observed.get(chain) ?? 0,
          milestoneTokenCount: milestones.get(chain) ?? 0,
          historicalAdmittedCount: historical.get(chain) ?? 0,
          aggregatedTokenCount: aggregated.get(chain) ?? 0,
          pendingPartitionCount: Number(partitionCounts.get(chain)?.pending ?? 0),
          failedPartitionCount: Number(partitionCounts.get(chain)?.failed ?? 0),
        })),
      } };
    }
    if (pathname === "/api/v2/candidate-funnel") {
      const scalar = (sql: string): number => Number((database.prepare(sql).get() as { count: number | null }).count ?? 0);
      return { status: 200, body: {
        historicalTokenCount: scalar("SELECT COUNT(*) AS count FROM historical_tokens"),
        milestoneReconstructedTokenCount: scalar("SELECT COUNT(DISTINCT token_id) AS count FROM token_milestone_crossings WHERE precision != 'unavailable'"),
        backfillCompletedCount: scalar("SELECT COUNT(*) AS count FROM milestone_backfill_jobs WHERE status = 'completed'"),
        backfillPendingCount: scalar("SELECT COUNT(*) AS count FROM milestone_backfill_jobs WHERE status IN ('pending', 'running', 'failed')"),
        evidenceCount: scalar("SELECT COUNT(*) AS count FROM candidate_evidence_v3"),
        evidenceTraderCount: scalar("SELECT COUNT(DISTINCT trader_id) AS count FROM candidate_evidence_v3"),
        identityUnresolvedCount: scalar("SELECT COUNT(DISTINCT e.trader_id) AS count FROM candidate_evidence_v3 e WHERE NOT EXISTS (SELECT 1 FROM trader_entities t WHERE t.entity_id = e.trader_id)"),
        historicalOnlyCount: scalar(`
          SELECT COUNT(*) AS count FROM candidate_admission_snapshots s
          WHERE s.historical_capability = 1 AND s.current_admission = 0
            AND NOT EXISTS (
              SELECT 1 FROM candidate_admission_snapshots newer
              WHERE newer.trader_id = s.trader_id
                AND (newer.evaluated_at > s.evaluated_at OR (newer.evaluated_at = s.evaluated_at AND newer.snapshot_id > s.snapshot_id))
            )
        `),
        currentAdmittedCount: scalar(`
          SELECT COUNT(*) AS count FROM candidate_admission_snapshots s
          WHERE s.current_admission = 1
            AND NOT EXISTS (
              SELECT 1 FROM candidate_admission_snapshots newer
              WHERE newer.trader_id = s.trader_id
                AND (newer.evaluated_at > s.evaluated_at OR (newer.evaluated_at = s.evaluated_at AND newer.snapshot_id > s.snapshot_id))
            )
        `),
        lastEvidenceAt: (database.prepare("SELECT MAX(evidence_at) AS value FROM candidate_evidence_v3").get() as { value: number | null }).value,
      } };
    }
    if (pathname === "/api/v2/candidates") {
      const items = rows(`
        SELECT s.trader_id AS traderId, s.current_admission AS currentAdmission,
          s.historical_capability AS historicalCapability, s.status,
          s.early_distinct_token_count AS earlyDistinctTokenCount,
          s.strong_distinct_token_count AS strongDistinctTokenCount,
          s.historical_distinct_token_count AS historicalDistinctTokenCount,
          s.reason_codes AS reasonCodes, s.window_start AS windowStart,
          s.window_end AS windowEnd, s.evaluated_at AS evaluatedAt,
          CASE WHEN EXISTS (SELECT 1 FROM trader_entities t WHERE t.entity_id = s.trader_id)
            THEN 'resolved' ELSE 'unresolved' END AS identityState,
          (SELECT p.display_name FROM trader_profiles p WHERE p.entity_id = s.trader_id) AS displayName,
          (SELECT GROUP_CONCAT(DISTINCT a.handle) FROM entity_accounts ea JOIN fomo_accounts a ON a.account_id = ea.account_id WHERE ea.entity_id = s.trader_id) AS handles,
          (SELECT GROUP_CONCAT(w.address, '|') FROM entity_accounts ea JOIN wallet_identities w ON w.account_id = ea.account_id WHERE ea.entity_id = s.trader_id AND w.chain_family = 'solana') AS solanaAddresses,
          (SELECT GROUP_CONCAT(w.address, '|') FROM entity_accounts ea JOIN wallet_identities w ON w.account_id = ea.account_id WHERE ea.entity_id = s.trader_id AND w.chain_family = 'evm') AS evmAddresses,
          (SELECT GROUP_CONCAT(DISTINCT h.chain) FROM candidate_evidence_v3 e JOIN historical_tokens h ON h.token_id = e.token_id WHERE e.trader_id = s.trader_id) AS chains,
          (SELECT evidence_type FROM candidate_evidence_v3 e
            WHERE e.trader_id = s.trader_id
            ORDER BY CASE e.admission_class WHEN 'strong' THEN 1 ELSE 0 END DESC,
              e.theoretical_opportunity DESC, e.evidence_at DESC LIMIT 1) AS strongestEvidenceType,
          (SELECT MAX(theoretical_opportunity) FROM candidate_evidence_v3 e
            WHERE e.trader_id = s.trader_id) AS strongestOpportunityMultiple,
          (SELECT MAX(evidence_at) FROM candidate_evidence_v3 e
            WHERE e.trader_id = s.trader_id) AS latestEvidenceAt
        FROM candidate_admission_snapshots s
        WHERE NOT EXISTS (
          SELECT 1 FROM candidate_admission_snapshots newer
          WHERE newer.trader_id = s.trader_id
            AND (newer.evaluated_at > s.evaluated_at OR (newer.evaluated_at = s.evaluated_at AND newer.snapshot_id > s.snapshot_id))
        )
        ORDER BY s.current_admission DESC, latestEvidenceAt DESC, s.trader_id
      `).map(item => {
        const row = item as Record<string, unknown>;
        return Object.freeze({
          ...row,
          reasonCodes: typeof row.reasonCodes === "string" ? Object.freeze(stringList(JSON.parse(row.reasonCodes) as unknown)) : Object.freeze([]),
        });
      });
      return { status: 200, body: { total: items.length, updatedAt: Date.now(), items } };
    }
    if (pathname === "/api/v2/workbench/summary") {
      const scalar = (sql: string): number => Number((database.prepare(sql).get() as { count: number | null }).count ?? 0);
      return { status: 200, body: {
        addressLibraryCount: scalar("SELECT COUNT(*) AS count FROM trader_entities WHERE lifecycle IN ('probation', 'active', 'elite', 'degraded') OR manual = 1 OR locked = 1"),
        candidateCount: scalar("SELECT COUNT(*) AS count FROM trader_entities WHERE lifecycle = 'candidate'"),
        pendingIdentityCount: scalar("SELECT COUNT(*) AS count FROM identity_resolution_queue WHERE status IN ('pending', 'exported')"),
        monitoredWalletCount: scalar("SELECT COUNT(*) AS count FROM wallet_identities") + scalar("SELECT COUNT(*) AS count FROM entity_wallet_identities"),
        aggregatedTokenCount: scalar("SELECT COUNT(*) AS count FROM token_evaluation_state"),
        qualifiedSignalCount: scalar("SELECT COUNT(*) AS count FROM broadcast_records"),
        deliveredSignalCount: scalar("SELECT COUNT(*) AS count FROM signal_outbox WHERE status = 'delivered'"),
      } };
    }
    if (pathname === "/api/v2/token-aggregates") {
      const items = rows(`
        SELECT e.token_id AS tokenId, e.chain, e.token_address AS tokenAddress,
          e.action, e.signal_family AS signalFamily, e.lifecycle_stage AS lifecycleStage,
          e.score AS currentScore, e.participant_count AS participantCount,
          e.total_buy_usd AS totalBuyUsd, e.source_state AS sourceState,
          e.window_ms AS windowMs, e.missing_conditions AS missingConditions, e.bundle_diagnostics AS bundleDiagnostics,
          COALESCE(a.broadcast_count, 0) AS broadcastCount, e.updated_at AS updatedAt
        FROM token_evaluation_state e
        LEFT JOIN token_aggregation_state a ON a.token_id = e.token_id
        ORDER BY e.updated_at DESC, e.chain, e.token_address
        LIMIT 500
      `).map(item => {
        const row = item as Record<string, unknown>;
        const conditions = typeof row.missingConditions === "string"
          ? stringList(JSON.parse(row.missingConditions) as unknown)
          : [];
        return Object.freeze({
          ...row,
          bundleDiagnostics: typeof row.bundleDiagnostics === "string" ? JSON.parse(row.bundleDiagnostics) : {},
          missingConditions: Object.freeze(conditions),
          missingConditionLabels: Object.freeze(conditions.map(explainTokenMissingCondition)),
        });
      });
      return { status: 200, body: { total: items.length, page: 1, pageSize: 500, updatedAt: Date.now(), items } };
    }
    if (pathname === "/api/v2/historical-tokens") {
      const items = rows(`
        SELECT h.token_id AS tokenId, h.chain, h.token_address AS tokenAddress,
          h.symbol, h.image_url AS imageUrl, h.first_trade_at AS firstTradeAt,
          h.first_reached_1m_at AS firstReached1mAt,
          h.peak_market_cap_usd AS peakMarketCapUsd, h.source,
          v.status AS verificationStatus, v.attempt_count AS verificationAttempts,
          v.exact_ca_match AS exactAddressMatch, v.history_available AS historyAvailable,
          v.last_error AS verificationError, v.last_checked_at AS verificationCheckedAt,
          CASE WHEN EXISTS (
            SELECT 1 FROM token_milestone_crossings m
            WHERE m.token_id = h.token_id AND m.precision != 'unavailable'
          ) THEN 'complete' ELSE 'missing' END AS milestoneStatus,
          CASE early.status
            WHEN 'available' THEN 'completed'
            WHEN 'partial' THEN 'completed'
            WHEN 'degraded' THEN 'completed'
            WHEN 'fetching' THEN 'running'
            WHEN 'scheduled' THEN 'pending'
            WHEN 'retry_scheduled' THEN 'pending'
            WHEN 'conflicted' THEN 'failed'
            WHEN 'terminal_unavailable' THEN 'failed'
            ELSE 'not_scheduled'
          END AS backfillStatus,
          (SELECT COUNT(*) FROM candidate_evidence_v3 e WHERE e.token_id = h.token_id) AS eligibleBuyerCount,
          (SELECT COUNT(DISTINCT e.trader_id) FROM candidate_evidence_v3 e WHERE e.token_id = h.token_id) AS evidenceTraderCount,
          (SELECT r.status FROM historical_re_evaluation_requests r WHERE r.token_id = h.token_id ORDER BY r.requested_at DESC LIMIT 1) AS reEvaluationStatus
        FROM historical_tokens h
        JOIN historical_token_verifications v ON v.token_id = h.token_id
        LEFT JOIN token_fact_status early
          ON early.token_id = h.token_id AND early.fact_type = 'early_trades'
        WHERE LOWER(h.chain) IN ('solana', 'eth', 'ethereum', 'bsc', 'robinhood', 'base')
        ORDER BY h.first_reached_1m_at DESC, h.chain, h.token_address
        LIMIT 1000
      `).map(item => {
        const row = item as Record<string, unknown>;
        const diagnostics: string[] = [];
        if (row.milestoneStatus !== "complete") diagnostics.push("缺少可信的市值里程碑时间");
        if (row.verificationStatus === "pending" || row.verificationStatus === "queued") diagnostics.push("等待 Fomo 精确验证");
        if (row.verificationStatus === "deferred") diagnostics.push("Fomo 查询暂时不可用，等待重试");
        if (row.verificationStatus === "not_found") diagnostics.push("Fomo 连续两次未找到，已隔离");
        if (row.verificationStatus === "mismatch") diagnostics.push("Fomo 搜索结果与 CA 不一致，已隔离");
        if (row.verificationStatus === "confirmed" && Number(row.historyAvailable ?? 0) !== 1) diagnostics.push("Fomo 已收录，但历史交易暂不可用");
        if (row.backfillStatus === "not_scheduled") diagnostics.push("尚未安排历史交易回补");
        if (row.backfillStatus === "failed") diagnostics.push("历史交易回补失败，可手动重试");
        if (Number(row.eligibleBuyerCount ?? 0) === 0) diagnostics.push("尚未发现满足最低买入金额的早期交易员");
        return Object.freeze({ ...row, diagnostics: Object.freeze(diagnostics) });
      });
      return { status: 200, body: { total: items.length, updatedAt: Date.now(), items } };
    }
    if (pathname === "/api/v2/historical-partitions") {
      const items = rows(`
        SELECT partition_id AS partitionId, query_kind AS queryKind, chain,
          day_start AS dayStart, day_end AS dayEnd, token_addresses AS tokenAddresses,
          status, execution_id AS executionId, next_offset AS nextOffset,
          row_count AS rowCount, attempt_count AS attemptCount, watermark,
          next_retry_at AS nextRetryAt, lease_expires_at AS leaseExpiresAt,
          last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt,
          completed_at AS completedAt
        FROM historical_backfill_partitions
        ORDER BY updated_at DESC, partition_id
        LIMIT 1000
      `).map(item => {
        const row = item as Record<string, unknown>;
        return Object.freeze({
          ...row,
          tokenAddresses: typeof row.tokenAddresses === "string" ? Object.freeze(stringList(JSON.parse(row.tokenAddresses) as unknown)) : Object.freeze([]),
        });
      });
      return { status: 200, body: { total: items.length, updatedAt: Date.now(), items } };
    }
    if (pathname === "/api/v2/historical-operations") {
      const usageDay = new Date().toISOString().slice(0, 10);
      const credits = database.prepare("SELECT credits_used AS creditsUsed FROM historical_backfill_credit_usage WHERE usage_day = ?").get(usageDay) as { creditsUsed: number } | undefined;
      const counts = database.prepare(`
        SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingPartitionCount,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningPartitionCount,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedPartitionCount
        FROM historical_backfill_partitions
      `).get() as Record<string, number | null>;
      const watermarks = rows(`
        SELECT chain, query_kind AS queryKind, watermark, updated_at AS updatedAt
        FROM historical_backfill_watermarks ORDER BY chain, query_kind
      `);
      const realtime = database.prepare("SELECT MAX(occurred_at) AS value FROM trader_events").get() as { value: number | null };
      const historical = database.prepare("SELECT MAX(watermark) AS value FROM historical_backfill_watermarks").get() as { value: number | null };
      const verification = database.prepare(`
        SELECT
          SUM(CASE WHEN status = 'confirmed' AND history_available = 1 THEN 1 ELSE 0 END) AS confirmedCount,
          SUM(CASE WHEN status IN ('pending', 'queued', 'deferred') THEN 1 ELSE 0 END) AS pendingCount,
          SUM(CASE WHEN status IN ('not_found', 'mismatch') THEN 1 ELSE 0 END) AS quarantinedCount,
          SUM(CASE WHEN status = 'unsupported' THEN 1 ELSE 0 END) AS unsupportedCount
        FROM historical_token_verifications
      `).get() as Record<string, number | null>;
      const stage = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM historical_token_verifications WHERE status = 'queued' AND next_retry_at > ?) AS activeFomoLookupCount,
          (SELECT COUNT(*) FROM historical_token_verifications WHERE status = 'confirmed' AND exact_ca_match = 1 AND history_available = 1) AS milestoneEligibleTokenCount,
          (SELECT COUNT(DISTINCT token_id) FROM token_milestone_crossings WHERE crossed_at IS NOT NULL AND precision != 'unavailable') AS milestoneCompletedTokenCount,
          (SELECT COUNT(DISTINCT e.token_id) FROM candidate_evidence_v3 e) AS earlyTradeCompletedTokenCount,
          (SELECT COUNT(*) FROM trader_sources WHERE source_key = 'milestone') AS materializedHistoricalTraderCount
      `).get(Date.now()) as Record<string, number | null>;
      return { status: 200, body: {
        creditsUsedToday: Number(credits?.creditsUsed ?? 0),
        pendingPartitionCount: Number(counts.pendingPartitionCount ?? 0),
        runningPartitionCount: Number(counts.runningPartitionCount ?? 0),
        failedPartitionCount: Number(counts.failedPartitionCount ?? 0),
        historicalWatermark: historical.value,
        realtimeWatermark: realtime.value,
        fomoConfirmedCount: Number(verification.confirmedCount ?? 0),
        fomoPendingCount: Number(verification.pendingCount ?? 0),
        fomoQuarantinedCount: Number(verification.quarantinedCount ?? 0),
        unsupportedTokenCount: Number(verification.unsupportedCount ?? 0),
        activeFomoLookupCount: Number(stage.activeFomoLookupCount ?? 0),
        milestoneEligibleTokenCount: Number(stage.milestoneEligibleTokenCount ?? 0),
        milestoneCompletedTokenCount: Number(stage.milestoneCompletedTokenCount ?? 0),
        earlyTradeCompletedTokenCount: Number(stage.earlyTradeCompletedTokenCount ?? 0),
        materializedHistoricalTraderCount: Number(stage.materializedHistoricalTraderCount ?? 0),
        watermarks,
        updatedAt: Date.now(),
      } };
    }
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
      SELECT j.analysis_id AS analysisId, j.chain_family AS chainFamily, j.address, j.display_name AS displayName,
        j.fomo_handle AS fomoHandle, j.status, j.requested_sample_count AS requestedSampleCount,
        j.valid_sample_count AS validSampleCount, j.coverage_rate AS coverageRate, j.metrics,
        j.last_error AS lastError, j.created_at AS createdAt, j.updated_at AS updatedAt, j.reviewed_at AS reviewedAt,
        p.phase, p.processed_transactions AS processedTransactions, p.discovered_tokens AS discoveredTokens,
        p.progress_percent AS progressPercent, p.heartbeat_at AS heartbeatAt, p.next_retry_at AS nextRetryAt
      FROM wallet_analysis_jobs j
      LEFT JOIN wallet_analysis_progress p ON p.analysis_id = j.analysis_id
      ORDER BY j.created_at DESC LIMIT 500
    `) };
    if (pathname === "/api/v1/config") return { status: 200, body: rows("SELECT strategy_version AS strategyVersion, payload, created_at AS createdAt FROM strategy_config_versions ORDER BY created_at DESC") };
    if (pathname === "/api/v1/audit") return { status: 200, body: rows("SELECT audit_id AS auditId, action, actor, payload, occurred_at AS occurredAt FROM operator_audit_log ORDER BY occurred_at DESC LIMIT 500") };
    return null;
  };

  return {
    handle(method, pathname, body) {
      if (method === "GET") return read(pathname) ?? { status: 404, body: { error: "not_found" } };
      const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const recoveryRetryMatch = pathname.match(/^\/api\/v2\/recovery\/jobs\/([^/]+)\/retry$/);
      const traderRetryMatch = pathname.match(/^\/api\/v2\/backfill\/traders\/([^/]+)\/retry$/);
      if (method === "POST" && traderRetryMatch) {
        const traderId = decodeURIComponent(traderRetryMatch[1] ?? "");
        const requestedJobId = typeof input.jobId === "string" ? input.jobId : null;
        const job = database.prepare(`
          SELECT job_id AS jobId, status, lease_expires_at AS leaseExpiresAt
          FROM automation_jobs
          WHERE subject_key = ? AND (? IS NULL OR job_id = ?)
          ORDER BY updated_at DESC LIMIT 1
        `).get(traderId, requestedJobId, requestedJobId) as { jobId: string; status: string; leaseExpiresAt: number | null } | undefined;
        if (!job) return { status: 404, body: { error: "automation_job_not_found" } };
        const now = Date.now();
        if (job.status === "completed" || job.status === "cancelled") return { status: 409, body: { error: "automation_job_not_retryable", diagnosticZh: "已完成或已取消的任务不能重试" } };
        if (["leased", "running"].includes(job.status) && (job.leaseExpiresAt ?? now + 1) > now) return { status: 409, body: { error: "automation_job_actively_leased", diagnosticZh: "任务仍由工作进程执行，不能重复领取" } };
        database.prepare(`
          UPDATE automation_jobs SET status = 'pending', next_attempt_at = ?,
            lease_expires_at = NULL, lease_owner = NULL, last_error = NULL,
            completed_at = NULL, updated_at = ? WHERE job_id = ?
        `).run(now, now, job.jobId);
        audit("automation.trader_retry", { traderId, jobId: job.jobId, previousStatus: job.status });
        return { status: 202, body: { traderId, jobId: job.jobId, status: "pending", updatedAt: now } };
      }
      const partitionRetryMatch = pathname.match(/^\/api\/v2\/mining\/partitions\/([^/]+)\/retry$/);
      if (method === "POST" && partitionRetryMatch) {
        const partitionId = decodeURIComponent(partitionRetryMatch[1] ?? "");
        const partition = database.prepare("SELECT status FROM historical_token_partitions WHERE partition_id = ?").get(partitionId) as { status: string } | undefined;
        if (!partition) return { status: 404, body: { error: "mining_partition_not_found" } };
        const now = Date.now();
        const active = database.prepare(`
          SELECT 1 AS active FROM automation_jobs
          WHERE subject_key = ? AND status IN ('leased', 'running') AND COALESCE(lease_expires_at, ?) > ?
          LIMIT 1
        `).get(partitionId, now + 1, now);
        if (partition.status === "completed") return { status: 409, body: { error: "mining_partition_completed", diagnosticZh: "分区已经完成，无需重试" } };
        if (active) return { status: 409, body: { error: "mining_partition_actively_leased", diagnosticZh: "分区仍在执行，不能重复领取" } };
        database.prepare(`
          UPDATE historical_token_partitions SET status = 'pending', next_attempt_at = ?,
            last_error = NULL, completed_at = NULL, updated_at = ? WHERE partition_id = ?
        `).run(now, now, partitionId);
        database.prepare(`
          UPDATE automation_jobs SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL,
            lease_owner = NULL, last_error = NULL, completed_at = NULL, updated_at = ?
          WHERE subject_key = ? AND status IN ('waiting_source', 'retryable', 'terminal')
        `).run(now, now, partitionId);
        audit("automation.partition_retry", { partitionId, previousStatus: partition.status });
        return { status: 202, body: { partitionId, status: "pending", updatedAt: now } };
      }
      if (method === "POST" && recoveryRetryMatch) {
        const jobId = decodeURIComponent(recoveryRetryMatch[1] ?? "");
        const job = database.prepare("SELECT status FROM recovery_jobs WHERE job_id = ?").get(jobId) as { status: string } | undefined;
        if (!job) return { status: 404, body: { error: "recovery_job_not_found" } };
        if (!new Set(["failed", "dead_letter"]).has(job.status)) return { status: 409, body: { error: "recovery_job_not_retryable" } };
        const now = Date.now();
        database.prepare("UPDATE recovery_jobs SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL, last_error = NULL, completed_at = NULL, updated_at = ? WHERE job_id = ?").run(now, now, jobId);
        audit("recovery.retry", { jobId, previousStatus: job.status });
        return { status: 200, body: { jobId, status: "pending", updatedAt: now } };
      }
      const tokenReEvaluateMatch = pathname.match(/^\/api\/v2\/tokens\/([^/]+)\/re-evaluate$/);
      if (method === "POST" && tokenReEvaluateMatch) {
        const tokenId = decodeURIComponent(tokenReEvaluateMatch[1] ?? "");
        const token = database.prepare("SELECT chain, token_address AS tokenAddress FROM token_observation_state WHERE token_id = ?").get(tokenId) as { chain: "solana" | "eth" | "bsc" | "base" | "robinhood"; tokenAddress: string } | undefined;
        if (!token) return { status: 404, body: { error: "token_observation_not_found" } };
        const now = Date.now();
        const queued: RecoveryJobType[] = ["market_enrichment", "market_history", "fomo_token_history", "milestone_early_buyers"];
        const priorities: Record<RecoveryJobType, number> = { rpc_gap: 10, market_enrichment: 20, market_history: 25, fomo_token_history: 30, milestone_early_buyers: 35, identity_resolution: 40, historical_research: 60 };
        for (const jobType of queued) {
          const existing = database.prepare("UPDATE recovery_jobs SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL, last_error = NULL, completed_at = NULL, updated_at = ? WHERE job_type = ? AND chain = ? AND subject_key = ?").run(now, now, jobType, token.chain, tokenId);
          if (existing.changes === 0) sourceLedger.enqueueRecoveryJob({ jobId: `recovery:${jobType}:${tokenId}`, jobType, chain: token.chain, subjectKey: tokenId, priority: priorities[jobType], cursor: null, nextAttemptAt: now, createdAt: now });
        }
        audit("token.re_evaluate", { tokenId, queued });
        return { status: 202, body: { tokenId, queued, requestedAt: now } };
      }
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
        const activeAnalysis = database.prepare(`
          SELECT analysis_id AS analysisId, status, valid_sample_count AS validSampleCount,
            coverage_rate AS coverageRate, metrics
          FROM wallet_analysis_jobs
          WHERE chain_family = ? AND address = ? AND requested_sample_count = ?
            AND status IN ('collecting', 'review_required')
          ORDER BY CASE status WHEN 'review_required' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT 1
        `).get(chainFamily, address, requestedSampleCount) as { analysisId: string; status: string; validSampleCount: number; coverageRate: number; metrics: string | null } | undefined;
        if (activeAnalysis) {
          return {
            status: 200,
            body: {
              analysisId: activeAnalysis.analysisId,
              chainFamily,
              address,
              status: activeAnalysis.status,
              metrics: activeAnalysis.metrics ? JSON.parse(activeAnalysis.metrics) : null,
              reused: true,
            },
          };
        }
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
        database.prepare(`
          INSERT INTO wallet_analysis_progress(analysis_id, phase, processed_transactions, discovered_tokens, progress_percent, heartbeat_at, next_retry_at, updated_at)
          VALUES (?, ?, 0, ?, ?, ?, NULL, ?)
        `).run(analysisId, metrics ? "completed" : "queued", metrics?.validSamples ?? 0, metrics ? 100 : 0, now, now);
        audit("wallet_analysis.create", { analysisId, chainFamily, address, requestedSampleCount, status });
        return { status: 201, body: { analysisId, chainFamily, address, status, metrics, reused: false } };
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
        withAddressRadarWriteTransaction(database, () => {
          database.prepare("INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, ?, 'confirmed', 'manual_analysis', ?, ?) ON CONFLICT(account_id, chain_family, address) DO UPDATE SET confidence = 'confirmed', source = 'manual_analysis', last_observed_at = excluded.last_observed_at")
            .run(account.accountId, job.chainFamily, job.address, now, now);
          database.prepare("UPDATE trader_profiles SET monitoring_enabled = 1, onchain_monitoring_enabled = 1, updated_at = ? WHERE entity_id = ?").run(now, entityId);
          database.prepare("UPDATE trader_entities SET lifecycle = CASE WHEN lifecycle = 'candidate' THEN 'probation' ELSE lifecycle END, updated_at = ? WHERE entity_id = ?").run(now, entityId);
          database.prepare("UPDATE wallet_analysis_jobs SET status = 'accepted', reviewed_at = ?, updated_at = ? WHERE analysis_id = ?").run(now, now, analysisId);
          database.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(now);
          database.prepare("INSERT INTO monitoring_registry_outbox(event_id, entity_id, event_type, payload, status, created_at, published_at) VALUES (?, ?, 'wallet_analysis.accepted', ?, 'published', ?, ?)")
            .run(randomUUID(), entityId, JSON.stringify({ analysisId, entityId, accountId: account.accountId, wallet: { family: job.chainFamily, address: job.address } }), now, now);
        }, { label: "console_accept_wallet_analysis" });
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
        const requestedHandle = rawHandle ? normalizeFomoHandle(rawHandle) : null;
        const wallets = [
          ...evmAddresses.map(address => ({ family: "evm" as const, address: normalizeWalletAddress("evm", address) })),
          ...solanaAddresses.map(address => ({ family: "solana" as const, address: normalizeWalletAddress("solana", address) })),
        ];
        const ownedWallets = wallets.flatMap(wallet => {
          const accountId = resolutionRepository.walletOwner(wallet.family, wallet.address);
          return accountId ? [{ wallet, accountId }] : [];
        });
        const walletOwnerIds = [...new Set(ownedWallets.map(item => item.accountId))];
        const conflictResult = (conflictingAccountId: string, wallet: typeof wallets[number], reason: string) => {
          const owner = database.prepare(`
            SELECT ea.entity_id AS entityId, p.display_name AS displayName, f.handle
            FROM entity_accounts ea
            LEFT JOIN trader_profiles p ON p.entity_id = ea.entity_id
            LEFT JOIN fomo_accounts f ON f.account_id = ea.account_id
            WHERE ea.account_id = ?
            ORDER BY ea.last_observed_at DESC LIMIT 1
          `).get(conflictingAccountId) as { entityId: string; displayName: string | null; handle: string | null } | undefined;
          return {
            status: 409,
            body: {
              error: "wallet_identity_conflict",
              reason,
              chainFamily: wallet.family,
              address: wallet.address,
              conflictingAccountId,
              conflictingEntityId: owner?.entityId ?? null,
              conflictingDisplayName: owner?.displayName ?? owner?.handle ?? null,
            },
          };
        };
        if (walletOwnerIds.length > 1) {
          const conflicting = ownedWallets.find(item => item.accountId !== walletOwnerIds[0]) ?? ownedWallets[0]!;
          return conflictResult(conflicting.accountId, conflicting.wallet, "wallets_owned_by_multiple_traders");
        }
        const walletOwnerId = walletOwnerIds[0] ?? null;
        const handleAccount = requestedHandle
          ? database.prepare("SELECT account_id AS accountId, handle FROM fomo_accounts WHERE handle = ? COLLATE NOCASE").get(requestedHandle) as { accountId: string; handle: string } | undefined
          : undefined;
        const explicitAccountId = typeof input.accountId === "string" && input.accountId.trim() ? input.accountId.trim() : null;
        const requestedAccountId = explicitAccountId ?? handleAccount?.accountId ?? walletOwnerId;
        if (walletOwnerId && requestedAccountId && walletOwnerId !== requestedAccountId) {
          return conflictResult(walletOwnerId, ownedWallets[0]!.wallet, "wallet_owned_by_another_trader");
        }
        const ownerAccount = walletOwnerId
          ? database.prepare("SELECT account_id AS accountId, handle FROM fomo_accounts WHERE account_id = ?").get(walletOwnerId) as { accountId: string; handle: string } | undefined
          : undefined;
        if (requestedHandle && ownerAccount && !handleAccount && !ownerAccount.handle.startsWith("wallet-") && ownerAccount.handle.toLowerCase() !== requestedHandle.toLowerCase()) {
          return conflictResult(ownerAccount.accountId, ownedWallets[0]!.wallet, "wallet_owned_by_named_trader");
        }
        const accountId = requestedAccountId ?? `manual-account:${identityId}`;
        const existingEntity = database.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = ? ORDER BY last_observed_at DESC LIMIT 1").get(accountId) as { entityId: string } | undefined;
        const explicitEntityId = typeof input.entityId === "string" && input.entityId.trim() ? input.entityId.trim() : null;
        if (explicitEntityId && existingEntity && explicitEntityId !== existingEntity.entityId) {
          return { status: 409, body: { error: "entity_account_conflict", accountId, conflictingEntityId: existingEntity.entityId } };
        }
        const entityId = explicitEntityId ?? existingEntity?.entityId ?? `manual-entity:${identityId}`;
        const handle = requestedHandle ?? ownerAccount?.handle ?? `wallet-${identityId}`;
        const created = !existingEntity;
        const priority = input.priority === "important" ? "important" : "normal";
        const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null;
        const tags: Array<{ category: typeof allowedTagCategories[number]; tag: string }> = allowedTagCategories.flatMap(category => typedTags(input, category).map(tag => ({ category, tag })));
        if (!tags.some(item => item.category === "source")) tags.push({ category: "source", tag: "source.manual" });
        withAddressRadarWriteTransaction(database, () => {
          database.prepare("INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET handle = excluded.handle, last_seen_at = excluded.last_seen_at").run(accountId, handle, now, now);
          database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES (?, 'probation', 1, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET manual = 1, locked = MAX(trader_entities.locked, excluded.locked), lifecycle = CASE WHEN trader_entities.lifecycle = 'candidate' THEN 'probation' ELSE trader_entities.lifecycle END, updated_at = excluded.updated_at").run(entityId, Number(priority === "important"), now, now);
          database.prepare("INSERT INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, 'confirmed', ?, ?, ?) ON CONFLICT(entity_id, account_id) DO UPDATE SET confidence = 'confirmed', source = excluded.source, last_observed_at = excluded.last_observed_at").run(entityId, accountId, rawHandle ? "manual" : "manual_wallet", now, now);
          database.prepare("INSERT INTO trader_profiles(entity_id, display_name, priority, notes, monitoring_enabled, fomo_monitoring_enabled, onchain_monitoring_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET display_name = excluded.display_name, priority = excluded.priority, notes = excluded.notes, monitoring_enabled = 1, fomo_monitoring_enabled = MAX(trader_profiles.fomo_monitoring_enabled, excluded.fomo_monitoring_enabled), onchain_monitoring_enabled = MAX(trader_profiles.onchain_monitoring_enabled, excluded.onchain_monitoring_enabled), updated_at = excluded.updated_at")
            .run(entityId, displayName, priority, notes, Number(Boolean(rawHandle)), Number(wallets.length > 0), now, now);
          const attach = database.prepare("INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, ?, 'confirmed', 'manual', ?, ?) ON CONFLICT(account_id, chain_family, address) DO UPDATE SET confidence = 'confirmed', source = 'manual', last_observed_at = excluded.last_observed_at");
          for (const wallet of wallets) attach.run(accountId, wallet.family, wallet.address, now, now);
          const addTag = database.prepare("INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at) VALUES (?, ?, ?, ?)");
          for (const tag of tags) addTag.run(entityId, tag.category, tag.tag, now);
          const eventType = created ? "identity.created" : "identity.updated";
          database.prepare("INSERT INTO monitoring_registry_outbox(event_id, entity_id, event_type, payload, status, created_at, published_at) VALUES (?, ?, ?, ?, 'published', ?, ?)")
            .run(`identity-registry:${entityId}:${created ? "created" : "updated"}:${now}`, entityId, eventType, JSON.stringify({ entityId, accountId, wallets, lifecycle: "probation" }), now, now);
          database.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(now);
        }, { label: "console_create_manual_trader" });
        audit(created ? "trader.manual_add" : "trader.manual_update", { entityId, accountId, displayName, fomoHandle: rawHandle ? handle : null, wallets, tags });
        return {
          status: created ? 201 : 200,
          body: {
            entityId,
            accountId,
            displayName,
            fomoHandle: rawHandle ? handle : null,
            lifecycleStatus: "observing",
            created,
            updated: !created,
          },
        };
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
      const historicalPartitionRetryMatch = pathname.match(/^\/api\/v2\/historical-partitions\/([^/]+)\/retry$/);
      if (method === "POST" && historicalPartitionRetryMatch) {
        const partitionId = decodeURIComponent(historicalPartitionRetryMatch[1] ?? "");
        const partition = database.prepare("SELECT status FROM historical_backfill_partitions WHERE partition_id = ?").get(partitionId) as { status: string } | undefined;
        if (!partition) return { status: 404, body: { error: "historical_partition_not_found" } };
        if (partition.status !== "failed") return { status: 409, body: { error: "historical_partition_not_retryable" } };
        const now = Date.now();
        database.prepare(`
          UPDATE historical_backfill_partitions
          SET status = 'pending', execution_id = NULL, next_offset = NULL,
            lease_expires_at = NULL, last_error = NULL, next_retry_at = ?,
            completed_at = NULL, updated_at = ?
          WHERE partition_id = ?
        `).run(now, now, partitionId);
        audit("historical_partition.retry", { partitionId, previousStatus: partition.status });
        return { status: 200, body: { partitionId, status: "pending", updatedAt: now } };
      }
      const historicalReEvaluateMatch = pathname.match(/^\/api\/v2\/historical-tokens\/([^/]+)\/re-evaluate$/);
      if (method === "POST" && historicalReEvaluateMatch) {
        const tokenId = decodeURIComponent(historicalReEvaluateMatch[1] ?? "");
        const token = database.prepare("SELECT token_id AS tokenId FROM historical_tokens WHERE token_id = ?").get(tokenId) as { tokenId: string } | undefined;
        if (!token) return { status: 404, body: { error: "historical_token_not_found" } };
        const existing = database.prepare("SELECT request_id AS requestId, status, requested_at AS requestedAt FROM historical_re_evaluation_requests WHERE token_id = ? AND status IN ('pending', 'running') ORDER BY requested_at DESC LIMIT 1").get(tokenId) as { requestId: string; status: string; requestedAt: number } | undefined;
        if (existing) return { status: 202, body: { tokenId, ...existing } };
        const requestId = randomUUID();
        const requestedAt = Date.now();
        database.prepare("INSERT INTO historical_re_evaluation_requests(request_id, token_id, status, requested_at, started_at, completed_at, last_error) VALUES (?, ?, 'pending', ?, NULL, NULL, NULL)")
          .run(requestId, tokenId, requestedAt);
        audit("historical_token.re_evaluate", { requestId, tokenId });
        return { status: 202, body: { requestId, tokenId, status: "pending", requestedAt } };
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
