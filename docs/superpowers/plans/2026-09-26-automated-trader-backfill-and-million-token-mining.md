# Automated Trader Backfill and Million-Token Mining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable dual-lane automation pipeline that batch-processes all observed traders, mines five-chain historical million-market-cap tokens, produces candidate evidence automatically, and exposes truthful operational state without enabling user delivery.

**Architecture:** Add one focused `apps/automation` worker that owns scheduling, leasing, lightweight evaluation, historical token partitions, candidate evidence generation, and repair. Existing wallet-monitor and wallet-analysis services remain responsible for real-time chain observation and bounded wallet-history collection. SQLite remains the system of record, with additive schema migrations, short retryable write transactions, source-specific budgets, and fully idempotent jobs.

**Tech Stack:** TypeScript, Node.js 24, `node:sqlite`, pnpm workspaces, Vitest, systemd, existing Address Radar domain/database/identity/collector packages.

**Execution mode:** Current-session inline execution with checkpoints. Do not create Git commits unless the user explicitly requests them.

**Specification:** `docs/specs/2026-09-26-automated-trader-backfill-and-million-token-mining-spac.md`

---

## Delivery stages

### Stage 1: Safety, truthful state, and durable foundations

Tasks 1 through 5 fix backup reliability, correct misleading metrics, separate monitoring from performance lifecycle, add durable automation storage, and remove SQLite write-loss behavior.

### Stage 2: Automatic backfill and historical token mining

Tasks 6 through 10 implement fair scheduling, existing-trader backfill, identity-triggered jobs, Solana rate control, and five-chain historical token partitions.

### Stage 3: Evidence closure, console, and production acceptance

Tasks 11 through 15 wire candidate evidence into production, compute repeatable ability, expose the automation console, run replay/load tests, and deploy in shadow mode.

---

## Task 1: Make production backups deterministic for large databases

**Files:**

- Modify: `scripts/backup-production-state.sh`
- Modify: `deployment/systemd/address-radar-backup.service`
- Create: `scripts/test/backup-production-state.test.ts`

- [ ] **Step 1: Write a failing backup regression test**

Create a temporary WAL database, insert enough rows to produce multiple pages, execute the backup script with temporary paths, then verify the completed database passes `PRAGMA quick_check` and contains every row.

```ts
it("creates a complete offline snapshot without leaving a partial backup", async () => {
  const source = await createWalFixture(25_000);
  const result = await runBackupScript({ databasePath: source.path, backupRoot: source.backupRoot });
  expect(result.exitCode).toBe(0);
  expect(result.completedFiles).toHaveLength(1);
  expect(result.partialFiles).toHaveLength(0);
  expect(readCount(result.completedFiles[0]!)).toBe(25_000);
  expect(quickCheck(result.completedFiles[0]!)).toBe("ok");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails against the current online-backup timeout behavior**

Run:

```bash
corepack pnpm vitest run scripts/test/backup-production-state.test.ts
```

Expected: FAIL because the script does not expose deterministic offline snapshot behavior and does not validate the result.

- [ ] **Step 3: Replace the memory-sensitive online copy with checkpoint, copy, and verification**

The script must assume all database-accessing services are stopped by systemd, checkpoint WAL, copy the static database, and validate before renaming.

```bash
node --input-type=module - "$database_path" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2]);
database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
database.close();
NODE

cp --reflink=auto --sparse=always "$database_path" "$partial"

node --input-type=module - "$partial" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const result = database.prepare("PRAGMA quick_check").get();
if (Object.values(result)[0] !== "ok") process.exit(1);
database.close();
NODE

mv "$partial" "$completed"
```

- [ ] **Step 4: Stop and restore every database-accessing production service around backup**

Update the unit so `ExecStartPre` stops scanner, wallet-monitor, wallet-analysis, automation, and console. Keep `ExecStopPost` restoration so a failed backup cannot leave services stopped.

- [ ] **Step 5: Run the focused test**

Run:

```bash
corepack pnpm vitest run scripts/test/backup-production-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Record that backups complete, validate, and restore services. Do not commit unless explicitly requested.

