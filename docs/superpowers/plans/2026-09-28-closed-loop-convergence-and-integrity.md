# Closed-Loop Convergence and Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Address Radar's historical recovery and live discovery pipelines converge reliably from valuable-token discovery to early-wallet evidence, trader admission, wallet monitoring, aggregation, and signal readiness, with explicit failure reasons and measurable forward progress.

**Architecture:** Keep the current single-server SQLite architecture, but replace implicit completion with durable stage outcomes and fact-level postconditions. Separate immutable economic events from mutable enrichment, separate automated jobs from manual identity work, model per-chain wallet coverage explicitly, and enforce bounded queues plus fair scheduling. Expose one metric dictionary to the developer console so every count can be traced to a durable database fact.

**Tech Stack:** TypeScript, Node.js, SQLite/WAL, Vitest, systemd, existing Address Radar scanner/automation/wallet-monitor/console services.

---

## Scope and Non-Goals

This plan implements the confirmed SPAC in `docs/specs/2026-09-28-closed-loop-convergence-and-integrity-spac.md`.

In scope:

- Durable automation outcomes and zero-output diagnostics.
- Recovery-job postconditions tied to canonical facts.
- Early-trade reconciliation and deterministic downstream wakeups.
- Immutable event identity and mutable enrichment revisions.
- SQLite write contention hardening.
- Explicit Solana/EVM wallet coverage and provider diagnostics.
- Queue admission control, scheduling fairness, and convergence metrics.
- Developer-console visibility for the complete closed loop.
- Additive migrations, historical reconciliation, deployment, and read-only production acceptance.

Out of scope:

- Enabling Gateway delivery. `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED` must remain `false`.
- Changing trader admission thresholds or signal strategy semantics.
- Replacing SQLite with a distributed database.
- Treating manual identity resolution as an automated recovery job.
- Adding new paid providers unless the existing provider matrix cannot satisfy a required chain after diagnostics.

## Invariants

1. A job is not considered productive merely because it reached `completed`.
2. A recovery job succeeds only when its required canonical fact exists or an explicit terminal reason is persisted.
3. Reprocessing the same economic event with updated metadata must not create a conflict.
4. Every queue has a finite admission budget, retry policy, and terminal/deferred state.
5. Manual identity work is visible but never consumes automated Repair-lane capacity.
6. All chain support is reported as `healthy`, `degraded`, `blocked`, or `unsupported`; no silent zero coverage.
7. Console metrics must be sourced from durable state and share the same definitions as production acceptance queries.

## Checkpoint 1: Establish the Metric Contract and Regression Baseline

**Files:**

- Create: `packages/domain/src/closed-loop-metrics.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/closed-loop-metrics.test.ts`
- Create: `docs/operations/closed-loop-metric-dictionary.md`

- [ ] Define the canonical stages and metric names before changing runtime behavior.

```ts
export const CLOSED_LOOP_STAGES = [
  "token_discovery",
  "market_history",
  "milestone_confirmation",
  "early_trade_recovery",
  "identity_resolution",
  "candidate_evidence",
  "ability_evaluation",
  "candidate_admission",
  "wallet_monitoring",
  "token_aggregation",
  "signal_readiness",
] as const;

export type ClosedLoopStage = (typeof CLOSED_LOOP_STAGES)[number];

export interface StageProgressMetric {
  stage: ClosedLoopStage;
  discovered: number;
  eligible: number;
  pending: number;
  blocked: number;
  completed: number;
  terminal: number;
  producedFacts: number;
  oldestPendingAt: string | null;
  lastProgressAt: string | null;
}
```

- [ ] Document the numerator, denominator, durable source table, freshness window, and expected direction for every metric.
- [ ] Add metric-definition tests that reject duplicate stage names and invalid negative counters.
- [ ] Capture the known production baseline in the operations document without embedding mutable counts in code: 8,065 historical tokens, 732 milestones, 610 Fomo-confirmed tokens, 72 recovered early buyers, one canonical early-trade fact, and zero EVM wallet observations at the time of diagnosis.

