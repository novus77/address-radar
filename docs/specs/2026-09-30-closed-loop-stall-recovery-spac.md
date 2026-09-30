# Address Radar Closed-Loop Stall Recovery SPAC

> Status: Approved design, pending implementation plan review  
> Date: 2026-09-30  
> Source baseline: production release copied read-only from `/opt/address-radar/current`  
> Delivery state: `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` throughout implementation and acceptance

## 1. Executive Summary

Address Radar has a complete logical pipeline and all six production services are running, but the production data path is not yet a self-healing closed loop. Token discovery, market-history collection, ability evaluation, token aggregation, and signal evaluation are active. Three prerequisite boundaries do not reliably convert pending state into executable work:

1. Milestone confirmation can remain pending without a runnable recovery job.
2. Identity resolution can remain pending after its automation job was cancelled or otherwise disappeared.
3. Candidate evidence records missing prerequisites without guaranteeing that a provider attempt is scheduled, observed, and linked back to the dependent candidate job.

These gaps create downstream symptoms: blocked candidate evidence, slowly growing admission work, incomplete wallet coverage, and only a small number of shadow-ready signals. A separate operational defect allows database backups to consume most remaining disk space and has already caused a full-service interruption.

This SPAC introduces a reconciliation-driven repair that preserves the existing SQLite, scheduler, provider, and shadow-signal architecture. It does not replace working services. It adds explicit invariants at each stage boundary, repairs orphaned work, makes admission event-driven, and applies disk-safe retention before historical processing continues.

## 2. Goals

- Keep every closed-loop stage either progressing or explicitly terminal.
- Ensure every pending milestone, identity, candidate prerequisite, admission, and wallet-backfill item maps to executable, deferred, manual, or terminal work.
- Make missing facts create deduplicated provider work and wake only their dependents after recovery.
- Drain historical candidate admission without starving realtime token and wallet processing.
- Prevent backup and historical workloads from exhausting production disk.
- Preserve all audit records and existing business facts.
- Keep Gateway delivery disabled until a separate approval.

## 3. Non-Goals

- Enabling customer delivery.
- Replacing SQLite, systemd, or the existing provider adapters.
- Deleting business facts, candidate evidence, trader history, or signal history.
- Reclassifying signal strategy thresholds.
- Making Dune or any paid provider mandatory.
- Automatically merging conflicting trader identities.

## 4. Confirmed Production Baseline

The baseline below was collected through read-only production inspection on 2026-09-30.

| Stage | Completed | Pending | Blocked | Recent state |
| --- | ---: | ---: | ---: | --- |
| Token discovery | 1,954 | 0 | 0 | Healthy |
| Market history | 1,880 | 74 | 0 | Progressing |
| Milestone confirmation | 1,736 | 144 | 0 | No completion in the previous hour |
| Early-trade recovery | 1,417 | 319 | 0 | Progressing slowly |
| Identity resolution | 122 | 312 | 0 | No progress since 2026-09-28 |
| Candidate evidence | 372 | 0 | 859 | Worker active; prerequisites blocked |
| Ability evaluation | 11,348 | 1 | 0 | Effectively complete |
| Candidate admission | 7,574 | 3,774 | 0 | Progressing below desired throughput |
| Wallet monitoring | 122 | 1,088 | 194 | Observations active; coverage incomplete |
| Token aggregation | 1,266 | 0 | 0 | Healthy |
| Signal readiness | 1,266 | 0 | 0 | Healthy evaluator; 8 qualifying results |

Additional evidence:

- Candidate blocks: 768 missing milestone, 74 missing canonical early-buy events, and 17 missing price history.
- No `token_fact_attempts` were recorded in the previous 30-minute window.
- Identity stage reported pending work while the automation queue contained no runnable identity-resolution jobs.
- Candidate admission snapshots were still being created, but completion throughput was substantially lower than the backlog.
- Initial wallet backfill contained pending records that were not represented as runnable work.
- Duplicate active automation jobs: zero.
- SQLite lock errors in the observed window: zero.
- Disk usage: 94%, approximately 2.5 GB free.
- `/var/lib/address-radar/backups` consumed approximately 8.1 GB.

## 5. Failure Topology

