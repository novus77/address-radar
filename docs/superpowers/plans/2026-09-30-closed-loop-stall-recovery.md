# Closed-Loop Stall Recovery Implementation Plan

> **For Codex:** Execute this plan inline, task by task. Keep production delivery disabled. Do not mutate production until the full local test and typecheck gates pass and deployment is explicitly authorized.

**Goal:** Make every automatic Address Radar closed-loop stage self-healing: database state, recovery facts, and runnable jobs must converge without manual queue surgery, while manual identity work remains explicitly separated from automated backlog.

**Architecture:** Add one bounded reconciliation layer around the existing fact graph and automation queue. Reconciliation is idempotent and only restores missing work; workers remain the sole owners of business outcomes. Candidate admission becomes request-driven with a low-frequency safety scan, and backup retention becomes disk-watermark aware rather than age-only.

**Tech Stack:** TypeScript, Node.js 24, SQLite, Vitest, systemd, Bash.

---

## Task 1: Repair milestone recovery routing

**Files:**
- Modify: `apps/automation/src/candidate-source-recovery.ts`
- Modify: `apps/automation/src/milestone-fact-reconciler.ts`
- Test: `apps/automation/test/milestone-fact-reconciler.test.ts`
- Test: `apps/automation/test/candidate-evidence-worker.test.ts`

**Steps:**
1. Add failing tests proving `missing_milestone` and `insufficient_coverage` schedule a chain-appropriate market-history job in addition to enrichment/research.
2. Add a failing reconciler test for a token with market history but no milestone crossing, asserting a `milestone_crossings` fact and linked recovery jobs are created exactly once.
3. Extend the recovery route mapping without changing existing idempotency keys.
4. Extend the milestone reconciler with a bounded query for tokens whose milestone fact is missing, partial, or retry-due and which lack an active linked recovery job.
5. Keep malformed token IDs terminal and audited; never retry them forever.
6. Run: `pnpm test -- apps/automation/test/milestone-fact-reconciler.test.ts apps/automation/test/candidate-evidence-worker.test.ts`.

**Acceptance:** Every pending milestone is either backed by an active recovery job, available, retry-scheduled, or terminal with a reason.

## Task 2: Add cross-stage state/job reconciliation

**Files:**
- Create: `apps/automation/src/closed-loop-state-reconciler.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Test: `apps/automation/test/closed-loop-state-reconciler.test.ts`
- Test: `packages/database/test/automation-job-store.test.ts`

**Steps:**
1. Add failing tests for orphaned token facts, blocked candidate jobs without unresolved recovery links, and completed facts whose downstream jobs remain blocked.
2. Add store queries that return bounded reconciliation candidates; do not expose raw database writes to callers.
3. Implement an idempotent reconciler that:
   - restores missing recovery work for retryable fact states;
   - links each recovery job to the requested fact;
   - wakes candidate evidence only after prerequisite facts become usable;
   - marks irrecoverable prerequisites terminal with a stable reason.
4. Invoke the reconciler from the existing planning gate, not from each worker poll.
5. Emit aggregate counts only; avoid one log line per stale row.
6. Run: `pnpm test -- apps/automation/test/closed-loop-state-reconciler.test.ts packages/database/test/automation-job-store.test.ts`.

**Acceptance:** Two consecutive reconciliation runs create no duplicate active jobs and the second run reports zero repairs.

## Task 3: Reconcile identity and wallet-backfill lifecycle

**Files:**
- Modify: `packages/database/src/identity-automation.ts`
- Modify: `apps/automation/src/initial-wallet-backfill-worker.ts`
- Modify: `apps/automation/src/closed-loop-state-reconciler.ts`
- Modify: `apps/console/src/application.ts`
- Test: `packages/identity/test/identity-automation-trigger.test.ts`
- Test: `apps/automation/test/closed-loop-state-reconciler.test.ts`
- Test: `apps/console/test/application.test.ts`

**Steps:**
1. Add failing tests for a resolved wallet with no active `initial_wallet_backfill` job and for a pending manual identity with no automation job.
2. Restore wallet-backfill jobs from the durable identity outbox/identity-wallet state using the existing deterministic idempotency key.
3. Do not create automatic jobs for unresolved manual identities.
4. Split console counts into `manualPending` and `automatedRepairBacklog`; keep canonical stage counters backward compatible.
5. Ensure completing an identity removes it from automatic candidate work and starts monitoring/backfill exactly once.
6. Run: `pnpm test -- packages/identity/test/identity-automation-trigger.test.ts apps/automation/test/closed-loop-state-reconciler.test.ts apps/console/test/application.test.ts`.

**Acceptance:** Manual identity work is visible but never counted as stalled automation; resolved wallets cannot remain without a backfill/coverage terminal state.

## Task 4: Make candidate admission event-driven

**Files:**
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `packages/database/src/candidate-evaluation-request-store.ts`
- Modify: `apps/automation/src/trader-ability-worker.ts`
- Test: `apps/automation/test/candidate-evidence-worker.test.ts`
- Test: `apps/automation/test/queue-convergence.test.ts`

**Steps:**
1. Add failing tests showing new evidence and completed ability evaluations increment a durable admission request revision.
2. Dispatch one job per dirty request and bind the active job atomically.
3. On completion, advance `processed_revision`; if a newer revision arrived during execution, enqueue one follow-up.
4. Retain the existing scan as a low-frequency repair path only.
5. Add bounded batch and cursor behavior so a large historical backlog cannot starve real-time work.
6. Run: `pnpm test -- apps/automation/test/candidate-evidence-worker.test.ts apps/automation/test/queue-convergence.test.ts`.

**Acceptance:** New evidence reaches admission without waiting for a full-table scan, and duplicate triggers collapse into one active job plus at most one follow-up.

## Task 5: Enforce queue fairness and convergence telemetry

**Files:**
- Modify: `apps/automation/src/queue-policy.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Modify: `packages/domain/src/closed-loop-metrics.ts`
- Modify: `apps/console/src/application.ts`
- Test: `apps/automation/test/queue-convergence.test.ts`
- Test: `packages/domain/test/closed-loop-metrics.test.ts`

