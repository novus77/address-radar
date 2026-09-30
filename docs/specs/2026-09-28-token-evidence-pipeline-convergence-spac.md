# Address Radar Token Evidence Pipeline Convergence SPAC

> Status: Draft for review  
> Date: 2026-09-28  
> Scope: historical token projection, early-trade recovery, candidate-evidence scheduling, recovery lifecycle, queue convergence, SQLite contention, and operations metrics  
> Delivery state: `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` remains mandatory

## 1. Executive Summary

The production pipeline is running, but useful historical-token progress is obscured and slowed by two structural defects:

1. Candidate evidence is scheduled per canonical trade event while evaluation operates on the complete token state. A single token can therefore create hundreds of equivalent jobs.
2. Early-trade facts are created only after a qualifying observation is already present. Milestone tokens with no observation receive no fact row, no recovery state, and no complete operator-visible status.

The production investigation found `23,110` candidate-evidence jobs for only `1,086` token subjects. One token had `462` jobs. At the same time, `290` milestone tokens had no `early_trades` fact row, only `7` early-trade fact links were pending, and only `11` `milestone_early_buyers` recovery jobs existed.

This SPAC introduces a token-level coalescing state machine, complete milestone-to-fact materialization, deterministic recovery planning, processing-time progress metrics, and a bounded production reconciliation. The design preserves the existing SQLite and systemd topology and does not enable signal delivery.

## 2. Production Evidence

### 2.1 Historical-token funnel

| Stage | Observed |
| --- | ---: |
| Milestone-confirmed tokens | 880 |
| Available early-trade facts | 590 |
| Milestone tokens without any early-trade fact row | 290 |
| Pending early-trade recovery fact links | 7 |
| Completed `milestone_early_buyers` recovery jobs | 5 |
| Failed `milestone_early_buyers` recovery jobs | 6 |

The missing `290` tokens consist of:

| Origin | Count |
| --- | ---: |
| Missing `historical_tokens` projection | 134 |
| Robinhood | 64 |
| Solana | 37 |
| Ethereum | 28 |
| BSC | 19 |
| Base | 8 |

### 2.2 Candidate-evidence queue

| Metric | Observed |
| --- | ---: |
| Candidate-evidence jobs | 23,110 |
| Distinct token subjects | 1,086 |
| Pending jobs | 15,477 |
| Blocked-source jobs | 754 |
| Completed jobs | 6,877 |
| Maximum jobs for one token | 462 |

In the sampled two-hour window, the worker processed `1,132` candidate jobs: `88` produced evidence, `810` produced no evidence, and `234` were deferred. The worker is active; redundant work is the limiting factor.

### 2.3 Recovery failures

| Reason | Count |
| --- | ---: |
| `historical_research_pending` | 70 |
| `fomo_token_history_unavailable` dead letter | 44 |
| `market_price_unavailable` | 17 |
| DefiLlama HTTP 400 | 13 |
| `early_trade_lookup_queued` | 6 |
| `rpc_gap_requires_provider_replay` | 5 |

`early_trade_lookup_queued` is asynchronous progress, but it is currently represented as a failed recovery attempt. This inflates failure metrics and obscures whether an external lookup is pending or truly failed.

### 2.4 Metric defect

The console derives recent candidate completion from `candidate_evidence_v3.evidence_at`. That timestamp describes the historical evidence event, not the processing time. Historical work completed now therefore appears as zero recent progress.

The early-trade stage counts only existing `token_fact_status` rows. A milestone token without a fact row is omitted from pending, blocked, completed, and terminal counts, violating stage conservation.

## 3. Root Causes

### 3.1 Event-granularity scheduling for token-granularity work

The dispatcher creates an idempotency key from every canonical event business state. The worker then reloads milestones, prices, and all early trades for the entire token. Each buy or sell event causes an equivalent token-wide evaluation.

The queue-level idempotency implementation is functioning as designed, but the chosen idempotency boundary is wrong.

### 3.2 No durable coalescing state

There is no token-level state recording:

- the latest requested source revision,
- the revision currently being evaluated,
- the latest processed revision,
- whether another source change arrived while a job was running.

Without this state, a stable token-level job ID either loses later changes after completion or requires a new job for every event.

