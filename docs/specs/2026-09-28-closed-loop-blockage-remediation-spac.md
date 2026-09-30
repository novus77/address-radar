# Address Radar Closed-Loop Blockage Remediation SPAC

## 1. Context

Production acceptance on 2026-09-28 confirmed that ingestion, historical recovery, event projection, and candidate evidence generation were running, but the business loop did not advance reliably from evidence to monitored traders and fresh token signals.

The observed production facts were:

- `234` candidate evidence rows across `223` traders and `64` tokens.
- `116` traders should currently satisfy admission policy, while `13` remained unadmitted.
- `12` affected traders had admission snapshots older than their latest evidence.
- `113` traders were marked admitted, but `83` remained `suspended` with `lightweight` monitoring.
- Only `29` admitted traders had a wallet identity.
- Projection replay had `448` pending events in the last 24 hours. A valid `$300` Solana buy had `446` older events ahead of it.
- `941/1008` token evaluations were blocked by `fresh_evidence`.

## 2. Root Causes

### 2.1 Admission used source time as decision time

Candidate evidence jobs used the triggering event or milestone timestamp as `evaluatedAt`. When persisted evidence had a later `evidenceAt`, the admission policy excluded that evidence with the `evidenceAt <= evaluatedAt` guard. The resulting snapshot incorrectly reported `candidate_evidence_missing`.

### 2.2 Candidate evidence v3 omitted admission side effects

The legacy discovery path activated admitted candidates and queued identity resolution. The v3 evidence worker only persisted an admission snapshot and enqueued ability evaluation. Admitted traders therefore remained suspended, unresolved, and outside realtime monitoring.

### 2.3 Historical replay starved realtime events

Projection replay selected missing events in ascending event-time order. Historical recovery continuously inserted older events, while each replayed event performed market enrichment. Recent trades remained behind the historical backlog and could not reach aggregation within a useful latency budget.

## 3. Goals

1. Admission decisions use processing time while retaining source time on evidence.
2. Every evidence trader is re-evaluated at least once per UTC day.
3. Current admission projects the trader into the correct lifecycle and monitoring state.
4. Admitted traders without wallet identities enter the manual identity-resolution queue.
5. Realtime projection receives reserved capacity and is processed before historical replay.
6. Historical replay continues making progress and cannot be permanently starved.
7. All changes remain idempotent across retries and restarts.
8. Gateway delivery remains disabled and outside this change.

## 4. Non-Goals

- Changing candidate evidence tiers or the `$50` evidence threshold.
- Lowering token signal thresholds.
- Enabling customer delivery.
- Replacing price-history or milestone providers.
- Automatically approving identity conflicts.

## 5. Design

### 5.1 Daily admission reconciliation

The candidate evidence dispatcher adds a daily, trader-ordered reconciliation cursor. Each dispatcher pass re-evaluates up to `100` evidence traders before applying token-job backpressure.

Admission decision time is the worker clock, not the historical source timestamp. Snapshot identity includes the UTC decision day and evidence fingerprint, providing daily refresh while keeping same-day retries idempotent.

```text
candidate_evidence_v3
  -> evaluate at processing time
  -> candidate_admission_snapshots
  -> admission projection
  -> ability_evaluation
```

### 5.2 Admission projection

For a currently admitted trader:

- Existing wallet identity: transition `suspended|candidate -> probation` and select `realtime` monitoring unless explicitly `off`.
- No wallet identity: transition `suspended -> candidate`, retain `lightweight` monitoring, and enqueue each linked Fomo account for identity resolution.
- Ability evaluation is enqueued with a snapshot-derived idempotency key.

An explicit `off` monitoring policy is never overridden.

### 5.3 Realtime and historical projection lanes

Projection replay reserves a configurable portion of every batch for events inside a realtime window. Realtime events are selected newest-first and placed before historical events. Remaining capacity is filled by oldest-first historical replay.

Defaults:

```text
realtime window: 1 hour
realtime batch capacity: 25
total replay batch capacity: 100
```

The collector deduplicates events returned by both queries. This preserves historical convergence while bounding realtime queue latency.

## 6. Failure Handling

- Admission reconciliation is restart-safe through the durable dispatcher cursor.
- Daily reconciliation restarts from the first trader on a new UTC day.
- Identity queue writes merge reasons and priorities rather than duplicating rows.
- Existing `off` monitoring policy is preserved.
- Realtime and historical replay share existing projection leases and idempotency keys.
- A failed market lookup remains retryable through the existing event projection state.

## 7. Observability

Production acceptance must track:

- Evidence traders whose latest snapshot predates latest evidence.
- Policy-eligible traders whose latest snapshot is not admitted.
- Admitted traders grouped by lifecycle and monitoring policy.
- Projection backlog split into `0-1h`, `1-6h`, `6-12h`, and `12-24h`.
- Maximum realtime event projection delay.
- Address signal evidence freshness.
- Signal evaluation missing-condition distribution.

## 8. Acceptance Criteria

1. The `13` known admission mismatches converge to `0` after reconciliation.
2. Strong evidence written after a historical triggering event produces `current_admitted` at processing time.
3. An admitted unresolved Fomo trader becomes `candidate + lightweight` and appears in identity resolution.
4. An admitted wallet-resolved trader becomes `probation + realtime`.
5. A realtime event is returned ahead of historical backlog in collector tests.
6. Historical events still occupy unused replay capacity.
7. A qualifying realtime event receives an event projection within two scanner intervals under normal provider latency.
8. Gateway delivery remains `false`.

## 9. Implementation Phases

### Phase 1: Admission correctness

- Add regression tests for historical source time versus processing time.
- Extract idempotent admission projection behavior.
- Add daily admission reconciliation to the durable dispatcher cursor.

### Phase 2: Realtime projection fairness

- Add ordered projection query support.
- Add realtime-window and realtime-capacity configuration.
- Merge realtime-first and historical-oldest replay batches.

### Phase 3: Verification and deployment readiness

- Run targeted automation and scanner tests.
- Run typecheck and the complete test suite.
- Deploy without enabling Gateway.
- Perform read-only production acceptance against the metrics in section 8.

## 10. Rollback

The change introduces no destructive migration. Rollback consists of deploying the previous release. New admission snapshots and identity queue reasons are additive and remain compatible with the previous schema.