Run:

```bash
pnpm exec vitest run packages/domain/test/closed-loop-metrics.test.ts
```

Expected: all metric-contract tests pass.

Commit checkpoint:

```bash
git add packages/domain/src/closed-loop-metrics.ts packages/domain/src/index.ts packages/domain/test/closed-loop-metrics.test.ts docs/operations/closed-loop-metric-dictionary.md
git commit -m "docs: define closed loop progress metrics"
```

## Checkpoint 2: Add Durable Outcomes, Fact Links, Coverage, and Enrichment Storage

**Files:**

- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrations.ts`
- Create: `packages/database/src/automation-outcome-store.ts`
- Create: `packages/database/src/recovery-fact-link-store.ts`
- Create: `packages/database/src/wallet-coverage-store.ts`
- Create: `packages/database/src/source-enrichment-store.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/closed-loop-schema.test.ts`
- Create: `packages/database/test/automation-outcome-store.test.ts`
- Create: `packages/database/test/recovery-fact-link-store.test.ts`

- [ ] Add an append-only `automation_job_outcomes` table.

```sql
CREATE TABLE automation_job_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  input_count INTEGER NOT NULL DEFAULT 0,
  produced_count INTEGER NOT NULL DEFAULT 0,
  deferred_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_json TEXT,
  created_at TEXT NOT NULL
);
```

Allowed outcomes: `produced`, `no_output`, `deferred`, `terminal`, `failed`.

- [ ] Add `recovery_fact_links` to connect each recovery job with the fact it is required to produce.

```sql
CREATE TABLE recovery_fact_links (
  recovery_job_id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal_reason TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recovery_job_id, fact_type, fact_key)
);
```

- [ ] Add `wallet_chain_coverage` with identity, chain, provider, cursor, coverage start/end, status, diagnostics, and last-success fields.
- [ ] Add `source_observation_enrichments` keyed by canonical observation ID and revision number. Store mutable USD amount, price, collection metadata, optional provenance, and quality score here.
- [ ] Add indexes for pending outcomes, unresolved fact links, stale chain coverage, and latest enrichment lookup.
- [ ] Make every migration additive and idempotent.
- [ ] Add store tests covering insert, repeated upsert, latest-revision selection, and terminal fact links.

Run:

```bash
pnpm exec vitest run packages/database/test/closed-loop-schema.test.ts packages/database/test/automation-outcome-store.test.ts packages/database/test/recovery-fact-link-store.test.ts
```

Expected: migration can run twice and all new stores preserve deterministic results.

Commit checkpoint:

```bash
git add packages/database
git commit -m "feat: add closed loop outcome and coverage storage"
```

## Checkpoint 3: Persist Structured Automation Outcomes

**Files:**

- Modify: `apps/automation/src/scheduler.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/src/candidate-source-recovery.ts`
- Create: `apps/automation/src/job-outcome.ts`
- Modify: `apps/automation/test/candidate-evidence-worker.test.ts`
- Modify: `apps/automation/test/candidate-source-recovery.test.ts`
- Create: `apps/automation/test/job-outcomes.test.ts`

- [ ] Replace string-only completion diagnostics with a typed result.

```ts
export interface AutomationJobOutcome {
  status: "produced" | "no_output" | "deferred" | "terminal";
  reasonCode?:
    | "missing_market_history"
    | "missing_milestone"
    | "missing_early_trades"
    | "no_eligible_wallets"
    | "evidence_below_threshold"
    | "already_current"
    | "unsupported_chain"
    | "provider_unavailable"
    | "manual_resolution_required";
  inputCount: number;
  producedCount: number;
  deferredCount: number;
  diagnostic?: Record<string, unknown>;
}
```

- [ ] Persist one outcome for every attempted job before final state transition.
- [ ] Change candidate evidence completion from `persisted for 0/N` text to `no_output` plus a reason histogram.
- [ ] Treat `no_output` as operationally successful but analytically non-productive.
- [ ] Preserve failure semantics for thrown errors and persist a `failed` outcome before retry/dead-letter logic.
- [ ] Add tests for productive completion, zero-output completion, deferral, terminal unsupported-chain handling, and thrown errors.

Run:

```bash
pnpm exec vitest run apps/automation/test/job-outcomes.test.ts apps/automation/test/candidate-evidence-worker.test.ts apps/automation/test/candidate-source-recovery.test.ts
```

Expected: every execution path writes exactly one durable outcome with stable reason codes.

Commit checkpoint:

```bash
git add apps/automation
git commit -m "feat: record structured automation outcomes"
```

## Checkpoint 4: Remove Manual Identity Work from Automated Repair Capacity

**Files:**

- Modify: `packages/database/src/automation-job-store.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `apps/automation/src/scheduler.ts`
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/app.ts`
- Create: `apps/automation/src/migrations/manual-identity-job-cleanup.ts`
- Create: `apps/automation/test/manual-identity-separation.test.ts`
- Modify: `apps/console/test/automation-funnel.test.ts`

- [ ] Stop admitting `identity_resolution` as an automation job type.
- [ ] Keep unresolved handles in the existing manual identity-resolution domain tables and console workflow.
- [ ] Add an idempotent cleanup migration that marks legacy pending `identity_resolution` automation jobs as `cancelled` with reason `migrated_to_manual_queue`; never delete them.
- [ ] Exclude manual identity work from automated Repair-lane depth and convergence calculations.
- [ ] Display separate counters for `Automated repair backlog` and `Manual identity backlog`.
- [ ] Add tests proving 1,030 legacy manual items cannot starve candidate evidence or ability evaluation.

Run:

```bash
pnpm exec vitest run apps/automation/test/manual-identity-separation.test.ts apps/console/test/automation-funnel.test.ts
```

Expected: manual identity items remain visible, automated Repair depth excludes them, and schedulable job types continue advancing.

Commit checkpoint:

```bash
git add packages/database/src/automation-job-store.ts apps/automation apps/console
git commit -m "fix: separate manual identity work from automation"
```

## Checkpoint 5: Enforce Recovery-to-Fact Postconditions

**Files:**

- Modify: `apps/scanner/src/recovery-runtime.ts`
- Modify: `apps/scanner/src/source-recovery-handlers.ts`
- Modify: `apps/automation/src/token-fact-orchestrator.ts`
- Modify: `packages/database/src/token-fact-store.ts`
- Create: `apps/scanner/src/recovery-postcondition.ts`
- Create: `apps/scanner/test/recovery-fact-closure.test.ts`
- Create: `apps/automation/test/token-fact-wakeup.test.ts`

- [ ] Define a postcondition for each recovery job type.

```ts
export interface RecoveryPostcondition {
  factType: "market_history" | "milestone" | "early_trades" | "token_identity";
  factKey: string;
  verify(): Promise<
    | { status: "satisfied"; producedCount: number }
    | { status: "deferred"; reasonCode: string; retryAt: string }
    | { status: "terminal"; reasonCode: string }
  >;
}
```

- [ ] Create fact links when recovery jobs are admitted.
- [ ] Mark a recovery job `completed` only after its postcondition is satisfied.
- [ ] When a source import creates a canonical fact, transition `token_fact_status` and enqueue downstream work in the same write transaction.
- [ ] Make wakeups idempotent by `(fact_type, fact_key, downstream_job_type)`.
- [ ] Persist terminal source conditions such as unsupported chain or permanently unavailable history instead of retrying forever.
- [ ] Add integration tests showing that a Fomo import changes the fact state and wakes candidate evidence without relying on polling order.

Run:

```bash
pnpm exec vitest run apps/scanner/test/recovery-fact-closure.test.ts apps/automation/test/token-fact-wakeup.test.ts
```

Expected: a recovery job cannot report success while its required canonical fact is absent.

Commit checkpoint:

```bash
git add apps/scanner apps/automation/src/token-fact-orchestrator.ts packages/database/src/token-fact-store.ts
git commit -m "fix: require canonical facts for recovery completion"
```

## Checkpoint 6: Add Deterministic Early-Trade Reconciliation

**Files:**

- Create: `apps/automation/src/early-trade-reconciler.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `apps/automation/src/candidate-source-recovery.ts`
- Modify: `packages/database/src/source-ledger-store.ts`
- Create: `apps/automation/test/early-trade-reconciler.test.ts`
- Modify: `apps/automation/test/full-pipeline-replay.test.ts`