---

## Task 2: Correct the trader discovery funnel

**Files:**

- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/app.ts`
- Modify: `apps/console/public/index.html`
- Modify: `apps/console/test/multi-source-operations.test.ts`
- Create: `apps/console/test/automation-funnel.test.ts`

- [ ] **Step 1: Write failing API tests for truthful funnel semantics**

Seed 10 entities, 8 Fomo account mappings, 3 wallet identities, 2 monitoring policies, 1 completed backfill, and 1 candidate evidence row.

```ts
expect(response.body).toMatchObject({
  observedFomoHandles: 8,
  canonicalTraders: 10,
  walletResolvedTraders: 3,
  monitoringEligibleTraders: 2,
  initialBackfillQueued: 2,
  initialBackfillCompleted: 1,
  candidateEvidenceTraders: 1,
});
```

- [ ] **Step 2: Run the focused test and confirm the old query mislabels all canonical traders as identity-resolved**

Run:

```bash
corepack pnpm vitest run apps/console/test/automation-funnel.test.ts
```

Expected: FAIL with `walletResolvedTraders` equal to the entity count instead of the wallet-resolved count.

- [ ] **Step 3: Implement a new `/api/v2/automation/overview` response**

Return separate metrics for account normalization, wallet resolution, monitoring eligibility, backfill coverage, evidence, and admission. Do not change public `/health`.

```ts
interface AutomationOverviewResponse {
  readonly updatedAt: number;
  readonly funnel: {
    readonly observedFomoHandles: number;
    readonly canonicalTraders: number;
    readonly walletResolvedTraders: number;
    readonly monitoringEligibleTraders: number;
    readonly initialBackfillQueued: number;
    readonly initialBackfillCompleted: number;
    readonly periodicCoverageCurrent: number;
    readonly candidateEvidenceTraders: number;
    readonly admittedTraders: number;
  };
}
```

- [ ] **Step 4: Replace misleading Chinese labels in the console**

Use `已观察 Fomo 用户`, `规范交易员`, `钱包已解析`, `已进入监控`, `首次回补`, `覆盖已更新`, `候选证据`, and `候选准入`.

- [ ] **Step 5: Run console tests**

Run:

```bash
corepack pnpm vitest run apps/console/test/automation-funnel.test.ts apps/console/test/multi-source-operations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Confirm the API reports production concepts accurately. Do not commit unless explicitly requested.

---

## Task 3: Separate data coverage, performance, and monitoring policy

**Files:**

- Create: `packages/domain/src/trader-automation.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrations.ts`
- Create: `packages/database/src/trader-automation-store.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/identity/src/monitoring-registry.ts`
- Create: `packages/identity/test/monitoring-policy.test.ts`
- Create: `packages/database/test/trader-automation-store.test.ts`

- [ ] **Step 1: Write failing state-separation tests**

Cover these required cases:

```ts
it("keeps a suspended trader in lightweight collection when policy is lightweight");
it("loads a suspended trader wallet when policy is realtime");
it("does not load a qualified trader when policy is off");
it("does not mutate performance lifecycle while updating coverage");
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run packages/identity/test/monitoring-policy.test.ts packages/database/test/trader-automation-store.test.ts
```

Expected: FAIL because monitoring currently depends on `lifecycle != 'suspended'`.

- [ ] **Step 3: Add domain contracts**

```ts
export type TraderCoverageState = "unseen" | "queued" | "backfilling" | "current" | "degraded" | "stale";
export type TraderMonitoringPolicy = "realtime" | "periodic" | "lightweight" | "off";
export type TraderAutomationTier = "T0" | "T1" | "T2" | "T3";

export interface TraderAutomationState {
  readonly traderId: string;
  readonly tier: TraderAutomationTier;
  readonly coverageState: TraderCoverageState;
  readonly monitoringPolicy: TraderMonitoringPolicy;
  readonly lastCoveredAt: number | null;
  readonly nextEvaluationAt: number;
  readonly strategyVersion: string;
}
```

- [ ] **Step 4: Add additive schema and idempotent migration**

