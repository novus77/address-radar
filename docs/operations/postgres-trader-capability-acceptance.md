# Forward Stable Capability Projection

## Approved policy and boundaries

Within the rolling 30-day purchase cohort, require at least three distinct validated 3x tokens OR two distinct validated 5x tokens. Each buy must be attributable, at least 50 USD and supported by real entry evidence. Require available observed 100K screening evidence for its generation/token. Do not require a realized sale, resolved wallet or fully mature cohort. Preserve sample/denominator counts, unknown screening/evidence and nominal stablecoin estimate markers separately. Elapsed cohort observation does not prove complete source coverage.

The legacy candidate-admission predicate remains unchanged: two Early tokens or one Strong token under its own policy. A forward `candidate_observed` state records a proven opportunity, not legacy candidate admission, stable capability or manual radar authorization. Historical SQLite statuses and policy versions are untouched. This foundation intentionally does not manufacture legacy evidence classifications or silently map a new label to an eligibility grant.

## Atomic projection

Load only the explicit generation and available purchase cohort, serialize per entity/generation, and share-lock loaded sample versions. Recheck the current opportunity head against its real entry and selected immutable peak. Stale heads, pending review and unavailable evidence cannot qualify. Budget overflow defers without projecting a truncated denominator. Save immutable versions, a monotonic head and its semantic downstream intent in one transaction. Clock-only refresh updates decision freshness without adding versions/intents. Head generations allow a future authorized state transition to notify even when a prior immutable state recurs.

Newly inserted samples or market results need their subsequent semantic consumer wakeup; this projection is a transactional current-input snapshot, not a promise that a concurrently committed future event was already included. Older decisions cannot replace newer heads. Capability transitions do not mutate execution revisions or grant signal delivery.

## Verification and remaining work

Build and run `scripts/verify-postgres-trader-capability-acceptance.ts` with the explicit loopback `_test` URL supplied by environment and delivery false. Temporary synthetic data is fully rolled back. Regressions exercise 100K after a stored high, distinct-token thresholds, missing-data denominators, projection deduplication, budget overflow, aging out, historical basis retention, old decision rejection and intent-interruption rollback.

Production opportunity-to-capability leases/receipts, milestone/cohort-aging dispatch, legacy admission input-cohort integration, manual-grant ledger/read models, risk-preserving signal aggregation, real FOMO coverage, permanent schema/write-path activation and migration remain open. The acceptance artifact does not start business workers/timers, switch release, resume FOMO or enable delivery.
