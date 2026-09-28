# Address Radar Closed-Loop Convergence and Integrity SPAC

> Status: Draft for review  
> Date: 2026-09-28  
> Scope: historical recovery, token facts, candidate evidence, wallet monitoring, queue convergence, SQLite write safety, and operator observability  
> Delivery state: `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` remains mandatory

## 1. Executive Summary

Address Radar is executing production work continuously, but task execution is not yet equivalent to business-loop progress. The current system can consume jobs, update timestamps, and report healthy services while producing no new candidate evidence, no EVM wallet observations, or no normalized token facts.

The production investigation confirmed six coupled failure modes:

1. Automation completion does not record whether a job produced useful output.
2. Automation jobs, source-recovery jobs, and token facts form separate control planes without a transactional closure contract.
3. Manual identity work is incorrectly represented as executable Repair-lane work.
4. EVM collectors are alive but do not prove wallet coverage or useful observations.
5. Multiple SQLite writers and unbounded conflict updates create avoidable write contention.
6. Work creation currently exceeds work completion, so the queue is active but not converging.

This SPAC adopts a **closed-loop integrity contract** while retaining the current single-server SQLite deployment:

- Every job must finish with a durable, machine-readable outcome.
- Every recovered prerequisite must update the normalized fact ledger and wake exactly the affected blocked work.
- Manual identity work must be removed from executable queue capacity.
- Provider health must distinguish transport success, coverage progress, and useful observation production.
- Mutable market enrichment must not be treated as a semantic conflict in immutable economic events.
- Planners must apply backlog high-water marks and per-stage capacity budgets.
- The developer console must report ingress, conversion, blockers, output, and backlog slope using one metric definition per concept.

The intended result is not merely a system that keeps running. It is a system whose useful outputs advance measurably from historical token discovery to stable trader admission and token signal evaluation.

## 2. Production Baseline

The following values were observed on 2026-09-28 and are diagnostic baselines, not permanent product thresholds.

### 2.1 Services and resources

| Area | Observed state |
| --- | --- |
| Scanner | Active, zero automatic restarts |
| Automation | Active, zero automatic restarts |
| Wallet Monitor | Active, zero automatic restarts |
| Wallet Analysis | Active, one restart |
| Console | Active, zero automatic restarts |
| Gateway delivery | Disabled |
| Root disk | 81% used, approximately 7.5 GB free |
| SQLite contention | Three failed Scanner/Recovery iterations caused by `database is locked` within approximately six minutes |

### 2.2 Historical and candidate funnel

| Stage | Count |
| --- | ---: |
| Historical tokens | 8,065 |
| Milestone-reconstructed tokens | 732 |
| Fomo-confirmed tokens | 610 |
| Fomo-pending tokens | 7,430 |
| Tokens with recovered early buyers | 72 |
| Candidate evidence records | 254 |
| Candidate evidence traders | 241 |
| Current admitted traders | 129 in the candidate view; 141 in the automation view |
| Latest candidate evidence age | Approximately 15 hours |
| Historical partitions pending | 7,598 |
| Historical partitions failed | 265 |

The differing admitted-trader counts are an existing metric-scope defect and must not be interpreted as two valid values for the same concept.

### 2.3 Queue movement

| Metric | First snapshot | Second snapshot after 20 seconds | Delta |
| --- | ---: | ---: | ---: |
| Total jobs | 67,974 | 68,030 | +56 |
| Completed jobs | 34,850 | 34,872 | +22 |
| Backlog | 33,124 | 33,158 | +34 |
| Candidate-evidence completed | 4,929 | 4,936 | +7 |
| Ability-evaluation completed | 8,899 | 8,906 | +7 |
| Candidate evidence records | 254 | 254 | 0 |

The scheduler is productive, but the queue is not converging and candidate output is not advancing.

### 2.4 Wallet and fact coverage