- [ ] Reconcile source observations into canonical early trades using stable token, chain, wallet, side, transaction, and event-time identity.
- [ ] Support both event-driven reconciliation after import and bounded sweep reconciliation for existing rows.
- [ ] Record why an observation was not promoted: missing wallet, missing transaction identity, outside early window, invalid side, or insufficient market-time context.
- [ ] Make the sweep resumable with a durable cursor and bounded batch size.
- [ ] Wake candidate-evidence jobs only when a new canonical early-trade fact is inserted.
- [ ] Add a replay test starting with market history plus source observations and ending with early trades, candidate evidence, ability evaluation, and candidate admission.

Run:

```bash
pnpm exec vitest run apps/automation/test/early-trade-reconciler.test.ts apps/automation/test/full-pipeline-replay.test.ts
```

Expected: repeated replay is idempotent and the first replay advances all eligible downstream stages.

Commit checkpoint:

```bash
git add apps/automation packages/database/src/source-ledger-store.ts
git commit -m "feat: reconcile source observations into early trades"
```

## Checkpoint 7: Separate Immutable Event Identity from Mutable Enrichment

**Files:**

- Modify: `packages/domain/src/source-observation.ts`
- Modify: `packages/database/src/source-ledger-store.ts`
- Modify: `packages/database/src/source-enrichment-store.ts`
- Modify: `packages/database/test/source-ledger-semantic-fingerprint.test.ts`
- Modify: `packages/database/test/source-ledger-store.test.ts`
- Create: `packages/database/test/source-enrichment-store.test.ts`

