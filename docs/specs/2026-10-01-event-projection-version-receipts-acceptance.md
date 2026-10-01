# Version-bound event projection receipt acceptance

## Scope

This slice corrects zero-row replay dispatch and adds a lease-bound execution snapshot for event projections. It does not implement candidate, signal, or token-aggregation execution acknowledgments and does not change eligibility, amount thresholds, identity links, or delivery configuration.

## Verified local behavior

Four new regressions reproduced false dispatch, missing completion acknowledgment, stale completion after revised economics, and missing filtered outcome classification. The existing lost-owner test passed before the fix. After implementation, all 14 targeted tests passed across projection receipts, ability revision context, and wallet execution revision regressions.

A successful projection claim snapshots economic inputs and execution heads in its transaction. Completion requires the existing projection owner and unchanged inputs, then updates both projection completion and the corresponding execution request acknowledgment in the same transaction. Filtered and recomputed outcomes are separate. Pre-rollout leases without a captured context cannot create a retrospective acknowledgment. A replay UPDATE matching no projection row does not advance the dispatch version.

## Deployment gate

Complete tests, type checking, build, package imports, boundary checks, and browser regressions must pass. Premigrate event_projection_execution_contexts before release switching because production runtime migrations are disabled. Take a consistent server-local backup under the disk guard, preserve the prior release, and verify all six service environments still disable delivery.

## Production acceptance boundary

Measure real context captures and projection acknowledgments; a passing test suite does not substitute for a real production receipt. Snapshot only aggregate counts and diagnostics. Check for stale completion, SQL errors, lock errors, restart increases, and disk headroom. Do not infer receipt application from an old completed projection row.

Previously misclassified dispatches and missing scanner registration still require bounded, audited follow-up; this slice does not rewrite those rows in bulk. Candidate entry-price consumption, all other consumer acknowledgments, actual revision-two correction, reorganization invalidation, and full lifecycle acceptance remain open.

## Validation and production rollout: 2026-10-02 Asia/Shanghai

- Commit/release: `15dc8c4` / `15dc8c4-projection-input-attestation`.
- Targeted validation: 7 tests passed. Complete validation: 865 tests across 210 files, workspace types, build, built package imports, boundaries and 2 desktop/mobile browser tests passed.
- Consistent server-local predeployment backup: `/var/backups/address-radar/15dc8c4-predeploy-1790871372.sql.gz`, 304199055 bytes, SHA256 `a77ca5e5ce7aeb5330fba3650156f1edae1d1044f1129b9cbd6ecbb312138f0d`; compressed integrity verified. No business data exported or deleted.
- Additive projection context schema applied before release switch. Previous release retained. Six services active with NRestarts=0; delivery remained false.
- Read-only acceptance at approximately 00:19 China: 3 captured contexts, all 3 verified consumed inputs; 1 real event-projection request acknowledged with `projection_recomputed`. Remaining event requests: 35 awaiting acknowledgement and 81 pending. The other four consumer types each had 117 requests and zero applied receipts; they are not declared complete.
- No error or SQLite-lock lines in the inspected 10-minute service logs. Free space approximately 3.68 GB.
- Closed-loop endpoint initially exceeded a 30-second timeout; one bounded retry succeeded. This remains a query-latency observation, not proof of universal availability.
- Queue runnable 1079, 15-minute delta -114, converging=true. Opportunity ability coverage 2328/11351 traders, pending 9023; early-trade recovery 1728 complete, 416 pending; candidate evidence blocked 2137. Identity resolution remains 122 resolved and 314 pending. Data coverage, identity recovery, other versioned consumer receipts and the full lifecycle acceptance remain open.