### 3.3 Fact creation is reactive rather than exhaustive

`early_trade_reconciler` creates an `early_trades` fact only after it parses an observation that maps to an existing trader and represents a buy before a milestone. It does not initialize facts for all milestone tokens.

Consequently, “no fact row” currently conflates:

- not planned,
- waiting for lookup,
- lookup found no early buyers,
- unsupported provider coverage,
- permanent source unavailability.

### 3.4 Live and historical token identity projections diverge

Milestones can exist for tokens that never entered `historical_tokens`. Candidate evaluation and recovery code still rely on the historical projection for identity resolution, causing `134` milestone tokens to fall outside the expected historical workflow.

### 3.5 Recovery lifecycle conflates waiting and failure

External Fomo lookup submission is followed by a retryable exception. The recovery row is reported as failed even though the system is intentionally waiting for asynchronous data. Provider gaps and permanent unsupported conditions are also insufficiently separated.

### 3.6 Console metrics mix source time and processing time

Business evidence time is correct for scoring, but incorrect for operational throughput. The console must use automation outcomes and fact-transition timestamps for progress while retaining source timestamps for historical analysis.

## 4. Goals

1. Schedule at most one active candidate-evidence evaluation per token and strategy version.
2. Preserve a later source update that arrives while a token evaluation is running.
3. Ensure every milestone token has exactly one explicit `early_trades` fact state.
4. Ensure every non-terminal missing early-trade fact has one recovery job and one fact link.
5. Project all milestone tokens into a canonical token identity record before downstream evaluation.
6. Treat a proven empty early-buyer result as a completed fact, not an infinite retry.
7. Distinguish asynchronous waiting, retryable provider failure, terminal unavailability, and successful empty coverage.
8. Report operational progress using processing timestamps.
9. Keep the automation queue converging without increasing SQLite writer concurrency.
10. Preserve evidence scoring thresholds, signal contracts, and disabled Gateway delivery.

## 5. Non-Goals

- Changing candidate evidence tiers or the `$50` minimum cumulative buy.
- Increasing worker concurrency as the primary remedy.
- Enabling customer signal delivery.
- Replacing SQLite, systemd, or the existing automation scheduler.
- Automatically resolving wallet identity conflicts.
- Reclassifying unsupported source coverage as successful evidence.

## 6. Considered Approaches

### 6.1 Approach A: token-level coalescing state plus append-only execution jobs

Maintain one durable state row per token and strategy version. Source changes advance a requested revision. At most one execution job is active. Completion records the processed revision and schedules one follow-up only when a newer revision arrived during execution.

Advantages:

- Exact coalescing without losing concurrent updates.
- Keeps the existing scheduler and audit history.
- Supports safe retries and restarts.
- Makes backlog size correspond to business subjects.

Disadvantages:

- Adds one state table and a small coordinator abstraction.
- Requires production reconciliation of existing duplicate jobs.

Decision: selected.

### 6.2 Approach B: reuse one mutable automation job row per token

Use a stable job ID and reset completed rows to pending when new events arrive.

Advantages:

- Fewer tables.
- Smaller initial implementation.

Disadvantages:

- A source update can race with a running worker and be overwritten by completion.
- Mutating historical job rows weakens auditability.
- Core queue semantics become specialized for one job type.

Decision: rejected.

### 6.3 Approach C: retain event jobs and increase concurrency

Advantages:

- Minimal scheduling changes.

Disadvantages:

- Preserves redundant evaluation.
- Increases provider load and SQLite contention.
- Does not repair missing fact coverage or misleading metrics.

Decision: rejected.

## 7. Design

### 7.1 Candidate evaluation request state

Add `candidate_evaluation_requests`, keyed by `(token_id, strategy_version)`:

```text
token_id
strategy_version
requested_revision
processed_revision
requested_at
processed_at
active_job_id
last_outcome
updated_at
```

The dispatcher continues to consume canonical-event and milestone cursors, but it calls one token-level request API. Each newly observed business-state change advances `requested_revision`. Multiple changes for the same token in one or many dispatcher passes update the same row.

The coordinator enqueues a candidate job only when:

```text
requested_revision > processed_revision
AND active_job_id IS NULL
```

