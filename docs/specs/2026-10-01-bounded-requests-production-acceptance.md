# Bounded Requests Production Acceptance

## Release and checks

- Code commit: `5763098`.
- Production release: `/opt/address-radar/releases/5763098-bounded-requests`.
- Rollback release remains `/opt/address-radar/releases/f1037c6-consumer-ranges`.
- Targeted tests: 35 passed. Full unit suite: 782 tests across 194 files passed.
- Build, type checks, built-package imports, module boundaries and desktop/mobile browser tests passed.
- Two SSH connections closed transiently; bounded retries succeeded. The first failed deployment connection left the old release intact.

## Production observation

Read-only snapshot: 2026-10-01 17:52:38 Asia/Shanghai (09:52:38 UTC).

- Six services active, with zero restarts since rollout; every process has gateway delivery disabled.
- Candidate evidence: 1,439 facts. Continued production activity is observed, but not all of it is attributable to this increment.
- Source recovery jobs: 2,184 completed, 1,604 failed, 4,534 pending, 1 running and 554 terminal.
- Strict complete-range consumer demands: 33,808 pending. Positive-hit demands: 8,343 satisfied and 25,465 pending.
- Automation queue runnable 52, delta15m -177 and converging=true. This is not evidence that the separate source recovery queue or the whole lifecycle is converging.
- Signal readiness remains 8. No delivery was enabled.

## Bounded legacy manifest correction

Two previously oversized active request manifests were corrected through the tested `resolveConsumerMarketHistoryRequestRange` API. Only request metadata and audit records were written; business observations, consumer proofs, task status, leases, cursor, attempt count and retry schedule were not reset.

Read-only post-correction snapshot: 2026-10-01 17:54:59 Asia/Shanghai (09:54:59 UTC).

- `bound_request` audits: 2.
- `freeze_request` audits: 2; `expand_completed` audits: 27.
- Oversized active tracked manifests: 0.
- Maximum active tracked request interval: exactly 30 days.
- Both corrected source jobs remain pending with attempt_count=1 and unchanged next_attempt_at=1790842310787.
- Six services remain active with zero restarts and delivery=false.
- Last five minutes: zero matched SQLite lock, file-lock timeout, contention retry, missing-table or fatal-error messages.
- Disk available: 3,022,614,528 bytes, above the 3GB deployment guard but with only about 22.6MB headroom.

## Verdict and boundaries

This bounded-request engineering increment passes local and production acceptance. Task 4 and the full lifecycle plan remain open.

The zero-oversized result applies to tracked active consumer request manifests, not every legacy candidate fetch or every historical source interval. Hourly source-point coverage and completed request status do not certify complete post-entry extrema. Genuine provider coverage, shared budget correctness, authoritative frozen cohort denominators and multi-chain real end-to-end traces are still required.

Do not infer a completion ETA from uptime or one shrinking automation interval. Continue with source precision/continuity certificates, provider-budget coordination and missing-data acquisition. Storage headroom must be restored safely before another deployment; preserve business data and the current/rollback releases.