Create `trader_coverage_state` and `trader_monitoring_policy`. Backfill defaults without modifying `trader_entities.lifecycle`:

- Manual and 30-day Top100 traders become `T0`.
- Wallet-resolved non-manual traders become `T1` or `T2` based on existing evidence.
- Other observed traders become `T3` with `lightweight` policy.
- Existing resolved wallets receive `realtime` policy unless explicitly disabled.

- [ ] **Step 5: Change monitoring registry selection**

Replace lifecycle filtering with policy filtering:

```sql
JOIN trader_monitoring_policy mp ON mp.trader_id = e.entity_id
WHERE mp.policy = 'realtime'
```

Performance lifecycle remains available for scoring and display but no longer controls collection.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run packages/identity/test/monitoring-policy.test.ts packages/database/test/trader-automation-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm collection policy and performance state are independently testable. Do not commit unless explicitly requested.

---

## Task 4: Add durable automation jobs, leases, and resource lanes

**Files:**

- Create: `packages/domain/src/automation-job.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/database/src/automation-job-store.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrations.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/automation-job-store.test.ts`

- [ ] **Step 1: Write failing job-store tests**

Required cases:

```ts
it("deduplicates jobs by stable idempotency key");
it("leases only due jobs from the requested resource lane");
it("reclaims an expired lease after worker failure");
it("does not advance a cursor before successful completion");
it("schedules retry with exponential backoff and source retry-after");
it("preserves terminal audit records");
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run packages/database/test/automation-job-store.test.ts
```

Expected: FAIL because the unified automation job store does not exist.

- [ ] **Step 3: Add job contracts**

```ts
export type AutomationLane = "trader_backfill" | "token_mining" | "repair";
export type AutomationJobStatus = "pending" | "leased" | "running" | "waiting_source" | "retryable" | "completed" | "terminal" | "cancelled";

export interface AutomationJob {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly lane: AutomationLane;
  readonly jobType: string;
  readonly subjectKey: string;
  readonly priority: number;
  readonly status: AutomationJobStatus;
  readonly cursor: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseExpiresAt: number | null;
  readonly payload: string;
}
```

- [ ] **Step 4: Implement additive tables and indexes**

Create `automation_jobs`, `automation_lane_state`, and `automation_runtime_snapshots`. Add claim indexes on `(lane, status, next_attempt_at, priority, created_at)`.

- [ ] **Step 5: Implement weighted lane selection**

Use integer credits to avoid floating-point drift:

```ts
const LANE_WEIGHTS = Object.freeze({
  trader_backfill: 40,
  token_mining: 40,
  repair: 20,
});
```

Unused credits carry forward so an empty lane cannot waste capacity.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run packages/database/test/automation-job-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm jobs survive process restart and can be replayed idempotently. Do not commit unless explicitly requested.

---

## Task 5: Centralize retryable SQLite write transactions

**Files:**

- Modify: `packages/database/src/connection.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `apps/wallet-monitor/src/store.ts`
- Modify: `apps/wallet-analysis/src/store.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Create: `packages/database/test/write-transaction-retry.test.ts`
- Modify: `apps/wallet-monitor/test/runtime.test.ts`

- [ ] **Step 1: Write a failing lock-contention test**

Hold one connection in a short write transaction while a second connection attempts to persist a checkpoint and event. Verify the second operation retries and neither loses the event nor advances only the checkpoint.

```ts
expect(result.attempts).toBeGreaterThan(1);
expect(readObservationCount(databasePath)).toBe(1);
expect(readCheckpoint(databasePath)).toBe("next");
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run packages/database/test/write-transaction-retry.test.ts apps/wallet-monitor/test/runtime.test.ts
```

Expected: FAIL with `SQLITE_BUSY` or `SQLITE_LOCKED`.

- [ ] **Step 3: Add a shared write helper**

```ts
export interface WriteTransactionOptions {
  readonly maximumAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
}

export function withAddressRadarWriteTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: WriteTransactionOptions = {},
): T;
```

The helper must retry only SQLite busy/locked errors, roll back before retry, use bounded exponential delay plus jitter, and rethrow all other failures.