| Area | Observed state |
| --- | --- |
| Canonical traders | 11,353 |
| Wallet-resolved traders | 121 |
| Wallet identities | 118 Solana, 97 EVM |
| Solana wallet observations | 41,583 across 117 wallets |
| EVM wallet observations | 0 across Ethereum, BSC, Base, and Robinhood |
| `early_trades` facts | 1 available |
| Tokens reported as early-buyer recovered | 72 |
| Candidate-stage abilities | 106, average coverage approximately 51% |
| Discovered-stage abilities | 7,572, average coverage 0% |

### 2.5 Current blocker distribution

| Blocker | Count |
| --- | ---: |
| Missing milestone | 310 |
| Missing market history | 47 |
| Insufficient coverage | 5 |
| Missing early trades | 5 |
| Total blocked-source jobs | 384 |

## 3. Goals

### 3.1 Primary goals

1. Make useful closed-loop progress measurable independently from task activity.
2. Guarantee that a successful recovery updates normalized facts and wakes dependent work.
3. Give every completed candidate-evidence job an explicit output or no-output reason.
4. Remove manual identity resolution from executable Repair-lane backlog.
5. Produce trustworthy EVM coverage diagnostics and observations where provider data exists.
6. Eliminate unrecovered SQLite lock failures under the current production workload.
7. Reduce semantic-conflict write amplification without hiding immutable-data conflicts.
8. Make queue backlog converge under steady-state ingestion while preserving realtime priority.
9. Unify console metrics so each displayed number has one query, scope, and definition.

### 3.2 Secondary goals

- Preserve safe degradation when providers are unavailable or rate limited.
- Keep historical work resumable and idempotent across restarts.
- Preserve existing RadarSignal, Gateway, and plugin contracts.
- Create migration boundaries compatible with a future PostgreSQL or queue-service architecture.

## 4. Non-Goals

- Enabling customer delivery.
- Replacing SQLite with PostgreSQL in this phase.
- Introducing Kafka, RabbitMQ, or another infrastructure dependency.
- Automatically resolving Fomo identities that require manual lookup.
- Changing candidate evidence thresholds such as the USD 50 minimum buy.
- Changing token-stage signal strategies or customer-facing signal formatting.
- Making one external provider mandatory for the entire scanner.

## 5. Confirmed Root Causes

### 5.1 Completed does not mean productive

`candidate-evidence-worker` always returns `completed` after prerequisites exist, even when evidence was persisted for `0/N` traders. The diagnostic string is not stored in a structured outcome table, and `automation_jobs.last_error` is cleared on completion.

Consequences:

- Completion throughput can increase while evidence count remains unchanged.
- Operators cannot distinguish below-threshold buys, missing entry prices, no qualifying tier, or excluded data.
- Re-running the same no-output work is difficult to prioritize rationally.

### 5.2 Recovery and fact state are split across control planes

The system currently uses:

- `automation_jobs` and `automation_job_blocks`
- `recovery_jobs`
- `token_fact_status` and `token_fact_attempts`
- domain tables such as `market_observations`, `token_milestone_crossings`, and `canonical_trader_events`

Recovery handlers can write domain rows and mark a recovery job complete without proving that all required token facts were transitioned or that every linked blocked job was woken. `milestone_early_buyers` queues a Fomo lookup and retries, but Fomo result ingestion is not the authoritative owner of the `early_trades` fact transition.

This explains the observed split between 72 recovered early-buyer tokens and one available `early_trades` fact.

### 5.3 Repair lane contains non-executable manual work

Production contains 1,030 pending `identity_resolution` jobs in the Automation Repair lane. However:

- `identity_resolution` is not an enabled Automation job type.
- Automation runtime has no identity-resolution handler.
- The intended product workflow requires unresolved Fomo identities to appear in the manual identity queue.

These rows inflate Repair backlog and make a healthy manual queue look like a broken worker queue.

### 5.4 EVM health describes requests, not coverage