**Steps:**
1. Add failing tests for a continuously replenished historical lane alongside real-time and repair work.
2. Enforce per-job-type admission limits and preserve weighted lane selection.
3. Expose reconciliation repair counts, orphan counts, and manual-vs-automatic pending counts.
4. Define stalled only when eligible automatic work has neither fact progress nor runnable/retry work for two planning windows.
5. Run: `pnpm test -- apps/automation/test/queue-convergence.test.ts packages/domain/test/closed-loop-metrics.test.ts`.

**Acceptance:** No enabled job type with runnable work is starved across the fairness window, and metrics identify the exact upstream blocker.

## Task 6: Add safe disk-watermark backup retention

**Files:**
- Modify: `scripts/backup-production-state.sh`
- Modify: `deployment/systemd/address-radar-backup.service`
- Test: `scripts/test/backup-production-state.test.ts`

**Steps:**
1. Add failing tests for low free space, maximum backup count, protected newest backup, and dry-run retention output.
2. Add configurable high/low watermarks and maximum backup count.
3. Prune only completed backup directories after a verified new backup exists; never remove the current backup or `.partial` evidence before failure reporting.
4. Write one JSON summary containing bytes before/after, retained count, and removed paths.
5. Add conservative defaults to the systemd unit environment.
6. Run: `pnpm test -- scripts/test/backup-production-state.test.ts`.

**Acceptance:** Backup growth is bounded, the newest verified snapshot is always retained, and low-space behavior is deterministic and auditable.

## Task 7: Full local validation and deployment handoff

**Files:**
- Modify only if a test exposes a defect in files already listed above.

**Steps:**
1. Run targeted tests from Tasks 1-6.
2. Run: `pnpm test`.
3. Run: `pnpm typecheck`.
4. Run: `pnpm build`.
5. Produce a deployment checklist with schema impact, backup prerequisites, service restart order, and rollback commands.
6. Stop before production mutation and request explicit deployment authorization.

**Acceptance:** All local gates pass; no production configuration, data, release symlink, or service state has changed.

## Production acceptance after separate authorization

1. Create and verify one production backup.
2. Deploy a versioned release and run additive migrations.
3. Restart services in dependency order.
4. Confirm `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
5. Observe two planning windows and verify:
   - milestone pending decreases or has explicit terminal reasons;
   - candidate `blocked_source` decreases with matching fact attempts;
   - wallet-backfill orphans are zero;
   - admission requests converge;
   - duplicate active jobs remain zero;
   - SQLite locks remain zero;
   - disk free space remains above the configured low watermark.