```text
token discovery
  -> market history
  -> milestone confirmation ---------+
                                      |
early-trade recovery -----------------+-> candidate evidence
                                      |       -> ability evaluation
identity resolution -----------------+       -> candidate admission
                                              -> wallet monitoring
                                              -> token aggregation
                                              -> signal readiness
```

The pipeline is not globally stopped. The failure occurs where a stage summary reports pending or blocked work but no durable executable prerequisite exists. Downstream evaluators remain healthy and therefore expose low output rather than service failure.

## 6. Root-Cause Findings

### 6.1 Disk retention has no enforced safety invariant

Backups can be created while historical workloads are active without first reserving sufficient free space. Multiple multi-gigabyte snapshots are retained, and the latest backup was temporally correlated with a full-service interruption.

Required invariant:

```text
backup creation is allowed only when:
free_bytes_after_estimate >= critical_reserve_bytes
```

Realtime services must not be stopped merely because maintenance work cannot proceed.

### 6.2 Milestone pending state is not equivalent to scheduled recovery

The milestone stage has pending tokens and partial milestone facts, but the recent provider-attempt ledger is empty. Stage accounting can therefore count a token as pending without proving that an eligible recovery job exists.

Required invariant:

```text
each pending milestone token has exactly one of:
runnable recovery job
deferred recovery job with next_attempt_at
terminal unsupported fact
completed milestone fact
```

### 6.3 Identity state and automation-job state can diverge

The identity stage reports 312 pending identities while no runnable identity-resolution jobs exist. Historical identity jobs were cancelled, but unresolved identity rows remained classified as pending.

Required invariant:

```text
pending identity = active automation job
manual identity = explicit manual state
unresolvable identity = terminal state with reason
```

### 6.4 Candidate blocking does not prove prerequisite recovery

Candidate evaluation correctly emits `blocked_source`, but a block does not guarantee a linked recovery job or a recent provider attempt. Re-evaluation can therefore keep rediscovering the same missing fact without repairing it.

Required invariant:

```text
blocked candidate
  -> recovery_fact_link
  -> deduplicated recovery job
  -> provider attempt or terminal reason
  -> dependent candidate wakeup
```

### 6.5 Candidate admission is scan-driven rather than consistently event-driven

Ability and evidence facts can arrive faster than periodic admission scanning drains them. Admission snapshots are valid and idempotent, but the backlog does not have a one-to-one executable queue representation.

Required invariant:

```text
new qualifying evidence or ability revision
  -> one coalesced admission request per trader, strategy, and window
```

Periodic reconciliation remains a safety net, not the primary trigger.

### 6.6 Wallet-backfill accounting can expose pending but non-runnable work

Initial wallet-backfill rows may be pending while absent from the runnable queue. These rows need explicit next-attempt, manual, blocked-provider, or terminal classification.

## 7. Target Design

### 7.1 Stage reconciliation contract

Add a reusable reconciliation service that compares durable stage state with automation jobs. It performs only idempotent transitions:

- Create missing jobs.
- Cancel provably obsolete duplicates.
- Move manual-only records out of automatic pending counts.
- Mark unsupported records terminal with machine-readable reasons.
- Preserve every previous state for audit.

The reconciler must not execute provider calls or long-running analysis inside its transaction.

### 7.2 Fact-recovery orchestration

Use existing `token_fact_status`, `token_fact_attempts`, `recovery_jobs`, and `recovery_fact_links` tables as the canonical recovery model.

For each required fact:

1. Resolve current fact status and freshness.
2. Upsert one recovery job by token, fact type, coverage range, and strategy revision.
3. Select the next healthy provider route.
4. Record every provider attempt, including no-data and unsupported outcomes.
5. Update fact status atomically after normalized facts are persisted.
6. Wake only candidate jobs linked to that fact.
7. Apply bounded exponential backoff when no provider can currently satisfy the request.

### 7.3 Milestone recovery repair

`milestone-fact-reconciler` becomes responsible for converting every partial or missing milestone fact into an automation job. A partial fact is complete only when it covers the strategy-required market-cap threshold and time range. A provider response with insufficient history remains partial and records the missing range.

### 7.4 Identity reconciliation repair

`identity-automation` classifies every unresolved identity into one of four states:

- `automatic_pending`
- `manual_pending`
- `resolved`
- `terminal_unresolvable`