Production has 97 EVM wallet identities and all required RPC endpoint flags. The runtime wires both realtime block collectors and indexed Blockscout collectors, but no EVM wallet observations have been persisted.

Observed details:

- BSC Blockscout partitions repeatedly return HTTP 404.
- Ethereum and Base indexed partitions often report `indexed_wallet_idle` or `indexed_wallet_backfill_pending`.
- Direct EVM collectors scan current blocks; they cannot recover historical wallet activity by address.
- A wallet is currently offered to every EVM chain without a durable chain-affinity state.
- Provider status can be healthy even when no useful observation has ever been produced.

Transport health is therefore being mistaken for data-path health.

### 5.5 Mutable enrichment is treated as immutable conflict

Recent source conflicts show the same economic event being recollected with changed `amountUsd`, `priceUsd`, collection time, or optional provenance. The semantic fingerprint excludes nested collection time but still includes mutable market enrichment.

Every recurrence updates `source_observation_conflicts.occurrence_count`, creating repeated writes. The same 621 distinct conflicts had accumulated more than 52,000 occurrences.

The immutable event identity and mutable valuation snapshot are currently mixed in one conflict boundary.

### 5.6 SQLite retry coverage is incomplete

The shared connection enables WAL, `synchronous=NORMAL`, and a one-second busy timeout. Shared write transactions retry up to eight times. However:

- Multiple systemd services remain independent writers.
- Some code, including historical price writes, uses direct `BEGIN IMMEDIATE` without the shared retry wrapper.
- Long batches and conflict updates increase writer hold time.
- Synchronous retry sleeps block the individual Node process.
- One-second busy timeout is too short for observed production bursts.

The existing retry layer reduces contention but does not establish a complete write-safety contract.

### 5.7 Planning has no global convergence guard

The scheduler implements weighted lane fairness, but planners continue creating work while backlog is already large. In the sampled 20-second interval, 56 jobs were added and only 22 completed.

Lane fairness answers “which existing job runs next.” It does not answer “should more historical work be created now.”

### 5.8 Console metrics mix different scopes

Examples include:

- 129 versus 141 admitted traders.
- 97 completed targeted backfills versus 7,598 pending historical partitions.
- 72 early-buyer recovered tokens versus one available `early_trades` fact.
- Provider `healthy` with zero observations.

The values are individually explainable but currently presented as if they measure the same stage.

## 6. Considered Approaches

### 6.1 Approach A: local patches and higher retry limits

Changes would include increasing SQLite timeout, retrying failed jobs, and adding more console labels.

Advantages:

- Smallest code change.
- Fastest short-term deployment.

Disadvantages:

- Does not fix split control planes.
- Preserves misleading completion semantics.
- Can increase backlog and write amplification.
- Makes future incidents harder to diagnose.

Decision: rejected as the primary approach.

### 6.2 Approach B: closed-loop integrity contract on current architecture

Keep SQLite and existing services, but unify completion semantics, recovery-to-fact transitions, blocker wakeup, queue admission control, provider coverage state, and operator metrics.

Advantages:

- Addresses the confirmed root causes.
- Incrementally deployable and reversible.
- Preserves the current server and service topology.
- Creates clean migration seams for future infrastructure changes.

Disadvantages:

- Requires coordinated changes across Scanner, Automation, Wallet Monitor, Database, and Console.
- Needs additive migrations and production reconciliation.

Decision: recommended.

### 6.3 Approach C: immediate PostgreSQL and external queue migration

Move jobs, facts, and observations to PostgreSQL and a queue service.

Advantages:

- Stronger concurrent-write behavior.
- Better long-term horizontal scaling.

Disadvantages:

- High migration risk while business semantics remain ambiguous.
- Does not automatically fix no-output completion or fact reconciliation.
- Delays signal-quality work.

Decision: defer until the integrity contract is proven on SQLite.

## 7. Target Closed-Loop Contract

