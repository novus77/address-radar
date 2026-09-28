# Address Radar Production Realtime Closure SPAC

> Status: Approved for implementation planning  
> Date: 2026-09-28  
> Scope: Address Radar production data path, candidate discovery, trader evaluation, token aggregation, and shadow signal generation  
> Delivery state: User-facing Gateway delivery remains disabled during implementation and shadow acceptance

## 1. Executive Summary

Address Radar currently has active collectors, wallet observations, historical token data, milestone records, candidate evidence, and ability-evaluation jobs. However, these components do not yet form a reliable end-to-end production loop.

The highest-impact confirmed defect is located between canonical trader-event persistence and signal evidence projection. Wallet Monitor can persist a trader event before Scanner sees it. Scanner currently treats the existing event as a reason to skip all downstream work, so an event may be safely stored while never producing address signal evidence, token aggregation, or a radar decision.

This SPAC adopts an **event projection ledger** architecture:

1. Raw observation persistence and canonical event persistence remain idempotent.
2. Downstream projection is tracked independently from event insertion.
3. Every eligible canonical event must reach a terminal projection state.
4. Failed or previously skipped events can be replayed safely.
5. Live processing and historical recovery use separate lanes and quotas.
6. Missing facts trigger targeted recovery instead of blocking unrelated work.
7. Production delivery remains disabled until shadow acceptance is complete.

The design preserves the current single-server and SQLite deployment while defining contracts that can later move to PostgreSQL or a message broker without changing business semantics.

## 2. Goals

### 2.1 Primary goals

- Form a measurable closed loop from valuable-token discovery to stable high-multiple trader discovery, identity admission, backtesting, token aggregation, and shadow radar signals.
- Ensure a canonical event is not lost merely because another service inserted it first.
- Make every processing stage observable through durable status, timestamps, retry reasons, and queue watermarks.
- Let live events continue when historical data, Fomo data, or an external provider is delayed.
- Drain existing candidate and ability-evaluation backlogs without starving realtime work.
- Support safe, idempotent replay of missed historical events.
- Keep production services stable under SQLite contention, provider rate limits, browser memory pressure, and low disk space.

### 2.2 Secondary goals

- Provide reliable operator-facing Chinese diagnostics instead of exposing internal status codes alone.
- Preserve stable event and signal contracts for a future queue/PostgreSQL architecture.
- Produce enough shadow data to evaluate signal quality before enabling user delivery.

## 3. Non-goals

- Enabling `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED` in this phase.
- Replacing SQLite with PostgreSQL immediately.
- Introducing Kafka, RabbitMQ, or another external queue immediately.
- Redesigning the customer plugin or Gateway authorization model.
- Making every external data source mandatory for signal generation.
- Treating temporary provider unavailability as a reason to stop scanning.
- Rebuilding the legacy non-address-based radar path.

## 4. Confirmed Production Baseline

The following values are the latest observed production baseline. They are evidence for planning, not permanent acceptance thresholds.

| Area | Observed state |
| --- | --- |
| Core services | Scanner, Automation, Wallet Monitor, Wallet Analysis, Historical Backfill, and Console active |
| Gateway delivery | Explicitly disabled |
| Historical tokens | 8,065 |
| Fomo verification | 6,138 queued, 1,299 deferred, 603 confirmed, 25 unsupported |
| Milestone crossings | 2,943 records across 713 tokens |
| Candidate evidence | 228 records, 218 traders, 63 tokens |
| Current admitted traders | Approximately 121 distinct traders in latest-admission view |
| Wallet identities | 215 |
| Wallet observations | 33,995 total |
| Recent wallet observations | Approximately 1,592-1,617 per hour |
| Recent eligible buys | 858 buys; 675 buys at or above USD 100 |
| Recent projection result | All recent observations projected to trader events, but 0 new address signal evidence |
| Token aggregation | 8 records; no recent updates |
| Broadcast records | 8 historical records; no recent updates |
| Candidate jobs | 4,289 completed, 18,595 pending, 225 blocked source, 1 retryable |
| Ability jobs | 7,346 completed, 10,340 pending, 3 retryable |
| Candidate throughput | Approximately 65 per hour; about 12 days of backlog at the observed rate |
| Ability throughput | Approximately 236 per hour; about 44 hours of backlog at the observed rate |
| Source blocks | 157 missing milestone, 52 missing market history, 7 missing early trades, 5 insufficient coverage |
| Disk | Approximately 91% used with about 3.7 GB free |
| Browser collector | High memory use and multiple Chromium renderers |
| SQLite | A recent Scanner lock conflict was observed; no evidence of a permanent database outage |