An automatic pending identity must own an active job. Manual-only entries are visible in the console but excluded from runnable backlog. Cancelled jobs are recreated only when the identity remains automatically resolvable.

### 7.5 Event-driven admission

Candidate evidence and ability evaluation publish a coalesced admission request after committing their facts. The request key is:

```text
trader_id + strategy_version + admission_window_end
```

The admission worker evaluates the latest evidence snapshot, writes one deterministic admission snapshot, and then enqueues wallet monitoring only when the effective admission state changes or a newly resolved wallet requires coverage.

### 7.6 Wallet-backfill reconciliation

The wallet reconciler maps each admitted, monitorable wallet to one initial-backfill state:

- runnable
- deferred with next attempt
- blocked provider
- manual because identity lacks an address
- completed
- terminal unsupported

Repeated admission evaluation must not duplicate initial backfill.

### 7.7 Disk-safety policy

Introduce configurable watermarks:

| Watermark | Default behavior |
| --- | --- |
| Free disk below 8 GB | Pause historical replay and nonessential backups |
| Free disk below 5 GB | Pause candidate bulk reconciliation and browser enrichment |
| Free disk below 3 GB | Run realtime-only mode and reject new backup creation |

Backup policy:

- Write to a temporary snapshot path.
- Verify SQLite snapshot integrity.
- Atomically rename after verification.
- Keep the latest successful backup, one daily backup for seven days, and one pre-deployment rollback backup.
- Never delete the active database, current rollback point, or the only valid backup.
- Produce a dry-run retention report before deletion.

## 8. Scheduling and Fairness

The scheduler retains existing lanes but applies reserved capacity after the ability backlog has drained:

| Lane | Reserved share |
| --- | ---: |
| Realtime wallet and token work | 40% |
| Fast prerequisite recovery | 25% |
| Candidate evidence and admission | 20% |
| Historical recovery | 10% |
| Maintenance | 5% |

Blocked-source rows never occupy worker capacity. Unused capacity may be borrowed. Admission requests receive aging so a large historical set cannot remain indefinitely behind newly arriving work.

## 9. Data and Schema Changes

Prefer additive changes to existing tables.

- Add missing identity lifecycle values and reconciliation timestamps where the current schema cannot express them.
- Add a durable admission-request job type rather than deriving pending work only from aggregate counts.
- Add indexes supporting active job lookup by subject, type, status, and next-attempt time.
- Require `recovery_fact_links` for every candidate block that has a recoverable prerequisite.
- Preserve cancelled and terminal jobs as audit records.
- Do not rewrite historical evidence or admission snapshots.

Any migration must be restart-safe and idempotent.

## 10. Expected Code Impact

Primary implementation areas:

- `scripts/backup-production-state.sh`
- `deployment/systemd/address-radar-backup.service`
- `deployment/systemd/address-radar-backup.timer`
- `apps/automation/src/milestone-fact-reconciler.ts`
- `apps/automation/src/token-fact-orchestrator.ts`
- `apps/automation/src/candidate-source-recovery.ts`
- `apps/automation/src/candidate-evidence-worker.ts`
- `apps/automation/src/trader-ability-worker.ts`
- `apps/automation/src/initial-wallet-backfill-worker.ts`
- `apps/automation/src/scheduler.ts`
- `apps/automation/src/runtime.ts`
- `apps/automation/src/migrations/reconcile-closed-loop-v1.ts`
- `packages/database/src/automation-job-store.ts`
- `packages/database/src/recovery-fact-link-store.ts`
- `packages/database/src/token-fact-store.ts`
- `packages/database/src/identity-automation.ts`
- `packages/database/src/candidate-evaluation-request-store.ts`
- `packages/identity/src/candidate-admission-service.ts`
- `packages/identity/src/identity-automation.ts`
- `packages/domain/src/closed-loop-metrics.ts`
- `apps/console/src/application.ts`

Tests remain colocated with the owning package or application.

## 11. Test Strategy

### 11.1 Disk and backup tests

- Reject backup creation below the critical reserve.
- Preserve the active database and protected rollback snapshot.
- Verify retention dry-run and deterministic selection.
- Confirm maintenance pause does not stop realtime services.

### 11.2 Milestone and fact-recovery tests