```text
Token / wallet discovery
  -> immutable source observation
  -> canonical economic event
  -> normalized token facts
  -> prerequisite recovery links
  -> candidate evidence outcome
  -> candidate admission projection
  -> monitored trader coverage
  -> token aggregation
  -> shadow radar decision
  -> Gateway outbox (disabled)
```

Every arrow must expose:

- input count and watermark
- output count and watermark
- terminal no-output count
- blocked count grouped by reason
- retry count and oldest age
- conversion rate
- backlog slope

## 8. Design

### 8.1 Structured automation outcomes

Add `automation_job_outcomes` with one row per completed job revision.

| Field | Purpose |
| --- | --- |
| `job_id` | Automation job identity |
| `job_revision` | Input revision or attempt identity |
| `outcome` | `produced`, `no_output`, `superseded`, `terminal_unavailable` |
| `produced_count` | Number of durable business records written |
| `reason_code` | Machine-readable no-output or terminal reason |
| `reason_context` | Bounded JSON diagnostics |
| `input_watermark` | Source fact revision used by the job |
| `completed_at` | Completion time |

Candidate evidence reason codes must include at least:

- `evidence_written`
- `below_minimum_buy`
- `missing_entry_price_at_buy`
- `missing_crossing_price`
- `no_buy_before_milestone`
- `no_qualifying_multiple_tier`
- `no_eligible_trader_events`
- `source_event_conflicted`
- `facts_superseded_during_evaluation`

A job can be operationally completed with `no_output`, but the console must never count it as evidence production.

### 8.2 Recovery-to-fact closure

Add a durable link between blocked automation work, recovery work, and required facts:

```text
automation_job_block
  -> recovery_job
  -> token_fact_status revision
  -> blocker wakeup
  -> targeted reevaluation
```

Required guarantees:

1. Recovery success and fact transition occur in the same short database transaction when both are local writes.
2. A recovery job is not `completed` until its declared fact postcondition is evaluated.
3. Empty provider results become `retry_scheduled` or `terminal_unavailable`, never silent success.
4. Fact revision changes wake only blockers linked to that token and fact type.
5. Reevaluation idempotency includes the fact revision.
6. Existing domain data can reconcile facts without another provider call.

The recovery handler contract must return:

```ts
interface RecoveryOutcome {
  factType: TokenFactType;
  factStatus: "available" | "partial" | "degraded" | "terminal_unavailable";
  factsWritten: number;
  coverageStartAt: number | null;
  coverageEndAt: number | null;
  provider: string;
  reEvaluate: { kind: "token" | "trader"; key: string } | null;
}
```

### 8.3 Early-trade reconciliation

Create an idempotent reconciler that derives `early_trades` from existing durable data:

1. Load the earliest valid milestone crossing.
2. Find canonical buy events at or before the crossing.
3. Validate trader attribution and minimum data quality.
4. Transition `early_trades` to `available`, `partial`, or `terminal_unavailable`.
5. Transition `trader_attribution` when identities are present.
6. Wake blocked candidate-evidence jobs.

Run this reconciler:

- after Fomo history import
- after wallet observation projection
- after milestone creation or correction
- during one-time production reconciliation

The migration must reconcile the existing 72 evidence-bearing tokens and explain every mismatch with the token fact ledger.

### 8.4 Identity work separation

Manual identity resolution is not executable Automation work.

Required changes:

- Migrate unresolved `identity_resolution` Automation jobs into the existing manual identity queue.
- Mark migrated Automation jobs `cancelled` with reason `moved_to_manual_identity_queue`.
- Do not include manual identity rows in Repair-lane backlog or estimated drain time.
- Preserve source reasons and affected trader IDs in the manual queue.
- When an identity is filled, emit a durable identity revision event that schedules initial wallet backfill and ability reevaluation.

Automated identity providers may later use a separate `identity_enrichment` job type, but manual resolution must remain explicit.

### 8.5 EVM wallet coverage model

Add per-wallet, per-chain coverage state:

| Field | Purpose |
| --- | --- |
| `entity_id` / `address` / `chain` | Coverage identity |
| `provider` | RPC, Blockscout, or future indexed provider |
| `coverage_state` | `unstarted`, `backfilling`, `current`, `idle`, `degraded`, `unsupported` |
| `coverage_start_at` / `coverage_end_at` | Proven time range |
| `last_cursor` | Resume point |
| `last_success_at` | Transport success |
| `last_observation_at` | Useful event success |
| `empty_page_count` | Empty-result diagnostics |
| `last_reason_code` | Machine-readable reason |

Provider health must be split into:

- transport health
- partition progress
- coverage freshness
- useful observation production

Collector strategy:

1. Realtime RPC collectors monitor head activity only.
2. Indexed providers perform 60-day historical wallet backfill.
3. Chain affinity is learned from successful activity and Fomo metadata; inactive chains receive reduced polling frequency.
4. BSC Blockscout 404 is treated as a provider-route incompatibility, not wallet inactivity.
5. A chain without a historical indexer remains realtime-only and reports that limitation explicitly.
6. No provider failure blocks collectors for other chains.

### 8.6 Immutable event and mutable enrichment split

The immutable source fingerprint must include only stable economic identity and action fields:

- source event ID or transaction identity
- chain
- wallet/entity identity
- token identity
- side
- occurred-at time
- deterministic source discriminator

Mutable values move to a revisioned enrichment record:

- USD amount derived from market price
- token price
- market capitalization
- liquidity
- optional source reference metadata
- collection time

Conflict behavior:

- Immutable disagreement creates a source conflict.
- Enrichment changes create or update an enrichment revision.
- Identical repeated conflicts update an in-memory or time-bucketed counter and flush at most once per configured interval.
- Conflict payload retention is bounded by age and occurrence policy.

### 8.7 SQLite write-safety contract

All production writers must use the shared transaction helper.

Required changes:

- Replace direct `BEGIN IMMEDIATE` paths with `withAddressRadarWriteTransaction`.
- Increase production busy timeout from one second to a configurable default of five seconds.
- Keep external network calls outside transactions.
- Bound write batches by row count and transaction duration.
- Add transaction labels and contention metrics.
- Add retry telemetry for attempt count, wait duration, success-after-retry, and terminal lock failure.
- Run WAL checkpoints from one designated maintenance path, not every service.
- Pause low-priority historical writes when disk or lock-pressure high-water marks are exceeded.

Acceptance is based on zero unrecovered lock failures, not zero internal retries.

### 8.8 Queue admission control and convergence

Add planner high-water marks by job type and lane.

Rules:

- Realtime work always has reserved capacity.
- Historical planners stop creating new jobs when their active backlog exceeds a configurable threshold.
- Recovery jobs linked to current blockers outrank speculative historical mining.
- Planner output is capped per interval.
- Existing idempotency keys are checked before backlog budget is consumed.
- Oldest-age promotion prevents starvation.
- Queue metrics expose ingress rate, completion rate, and net slope over 5 minutes, 30 minutes, and 24 hours.

The scheduler remains work-conserving: unused realtime capacity can process historical work.

### 8.9 Metric dictionary and console changes

Create one metric dictionary used by SQL queries, API responses, and Chinese UI labels.

Required top-level cards:

- historical token universe
- Fomo verified / pending / terminal
- milestone facts available / partial / missing
- early-trade facts available / partial / missing
- candidate evaluations produced / no-output / blocked
- admitted traders, using one current-snapshot definition
- wallet coverage by chain
- aggregation and shadow-signal freshness
- queue ingress, completion, and net slope
- SQLite contention and disk headroom

The console must show separate numbers for:

- targeted candidate backfill
- full historical partition backlog
- transport-healthy providers
- providers producing observations
- recovered domain rows
- normalized facts available

## 9. Migration and Reconciliation

All migrations are additive and restart-safe.

### 9.1 Database migration

