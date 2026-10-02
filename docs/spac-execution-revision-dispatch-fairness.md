# SPAC: Execution Revision Dispatch Fairness

## Verified Incident

Read-only production inspection on 2026-10-02 found 910 revision requests per consumer. Candidate evidence had 875 undispatched requests and 35 dispatched requests awaiting acknowledgement. All 910 applied execution heads had canonical observations, matching identity/side/amount/time, and positive buy execution prices.

The oldest 100 undispatched requests contained only ability evaluation (36), signal projection (32), and token aggregation (32). Requests that could not immediately dispatch stayed at the front of every oldest-first batch, preventing later candidate requests from being examined. Missing execution prices were not the cause of this dispatch blockage. Separate candidate history prerequisites can still be unavailable.

## Design

- Rank pending requests independently within each consumer type.
- Interleave consumer positions before applying the existing global batch limit.
- Exclude ability subjects with active pending, leased, running, waiting-source, blocked-source, or retryable jobs from selection. Do not duplicate their work or falsely mark them dispatched.
- Keep queue capacity checks, per-subject grouping, revision comparison, and acknowledgement rules unchanged.
- Never acknowledge merely because a request was selected or dispatched.
- Preserve original requested timestamps; no production data repair or schema migration is required.

## Scope

Changed modules:

- apps/automation/src/execution-revision-consumers.ts
- apps/automation/test/execution-revision-consumers.test.ts

This phase fixes cross-consumer dispatch starvation and same-consumer active-subject starvation. It does not implement missing aggregation or signal consumer acknowledgement, prove complete historical price coverage, or resolve wallet identities.

## Acceptance

- Targeted candidate and revision consumer regression: 17 tests passed.
- Complete suite: 872 tests across 210 files passed.
- Type checks, build, package import checks, and repository boundary checks passed.
- Desktop and mobile browser regression: 2 tests passed.
- Regression cases verify candidate dispatch behind 100 older blocked signal requests, skipping active ability subjects, dispatch idempotency, and absence of false acknowledgements.

Production acceptance after deployment must compare candidate undispatched counts, real consumer receipts, blocked reasons, duplicate active tasks, SQLite errors, and service stability. Stable services or completed dispatches alone do not establish business closure.

## Rollout Safety

Retain the current release and three rollback versions, business data, logs, and backups. Require a verified deployment backup and adequate free space. Do not lower the 3 GB deployment safety floor or the 3.5 GB backup-start guard to force rollout. Gateway delivery remains disabled. No bulk request rewrite is included.