The job payload contains `tokenId`, `strategyVersion`, and `targetRevision`. Event-specific identifiers are not part of the execution idempotency key.

### 7.2 Race-safe completion

Candidate evaluation completion and request-state advancement occur in one write transaction:

1. Persist or update evidence.
2. Record the structured job outcome.
3. Advance `processed_revision` to the job's `targetRevision`.
4. Clear `active_job_id`.
5. If `requested_revision > processed_revision`, enqueue exactly one follow-up job and set it active.

An event arriving during execution only advances `requested_revision`; it cannot be lost when the running job completes.

### 7.3 Existing queue reconciliation

The production reconciliation is restart-safe and chunked:

1. Group active candidate jobs by token subject.
2. Preserve source blocks and the newest requested business state in `candidate_evaluation_requests`.
3. Cancel redundant `pending`, `retryable`, and duplicate `blocked_source` rows; never delete audit rows.
4. Keep a valid leased/running row until its lease finishes, or requeue it through normal lease recovery.
5. Enqueue at most one v2 token-level job for each dirty token.
6. Process no more than `250` subjects per transaction.

The reconciliation exposes dry-run counts before applying changes.

### 7.4 Canonical token projection

Add an idempotent projection step for every token found in `token_milestone_crossings`:

- Reuse complete identity from `historical_tokens` when present.
- Otherwise derive chain and token address from canonical `token_id` and enrich from `token_observation_state` or market snapshots.
- Persist a minimal historical-token projection when symbol, name, or image is unavailable; missing presentation metadata must not block recovery.
- Record provenance and precision so later enrichment can upgrade the row.

After reconciliation, no milestone token may be absent from the canonical token projection.

### 7.5 Exhaustive early-trade fact materialization

For every milestone token:

1. Ensure an `early_trades` fact row exists.
2. If canonical early buys already exist, transition it to `available`.
3. If complete source coverage proves there are no eligible early buys, transition it to `available` with an explicit empty-result diagnostic.
4. If lookup is required, transition it to `scheduled`, create one `milestone_early_buyers` recovery job, and create one fact link.
5. If every supported source is permanently unavailable, transition it to `terminal_unavailable` with a stable reason.

This establishes the invariant:

```text
eligible milestone tokens
= available/partial/degraded
+ scheduled/fetching/retry_scheduled
+ conflicted
+ terminal_unavailable
```

### 7.6 Recovery completion contract

`milestone_early_buyers` uses explicit outcomes:

- `available_nonempty`: canonical early buys were persisted.
- `available_empty`: complete lookup returned no qualifying early buys.
- `waiting_external`: a Fomo lookup was accepted and is awaiting ingestion.
- `retryable_provider`: transient provider or RPC failure.
- `terminal_unavailable`: all supported coverage paths are exhausted.

`waiting_external` remains operationally pending and does not count as a failure. Fomo result ingestion owns the fact transition and wakes the token-level candidate request after persistence.

### 7.7 Queue policy

Candidate high-water accounting uses distinct dirty token requests, not raw automation job rows. Existing concurrency remains unchanged until contention acceptance passes.

Scheduler fairness remains in place, but candidate work is selected by:

1. realtime dirty tokens,
2. unblocked historical tokens with complete prerequisites,
3. recovered tokens,
4. low-priority reconciliation.

Blocked-source work does not consume runnable capacity.

### 7.8 Operational metrics

The closed-loop endpoint reports, for each stage:

- `eligibleSubjects`
- `completedSubjects`
- `pendingSubjects`
- `blockedSubjects`
- `terminalSubjects`
- `untrackedSubjects`
- `processed15m`, `processed1h`, and `processed24h`
- `produced15m`, `noOutput15m`, and `deferred15m`
- `lastProcessedAt` and `lastProducedAt`

Candidate progress uses `automation_job_outcomes.created_at`. Historical `evidence_at` remains a business timestamp and is never used for operational throughput.

The API emits an integrity diagnostic whenever:

```text
completed + pending + blocked + terminal + untracked != eligible
```

The console presents `untracked` as a defect, not as successful completion.

### 7.9 SQLite write safety

- Reconciliation writes are chunked to at most `250` token subjects.
- Candidate evidence and request-state completion share one bounded transaction.
- Dispatcher cursor updates and request coalescing use the shared write-retry wrapper.
- No worker concurrency increase is allowed during rollout.
- SQLite lock telemetry is measured for at least 30 minutes before considering concurrency changes.

