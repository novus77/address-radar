# Scanner Idempotency and Automation Resilience Design

**Status:** Approved for implementation planning  
**Date:** 2026-09-27  
**Scope:** Address Radar scanner, source ledger, durable automation, production logging, disk protection, and operational rollout  
**User delivery:** Must remain disabled throughout implementation and shadow acceptance

## 1. Context

The production system exposed two coupled failure modes after durable automation was enabled.

The scanner repeatedly rereads source events whose stable event identity is unchanged while collection metadata changes. `SourceObservation.observationId` is derived from `source`, `sourceEventId`, and `payloadVersion`, but the stored content fingerprint also includes `collectedAt` and the complete payload. Recollecting the same event can therefore produce the same observation ID with a different fingerprint. The source ledger throws, the scanner logs a complete stack trace for every event, and the collector retries without backoff.

Observed production impact:

- Approximately 59,873 scanner log lines and 8.8 MB were produced in 30 seconds.
- `syslog` and journald duplicated the write load and consumed roughly 1-2 GB per hour.
- Root filesystem usage reached 86% and continued increasing.
- Scanner processing spent substantial CPU and I/O on deterministic conflicts instead of new observations.

The automation service remained alive, but prerequisite-missing jobs created a retry storm. Candidate evidence jobs with no token price history or milestone data entered `waiting_source`, retried after 60 seconds, and retained priority `20`. The scheduler processes one job at a time and orders lower numeric priorities first. More waiting jobs became due per minute than the worker could consume, starving all higher numeric priority work.

Observed queue impact:

| Job group | State | Count | Priority |
| --- | --- | ---: | ---: |
| Candidate evidence | Waiting for source | 205 | 20 |
| Candidate evidence | Pending | 22,894 | 82/88 |
| Trader lightweight evaluation | Pending | 10,869 | 30/40 |
| Ability evaluation | Pending | 6,138 | 72/76 |
| Initial wallet backfill | Completed | 181 | 10 |

Missing prerequisite reasons were dominated by unavailable price history and token milestones. This is a data readiness condition, not an executable job failure.

## 2. Goals

- Make repeated collection of the same semantic event idempotent.
- Preserve genuine source revisions or conflicts for audit without crashing the scanner.
- Prevent a single repeated error from producing unbounded logs.
- Prevent source-unavailable jobs from consuming the runnable queue continuously.
- Guarantee bounded progress for every enabled automation job type.
- Apply backpressure before planners create unbounded pending queues.
- Wake blocked work when its missing prerequisite arrives.
- Protect the server from log, database, WAL, import, or backup disk exhaustion.
- Preserve current data, attempt history, and auditability during migration.
- Keep Gateway delivery disabled until a separate user-approved release gate.

## 3. Non-goals

- Replacing SQLite with a distributed database.
- Introducing Kafka, Redis, or an external message broker.
- Increasing worker concurrency before single-worker fairness is proven stable.
- Relaxing candidate evidence requirements merely to increase completion counts.
- Deleting unresolved jobs or historical observations during migration.
- Enabling user signal delivery as part of this work.

## 4. Design Principles and Invariants

1. Event identity and collection metadata are separate concepts.
2. Expected duplicate input is not an exception.
3. A source outage degrades one factor or queue item; it never blocks unrelated work.
4. Missing prerequisites are parked and event-woken, not polled every minute forever.
5. Priority orders jobs within a job type; fairness allocates capacity across job types.
6. Planners must obey queue high-water marks and resume from durable cursors.
7. No expected input condition may generate an unbounded stack-trace loop.
8. Disk pressure pauses ingestion before the operating system reaches critical capacity.
9. Every migration is additive or reversible and starts with a verified backup.
10. `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` remains an enforced rollout invariant.

## 5. Considered Approaches

### 5.1 Logging-only patch

This approach rate-limits the scanner error and extends `waiting_source` delay without changing data semantics or scheduling.

Advantages:

- Smallest code change.
- Fastest short-term deployment.

Disadvantages:

- Invalid observation semantics remain.
- Queue starvation can recur with a different missing source.
- Planners can continue producing unbounded work.
- Genuine conflicts remain indistinguishable from collection-time changes.

Decision: rejected as an emergency-only mitigation.

### 5.2 Semantic idempotency, event-woken prerequisites, and fair scheduling