## 5. Problem Definition

### 5.1 Confirmed root cause: insertion deduplication blocks downstream projection

The current flow effectively behaves as follows:

```text
Wallet observation
  -> Wallet Monitor inserts canonical trader event
  -> Scanner sees the same event
  -> insertTraderEvent returns inserted=false
  -> Scanner continues to the next event
  -> no signal evidence
  -> no token aggregation update
  -> no signal evaluation
```

The defect is conceptual: **event existence** and **projection completion** are different facts. Event insertion must be idempotent, but downstream projection must have its own idempotency boundary.

### 5.2 Fomo verification is active but not closing the queue

The sync timer and service run successfully, yet a large queued set shows no corresponding progress. A successful process exit only proves that the command ran; it does not prove that requests were consumed, matched with results, persisted, or transitioned to a terminal state.

The exact failing edge must be measured across:

```text
verification request
  -> request export
  -> browser collector intake
  -> Fomo lookup/search
  -> result output
  -> result import
  -> token verification state transition
```

### 5.3 Backfill queues are not meeting realtime operational needs

Historical candidate and ability jobs are progressing, but candidate throughput is far below the backlog size. A single shared scheduling lane risks allowing blocked or expensive historical jobs to delay live work.

### 5.4 Missing facts are represented as blockers rather than recovery work

Milestones, market history, and early trades are sometimes missing. These cases need explicit recovery jobs, provider fallback, retry timing, and terminal outcomes. Repeatedly rescheduling the original candidate job without repairing the prerequisite wastes capacity.

### 5.5 Resource pressure can invalidate otherwise correct logic

- Disk usage is already above a safe operating watermark.
- Chromium collection is memory-intensive on a 4 GB host.
- Multiple SQLite writers can collide.
- High-frequency timers can create overlapping or low-value work.
- Unbounded repeated logs can turn recoverable errors into a production outage.

## 6. Root Cause Matrix

| Symptom | Status | Primary cause | Required correction |
| --- | --- | --- | --- |
| Wallet observations grow but signal evidence does not | Confirmed | Scanner skips downstream work when canonical event already exists | Independent event projection ledger and replay worker |
| Token aggregation remains stale | Confirmed downstream consequence | No new signal evidence reaches aggregation | Reproject missed events, then recompute affected tokens |
| Fomo verification queue remains large | Confirmed symptom; edge not yet isolated | Request/result lifecycle has no visible per-stage acknowledgement | Durable state machine, correlation ID, stage metrics, stale-request recovery |
| Candidate backlog drains too slowly | Confirmed | Historical queue volume and blocked work compete with useful work | Lane quotas, priority aging, prerequisite recovery queue |
| Ability evaluation backlog is large | Confirmed | Capacity and scheduling fairness | Separate quota and bounded concurrency |
| Missing milestone/history/early trade blocks | Confirmed | Prerequisite data was not recovered before reevaluation | Fact recovery planner and provider fallback |
| SQLite lock conflict | Confirmed intermittent symptom | Concurrent writers and transaction duration | Single-writer boundaries, short transactions, busy retry, lock metrics |
| Disk near full | Confirmed risk | Logs, browser profiles, release/data retention | Watermarks, rotation, retention, low-priority pause |
| Browser collector memory pressure | Confirmed risk | Long-lived Chromium pages/renderers | Page caps, recycling, memory guard, controlled restart |

## 7. Target Architecture

### 7.1 Logical pipeline

```text
Discovery sources
  -> Raw observations
  -> Canonical events
  -> Projection ledger
  -> Address signal evidence
  -> Token aggregation state
  -> Strategy evaluation
  -> Shadow signal records
  -> Gateway outbox (disabled until approval)

Missing facts at any stage
  -> Fact recovery planner
  -> Provider chain
  -> Normalized fact ledger
  -> Targeted reevaluation
```

### 7.2 Service responsibilities