- Add automation outcome storage.
- Add recovery-to-fact link storage.
- Add wallet-chain coverage state.
- Add enrichment revision storage if not already represented by market observations.
- Add indexes for due jobs, blocker links, fact revisions, wallet coverage, and recent outcomes.

### 9.2 Existing data reconciliation

1. Backfill `early_trades` and `trader_attribution` facts from milestones, canonical events, and candidate evidence.
2. Recompute fact revisions without deleting historical records.
3. Link unresolved blocked jobs to existing recovery jobs.
4. Wake blockers whose required facts are already available.
5. Move 1,030 pending manual identity jobs out of the Repair lane.
6. Classify existing candidate job completions as `unknown_legacy_outcome`; do not fabricate produced counts.
7. Build wallet-chain coverage rows from existing checkpoints, diagnostics, and observations.
8. Preserve source conflicts for audit while stopping repeated write amplification.

## 10. Failure and Degradation Policy

- A provider failure never stops unrelated chains or stages.
- Missing facts block only their dependent work.
- Provider empty results require an explicit coverage interpretation.
- Retry schedules use exponential backoff with jitter and provider reset times.
- Repeated empty or incompatible provider responses become terminal for that route, not for the token globally.
- A terminal provider route allows fallback routes to continue.
- Disk pressure pauses speculative backfill before realtime monitoring.
- SQLite lock retries are bounded and observable.
- Gateway delivery remains disabled throughout migration and shadow acceptance.

## 11. Observability and Operational Invariants

### 11.1 Required invariants

1. Every completed automation job has exactly one structured outcome.
2. `produced_count > 0` implies the referenced durable business record exists.
3. Every blocked-source job links to at least one unresolved fact or terminal reason.
4. A completed recovery job satisfies its declared fact postcondition.
5. An available fact wakes all linked blocked work exactly once per fact revision.
6. Manual identity rows are absent from executable backlog metrics.
7. Provider health cannot be `productive` without a useful observation watermark.
8. Immutable event conflicts never arise solely from price, USD valuation, collection time, or optional provenance changes.

### 11.2 Alerts

- backlog slope positive for 30 consecutive minutes
- no new useful output while jobs complete for 30 minutes
- candidate evidence freshness above two hours during active ingestion
- any unrecovered SQLite lock failure
- provider transport healthy but coverage watermark stale
- source conflict write rate above threshold
- disk use above 85% warning or 90% critical
- recovery completed without a fact revision

## 12. Acceptance Criteria

### 12.1 Correctness

1. 100% of newly completed candidate jobs have a structured outcome.
2. Candidate completion dashboards distinguish produced, no-output, blocked, retryable, and terminal outcomes.
3. Existing early-buyer data is reconciled so every recovered token has an explicit `early_trades` fact state.
4. Recovery completion updates the fact ledger and wakes linked candidate work in integration tests.
5. Manual identity jobs no longer appear in Repair-lane backlog.
6. Admitted-trader metrics use one definition and match across APIs.

### 12.2 Stability

1. Zero unrecovered `database is locked` failures during a two-hour production shadow window.
2. Conflict writes caused only by mutable enrichment decrease by at least 95%.
3. No core service restart outside controlled deployment during the shadow window.
4. Disk usage remains below 85% or low-priority planning is automatically paused.

### 12.3 Convergence

1. Under steady-state input, 30-minute completion rate is at least the enqueue rate.
2. Realtime job p95 age remains below two scanner intervals plus provider latency.
3. Historical work continues whenever reserved realtime and recovery capacity is unused.
4. Repair lane contains only executable job types with registered handlers.

### 12.4 Wallet monitoring

1. Every one of the 97 current EVM wallets has per-chain coverage state or an explicit unsupported/no-activity reason.
2. BSC provider incompatibility is surfaced separately from wallet inactivity.
3. A known EVM wallet fixture produces a persisted observation through each supported provider adapter.
4. Production providers expose separate transport, coverage, and production health.