- [ ] **Step 4: Move wallet-monitor, wallet-analysis, and automation writes to the shared helper**

No network, RPC, market lookup, or file I/O may occur inside these transactions.

- [ ] **Step 5: Run focused tests**

Run:

```bash
corepack pnpm vitest run packages/database/test/write-transaction-retry.test.ts apps/wallet-monitor/test/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Confirm lock conflicts are retried and checkpoint atomicity is preserved. Do not commit unless explicitly requested.

---

## Task 6: Create the automation worker shell and fair scheduler

**Files:**

- Create: `apps/automation/package.json`
- Create: `apps/automation/tsconfig.json`
- Create: `apps/automation/src/config.ts`
- Create: `apps/automation/src/scheduler.ts`
- Create: `apps/automation/src/runtime.ts`
- Create: `apps/automation/src/service.ts`
- Create: `apps/automation/src/cli.ts`
- Create: `apps/automation/test/scheduler.test.ts`
- Create: `apps/automation/test/config.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Cover 40/40/20 allocation, carry-forward credits, five-chain minimum slots, lease expiry, disabled execution, and independent lane failure.

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/scheduler.test.ts apps/automation/test/config.test.ts
```

Expected: FAIL because the automation app does not exist.

- [ ] **Step 3: Implement validated configuration**

Support every default defined in SPAC section 22. `ADDRESS_RADAR_AUTOMATION_ENABLED` defaults to `false`.

- [ ] **Step 4: Implement the scheduler contract**

```ts
export interface AutomationHandler {
  readonly jobType: string;
  execute(job: AutomationJob, signal: AbortSignal): Promise<AutomationExecutionResult>;
}

export interface AutomationExecutionResult {
  readonly status: "completed" | "waiting_source" | "retryable" | "terminal";
  readonly cursor?: string | null;
  readonly retryAt?: number;
  readonly diagnostic?: string;
}
```

One handler failure must update only its job and must not stop the service loop.

- [ ] **Step 5: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/scheduler.test.ts apps/automation/test/config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Confirm the worker can run with execution disabled while still exposing queue snapshots. Do not commit unless explicitly requested.

---

## Task 7: Seed and maintain trader-centric backfill jobs

**Files:**

- Create: `apps/automation/src/trader-backfill-planner.ts`
- Create: `apps/automation/src/trader-lightweight-worker.ts`
- Create: `apps/automation/test/trader-backfill-planner.test.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `packages/database/src/trader-automation-store.ts`

- [ ] **Step 1: Write failing planner tests**

Required fixtures:

- T0 manual trader with two wallets.
- T1 evidence-backed trader.
- T2 unresolved Fomo trader.
- T3 ordinary observed trader.
- Duplicate account/entity mappings.

Expected behavior:

