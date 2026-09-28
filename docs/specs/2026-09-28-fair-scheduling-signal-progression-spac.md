# Fair Scheduling and Signal Progression SPAC

## Status

Approved for implementation on 2026-09-28.

## Problem

The production closed loop can ingest and recover facts, but it cannot guarantee that every live stage receives execution time or that a later trader-state change re-evaluates an existing token. Four symptoms are coupled:

1. `ability_evaluation` can remain pending while another job family keeps producing outcomes.
2. `candidate_evidence` admission can temporarily exceed completion after a reconciliation wave.
3. The global runnable queue can switch from converging to expanding without producer throttling.
4. `signal_readiness` advances only when Scanner receives a new trade event, not when identity, ability, admission, or historical facts become available later.

## Root causes

### Scheduler state is not lane-scoped

`automation_job_type_state` is keyed only by `job_type`. Dispatcher jobs in the `repair` lane therefore update the same fairness clock as evaluation jobs in `trader_backfill`. A dispatcher claim can make real evaluation work appear recently served.

### Inactive lanes accumulate credit

Lane credit is incremented even when a lane has no runnable work. When it becomes active again, accumulated credit can create a long burst and starve other lanes.

### Capacity mixes runnable and dependency-blocked work

The candidate producer uses an active count that includes `waiting_source` and `blocked_source`. This obscures executable capacity and prevents backpressure from describing the actual consumer load.

### Signal evaluation is event-coupled

Scanner evaluates a token only in the batch that accepts a new event. Later ability, admission, lifecycle, or identity changes do not re-evaluate saved evidence.

## Goals

- Bound starvation for every enabled live job type.
- Keep dispatcher activity isolated from worker fairness state.
- Admit work from material fact changes only.
- Separate runnable capacity from dependency-blocked inventory.
- Re-evaluate existing tokens after relevant upstream facts change.
- Preserve idempotent broadcasts and keep Gateway delivery disabled until separately approved.
- Expose enough state to prove progress, convergence, and signal readiness.

## Non-goals

- Splitting the SQLite writer into multiple systemd services.
- Enabling Gateway delivery.
- Replacing SQLite with PostgreSQL.
- Changing signal thresholds or trader admission policy.

## Invariants

1. Fairness state is scoped by `(lane, job_type)`.
2. Only eligible lanes accrue scheduling credit.
3. A single eligible lane cannot accumulate positive or negative credit.
4. Blocked jobs do not consume runnable admission capacity.
5. A signal projection revision is created only when its material source fingerprint changes.
6. Applying revision `N` never marks revision `N+1` complete.
7. Projection retries are idempotent; broadcast uniqueness remains `(token_id, broadcast_number)`.
8. New trade events keep the existing synchronous Scanner path; projection is an eventual correction path.

## Design

### Lane and job-type fairness

- Store job-type fairness under the encoded key `<lane>:<job_type>`.
- Add credit only to currently eligible lanes.
- Subtract the sum of eligible lane weights from the selected lane.
- Reset inactive lane credit to zero.
- Preserve the existing priority ordering within a selected job type.

### Runnable capacity

Add `runnableCount(jobType)` to distinguish executable and leased work from dependency-blocked inventory. Candidate admission uses this value for its high-water check. Blocked work remains visible in queue metrics and audit records.

### Signal projection request model

`signal_projection_requests` stores one durable row per token:

- source fingerprint;
- desired revision;
- applied revision;
- request and completion timestamps;
- last error.

A periodic reconciler scans tokens with saved address evidence and builds a material fingerprint from:

- latest evidence time and evidence count;
- latest trader ability snapshot;
- latest candidate admission snapshot;
- latest trader entity update.

Only a changed fingerprint increments `desired_revision`. Pending requests enqueue a `signal_projection` job using the current revision as its idempotency key.

### Signal projection worker

The worker loads the current one-hour evidence window and runs the same `createTokenSignalService` used by Scanner. It writes `token_evaluation_state` or an idempotent broadcast, then advances only the applied revision it actually evaluated.

### Backpressure

- Candidate production uses runnable capacity rather than total unresolved inventory.
- `signal_projection` has an explicit queue policy and concurrency limit.
- Historical admission remains paused when historical high-water marks are reached.
- Operations acceptance must compare admitted and completed deltas per type, not service liveness alone.

## Failure handling

- A projection exception remains retryable under the normal automation retry budget.
- A newer desired revision is not lost when an older job completes.
- Restarting the service reconstructs pending projection jobs from durable requests.
- Existing global job-type fairness rows remain harmless legacy records; new claims use lane-scoped keys.
- Gateway delivery remains controlled by `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.

## Acceptance criteria

- Each continuously runnable enabled job type records a claim within a bounded observation window.
- `ability_evaluation` produces outcomes while candidate work is present.
- Candidate admitted/completed deltas converge after the initial migration wave.
- `signal_projection_requests.desired_revision = applied_revision` converges for stable facts.
- Updating an ability or admission fact causes the related token to be re-evaluated without a new trade.
- Re-running the same projection revision produces no duplicate broadcast.
- Queue metrics distinguish runnable, deferred, and blocked inventory.
- All services remain active with no SQLite lock regression.

## Rollout

1. Back up the production database.
2. Deploy schema and code with Gateway delivery disabled.
3. Enable `signal_projection` in `ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES`.
4. Restart automation and console only after migration completes.
5. Observe per-type claims, outcomes, projection lag, queue deltas, SQLite locks, and disk for at least 30 minutes.
6. Roll back the release symlink and restore the backup only if schema or queue integrity fails.