- [ ] Restrict the semantic fingerprint to immutable economic identity.

```ts
interface EconomicEventIdentity {
  source: string;
  chain: string;
  transactionHash?: string;
  eventIndex?: number;
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  amountRaw?: string;
  blockNumber?: string;
  occurredAt: string;
}
```

- [ ] Move `amountUsd`, `priceUsd`, `collectedAt`, provider metadata, and optional provenance to enrichment revisions.
- [ ] When two records share economic identity, merge enrichment by quality and freshness rather than recording a content conflict.
- [ ] Keep true immutable-field disagreement in the conflict ledger.
- [ ] Rate-limit repeated conflict occurrence writes by conflict key and time bucket while preserving total occurrence counters.
- [ ] Add tests for mutable refresh, higher-quality enrichment, true immutable conflict, and repeated-conflict aggregation.

Run:

```bash
pnpm exec vitest run packages/database/test/source-ledger-semantic-fingerprint.test.ts packages/database/test/source-ledger-store.test.ts packages/database/test/source-enrichment-store.test.ts
```

Expected: collection refreshes no longer inflate the conflict ledger; true economic conflicts remain auditable.

Commit checkpoint:

```bash
git add packages/domain/src/source-observation.ts packages/database
git commit -m "fix: separate economic events from mutable enrichment"
```

## Checkpoint 8: Harden SQLite Write Safety

**Files:**