### 12.5 Closed-loop shadow output

1. A recovered fact can cause candidate reevaluation without manual database intervention.
2. A qualifying trader event reaches aggregation and shadow decision through the standard projection path.
3. A non-qualifying event finishes with a durable no-output reason.
4. Gateway delivery remains `false`.

## 13. Implementation Phases

### Phase 0: Baseline and safety guards

- Freeze metric definitions for the acceptance window.
- Add production backup and rollback checkpoints.
- Add lock, queue-slope, conflict-rate, and disk guards.
- Keep Gateway delivery disabled.

### Phase 1: Outcome semantics and identity queue cleanup

- Add structured automation outcomes.
- Add candidate no-output reason classification.
- Migrate manual identity work out of Repair lane.
- Correct Repair backlog and drain-time metrics.

### Phase 2: Recovery-to-fact closure

- Introduce recovery postconditions and fact links.
- Reconcile existing early-trade and trader-attribution facts.
- Wake blockers by fact revision.
- Add recovery integration tests.

### Phase 3: SQLite and conflict integrity

- Move all writes to the shared retry contract.
- Bound transaction sizes.
- Separate immutable events from mutable enrichment.
- Rate-limit repeated conflict updates.

### Phase 4: EVM wallet coverage

- Add wallet-chain coverage state.
- Correct BSC route handling.
- Add chain-affinity scheduling and explicit unsupported states.
- Validate Ethereum, BSC, Base, and Robinhood independently.

### Phase 5: Queue convergence

- Add planner high-water marks and output caps.
- Add reserved realtime and recovery capacity.
- Add backlog-slope metrics and starvation tests.

### Phase 6: Console and production acceptance

- Publish the unified funnel and metric dictionary.
- Show output conversion and no-output reasons.
- Run a two-hour read-only shadow acceptance.
- Compare beginning and ending facts, evidence, admissions, aggregation, locks, conflicts, and backlog slope.

## 14. Expected Code Impact

Primary implementation areas:

- `packages/database/src/connection.ts`
- `packages/database/src/automation-job-store.ts`
- `packages/database/src/token-fact-store.ts`
- `packages/database/src/source-ledger-store.ts`
- `packages/database/src/schema.ts`
- `packages/domain/src/source-observation.ts`
- `apps/automation/src/scheduler.ts`
- `apps/automation/src/runtime.ts`
- `apps/automation/src/candidate-evidence-worker.ts`
- `apps/automation/src/candidate-source-recovery.ts`
- `apps/automation/src/token-fact-orchestrator.ts`
- `apps/scanner/src/recovery-runtime.ts`
- `apps/scanner/src/source-recovery-handlers.ts`
- `apps/wallet-monitor/src/runtime.ts`
- `apps/wallet-monitor/src/indexed-wallet-collector.ts`
- `apps/wallet-monitor/src/store.ts`
- `apps/console/src/application.ts`
- `apps/console/public/app.ts`

Tests must cover database migration, state transitions, job outcomes, fact reconciliation, queue admission control, SQLite contention, provider coverage, and full-pipeline replay.

## 15. Rollback

- All schema changes are additive.
- The previous release remains available for atomic symlink rollback.
- Reconciliation writes preserve source records and history.
- New outcome and coverage rows may remain after rollback because older services ignore them.
- Identity migration records the source job ID and can be audited without recreating executable backlog.
- No rollback step enables Gateway delivery.

## 16. Open Implementation Decisions

These decisions are intentionally deferred to the implementation plan, not left undefined:

1. Exact planner high-water marks will be derived from the first 30-minute baseline after outcome instrumentation is deployed.
2. EVM fallback provider order will use configured provider capabilities; unsupported routes must remain explicit.
3. Conflict aggregation interval defaults to five minutes and may be tuned from observed write pressure.
4. SQLite busy timeout defaults to five seconds and remains configurable.
5. Historical backfill remains lower priority than realtime monitoring and blocker recovery.