| Component | Responsibility | Must not own |
| --- | --- | --- |
| Wallet Monitor | Observe configured wallets, normalize trades, persist observations and canonical events | Signal eligibility decisions |
| Fomo Collector | Capture Fomo account actions and identity/token verification results | Candidate admission policy |
| Scanner | Discover token events and submit canonical events for projection | Treat event insertion as proof of projection |
| Projection Worker | Convert canonical events into address evidence exactly once and trigger affected-token evaluation | Provider scraping |
| Fact Recovery Worker | Repair missing milestone, price, early-trade, market, and identity facts | Block the live lane globally |
| Automation Scheduler | Allocate capacity across realtime, recovery, candidate, and ability lanes | Execute long work inside scheduler transactions |
| Signal Evaluator | Evaluate token-stage rules from normalized evidence | Mutate raw source records |
| Gateway | Authenticate clients and distribute approved signals | Decide whether a signal is analytically valid |

## 8. Canonical Event and Projection Model

### 8.1 Canonical event identity

Every economic action receives a deterministic `canonical_event_key` based on stable source facts. The key must not depend on collection time.

Preferred inputs:

- Chain identifier
- Transaction hash or source event ID
- Log/instruction index when available
- Wallet address
- Token contract or mint
- Side
- Source-specific sequence discriminator

When a transaction hash is unavailable, a fallback fingerprint can use normalized wallet, token, side, amount bucket, source timestamp, and source identity. Fallback keys must record lower confidence.

### 8.2 Projection ledger

A durable ledger tracks each downstream projection independently:

| Field | Purpose |
| --- | --- |
| `canonical_event_key` | Stable event identity |
| `projection_type` | Example: `address_signal_evidence_v1` |
| `status` | `pending`, `running`, `completed`, `retryable`, `blocked_source`, `terminal_failed` |
| `attempt_count` | Retry accounting |
| `next_attempt_at` | Backoff scheduling |
| `claimed_at` / `claim_owner` | Lease ownership |
| `completed_at` | Completion watermark |
| `result_key` | Created evidence or aggregation identifier |
| `failure_code` | Machine-readable reason |
| `failure_detail` | Bounded diagnostic detail |
| `source_revision` | Supports intentional re-projection after semantic changes |

Uniqueness must be enforced on:

```text
(canonical_event_key, projection_type, source_revision)
```

### 8.3 Projection transaction

For a single event, the worker performs a short transaction:

1. Claim or create its projection ledger row.
2. Re-read the canonical event.
3. Validate minimum facts required for address evidence.
4. Upsert address signal evidence using a deterministic evidence key.
5. Mark affected token aggregation dirty or enqueue token evaluation.
6. Mark projection completed.

External API calls must not occur inside this transaction.

### 8.4 Idempotency guarantees

- Re-reading an observation must not duplicate a canonical event.
- Re-projecting a canonical event must not duplicate evidence.
- Re-evaluating a token must not duplicate the same signal occurrence.
- A changed strategy revision may intentionally produce a new evaluation while retaining provenance.
- Collection timestamp changes alone must not create a new business revision.

## 9. Compensation and Historical Replay

### 9.1 Replay scope

The initial replay should be staged:

1. Dry-run count and classify the previous 24 hours.
2. Replay the previous 24 hours under a strict rate limit.
3. Compare event, evidence, aggregation, and signal counts.
4. Extend to 7 days only if disk, lock, and duplication metrics remain safe.
5. Older history remains available as an operator-triggered bounded job.

### 9.2 Replay safety

- Replay reads canonical events, not raw provider payloads.
- Projection uniqueness prevents duplicate evidence.
- Token evaluations are coalesced by token and evaluation window.
- Repeated events for the same token trigger one dirty marker rather than unbounded evaluations.
- Replay has a lower scheduling quota than realtime work.
- Replay can be paused without affecting live ingestion.

### 9.3 Reconstruction order

```text
missing projections
  -> address evidence
  -> affected-token aggregation rebuild
  -> strategy reevaluation in shadow mode
  -> signal audit comparison
```

## 10. Fomo Verification Closure

### 10.1 Durable lifecycle

Each verification request needs a correlation ID and explicit lifecycle:

```text
queued
  -> exported
  -> collector_received
  -> lookup_started
  -> result_ready
  -> imported
  -> confirmed | not_found | unsupported | retryable | terminal_failed
```

### 10.2 Acknowledgement contract

- Export writes a manifest containing correlation IDs and a checksum.
- Collector acknowledges intake before processing.
- Results preserve the original correlation ID.
- Import is idempotent by correlation ID and result revision.
- Requests without acknowledgement are returned to `queued` after lease expiry.
- `not_found` is a terminal observation with an expiry, not an infinite retry.
- Provider or page failures use bounded exponential backoff with jitter.