```ts
expect(plan.deepBackfills).toContainEqual(expect.objectContaining({ windowDays: 60, maximumTokens: 300 }));
expect(plan.identityRequests).toContainEqual(expect.objectContaining({ traderId: "t2" }));
expect(plan.lightweightEvaluations).toContainEqual(expect.objectContaining({ traderId: "t3" }));
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
corepack pnpm vitest run apps/automation/test/trader-backfill-planner.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement idempotent seeding**

On first run:

- Queue lightweight evaluation for every canonical trader.
- Queue deep backfill for every wallet-resolved T0/T1 trader.
- Queue identity resolution for evidence-backed unresolved T2 traders.
- Leave T3 in low-cost evaluation until evidence upgrades it.

- [ ] **Step 4: Implement periodic due-time calculation**

```ts
const intervals = {
  T0: { fomoMs: 15 * 60_000, walletMs: 60 * 60_000 },
  T1: { fomoMs: 60 * 60_000, walletMs: 6 * 60 * 60_000 },
  T2: { fomoMs: 6 * 60 * 60_000, walletMs: null },
  T3: { fomoMs: 7 * 24 * 60 * 60_000, walletMs: null },
} as const;
```

- [ ] **Step 5: Use existing canonical Fomo events for lightweight evaluation**

Do not require wallet identity. Generate priority upgrades from early entry, milestone opportunity, cumulative buy above 50 USD, and repeated evidence across distinct tokens.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/trader-backfill-planner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm every trader receives one explainable next action without immediately deep-scanning all 10,722 entities. Do not commit unless explicitly requested.

---

## Task 8: Trigger wallet history automatically after identity resolution

**Files:**

- Modify: `packages/database/src/repository.ts`
- Modify: `packages/identity/src/identity-resolution-service.ts`
- Modify: `packages/identity/src/manual-resolution-service.ts`
- Modify: `packages/identity/src/monitoring-registry.ts`
- Create: `packages/identity/test/identity-automation-trigger.test.ts`
- Modify: `apps/wallet-analysis/src/store.ts`
- Modify: `apps/wallet-analysis/test/runtime.test.ts`

- [ ] **Step 1: Write failing identity-trigger tests**

```ts
it("publishes one monitoring change and one initial backfill per newly resolved wallet");
it("does not duplicate jobs when the same mapping is imported twice");
it("moves a resolved T2 trader to T1 monitoring without changing performance lifecycle");
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run packages/identity/test/identity-automation-trigger.test.ts apps/wallet-analysis/test/runtime.test.ts
```

Expected: FAIL because identity completion does not create automatic history jobs.

- [ ] **Step 3: Publish durable identity events in the same transaction as wallet attachment**

Use `monitoring_registry_outbox` with deterministic event IDs. Increment registry version only when the mapping changes.

- [ ] **Step 4: Convert outbox events into deep-backfill jobs**

Use a stable key:

```text
initial-wallet-backfill:{traderId}:{chainFamily}:{normalizedAddress}:60d:300:{strategyVersion}
```

- [ ] **Step 5: Preserve Fomo-only evidence while wallet history is pending**

Coverage becomes `queued` or `backfilling`; candidate evidence is not deleted or blocked.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run packages/identity/test/identity-automation-trigger.test.ts apps/wallet-analysis/test/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm manual and automatic identity resolution share the same durable trigger path. Do not commit unless explicitly requested.

---

## Task 9: Add provider budgets and Solana adaptive rate control

**Files:**

- Create: `apps/wallet-monitor/src/provider-budget.ts`
- Modify: `apps/wallet-monitor/src/config.ts`
- Modify: `apps/wallet-monitor/src/rpc.ts`
- Modify: `apps/wallet-monitor/src/collectors.ts`
- Modify: `apps/wallet-monitor/src/runtime.ts`
- Create: `apps/wallet-monitor/test/provider-budget.test.ts`
- Modify: `apps/wallet-monitor/test/solana-regressions.test.ts`

- [ ] **Step 1: Write failing limiter tests**

Cover token consumption, independent real-time/history budgets, Retry-After handling, global cooldown, fallback switching, cursor preservation, and other-chain isolation.

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run apps/wallet-monitor/test/provider-budget.test.ts apps/wallet-monitor/test/solana-regressions.test.ts
```

Expected: FAIL because the current collector launches up to 20 wallet requests without provider-wide rate control.

- [ ] **Step 3: Implement provider token buckets**

```ts
export interface ProviderBudget {
  acquire(kind: "realtime" | "history", signal: AbortSignal): Promise<void>;
  rateLimited(retryAt: number): void;
  snapshot(): ProviderBudgetSnapshot;
}
```

- [ ] **Step 4: Reduce the default Solana rotating batch to 3**

Keep it configurable through `ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE`.

- [ ] **Step 5: Treat 429 as a provider cooldown**

Do not emit 88 simultaneous retry failures. Preserve each wallet cursor and resume after cooldown.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/wallet-monitor/test/provider-budget.test.ts apps/wallet-monitor/test/solana-regressions.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm Solana degradation cannot stop EVM or Fomo processing. Do not commit unless explicitly requested.

---

## Task 10: Build five-chain historical million-token partitions

**Files:**

