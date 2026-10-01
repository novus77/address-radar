# Versioned Ability Dispatch: Production Acceptance

## Scope and release

Release: `9da2921-versioned-ability-dispatch`.
The complete data lifecycle plan remains open. This acceptance covers bounded restart
of the historical ability scan after a strategy version change, not complete market
coverage, candidate discovery, identity resolution, or signal production.

## Authorized storage maintenance

The operator approved removal of inactive old release code/build artifacts while
retaining the current release and the three latest rollback releases, all business
databases, event files, and backups. Thirty-one inactive SHA-named releases were
archived before removal. Timestamp-named and special console releases were retained.

Retained rollback set at cleanup time: `617f7a1-current-ability`,
`fbc88eb-milestone-handoff`, `6e72397-queue-accounting`, `502409a-page-resume`.
Audit/code archive: `/var/log/address-radar/maintenance-20261001T142219Z-retired-code`.
Free disk space after cleanup: 4,643,119,104 bytes. Dependencies are omitted from the
retired-code archive; the retained rollback releases keep their dependency trees.

## Validation before deployment

Seventeen targeted tests, 839 unit tests across 206 files, type checking, build,
package smoke tests, boundary checks, and two desktop/mobile browser tests passed.
The existing guarded deployment performed additive schema checks and switched all
six services to the new release. Delivery remained disabled.

## Read-only observations

| Metric | 2026-10-01 14:26:28 UTC | 2026-10-01 14:29:21 UTC |
| --- | ---: | ---: |
| Distinct traders with current 30-day v4 evaluations | 605 | 627 |
| Current-strategy completed worker jobs | 3,124 | 3,158 |
| Current-strategy pending worker jobs | 52 | 974 |
| Candidate evidence facts | 1,439 | 1,439 |
| Available disk bytes | 4,625,399,808 | 4,620,144,640 |

The dispatcher moved from a reset cursor to an advancing cursor containing
`strategyVersion: trader-ability-v4-opportunity`. It did not wait for the old
unversioned end-of-day cursor. Worker queue growth is expected during bounded
refill, not evidence of completion or convergence. No duplicate active
`job_type/subject_key` groups were found in the second snapshot.

All six services were active with `NRestarts=0` and actual process environments
reported `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`. The inspected five-minute
logs contained no SQLite busy/locked, file lock timeout, contention, or fatal messages.
These observations do not prove that such errors can never recur.

The data-flow API and a separate SQL sample differed by one runnable task while
workers were active. The samples were not a single transaction; this is not sufficient
evidence of a queue-accounting regression. Current ability counts matched independent
SQL in the first snapshot.

## Result and remaining gates

Historical dispatch restart and initial forward progress passed: 22 additional
traders received current-version evaluations between the observations. The current
strategy population remains far below the 11,351 eligible-trader cohort. Reliable
remaining-time estimates require sustained throughput, not this short window.

Candidate evidence did not increase during this interval. Market coverage, early
trade recovery, audited execution revisions, consumer recomputation, identity-to-wallet
handoff, and genuine new signal production remain separate acceptance gates. Gateway
delivery must remain disabled throughout subsequent development and acceptance.