This approach separates semantic event content from collection metadata, records genuine conflicts, parks source-blocked work, wakes it on prerequisite arrival, and schedules job types with reserved capacity.

Advantages:

- Fixes the root causes rather than symptoms.
- Preserves evidence and operational auditability.
- Fits the existing SQLite and systemd architecture.
- Can be deployed in reversible stages.

Disadvantages:

- Requires a schema migration and coordinated changes across several packages.
- Requires explicit migration of current pending and waiting jobs.

Decision: selected.

### 5.3 External broker and independently scaled workers

This approach moves automation to an external queue and splits scanner, enrichment, candidate evidence, and ability evaluation into separately scaled services.

Advantages:

- Strong workload isolation and horizontal scalability.
- Native dead-letter and delayed delivery capabilities.

Disadvantages:

- Excessive operational complexity for the current user volume.
- Adds infrastructure before current semantics are correct.
- Increases migration and recovery risk.

Decision: deferred. The selected design keeps interfaces compatible with a future broker.

## 6. Emergency Production Containment

Emergency containment precedes code rollout because the current scanner can exhaust the server disk.

Required sequence:

1. Save a bounded tail of scanner, syslog, and journald evidence outside the files being cleaned.
2. Stop only `address-radar-scanner.service`.
3. Confirm automation, wallet monitor, wallet analysis, historical backfill, and console remain active.
4. Rotate or truncate the runaway `syslog` only after the evidence tail is preserved.
5. Vacuum journald to a bounded retained size.
6. Confirm at least 20% root filesystem headroom before deployment work.
7. Keep the scanner stopped until the idempotency and log-rate fixes pass server-side smoke tests.

Containment does not delete the production database, import files, or completed backups. The scanner outage is recorded as an intentional ingestion pause. The system must resume from durable source cursors after deployment.

## 7. Source Observation Idempotency

### 7.1 Semantic fingerprint

The observation ID remains based on:

```text
source + sourceEventId + payloadVersion
```

The semantic fingerprint excludes collection-only metadata:

- Top-level `collectedAt`.
- `payload.collectedAt` for `TraderEvent` payloads.

The semantic fingerprint retains:

- Source and source event identity.
- Chain.
- Event occurrence time.
- Payload version.
- Account, wallet, token, side, amount, transaction identity, and other business fields.
- Extraction mode, confidence, and provenance fields that change evidence interpretation.

This rule is explicit and field-aware. It must not recursively remove arbitrary fields named `collectedAt` from unknown payloads.

### 7.2 Save result contract

`SourceLedgerStore.saveObservation` returns a discriminated result instead of throwing for expected input states:

```ts
type SaveObservationResult =
  | { readonly status: "inserted" }
  | { readonly status: "duplicate" }
  | { readonly status: "conflict"; readonly conflictId: string };
```

Behavior:

| Condition | Result | Scanner behavior |
| --- | --- | --- |
| No existing observation ID | `inserted` | Continue normal processing |
| Existing ID and same semantic fingerprint | `duplicate` | Skip repeated event processing |
| Existing ID and different semantic fingerprint | `conflict` | Quarantine incoming revision and skip signal processing |
| Database or programming failure | Throw | Apply collector backoff and bounded logging |

### 7.3 Conflict ledger

Add `source_observation_conflicts` with the following fields:

| Field | Purpose |
| --- | --- |
| `conflict_id` | Stable ID derived from observation ID and incoming semantic fingerprint |
| `observation_id` | Existing source observation identity |
| `existing_fingerprint` | Fingerprint already accepted by the ledger |
| `incoming_fingerprint` | Fingerprint of the conflicting revision |
| `incoming_payload` | Canonical incoming observation payload |
| `first_seen_at` | First conflict timestamp |
| `last_seen_at` | Most recent repeated conflict timestamp |
| `occurrence_count` | Aggregated repeat count |
| `resolution_status` | `open`, `accepted_revision`, or `dismissed` |

The unique key is `(observation_id, incoming_fingerprint)`. Repeated copies update `last_seen_at` and `occurrence_count` rather than inserting unlimited rows.

Conflicting revisions never become candidate evidence automatically. They remain inspectable and can be resolved through a later operator workflow.

## 8. Scanner Error Isolation and Logging

### 8.1 Collector backoff

Unexpected collector failures use per-collector exponential backoff with jitter:

```text
1 second -> 5 seconds -> 30 seconds -> 2 minutes -> 10 minutes maximum
```

A successful batch resets the failure counter. One degraded collector does not pause other collectors.

### 8.2 Aggregated diagnostics

Expected duplicate observations produce no warning log.

Observation conflicts are aggregated by collector and error code. At most one summary per minute is emitted:

```json
{
  "event": "source_observation_conflicts",
  "collector": "fomo_history",
  "count": 1420,
  "sampleObservationIds": ["..."],
  "windowMs": 60000
}
```

Repeated errors omit stack traces. The first occurrence of a new unexpected error includes a stack trace; subsequent occurrences within the aggregation window include counters only.

### 8.3 Service-level rate protection

The scanner systemd unit applies a secondary safety limit:

```text
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200
```

Application correctness must not depend on systemd dropping logs. This limit protects the host from a future unknown loop.

## 9. Disk Pressure Guard

Add a read-only disk pressure sampler to the scanner runtime. It samples the root filesystem once per minute.

| Root usage | State | Behavior |
| --- | --- | --- |
| Below 80% | Healthy | Normal collection |
| 80%-87% | Warning | Continue collection and emit one warning per 10 minutes |
| 88%-91% | Ingestion paused | Pause scanner collectors; keep process and health endpoint alive |
| 92% or above | Critical | Keep ingestion paused and emit an operator-required alert |
| Back below 80% | Recovered | Resume collectors from durable cursors |

The guard never deletes files automatically. Cleanup remains an explicit operational action.

Production logging policy must also enforce:

- Journald retained usage no greater than 1 GB for this host profile.
- Rotated syslog retention bounded by size and age.
- Daily reporting of database, WAL, logs, imports, releases, and backups by directory.
- Backup retention based on both age and a minimum free-space floor.

## 10. Candidate Evidence Readiness

### 10.1 Prerequisite gate

Candidate evidence is runnable only when required inputs exist:

- Token milestone is available.
- Price or market-cap history covers the evidence evaluation interval.
- The token identity is canonical and belongs to a supported chain.

The candidate planner checks readiness before creating a runnable candidate job.

Missing data produces or updates the appropriate recovery work:

| Missing input | Recovery work |
| --- | --- |
| Token price or market-cap history | `market_enrichment` |
| Milestone and threshold crossing | `milestone_early_buyers` or historical milestone recovery |
| Canonical token identity | Identity recovery or quarantine |

The planner stores a blocked readiness record but does not flood the runnable queue.

### 10.2 Blocked-source state

Add `blocked_source` as a durable automation status. It is distinct from failure and retryable execution errors.

Blocked jobs retain:

- Original job ID and idempotency key.
- Missing prerequisite codes.
- First blocked timestamp.
- Last readiness check timestamp.
- Attempt count.
- Safety-poll timestamp.

Safety polling uses:

```text
5 minutes -> 30 minutes -> 2 hours maximum
```

After reaching the maximum, the job remains blocked and receives a two-hour safety check. It is never promoted to a hot retry loop.

### 10.3 Event-driven wakeup

Price history, milestone, and identity writes publish an in-database readiness notification in the same transaction as the source update. The automation service consumes these notifications and immediately rechecks affected blocked jobs.

The event path is the primary wakeup mechanism. Scheduled safety polling exists only to recover from missed notifications or deployment interruptions.

## 11. Fair Scheduling

### 11.1 Two-level selection

Scheduling uses two levels:

1. Select an automation lane using the existing lane credit model.
2. Select a job type within that lane using weighted deficit round-robin.

Priority applies only after a job type receives a scheduling slot. This prevents thousands of low-numbered retries from starving unrelated types.

### 11.2 Default capacity weights

| Job type | Weight |
| --- | ---: |
| Trader lightweight evaluation | 35 |
| Candidate evidence | 25 |
| Ability evaluation | 20 |
| Initial wallet backfill | 10 |
| Historical token partition | 10 |

Unused capacity is redistributed among runnable job types. Every enabled type with due work receives at least one slot in each 20-slot scheduling window.

The first release keeps one executing worker. Concurrency is not increased until the fairness release completes a 4-hour SQLite contention soak test.

### 11.3 Aging

Within each job type, effective priority improves as queue age increases. Aging is bounded and cannot let a source-blocked job bypass its readiness gate.

## 12. Planner Backpressure