- Create: `apps/automation/src/token-partition-planner.ts`
- Create: `apps/automation/src/token-mining-worker.ts`
- Create: `apps/automation/src/token-source-adapters.ts`
- Create: `apps/automation/test/token-partition-planner.test.ts`
- Create: `apps/automation/test/token-mining-worker.test.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `packages/database/src/automation-job-store.ts`

- [ ] **Step 1: Write failing partition tests**

Use fixtures spanning Solana, BSC, Ethereum, Base, Robinhood, and Monad. Verify:

- Only the five supported chains remain.
- Partitions use `chain + calendar_week`.
- Each execution batch contains at most 50 tokens.
- Every scheduling round reserves one slot per non-empty chain.
- 70% of remaining capacity goes to the most recent 14 days.
- Duplicate canonical token IDs appear once.

- [ ] **Step 2: Run the focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/token-partition-planner.test.ts apps/automation/test/token-mining-worker.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement partition persistence**

Create `historical_token_partitions` and `historical_token_mining_jobs` through the automation store. Seed from `2026-08-09T16:00:00.000Z`.

- [ ] **Step 4: Implement source adapters**

Adapters must expose the same contract:

```ts
export interface HistoricalTokenSource {
  readonly name: string;
  discover(partition: HistoricalTokenPartition, cursor: string | null, signal: AbortSignal): Promise<HistoricalTokenPage>;
}
```

Use existing historical tables and Dune results when present. A missing Dune result returns `waiting_source`; it must not block Fomo verification or other chains.

- [ ] **Step 5: Enforce Fomo existence verification before buyer evidence**

Unconfirmed tokens move to a recoverable verification queue. Confirmed tokens continue to milestone and early-buyer recovery.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/token-partition-planner.test.ts apps/automation/test/token-mining-worker.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm all five chains progress independently and Monad cannot enter production partitions. Do not commit unless explicitly requested.

---

## Task 11: Wire multi-source candidate evidence into production

**Files:**

- Create: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `apps/wallet-analysis/src/multi-source-candidate-discovery.ts`
- Modify: `packages/database/src/candidate-history-store.ts`
- Create: `apps/automation/test/candidate-evidence-worker.test.ts`
- Modify: `apps/wallet-analysis/test/multi-source-candidate-discovery.test.ts`

- [ ] **Step 1: Write failing end-to-end evidence tests**

Required cases:

```ts
it("creates evidence from FOMO_ONLY events without wallet identity");
it("upgrades the same evidence when on-chain confirmation arrives");
it("admits one strong item");
it("admits two early items from distinct tokens");
it("does not admit repeated observations from one token");
it("ignores cumulative buy below 50 USD");
it("is idempotent across repeated replays");
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/candidate-evidence-worker.test.ts apps/wallet-analysis/test/multi-source-candidate-discovery.test.ts
```

Expected: FAIL because the discovery library has no production caller.

- [ ] **Step 3: Build observations from canonical events and milestones**

The worker loads affected traders and tokens from job payloads, evaluates only the impacted window, and persists through `candidate-history-store`.

- [ ] **Step 4: Trigger the worker from new canonical events, completed token mining, and late source observations**

Use deterministic job keys so Fomo, RPC, and historical replay converge on one evidence result.

- [ ] **Step 5: Persist admission snapshots**

Every evaluation records strategy version, reason codes, distinct-token counts, and evaluated time.

- [ ] **Step 6: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/candidate-evidence-worker.test.ts apps/wallet-analysis/test/multi-source-candidate-discovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm existing Fomo history can generate candidate evidence before wallet enrichment. Do not commit unless explicitly requested.

---

## Task 12: Evaluate repeatable trader ability and bundle risk

**Files:**

- Create: `apps/automation/src/trader-ability-worker.ts`
- Create: `apps/automation/src/bundle-risk-detector.ts`
- Modify: `apps/wallet-analysis/src/performance.ts`
- Modify: `packages/domain/src/trader-automation.ts`
- Create: `apps/automation/test/trader-ability-worker.test.ts`
- Create: `apps/automation/test/bundle-risk-detector.test.ts`

- [ ] **Step 1: Write failing ability tests**

Cover discovered, candidate, stable, degraded, single-token profit concentration, loss inclusion, 5-second bundle behavior, 10-second bundle behavior, and no false bundle from unrelated tokens.

- [ ] **Step 2: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/trader-ability-worker.test.ts apps/automation/test/bundle-risk-detector.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Compute ability from complete denominators**

Stable requires:

```ts
const stable = validSamples >= 8
  && successfulDistinctTokens >= 3
  && sampleSpanMs >= 14 * 24 * 60 * 60_000
  && maximumSingleTokenProfitShare <= 0.5;