- Modify: `packages/database/src/connection.ts`
- Modify: `packages/database/src/source-ledger-store.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Modify: `packages/database/test/write-transaction-retry.test.ts`
- Modify: `apps/automation/test/sqlite-contention.test.ts`
- Create: `packages/database/test/no-direct-write-transactions.test.ts`

- [ ] Raise the default busy timeout from 1 second to 5 seconds and make it configurable.
- [ ] Replace every direct `BEGIN IMMEDIATE` write path, including historical price persistence, with `withAddressRadarWriteTransaction`.
- [ ] Use bounded exponential backoff with jitter; do not block indefinitely.
- [ ] Add transaction labels, wait duration, retry count, and batch-size telemetry.
- [ ] Cap large writes and release the transaction between batches.
- [ ] Add a guard test that scans production database source files for unapproved direct write transactions.
- [ ] Add contention tests with concurrent Scanner, Recovery, Automation, and Wallet Monitor writers.

Run:

```bash
pnpm exec vitest run packages/database/test/write-transaction-retry.test.ts packages/database/test/no-direct-write-transactions.test.ts apps/automation/test/sqlite-contention.test.ts
```

Expected: bounded concurrent writers complete without unhandled `SQLITE_BUSY`; telemetry identifies any delayed transaction.

Commit checkpoint:

```bash
git add packages/database apps/automation/test/sqlite-contention.test.ts
git commit -m "fix: harden sqlite write coordination"
```

## Checkpoint 9: Make Wallet Coverage Explicit Across Solana and EVM

**Files:**

- Modify: `apps/wallet-monitor/src/cli.ts`
- Modify: `apps/wallet-monitor/src/runtime.ts`
- Modify: `apps/wallet-monitor/src/indexed-wallet-collector.ts`
- Modify: `apps/wallet-monitor/src/store.ts`
- Create: `apps/wallet-monitor/src/coverage-controller.ts`
- Modify: `apps/wallet-monitor/test/production-wiring.test.ts`
- Modify: `apps/wallet-monitor/test/provider-health-regressions.test.ts`
- Modify: `apps/wallet-monitor/test/runtime.test.ts`
- Create: `apps/wallet-monitor/test/coverage-controller.test.ts`

- [ ] Create one coverage record per resolved identity and supported chain family.
- [ ] Distinguish live cursor, historical backfill cursor, last successful observation, and provider health.
- [ ] Mark BSC Blockscout 404 behavior as an explicit incompatible route, not a generic healthy-zero result.
- [ ] Fall back through configured indexed providers and RPC capabilities; persist every route decision.
- [ ] Mark plain EVM RPC as `unsupported_for_full_history` when it cannot query address history, while retaining it for live log/transaction monitoring where applicable.
- [ ] Schedule EVM backfill in bounded partitions and expose idle, pending, running, blocked, and complete states.
- [ ] Add fixture-based tests for ETH/Base indexed partitions, BSC provider incompatibility, Solana continuity, and no-provider terminal diagnostics.

Run:

```bash
pnpm exec vitest run apps/wallet-monitor/test/coverage-controller.test.ts apps/wallet-monitor/test/production-wiring.test.ts apps/wallet-monitor/test/provider-health-regressions.test.ts apps/wallet-monitor/test/runtime.test.ts
```

Expected: zero EVM observations always have a durable chain-specific explanation and recovery path.

Commit checkpoint:

```bash
git add apps/wallet-monitor
git commit -m "feat: track wallet coverage by chain and provider"
```

## Checkpoint 10: Add Queue Admission Control and Convergence Guarantees

**Files:**

- Modify: `packages/database/src/automation-job-store.ts`
- Modify: `apps/automation/src/scheduler.ts`
- Modify: `apps/automation/src/runtime.ts`
- Create: `apps/automation/src/queue-policy.ts`
- Create: `apps/automation/test/queue-convergence.test.ts`
- Modify: `apps/automation/test/sqlite-contention.test.ts`

- [ ] Define per-job-type high-water marks, admission rates, concurrency limits, and retry budgets.
- [ ] Replace a single aggregate backlog view with runnable, deferred, blocked, terminal, and manual counts.
- [ ] Preserve lane fairness, but add job-type round-robin inside each lane so one retry-heavy type cannot monopolize a consumer.
- [ ] Use exponential retry schedules for missing source data and cap repeated retries before converting to a durable deferred state.
- [ ] Pause low-priority historical admission when total runnable backlog grows across consecutive windows.
- [ ] Never pause live discovery, fact transition, or signal-readiness work because of historical backlog.
- [ ] Define convergence as `completion_rate > admission_rate` over a rolling window while oldest runnable age decreases.
- [ ] Add deterministic load tests that reproduce the previous growing-backlog condition and prove recovery.

Run:

```bash
pnpm exec vitest run apps/automation/test/queue-convergence.test.ts apps/automation/test/sqlite-contention.test.ts
```

Expected: live work remains responsive and a fixed historical workload drains to zero runnable jobs.

Commit checkpoint:

```bash
git add packages/database/src/automation-job-store.ts apps/automation
git commit -m "feat: enforce queue convergence and scheduling fairness"
```

## Checkpoint 11: Build the Closed-Loop Operations View

**Files:**

- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/app.ts`
- Modify: `apps/console/test/automation-funnel.test.ts`
- Modify: `apps/console/test/multi-source-operations.test.ts`
- Create: `apps/console/test/closed-loop-operations.test.ts`

