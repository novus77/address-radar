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