```

Store 24-hour, 7-day, and 30-day snapshots. Include losing and zero-value samples.

- [ ] **Step 4: Add repeated bundle-risk scoring**

A single synchronized trade is evidence, not automatic rejection. Promote to `bundle_risk` only when synchronized behavior repeats across distinct tokens.

- [ ] **Step 5: Run focused tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/trader-ability-worker.test.ts apps/automation/test/bundle-risk-detector.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Confirm discovery and stable performance remain separate concepts. Do not commit unless explicitly requested.

---

## Task 13: Add the automation operations console

**Files:**

- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/index.html`
- Modify: `apps/console/public/app.ts`
- Create: `apps/console/test/automation-operations.test.ts`

- [ ] **Step 1: Write failing API tests**

Cover:

```text
GET  /api/v2/automation/overview
GET  /api/v2/backfill/traders
GET  /api/v2/backfill/traders/:traderId
POST /api/v2/backfill/traders/:traderId/retry
GET  /api/v2/mining/partitions
GET  /api/v2/mining/tokens
POST /api/v2/mining/partitions/:partitionId/retry
GET  /api/v2/coverage/traders
GET  /api/v2/coverage/sources
```

Verify retry endpoints reject completed or actively leased jobs and audit every accepted retry.

- [ ] **Step 2: Run the focused test**

Run:

```bash
corepack pnpm vitest run apps/console/test/automation-operations.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement read models and retry commands**

Return Chinese diagnostics from stable reason-code mappings. Do not expose internal SQL error strings as primary descriptions.

- [ ] **Step 4: Build the “自动化闭环” console module**

Show one record per row, with filters for lane, chain, tier, status, source, and age. Include totals, oldest backlog, throughput, failure rate, and estimated drain time.

- [ ] **Step 5: Show provider budgets and SQLite contention**

Display Solana cooldown, fallback state, due-wallet age, lock retries, and maximum write wait.

- [ ] **Step 6: Run console tests and build**

Run:

```bash
corepack pnpm vitest run apps/console/test/automation-operations.test.ts apps/console/test/automation-funnel.test.ts
corepack pnpm --filter @address-radar/console build
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Confirm the console explains why every item is waiting, degraded, completed, or terminal. Do not commit unless explicitly requested.

---

## Task 14: Add full replay, restart, and contention acceptance tests

**Files:**

- Create: `apps/automation/test/full-pipeline-replay.test.ts`
- Create: `apps/automation/test/restart-recovery.test.ts`
- Create: `apps/automation/test/sqlite-contention.test.ts`
- Modify: `apps/scanner/test/multi-source-replay.test.ts`

- [ ] **Step 1: Create a deterministic five-chain replay fixture**

The fixture must include:

- Fomo-only trader events.
- On-chain-only events.
- Late cross-confirmation.
- One strong-evidence trader.
- One two-token early-evidence trader.
- One repeated bundle cluster.
- One Solana rate-limit response.
- One Dune-unavailable partition.
- One process restart between page one and page two.

- [ ] **Step 2: Write expected final assertions**

```ts
expect(result.duplicateCanonicalEvents).toBe(0);
expect(result.duplicateCandidateEvidence).toBe(0);
expect(result.admittedTraderIds).toEqual(["strong", "two-early"]);
expect(result.bundleRiskTraderIds).toEqual(["bundle-cluster"]);
expect(result.unblockedChains).toEqual(["base", "bsc", "eth", "robinhood"]);
expect(result.resumeCursor).toBe("page-2");
```