- [ ] Add a compact closed-loop funnel showing all canonical stages from token discovery to signal readiness.
- [ ] For each stage show total, newly completed in 15 minutes/1 hour/24 hours, pending, blocked, terminal, oldest pending age, and last progress time.
- [ ] Add productive-job rate separately from completed-job rate.
- [ ] Add recovery-to-fact closure rate and a top reason-code breakdown.
- [ ] Add wallet coverage by chain and provider, including explicit unsupported or incompatible routes.
- [ ] Add queue convergence: admission rate, completion rate, runnable backlog delta, deferred backlog, and oldest runnable age.
- [ ] Add SQLite contention telemetry and conflict-ledger write rate.
- [ ] Use precise Chinese labels in the UI while keeping API identifiers in English.
- [ ] Add drill-down links from every blocked stage to the underlying tokens, wallets, jobs, or providers.

Run:

```bash
pnpm exec vitest run apps/console/test/closed-loop-operations.test.ts apps/console/test/automation-funnel.test.ts apps/console/test/multi-source-operations.test.ts
```

Expected: console counts reconcile exactly with store queries and no status is represented only by an opaque internal identifier.

Commit checkpoint:

```bash
git add apps/console
git commit -m "feat: expose closed loop operations metrics"
```

## Checkpoint 12: Reconcile Existing Data and Prove End-to-End Behavior

**Files:**

- Create: `apps/automation/src/migrations/reconcile-closed-loop-v1.ts`
- Create: `apps/automation/test/reconcile-closed-loop-v1.test.ts`
- Modify: `apps/automation/test/full-pipeline-replay.test.ts`
- Modify: `packages/database/test/query-indexes.test.ts`
- Create: `docs/operations/closed-loop-production-acceptance.md`

- [ ] Implement an idempotent reconciliation command with dry-run, cursor, bounded batch, and summary output.
- [ ] Backfill recovery fact links from existing recovery jobs.
- [ ] Reclassify legacy manual identity jobs without deleting history.
- [ ] Recompute observation fingerprints and create enrichment revisions without overwriting original raw payloads.
- [ ] Reconcile eligible source observations into canonical early trades.
- [ ] Initialize wallet coverage rows for all resolved identities.
- [ ] Requeue only downstream work whose canonical prerequisites now exist.
- [ ] Add a representative replay fixture covering Solana, ETH, BSC, Base, and Robinhood identifiers, including unsupported-provider outcomes.
- [ ] Verify indexes for every new production dashboard and reconciliation query.

Run targeted checks:

```bash
pnpm exec vitest run apps/automation/test/reconcile-closed-loop-v1.test.ts apps/automation/test/full-pipeline-replay.test.ts packages/database/test/query-indexes.test.ts
```

Run complete verification:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all tests pass, TypeScript reports no errors, and the build completes successfully.