## 8. Failure Handling

- Process termination after evidence persistence but before completion is safe because evidence IDs and request revisions are idempotent.
- Expired leases return through existing retry handling without creating a second active token request.
- A malformed token ID becomes terminal with a visible projection reason.
- Unsupported provider coverage becomes terminal only after configured fallbacks are exhausted.
- Provider rate limits schedule bounded backoff and do not create additional candidate jobs.
- Production reconciliation can resume from its subject cursor after restart.
- Rollback leaves additive state tables intact; the previous release ignores them.

## 9. Migration and Rollout

### Phase 1: schema and token-level coordinator

- Add candidate request state and indexes.
- Add repository APIs for request, claim binding, and race-safe completion.
- Add unit tests for duplicate events, running-job updates, retries, and restart recovery.

### Phase 2: fact coverage and recovery lifecycle

- Add canonical token projection reconciliation.
- Materialize an early-trade fact for every milestone token.
- Add explicit empty, waiting, retryable, and terminal recovery outcomes.
- Wake candidate requests only after durable fact transitions.

### Phase 3: metrics and console

- Replace source-time operational metrics with outcome-time metrics.
- Add conservation and untracked diagnostics.
- Display distinct token backlog and duplicate suppression counts.

### Phase 4: production reconciliation

- Take a fresh database backup.
- Run candidate deduplication and fact materialization in dry-run mode.
- Compare dry-run counts with the baseline in this document.
- Apply chunked reconciliation.
- Deploy with Gateway delivery disabled.
- Run read-only acceptance for at least 30 minutes.

## 10. Acceptance Criteria

1. Candidate-evidence active jobs are no greater than distinct dirty token requests plus one dispatcher job.
2. No token has more than one active candidate-evidence job for the same strategy version.
3. Replaying the same canonical event does not advance the requested revision or add a job.
4. A new event arriving during evaluation causes exactly one follow-up evaluation.
5. Existing duplicate active candidate jobs are cancelled, not deleted, and remain auditable.
6. All milestone tokens have a canonical token projection.
7. All milestone tokens have exactly one explicit `early_trades` fact state.
8. The production `untracked` early-trade count falls from `290` to `0`.
9. Every non-terminal missing early-trade fact has one recovery job and one fact link.
10. A complete lookup with zero early buyers completes as `available_empty` and does not retry indefinitely.
11. Candidate `processed15m` matches automation outcomes even for historical evidence.
12. Stage conservation diagnostics report no mismatch.
13. The runnable candidate backlog falls below the distinct token count after reconciliation.
14. No unrecovered `database is locked` failure occurs during a 30-minute acceptance window.
15. All production services remain active, disk stays below 85%, and Gateway delivery remains disabled.

## 11. Test Strategy

### Unit tests

- Token request coalescing across repeated buy and sell events.
- Dirty revision preservation during a running job.
- Idempotent completion and retry behavior.
- Fact materialization for available, empty, waiting, retryable, and terminal outcomes.
- Canonical token projection from historical, observation, and token-ID fallback sources.
- Metric conservation and processing-time windows.

### Integration tests

- Milestone to early-trade recovery to candidate evaluation.
- External Fomo lookup ingestion wakes exactly one token request.
- Duplicate production-like event replay produces one active candidate job.
- Reconciliation dry-run and apply produce identical subject counts.
- Restart between request, evaluation, and completion does not lose a source revision.

### Production acceptance

- Capture pre-deployment baseline and database backup.
- Verify the duplicate active queue collapses from approximately `16,000` jobs toward at most the dirty token count.
- Verify all `290` untracked milestone tokens become explicit fact states.
- Verify candidate processed and produced counters advance independently.
- Verify queue slope, SQLite lock telemetry, service restarts, disk headroom, and delivery configuration.

## 12. Rollback

Rollback switches `/opt/address-radar/current` to the previous release and restarts services. Additive tables and cancelled duplicate jobs remain compatible and auditable. The database backup taken immediately before reconciliation is retained. No rollback procedure deletes candidate evidence, token facts, canonical events, or recovery outcomes.