### 10.3 Diagnostic watermarks

The console and metrics must expose:

- Oldest request age per state
- Count entering and leaving each state in 15-minute and 1-hour windows
- Collector acknowledgement latency
- Result import latency
- Retry and terminal-failure reasons
- Tokens blocked only by Fomo verification

### 10.4 Cost and load control

- Prioritize tokens already containing qualified wallet activity.
- Deduplicate verification by chain and contract.
- Cache confirmed and valid negative results with separate TTLs.
- Cap concurrent browser tabs and recycle sessions.
- Avoid polling a queue every few seconds when no work changed; use a watermark or a conservative interval.

## 11. Fact Recovery Framework

### 11.1 Recoverable fact types

- Token identity and canonical chain/contract
- Market existence and executable pair
- Price history
- Market-cap milestones
- Early trades and early buyers
- Wallet transaction history
- Fomo presence and account action
- Token launch timestamp and lifecycle stage

### 11.2 Recovery policy

Each missing fact creates or updates one deduplicated recovery request:

```text
(entity_key, fact_type, required_time_range, schema_revision)
```

Recovery requests use:

- Provider priority order
- Provider-specific rate limits
- Cache and freshness rules
- Retry budget
- Next-attempt time
- Confidence and provenance
- Terminal unsupported state

### 11.3 Provider strategy

The system must use a provider chain rather than a single mandatory source:

1. Local normalized facts and cached observations
2. Existing chain RPC data where technically sufficient
3. DEX/market APIs for market and price history
4. Fomo page/network capture for platform presence and activity
5. Dune or paid analytical sources as optional enrichment, not a hard dependency

When all providers fail, the original event remains stored. Only the dependent evaluation is deferred.

### 11.4 Blocked-source behavior

- Move the prerequisite into a recovery queue.
- Record exactly which fact and time range is missing.
- Do not repeatedly run the full candidate evaluator.
- Wake only dependent jobs when the fact is recovered.
- Use progressive backoff such as 5 minutes, 30 minutes, 2 hours, 8 hours.
- Lower scheduling priority after repeated source failure.

## 12. Scheduling and Fairness

### 12.1 Work lanes

| Lane | Intended work | Priority |
| --- | --- | --- |
| Realtime | New wallet/Fomo events and token aggregation | Highest |
| Fast recovery | Facts required by active realtime opportunities | High |
| Candidate | Candidate evidence and admission | Medium |
| Ability | Trader history and ability evaluation | Medium |
| Historical | Old token/trader recovery | Low |
| Maintenance | Cleanup, compaction, reports | Lowest |

### 12.2 Initial capacity allocation

The exact values remain configurable. Recommended starting allocation:

| Lane | Capacity share |
| --- | ---: |
| Realtime | 40% |
| Fast recovery | 20% |
| Candidate | 15% |
| Ability | 15% |
| Historical | 8% |
| Maintenance | 2% |

Unused capacity may be borrowed, but realtime reserved capacity cannot be consumed by historical work.

### 12.3 Fairness rules

- Weighted round-robin across lanes.
- Oldest-job aging within a lane.
- Per-provider and per-task-type concurrency limits.
- Leases with expiration for crashed workers.
- Retryable jobs are not immediately reclaimed in a tight loop.
- Blocked-source jobs do not occupy active worker slots.
- Queue arrival and completion rates are reported separately.

## 13. Signal Evaluation Closure

### 13.1 Required stages

```text
qualified event
  -> address evidence
  -> token-window aggregation
  -> token lifecycle classification
  -> strategy evaluation
  -> shadow signal occurrence
  -> repeated occurrence counter
  -> optional Gateway outbox
```

### 13.2 Token lifecycle strategy

The evaluator must preserve the existing distinction between:

- New-token discovery
- Launched-token continuation
- Older-token movement

Each strategy owns its event window, trader-quality requirement, minimum unique-trader count, and amount logic. The projection repair must not collapse these strategies into one universal 15-minute rule.

### 13.3 Repeated signals

When the same token satisfies the same strategy again:

- Preserve the first signal record.
- Increment the occurrence count.
- Append a new occurrence with timestamp and market snapshot.
- Keep a stable signal identity for plugin presentation.
- Prevent retries from counting as a new occurrence.