Every planner has a configurable pending high-water mark and a durable planning cursor.

Default high-water marks:

| Job type | Maximum pending runnable jobs |
| --- | ---: |
| Trader lightweight evaluation | 2,000 |
| Initial wallet backfill | 500 |
| Historical token partition | 100 |
| Candidate evidence | 2,000 |
| Ability evaluation | 1,000 |

When a queue reaches its high-water mark, planning stops for that type without losing cursor position. Planning resumes when the queue drops below 70% of the limit.

Dispatcher jobs are singleton and idempotent. A dispatcher cannot enqueue another dispatcher while one is pending, leased, or blocked.

## 13. Existing Queue Migration

Migration preserves all current records.

Required migration behavior:

1. Add conflict-ledger and readiness-notification tables.
2. Add support for `blocked_source` without rewriting completed records.
3. Re-evaluate existing `waiting_source` candidate jobs against current prerequisites.
4. Move missing-prerequisite jobs to `blocked_source` and preserve their errors and attempts.
5. Keep ready candidate jobs pending with normalized priority.
6. Re-evaluate the existing candidate backlog in bounded batches.
7. Do not enqueue more runnable candidates above the new high-water mark.
8. Preserve all ability evaluation jobs and allow fair scheduling to drain them.
9. Record migration counts and decisions in `migration_audit`.

No queue rows are deleted. Jobs proven to reference unsupported or invalid token identities are terminated with an explicit auditable reason.

## 14. Observability

The runtime quality snapshot and developer console expose:

- Queue depth by job type and status.
- Oldest runnable job age.
- Completed jobs per 10 minutes.
- Blocked jobs by missing prerequisite.
- Retry and wakeup counts.
- Per-job-type scheduling share.
- Source observation duplicate and conflict rates.
- Aggregated scanner error rate.
- Log bytes per minute.
- Database and WAL size.
- Filesystem usage and estimated time to full.
- Scanner disk-pressure state.

Chinese operator descriptions must explain the business meaning of each state. Raw database identifiers remain available only as secondary diagnostic detail.

Alert thresholds:

| Condition | Severity |
| --- | --- |
| Filesystem at or above 80% | Warning |
| Filesystem at or above 88% | Critical ingestion pause |
| Logs grow more than 100 MB in 10 minutes | Critical |
| Due jobs exist but a job type has no progress for 10 minutes | Warning |
| Blocked-source executions exceed 10% of worker slots | Warning |
| SQLite busy or locked error occurs | Critical |
| Gateway delivery becomes enabled during shadow rollout | Critical |

## 15. Failure Handling

| Failure | Required behavior |
| --- | --- |
| Semantic duplicate | Skip silently |
| Genuine observation conflict | Aggregate in conflict ledger, quarantine, continue |
| Source unavailable | Block affected job and continue unrelated work |
| Provider rate limit | Honor reset time and provider-specific circuit breaker |
| Unexpected collector error | Back off only that collector |
| SQLite busy | Retry with bounded jitter and surface critical health state |
| Disk warning | Alert and continue |
| Disk critical | Pause scanner ingestion |
| Missed readiness notification | Recover through bounded safety poll |
| Process restart | Resume from durable cursor, lease, and blocked state |

## 16. Delivery Phases

### Phase 0: Emergency containment

- Preserve diagnostic tails.
- Stop scanner only.
- Reclaim log space and enforce bounded retention.
- Confirm at least 20% filesystem headroom.
- Keep Gateway delivery disabled.

### Phase 1: Idempotency and logging

- Add semantic fingerprinting.
- Add conflict ledger.
- Change expected duplicates and conflicts to non-throwing results.
- Add scanner backoff and aggregated logging.
- Add systemd log-rate safety limits.
- Deploy with scanner inputs in shadow/replay mode before live resume.

### Phase 2: Readiness and source blocking

- Add prerequisite checks.
- Add `blocked_source` and readiness notifications.
- Add event-driven wakeup and bounded safety polling.
- Migrate current waiting jobs.

### Phase 3: Fair scheduling and backpressure

- Add weighted deficit round-robin by job type.
- Add queue aging.
- Add planner cursors and high-water marks.
- Reclassify the existing candidate backlog in bounded batches.

### Phase 4: Production shadow acceptance

