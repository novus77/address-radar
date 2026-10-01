# Consumer Range and Contention Production Acceptance

## Changes deployed

- `4b9b482-fomo-lock`: request coordination timeout isolation, stage fairness, partial-cycle backoff and chunked producer deduplication.
- `f1037c6-consumer-ranges`: bounded completed-job rescheduling, exact range-unavailable terminal recovery, transactional audit and request manifests.

## Executed local checks

- Contention targeted tests: 32 passed.
- Range/dispatch/wakeup targeted tests: 18 passed.
- Latest complete suite: 777 tests across 193 files passed.
- Build, type checks, built package import smoke and module boundaries passed.
- Desktop and mobile console tests: 2 passed.
- Explicit additive migration completed. Existing business price, trade, identity and evidence rows were not bulk rewritten or deleted.

## Read-only production snapshot

Snapshot at `2026-10-01T08:13:47.960Z` (16:13:47 Asia/Shanghai):

- Current release `/opt/address-radar/releases/f1037c6-consumer-ranges`.
- All six services active, `NRestarts=0` since this rollout.
- Every service process retained delivery disabled.
- Request manifests: 21, all associated with an actual requested envelope.
- Rescheduling audits: 21 `expand_completed` actions. All audited jobs were pending at the snapshot.
- Existing audited price fact links: 20, all pending. One legacy job had no existing price link at this snapshot; the recovery runtime ensures its link when claiming work.
- Invalid audited temporal intervals: zero.
- Consumer wakeup receipts: 225; dispatched fingerprints: 16.
- No `recover_missing_range` production audit was observed in this short snapshot. The exact terminal recovery path is tested and deployed but not yet certified on a production example.
- Early trade coverage count: 1,675. Candidate evidence facts: 1,419. Admitted traders: 393. Signal-ready facts: 8.
- Automation runnable: 108; 15-minute runnable delta +64; queue not converging.
- Available disk: 3,082,801,152 bytes. Deployment guard passed but headroom is limited.
- Sampled preceding five-minute historical-backfill/automation logs: no typed file lock timeout, contention warning, missing table error or fatal exit.

## Interpretation

Actual production scheduling, durable auditing and consumer wakeups are observed. This is not proof that new source requests have completed, that all terminal tasks recovered, that the queue is converging, or that new wallet identities/signals were produced.

The request producer still scans the journal for a new ID; bounded memory is not an indexed handoff. Sustained contention acceptance remains necessary beyond this short observation.

## Remaining Task 4/source dependencies

- Strict complete-range proofs require source-specific acquisition time, interval precision, extrema provenance and continuous coverage certificates. Existing hourly point coverage is only a recovery request test.
- Partial positive-hit evidence remains distinct from verified full-range non-hit evidence.
- Disjoint consumer intervals still use a shared envelope; independent bounded intervals remain open.
- Source capability/shared-budget validation and actual historical fact production remain required before full lifecycle acceptance.
- Continue storage growth mitigation without deleting active business history.

Task 4 and the full lifecycle plan remain open. No core business rule was relaxed.