### 13.4 Shadow mode

During this phase:

- Valid signals are persisted and visible in the developer console.
- Gateway outbox creation can be simulated or recorded without delivery.
- `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED` remains `false`.
- Enabling delivery requires a separate explicit production decision.

## 14. SQLite and Storage Reliability

### 14.1 Write discipline

- Define one owner for each mutable table.
- Keep transactions short and deterministic.
- Never hold a transaction during network, browser, or filesystem waits.
- Use bounded busy timeout and retry with jitter.
- Batch related inserts without creating oversized transactions.
- Use WAL mode and monitor checkpoint health where supported by current deployment.

### 14.2 Lock diagnostics

Record:

- Writer and operation name
- Lock wait duration
- Retry count
- Transaction duration
- Final outcome
- Queue age caused by lock contention

Repeated lock messages must be aggregated and rate-limited.

### 14.3 Disk watermarks

| Disk use | Action |
| --- | --- |
| Below 75% | Normal operation |
| 75%-85% | Warning and increased cleanup frequency |
| 85%-90% | Pause nonessential historical expansion and browser artifacts |
| Above 90% | Critical mode: preserve realtime ingestion, suspend low-priority work, alert operator |
| Above 95% | Emergency mode: stop write-heavy noncritical services to protect database integrity |

Production is currently around the critical threshold and must receive an operational cleanup before large replay jobs.

### 14.4 Retention

- Rotate journald and service logs by size and age.
- Retain bounded browser profiles, screenshots, and response captures.
- Keep only approved release count plus active rollback release.
- Store long-term analytics as compact aggregates where raw retention is unnecessary.
- Never delete the active database or rollback snapshot automatically.

## 15. Browser Collector Reliability

- Limit tabs, contexts, and renderer processes.
- Recycle browser contexts after a bounded number of lookups.
- Track resident memory, lookup latency, crash count, and login validity.
- Stop accepting new low-priority work before memory exhaustion.
- Persist request leases so a controlled browser restart does not lose work.
- Distinguish login expiry, selector mismatch, network failure, rate limiting, and no-result outcomes.
- Capture a bounded diagnostic sample instead of logging full payloads repeatedly.

## 16. Observability and Operator Console

### 16.1 End-to-end funnel

The console must show counts and recent rates for:

```text
discovered tokens
-> verified supported tokens
-> observations
-> canonical events
-> completed projections
-> address evidence
-> token aggregations
-> strategy evaluations
-> shadow signals
-> delivery outbox
```

### 16.2 Required diagnostics

- Total and recent counts per stage
- Oldest pending age
- Arrival versus completion rate
- Projection success and retry rate
- Top missing-fact reasons
- Fomo verification stage distribution
- Realtime and historical queue separation
- Last successful update timestamp for each stage
- SQLite lock rate
- Disk and browser memory risk
- Gateway delivery state

### 16.3 Chinese status mapping

Internal codes remain stable English identifiers. The console maps them to precise Chinese descriptions, for example:

| Internal code | Console description |
| --- | --- |
| `missing_milestone` | 缺少目标市值里程碑，已进入里程碑补数 |
| `missing_market_history` | 缺少评估时间段的价格或市值历史，已进入行情补数 |
| `missing_early_trades` | 缺少里程碑前的早期交易明细，已进入早期交易回补 |
| `projection_pending` | 交易事件已入库，等待生成地址信号证据 |
| `projection_retryable` | 信号证据生成暂时失败，将按退避策略重试 |
| `fomo_queued` | 等待进行 Fomo 平台存在性验证 |

## 17. Failure and Degradation Policy

### 17.1 General rule

No single external data source may stop global scanning.

### 17.2 Failure behavior

| Failure | Behavior |
| --- | --- |
| One provider unavailable | Try fallback or defer dependent fact only |
| Fomo unavailable | Continue chain observation; mark Fomo fact pending |
| RPC rate limited | Switch endpoint or back off affected chain |
| SQLite busy | Retry bounded transaction; preserve queue item |
| Browser memory high | Pause low-priority lookups and recycle browser |
| Disk critical | Pause historical/replay work; preserve realtime and database |
| Projection code error | Mark retryable/terminal with bounded diagnostics; do not lose canonical event |
| Worker crash | Lease expires and another worker resumes safely |

### 17.3 Dead-letter handling

Only deterministic, nonrecoverable failures enter a dead-letter state. Every dead-letter item retains:

