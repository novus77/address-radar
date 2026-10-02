# SPAC: Independent Consumer Wake-up and Historical Recovery Closure

## Scope and Confirmed Rules

Fix source-fact wake-up coupling, guarantee recovery execution opportunities, implement real signal and aggregation revision acknowledgements, and distinguish unconfirmed milestones from proven absence. Admission thresholds, the 30-day opportunity window, identity boundaries, and disabled gateway delivery remain unchanged.

## Verified Problems

Production inspection on 2026-10-02 found source-fact reconciliation defers candidate wake-up whenever any owner has active ability work. This can repeatedly occupy the oldest batch. Candidate execution acknowledgements now advance, but signal and aggregation execution revision requests are not acknowledged by their actual consumers. Missing historical milestones remain the largest candidate blocker.

Recovery already uses cross-type attempt ordering; absence of fairness must not be asserted. Within-type backlog, provider budgets, actual attempts and fact coverage require separate measurement. Ten sampled blocked tokens were absent from historical inventory; this does not prove they never crossed the threshold or are fake tokens.

## Phase 1: Independent Source-fact Dispatch

- Retain the existing candidate trigger receipt, whose meaning is persisted wake-up, not successful evaluation.
- Atomically persist candidate wake-up and one ability dispatch obligation per fact revision and affected trader.
- A busy ability owner does not prevent candidate reconciliation.
- Dispatch ability obligations independently; exclude active subjects before the batch limit and preserve the existing 1,000 runnable capacity.
- Mark dispatched only after a job exists. Dispatch is not a recomputation acknowledgement.
- Keep undispatched obligations durable across process restarts; repeated scans do not duplicate candidate triggers.
- Add source_fact_ability_dispatches and a pending index. Prepare the additive schema before production activation; preserve existing receipts and all facts. Do not automatically replay all legacy receipts or claim they were audited.
- Report abilityDispatched and abilityPending separately from candidate processed.

Acceptance: busy-owner candidate wake-up, deferred ability dispatch after owner completion, no repeat candidate trigger, batch fairness, queue capacity, transaction rollback and restart durability.

## Phase 2: Recovery Execution Opportunities

Measure due age, last attempt, provider budget deferral and actual fact production by job type and chain. Give runnable prerequisite recovery bounded execution opportunities without bypassing shared provider limits. Preserve cursors, retry classification and linked recovery obligations; do not manufacture coverage or cancel outstanding work to improve dashboard counts.

Acceptance: representative historical tokens receive attempts despite backlog, provider retries remain bounded, completed recovery proves the prerequisite range, and duplicates do not grow.

## Phase 3: Signal and Aggregation Revision Acknowledgements

Capture exact consumed execution heads, identity and input coverage. Atomically acknowledge only the revisions used by successful aggregation and signal evaluation. A concurrent newer revision stays pending. Missing prerequisites defer without acknowledgement. Admission and scoring do not change. No acknowledged receipt may be inferred from dispatch, a running service, or an unrelated completed projection.

Acceptance: real revision changes reach both consumers, newer revisions remain pending, missing data is not acknowledged, replay is idempotent and no signal is delivered.

## Phase 4: Milestone State Semantics

Distinguish current observation below threshold (awaiting a future crossing), historical prerequisites missing (recovery needed), verified crossing (eligible for evaluation), and externally unavailable coverage (explicit reason and retained evidence). Historical absence is only established with complete, relevant coverage; current price or a partial scan cannot prove it. Use clear Chinese console descriptions, keeping raw reason codes for diagnostics.

## Rollout and Final Acceptance

Run targeted regression, full tests, types, build, import and boundary checks for each implementation phase. Commit and deploy only with a verified backup and disk safety guards (3.5 GB before backup and 3 GB deployment minimum). Latest measured free space is approximately 3.29 GB, so another deployment backup currently requires additional safe headroom; do not weaken the guard.

Compare distinct ability coverage, candidate produced/deferred, actual identities, prerequisite fact ranges, consumer acknowledgement revisions, recovery due age, queue convergence, SQLite contention and disk usage. Continuous live arrivals mean queue size alone is not a completion metric. Final closure requires representative real token/trade evidence across discovery, admission, wallet resolution, monitoring, aggregation and signal readiness, not merely service health. No complete closure claim until those checks pass.

## Implementation Status

Phase 1 is under implementation. Phases 2-4 remain pending. No production data rewrite is included in this phase.
