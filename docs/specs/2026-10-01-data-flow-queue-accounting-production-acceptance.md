# Data-flow queue accounting production acceptance

## Deployment

Code commit: `6e72397`. Active release: `/opt/address-radar/releases/6e72397-queue-accounting`. Rollback release: `/opt/address-radar/releases/502409a-page-resume`.

Validation passed: 4 targeted tests, all 820 unit tests in 204 files, typecheck, build, package smoke, repository boundaries and 2 desktop/mobile browser tests.

## Live read-only checks

2026-10-01 20:48 Asia/Shanghai:

- All six services active; all NRestarts zero and actual process delivery flags false.
- No SQLite lock, missing-table, invalid budget or fatal log entries in the preceding five minutes.
- Data-flow queue endpoint: runnable 97, scheduled 13, running 0, waiting-source 0, blocked-source 2,045.
- Direct SQLite classification at the endpoint's snapshot time matched all five totals exactly. Source-blocked rows have dueTasks zero.
- The separate closed-loop read measured runnable 95 a few seconds earlier. It is not the same atomic snapshot as the data-flow read and must not be treated as a classification regression.
- Current opportunity-v4, 30-day latest-state population: 373 distinct evaluated traders (154 candidate, 148 discovered, 71 stable). These are ability states, not 373 resolved wallets or newly admitted traders.
- Legacy closed-loop ability completed count remains 11,349. It is not interchangeable with the versioned distinct-trader population; remaining metric version alignment is not claimed complete.
- Candidate evidence remains 1,439; candidate source-blocked tasks 2,032. Recovery closure: 2,218 satisfied, 3,128 pending, 532 terminal. Early-trade facts: 1,713. Ready signals: 8.
- Free disk: 3,051,192,320 bytes. Capacity headroom remains narrow after the previously approved archived-log cleanup.

## Conclusion and remaining gates

The diagnostic eligibility correction and separated queue totals passed local and live read-only acceptance without changing scheduling or business data. A zero current runnable bucket would still not prove complete recovery. Historical price/milestone/early-buyer closure, unresolved wallet identity handoff, versioned metric alignment, source coverage and sustained signal production remain open in the full lifecycle plan.