- Original entity/event key
- Processing revision
- Failure code
- Bounded error detail
- Attempt history summary
- Operator retry eligibility

## 18. Security and Data Integrity

- Secrets remain in production environment files or secret management, never in logs or SPAC documents.
- Operator APIs remain developer-only.
- Replay and migration commands default to dry-run.
- Every migration has a backup and rollback procedure.
- Event provenance and provider confidence are retained.
- Raw source payloads are size-bounded and sanitized before logging.
- Gateway delivery stays disabled throughout shadow acceptance.

## 19. Implementation Phases

### Phase 0: Production safety baseline

Objective: create room for safe repair and replay.

Tasks:

- Capture current database, service, queue, disk, memory, and throughput baseline.
- Back up the production SQLite database using a consistent snapshot method.
- Identify largest disk consumers.
- Apply bounded log and release retention configuration.
- Confirm Gateway delivery is disabled.
- Define replay maximum rate and automatic pause watermarks.

Exit criteria:

- Recoverable database snapshot exists.
- Sufficient free disk exists for migration and a 24-hour replay.
- No service is producing uncontrolled log growth.

Rollback:

- Restore previous retention configuration; no business schema change occurs in this phase.

### Phase 1: Projection ledger and hot-path repair

Objective: ensure every eligible canonical event reaches downstream projection.

Tasks:

- Add projection ledger schema and indexes.
- Add repository APIs for create, claim, complete, retry, and lease recovery.
- Remove the semantic dependency between `insertTraderEvent().inserted` and downstream projection.
- Add an idempotent projection worker.
- Add deterministic evidence keys.
- Coalesce affected-token evaluations.
- Add unit and integration tests for competing Wallet Monitor and Scanner insertion orders.

Exit criteria:

- Both insertion orders generate exactly one evidence record.
- Duplicate collection generates no duplicate evidence or signal occurrence.
- Eligible live events reach evidence within the target latency.

Rollback:

- Keep the new table but disable the worker; restore the previous runtime path without data deletion.

### Phase 2: Compensation replay

Objective: repair events skipped by the existing logic.

Tasks:

- Implement dry-run classification and counts.
- Enqueue missing projections for the previous 24 hours.
- Rate-limit replay below realtime capacity.
- Rebuild aggregations only for affected tokens.
- Compare expected versus produced evidence.
- Extend to 7 days after successful acceptance.

Exit criteria:

- Replay is idempotent across two runs.
- Realtime latency remains within SLO during replay.
- No unexplained difference remains between eligible canonical events and completed projections.

Rollback:

- Pause replay workers; projection ledger preserves progress for later resume.

### Phase 3: Fomo verification closure

Objective: make queue progress and failure location explicit.

Tasks:

- Add correlation IDs and lifecycle states.
- Add request manifests and collector acknowledgements.
- Add result-import idempotency.
- Recover expired leases.
- Classify `not_found`, login expiry, selector mismatch, throttling, and transport failure.
- Add per-stage console watermarks.
- Reduce empty high-frequency polling.

Exit criteria:

- Test requests reach a terminal result with full provenance.
- Oldest queued age decreases under normal collector availability.
- No successful sync run can hide zero consumed work.

Rollback:

- Preserve old file exchange format behind a compatibility adapter until the new lifecycle is accepted.

### Phase 4: Fact recovery and scheduling fairness

Objective: drain useful work while repairing missing prerequisites efficiently.

Tasks:

- Normalize missing-fact requests.
- Add deduplication and dependent-job wakeup.
- Separate realtime, fast recovery, candidate, ability, historical, and maintenance lanes.
- Add weighted scheduling and aging.
- Add provider-specific concurrency and rate limits.
- Move blocked-source work out of active worker capacity.
- Add queue arrival/completion dashboards.

Exit criteria:

- Every task class progresses in consecutive observation windows.
- Candidate and ability completion rates exceed their new arrival rates.
- Missing-fact retry volume decreases without lowering useful completions.

Rollback:

- Switch scheduler policy to the previous single-lane mode while retaining normalized recovery records.

### Phase 5: SQLite and resource hardening

Objective: prevent infrastructure pressure from breaking the repaired pipeline.

Tasks:

- Audit table ownership and writer paths.
- Shorten transactions and move external work outside transactions.
- Add bounded lock retry and metrics.
- Configure WAL/checkpoint monitoring where applicable.
- Add browser page/context caps and recycling.
- Add disk-watermark behavior and retention jobs.
- Rate-limit repetitive error logs.

