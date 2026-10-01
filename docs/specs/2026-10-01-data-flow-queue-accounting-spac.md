# Data-flow queue accounting SPAC

## Verified issue

The SELECT-only data-flow diagnostic counts `retryable` and `waiting_source` as due automation work. Scheduler runnable queries use `pending` and `retry_scheduled`; source-waiting tasks are not runnable. This mismatch can conceal due retries and exaggerate executable work. It is a diagnostic issue, not evidence that source coverage is complete or that the scheduler itself is faulty.

## Scope

Correct the existing row-level `dueTasks` predicate and add explicit queue totals for runnable, scheduled, running, waiting-source and blocked-source tasks. Keep existing fields and units. Do not change scheduler state, task eligibility, quotas, scoring, schemas or production records. Preserve unavailable-table semantics and the endpoint's best-effort-read limitation.

## Rules

- Runnable: pending or retry-scheduled tasks whose next attempt is at or before the snapshot time.
- Scheduled: pending or retry-scheduled tasks with a future next attempt.
- Running: tasks already executing; never counted as runnable again.
- Waiting-source and blocked-source: separate pending prerequisites, not executable work.
- A zero runnable total is not a closed business loop; source blocks, recovery work and unresolved identities remain independent.

## Validation

Test due retries, future retries, waiting-source exclusion and queue total separation using an in-memory SQLite fixture. Run targeted and complete regression, typecheck, build, smoke, boundaries and browser tests, then commit and deploy. Read-only acceptance must compare diagnostic totals with direct SQL at a documented snapshot; distinguish sequential-read drift from semantic differences.

## Local validation

All three original regression assertions failed before the fix: due retries were hidden, waiting-source rows were counted as due, and separated queue totals were unavailable. After the fix, all 4 targeted assertions and all 820 unit tests across 204 files passed. Typecheck, build, package smoke, module boundaries and both desktop/mobile browser tests passed. Live diagnostic totals remain a separate production acceptance gate.