- [ ] **Step 3: Run tests before final integration**

Run:

```bash
corepack pnpm vitest run apps/automation/test/full-pipeline-replay.test.ts apps/automation/test/restart-recovery.test.ts apps/automation/test/sqlite-contention.test.ts
```

Expected: FAIL until all prior tasks are integrated.

- [ ] **Step 4: Complete integration boundaries only**

Do not add new strategy behavior here. Fix wiring, dependency injection, and idempotency boundaries required by the accepted specification.

- [ ] **Step 5: Run focused acceptance tests**

Run:

```bash
corepack pnpm vitest run apps/automation/test/full-pipeline-replay.test.ts apps/automation/test/restart-recovery.test.ts apps/automation/test/sqlite-contention.test.ts apps/scanner/test/multi-source-replay.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the complete local suite and build**

Run:

```bash
corepack pnpm test
corepack pnpm build
```

Expected: all tests and builds pass.

- [ ] **Step 7: Checkpoint**

Report test totals and any remaining external-source limitations. Do not commit unless explicitly requested.

---

## Task 15: Deploy in shadow mode and perform production acceptance

**Files:**

- Create: `deployment/systemd/address-radar-automation.service`
- Modify: `deployment/address-radar.env.example`
- Create: `docs/operations/automation-backfill-and-token-mining.md`
- Modify: `docs/operations/multi-source-discovery.md`

- [ ] **Step 1: Add a hardened automation systemd unit**

Use the existing release symlink and environment file. Configure restart protection and the same writable database/log paths as other services.

- [ ] **Step 2: Document safe initial configuration**

Deploy with:

```text
ADDRESS_RADAR_AUTOMATION_ENABLED=false
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false
ADDRESS_RADAR_RECOVERY_ENABLED=false
ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE=3
```

- [ ] **Step 3: Create and validate a production backup**

The backup must complete and return `PRAGMA quick_check=ok` before release switching.

- [ ] **Step 4: Upload an isolated release and run server-side package smoke tests**

Do not copy macOS dependencies. Reuse or install Linux dependencies and verify automation imports before switching.

- [ ] **Step 5: Switch the release atomically with rollback protection**

Restart scanner, wallet-monitor, wallet-analysis, automation, and console. Verify remote console health on port 3214.

- [ ] **Step 6: Run read-only migration and planning shadow**

With execution disabled, verify:

- Correct funnel counts.
- Current resolved wallets receive planned initial backfills.
- All observed traders receive a lightweight next action.
- Five-chain token partitions are generated.
- No user signal is delivered.

- [ ] **Step 7: Enable one lane at a time**

Enable in this order:

```text
repair
trader_backfill
solana_history
historical_token_mining
candidate_evidence
ability_evaluation
```

Observe each lane for errors and data movement before enabling the next.

- [ ] **Step 8: Validate production acceptance metrics**

Required observations:

- No misleading wallet-resolved count.
- Every active wallet has a backfill job or explicit terminal reason.
- At least one real Fomo event reaches candidate evaluation.
- At least one real wallet partition records a successful no-change checkpoint or transaction event.
- Solana rate limiting does not stop other chains.
- No unrecovered SQLite lock loss.
- Candidate replay is idempotent.
- Gateway delivery remains disabled.

- [ ] **Step 9: Produce the final checkpoint report**

Report release path, backup path, service state, queue totals, source degradation, completed coverage, candidate evidence totals, disk usage, and explicit remaining external blockers.

Do not commit or merge unless explicitly requested.

---

## Plan self-review result

- Every SPAC phase maps to at least one implementation task.
- Monitoring policy is separated from performance lifecycle before any bulk job seeding.
- Existing Fomo evidence can produce candidates before wallet identity resolution.
- Historical EVM activity is not delegated to raw per-wallet RPC scans.
- Solana public RPC is bounded and isolated.
- SQLite writes are retryable and checkpoint-safe before automation concurrency increases.
- All migrations are additive and idempotent.
- Gateway delivery remains disabled throughout implementation and production shadow acceptance.
- The plan contains no destructive database migration and no automatic Git operation.