Exit criteria:

- No SQLite lock causes a service exit during a 24-hour shadow run.
- Disk remains below the configured safe watermark.
- Browser collector remains within its memory budget without losing request leases.

Rollback:

- Revert concurrency values and operational settings independently; schema remains backward compatible.

### Phase 6: Console and end-to-end observability

Objective: make the entire loop inspectable without database access.

Tasks:

- Add funnel totals, recent deltas, and oldest pending ages.
- Add projection and Fomo lifecycle panels.
- Add candidate and ability throughput panels.
- Add Chinese explanations for missing data and blocked states.
- Add signal provenance from occurrence back to source events and trader identities.
- Add a shadow-signal view with first occurrence, repeat count, market snapshots, and strategy version.

Exit criteria:

- An operator can explain why any token did or did not become a shadow signal.
- Every stale stage shows its last success, queue age, and actionable reason.

Rollback:

- Console changes are read-only and can be rolled back without affecting processors.

### Phase 7: Shadow production acceptance

Objective: prove correctness and stability before delivery is considered.

Tasks:

- Run a controlled synthetic event through the complete path.
- Observe real production events for at least 24 hours.
- Compare canonical events, projections, evidence, aggregation, and signal records.
- Review false duplicate and missed-event samples.
- Verify repeated-signal occurrence behavior.
- Produce a go/no-go report.

Exit criteria:

- All acceptance criteria in Section 21 pass.
- No unresolved P0 or P1 issue remains.
- Gateway delivery remains disabled unless separately approved.

## 20. Test Strategy

### 20.1 Unit tests

- Canonical key stability
- Projection state transitions
- Retry and lease expiry
- Evidence idempotency
- Token evaluation coalescing
- Fomo lifecycle transitions
- Recovery request deduplication
- Scheduler lane fairness
- Chinese status mapping

### 20.2 Integration tests

- Wallet Monitor inserts before Scanner.
- Scanner inserts before Wallet Monitor.
- Both services receive the same event concurrently.
- Worker crashes after evidence insert but before completion update.
- Missing milestone is recovered and wakes only dependent jobs.
- Fomo result is imported twice.
- Historical replay runs twice.
- SQLite busy error occurs during projection.
- Browser collector restarts while requests are leased.

### 20.3 Production shadow tests

- Synthetic known wallet buy with a known token.
- Real event sample reconciliation.
- Twenty-four-hour duplicate and omission audit.
- Replay under realtime load.
- Disk and memory watermark exercise without destructive actions.

## 21. Acceptance Criteria

### 21.1 Functional closure

- At least 99% of eligible canonical events produce completed projection records within 60 seconds under normal operation.
- Every noncompleted projection has a durable, explicit state and reason.
- No eligible event is skipped solely because its canonical event already exists.
- Duplicate source delivery produces exactly one address evidence record.
- Affected tokens are re-aggregated after new evidence.
- Shadow signals retain strategy version and complete provenance.

### 21.2 Realtime performance

- New live observation to canonical event: target P95 below 30 seconds.
- Canonical event to address evidence: target P95 below 60 seconds.
- Evidence to token aggregation and strategy decision: target P95 below 2 minutes.
- Historical replay must not push realtime P95 above twice the target for more than one measurement window.

### 21.3 Queue health

- Realtime oldest-pending age remains below 5 minutes during normal provider availability.
- Candidate and ability completion rates exceed arrival rates over a rolling 6-hour window.
- No task class has zero completion for two consecutive windows while runnable work exists.
- Blocked-source jobs do not consume active worker slots.
- Fomo queue states show both intake and completion movement.

### 21.4 Reliability

- No service exits due to SQLite lock contention during a 24-hour shadow run.
- No uncontrolled repeated log exceeds its configured rate limit.
- Disk remains below 85% during normal operation and never exceeds 90% during replay.
- Browser collector stays within the configured memory guard and resumes leased work after recycling.
- Service restart counts remain stable except for controlled deployment restarts.

### 21.5 Signal correctness

- Retry/replay does not increment a token's occurrence count.
- A genuine later qualifying event increments the existing signal occurrence.
- New-token and older-token strategies use their own configured windows and thresholds.
- Every signal can be traced to contributing events and trader identities.
- Gateway delivery remains off during shadow acceptance.