- Run all automation types with Gateway delivery disabled.
- Verify four-hour service stability.
- Verify five-chain task coverage.
- Confirm every runnable job type makes progress.
- Confirm blocked jobs do not consume hot worker capacity.
- Confirm disk growth and logs remain bounded.

### Phase 5: Operational handoff

- Update runbooks and developer console diagnostics.
- Preserve the previous release and database backup as rollback points.
- Produce an acceptance report.
- Leave user delivery disabled pending a separate approval.

## 17. Testing Strategy

### Unit tests

- Same event with different collection timestamps returns `duplicate`.
- Same event with a changed business field returns `conflict`.
- Repeated conflict updates one conflict row and increments its counter.
- Expected duplicates and conflicts do not throw.
- Backoff follows the configured sequence and resets after success.
- Blocked-source delay follows 5-minute, 30-minute, and 2-hour stages.
- Readiness arrival wakes only affected jobs.
- Weighted scheduling gives every runnable type its minimum share.
- High-water marks stop planning and preserve planner cursors.

### Integration tests

- Replay 100,000 copies of one semantic event with changing collection time.
- Verify one source observation, no conflict rows, and bounded logs.
- Replay a genuine revised event and verify one aggregated conflict record.
- Seed source-missing candidate jobs and verify unrelated ability work progresses.
- Publish price and milestone data and verify immediate candidate wakeup.
- Restart during planning and verify cursor and idempotency recovery.
- Run all job types against one SQLite database and verify no lock errors.

### Production smoke and soak tests

- Validate a fresh backup with `PRAGMA quick_check` before release switch.
- Run server-side package smoke tests in an immutable release directory.
- Resume scanner with delivery disabled.
- Observe a 30-minute smoke window before queue migration.
- Observe a 4-hour soak window after all automation types are enabled.

## 18. Acceptance Criteria

- Recollecting an unchanged semantic event never creates a conflict.
- A genuine revision is preserved once and never creates an unbounded row or log loop.
- Scanner logs remain below 20 MB per hour during normal operation.
- Root filesystem usage remains below 80% after cleanup and does not grow more than 100 MB per hour from logs.
- Scanner pauses ingestion automatically at 88% disk usage and resumes only below 80%.
- No `waiting_source` or `blocked_source` retry class consumes more than 10% of worker slots.
- Every enabled runnable job type completes work within each 10-minute window.
- Candidate evidence jobs are not runnable until required price and milestone data exists.
- Ability evaluation progresses even while candidate evidence has a large backlog.
- Planner pending queues remain below configured high-water marks.
- No SQLite lock errors occur during the 4-hour soak.
- Scanner, automation, wallet monitor, wallet analysis, historical backfill, and console remain active with `NRestarts=0` after final rollout.
- Solana, Ethereum, BSC, Base, and Robinhood remain represented in historical partitions.
- `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` and no user signal is delivered.

## 19. Rollback

Rollback is release-based and does not reverse Git or delete migrated data.

1. Stop scanner and automation.
2. Point `/opt/address-radar/current` to the previous immutable release.
3. Keep Gateway delivery disabled.
4. Restore the pre-migration database backup only if the previous release cannot tolerate additive schema objects.
5. Restart wallet monitor, wallet analysis, historical backfill, automation, console, and scanner in that order.
6. Verify service health, database integrity, disk headroom, and source cursors.

Additive tables and statuses remain ignored by older code where possible. The implementation plan must explicitly test old-release compatibility before production migration.

## 20. Expected Implementation Boundaries

Primary code areas:

- `packages/domain/src/source-observation.ts`
- `packages/domain/src/automation-job.ts`
- `packages/collectors/src/source-observation-ingestor.ts`
- `packages/database/src/source-ledger-store.ts`
- `packages/database/src/automation-job-store.ts`
- `apps/scanner/src/runtime.ts`
- `apps/scanner/src/config.ts`
- `apps/automation/src/scheduler.ts`
- Candidate evidence planner and worker modules under `apps/automation/src`
- Market and milestone persistence adapters that emit readiness notifications
- Runtime quality snapshot and console diagnostics
- `deployment/systemd/address-radar-scanner.service`
- Production backup, deployment, and incident runbooks

The implementation plan must preserve focused file responsibilities. Semantic fingerprinting, conflict persistence, disk pressure, readiness notification, and fair scheduling should remain independently testable units rather than accumulating in scanner or scheduler runtime files.