- A pending milestone without a job creates exactly one job.
- A partial milestone requests only the missing coverage range.
- A no-data provider attempt records an attempt and backs off.
- A recovered fact wakes linked candidates exactly once.
- A terminal unsupported fact does not requeue indefinitely.

### 11.3 Identity tests

- An orphan automatic-pending identity recreates one job.
- A manual-only identity is excluded from automatic backlog.
- A resolved identity cancels obsolete active jobs.
- Cancelled audit rows remain queryable.

### 11.4 Admission tests

- Evidence revision enqueues one admission request.
- Ability revision coalesces with an existing admission request.
- Reprocessing produces one deterministic snapshot.
- Admission state changes enqueue one wallet-monitoring request.

### 11.5 Wallet tests

- Every admitted wallet has an explicit backfill state.
- A missing address becomes manual rather than permanently runnable.
- Provider retry uses `next_attempt_at` and does not spin.
- Repeated admission does not duplicate backfill work.

### 11.6 End-to-end regression

Run a fixture through:

```text
token -> market history -> milestone -> early trades
-> candidate evidence -> ability -> admission
-> wallet coverage -> aggregation -> shadow signal
```

The test must also cover missing milestone recovery, orphan identity repair, restart recovery, and duplicate scheduling.

## 12. Rollout Plan

### Checkpoint 0: Restore source of truth

- Record production release provenance.
- Initialize the independent source repository without importing secrets or production data.
- Keep the existing unrelated console project unchanged.

### Checkpoint 1: Disk safety

- Deploy backup guard and retention dry-run.
- Review protected and deletable backup sets.
- Require explicit approval before deleting or relocating production backups.

### Checkpoint 2: Reconciliation framework

- Deploy additive schema and repository APIs.
- Run reconciliation in report-only mode.
- Compare expected jobs with actual stage backlog.

### Checkpoint 3: Milestone and candidate recovery

- Enable milestone reconciliation for a bounded batch.
- Confirm provider attempts and candidate wakeups.
- Expand only while disk and lock metrics remain safe.

### Checkpoint 4: Identity and wallet reconciliation

- Classify orphan identities.
- Recreate only automatically resolvable jobs.
- Reconcile initial wallet backfill states.

### Checkpoint 5: Event-driven admission

- Enable coalesced admission requests.
- Drain historical admission at a bounded rate.
- Preserve realtime scheduling capacity.

### Checkpoint 6: Shadow acceptance

- Observe all stages for at least two hours.
- Require positive net progress for every runnable stage.
- Verify signal provenance and occurrence idempotency.
- Keep Gateway delivery disabled.

## 13. Rollback Strategy

- All schema changes are additive.
- New reconcilers and event-driven triggers have independent feature flags.
- Disabling a reconciler leaves durable jobs for later resume.
- Existing facts and audit rows are never deleted during rollback.
- Production backup cleanup is operationally separate from code deployment.
- Each release preserves the previous release target for symlink rollback.

## 14. Acceptance Criteria

### Operational safety

- Free disk remains above 8 GB during normal historical processing.
- No backup begins when projected free space would cross the configured reserve.
- No service exits due to disk or SQLite contention during a 24-hour shadow run.

### Stage invariants

- Every pending milestone maps to runnable, deferred, terminal, or completed recovery state.
- Every pending automatic identity maps to exactly one active job.
- Every recoverable candidate block maps to exactly one recovery fact link and job.
- Every admitted monitorable wallet maps to exactly one backfill state.
- Duplicate active automation jobs remain zero.

### Throughput

- Milestone confirmation records positive completions in two consecutive 30-minute windows while pending work exists.
- Identity resolution records progress or explicitly reclassifies all nonautomatic entries.
- Candidate admission completion exceeds arrival rate over two consecutive hours.
- Recoverable candidate blocks decrease over two consecutive hours.

### Signal closure

- New qualifying evidence reaches token aggregation within two minutes under normal load.
- Signal readiness continues updating without duplicate occurrences.
- Every shadow signal retains source-event, trader, strategy, and market-snapshot provenance.
- Gateway delivery remains disabled.

## 15. Definition of Done

The repair is complete only when disk safety is enforced, no stage exposes orphan pending work, missing prerequisites create observable provider attempts, recovered facts wake their dependents, admission drains faster than it grows, wallet coverage has explicit outcomes, and the shadow-signal funnel continues progressing without manual intervention.