## 22. Rollout and Migration Plan

1. Capture baseline and database snapshot.
2. Deploy additive schema migration only.
3. Deploy projection code with worker disabled.
4. Validate schema and dry-run projection counts.
5. Enable projection worker for newly arriving events only.
6. Observe a short canary window.
7. Enable 24-hour replay at low rate.
8. Rebuild affected token aggregations.
9. Deploy Fomo lifecycle and scheduler changes independently.
10. Complete 24-hour shadow acceptance.
11. Produce a separate decision document before any user delivery change.

Each step must have its own rollback switch. No migration step may require deleting existing production facts.

## 23. Operational Checkpoints

### Checkpoint A: Safety ready

- Backup verified
- Disk below critical watermark
- Delivery disabled
- Baseline recorded

### Checkpoint B: Live projection repaired

- New eligible events produce evidence
- Dedupe verified
- No new lock-related exit

### Checkpoint C: Missed history recovered

- 24-hour replay complete
- Aggregations rebuilt
- Count reconciliation accepted

### Checkpoint D: Fomo lifecycle closed

- Requests visibly traverse all stages
- Stale requests recover or terminate
- Queue oldest age trends downward

### Checkpoint E: Backlogs controlled

- All lanes progress
- Completion exceeds arrival
- Blocked work is isolated

### Checkpoint F: Production shadow accepted

- 24-hour stability complete
- Funnel reconciliation complete
- Signal audit complete

## 24. Expected Code and Data Impact

Likely implementation areas include:

- Scanner runtime event handling
- Scanner collectors and canonical event normalization
- Wallet Monitor event persistence contract
- Database schema, migration, and repository APIs
- Projection worker and compensation replay command
- Token aggregation dirty-state handling
- Automation scheduler lanes and quotas
- Fomo verification sync and collector acknowledgement
- Console runtime-quality and funnel endpoints
- Operational service/timer configuration
- Unit, integration, and production-audit tests

Exact files are to be confirmed during implementation planning after one focused repository inspection. The implementation should prefer additive schema changes and small reviewable commits.

## 25. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Replay creates duplicate evidence | False signals | Deterministic evidence key and unique constraint |
| Replay overloads SQLite | Realtime delay or service failure | Low-priority lane, rate limit, disk/lock auto-pause |
| Existing event schema lacks stable identity | Weak dedupe | Source-specific canonical keys plus confidence-marked fallback |
| Fomo UI changes | Verification stalls | Network-response preference, DOM fallback, selector version diagnostics |
| Provider rate limiting | Missing facts | Provider chain, cache, backoff, and partial degradation |
| Scheduler policy starves a lane | Backlog growth | Reserved quotas, aging, and per-lane progress alerts |
| Disk cleanup removes required evidence | Audit loss | Explicit retention classes and protected database snapshots |
| Strategy reevaluation creates false repeats | Inflated occurrence count | Separate evaluation revision from genuine event occurrence |

## 26. Implementation Planning Requirements

The implementation plan derived from this SPAC must:

- Break work into independently deployable checkpoints.
- Name exact files, migrations, tests, and service units.
- Put projection correctness before backlog optimization.
- Include pre-deployment data queries and post-deployment reconciliation queries.
- Include a rollback command or switch for every production change.
- Keep Gateway delivery disabled.
- Avoid destructive database cleanup.
- Complete tests before each checkpoint deployment.
- Record observed production results rather than assuming service health from process status alone.

## 27. Final Definition of Closed Loop

The system is considered closed only when all of the following are true:

1. Valuable tokens are discovered from supported sources.
2. Token facts and lifecycle milestones are stored with provenance.
3. Early/high-return trader activity is recovered from realtime and historical paths.
4. Trader identities and wallets are admitted or explicitly left unresolved.
5. Wallet and Fomo actions become canonical events.
6. Canonical events reliably become address signal evidence.
7. Evidence updates token aggregation in the correct lifecycle window.
8. Strategy evaluation produces traceable shadow signals and repeat occurrences.
9. Candidate admission and ability evaluation continue progressing automatically.
10. Missing facts create targeted recovery work rather than silent gaps.
11. Every stage exposes queue size, recent progress, oldest age, and failure reason.
12. The system remains stable under provider failure, browser recycling, SQLite contention, and replay load.

Until these conditions pass production shadow acceptance, the architecture is operationally active but not yet a complete radar closure.