Commit checkpoint:

```bash
git add apps/automation docs/operations/closed-loop-production-acceptance.md packages/database/test/query-indexes.test.ts
git commit -m "feat: reconcile historical closed loop state"
```

## Checkpoint 13: Deploy Safely and Run Read-Only Production Acceptance

**Files:**

- No source changes expected.
- Operational evidence should be recorded in `docs/operations/closed-loop-production-acceptance.md` only after the user explicitly authorizes deployment and production writes.

- [ ] Confirm the working tree, branch, and exact commit intended for deployment.
- [ ] Confirm `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` before and after deployment.
- [ ] Stop only the writers required for a consistent database backup.
- [ ] Back up `/var/lib/address-radar/address-radar.db`, WAL, SHM, environment files, and current systemd unit definitions.
- [ ] Resolve the current release symlink before creating a new release. Do not hard-link the symlink itself.

```bash
source_dir="$(readlink -f /opt/address-radar/current)"
release_dir="/opt/address-radar/releases/<release-id>"
mkdir -p "$release_dir"
cp -al "$source_dir"/. "$release_dir"/
```

- [ ] Install/build in the new immutable release, run migration dry-run, then apply additive migrations.
- [ ] Run historical reconciliation in bounded batches and record each batch summary.
- [ ] Atomically switch the `current` symlink and restart services in dependency order.
- [ ] Keep the previous release and database backup as read-only rollback points.
- [ ] Perform immediate health checks for Scanner, Automation, Wallet Monitor, Wallet Analysis, and Console.
- [ ] Run a two-hour read-only acceptance window with measurements every 10 minutes.

Acceptance thresholds:

1. All required services remain `active` with no restart loop.
2. Gateway delivery remains disabled.
3. No sustained SQLite lock failures; transient retries remain bounded and observable.
4. Recovery jobs cannot increase `completed` without matching fact-link resolution.
5. Canonical early-trade facts increase when eligible recovered observations exist.
6. Candidate evidence and ability evaluation either produce rows or persist explicit zero-output reasons.
7. Automated runnable backlog has a non-positive trend after initial reconciliation admission.
8. Oldest runnable job age decreases; deferred/manual work is excluded from runnable convergence.
9. Each resolved wallet has explicit per-chain coverage status.
10. Console totals reconcile with direct read-only SQL queries.

Rollback triggers:

- Any migration corruption or failed integrity check.
- Repeated service crashes.
- Sustained database lock failures that prevent forward progress.
- Material loss of canonical observations or candidate evidence.
- Unexpected Gateway enablement.

Rollback procedure:

1. Stop new release writers.
2. Restore the previous `current` symlink.
3. Restore the database backup only if an additive migration or reconciliation damaged data; otherwise retain the migrated database for diagnosis.
4. Restart the previous release and verify Gateway remains disabled.
5. Preserve new-release logs and reconciliation reports for root-cause analysis.

Final deployment evidence:

- Release commit and release directory.
- Migration and reconciliation summaries.
- Service status and restart counts.
- Database integrity result and disk headroom.
- Two-hour stage-delta table.
- Remaining reason-code distribution.
- Explicit decision: `accepted`, `accepted_with_degradation`, or `rolled_back`.

## Completion Definition

The implementation is complete only when all of the following are true:

- Every automation execution has a durable structured outcome.
- Every recovery completion is backed by a canonical fact or terminal reason.
- Historical observations can deterministically become early-trade facts.
- Candidate evidence and ability evaluation show measurable progress or explicit blockers.
- Manual identity work does not consume automated queue capacity.
- Solana and EVM wallet coverage is explicit and diagnostically useful.
- Mutable enrichment no longer creates false economic-event conflicts.
- SQLite write contention is bounded and observable.
- Historical queues converge without starving live discovery.
- The developer console exposes one reconcilable end-to-end operational view.
- Production passes the two-hour read-only acceptance window with Gateway delivery disabled.
