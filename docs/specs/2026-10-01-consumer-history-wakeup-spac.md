# Consumer History Semantic Wakeup SPAC

## Problem

Token-level source revision replay finds canonical-event and candidate-evidence owners. A wallet-history-only consumer may not occur in either owner set. A busy owner can also postpone token-wide revision processing. Consumer coverage demands need an independent, durable reevaluation path.

## Design

- Scan pending eligible market-range consumers in bounded, rotating batches of 25 consumer/token pairs.
- Fingerprint actual finite positive canonical price points, timestamps and named sources inside the consumers' requested envelope.
- Do not use task status, fact metadata revision, provider attempts or log activity as evidence of semantic progress.
- Persist observed and dispatched fingerprints separately in an additive receipt table.
- Missing facts update only the scan position; they do not create an ability evaluation.
- An active ability evaluation defers that consumer only. Keep its undispatched fingerprint so the next eligible scan can retry without losing the arrival.
- Enqueue and dispatch receipt updates share a write transaction; do not reset existing jobs or leases.
- Deduplicate unchanged facts, detect corrected values and new in-range facts, and preserve chain/address identity rules.
- New facts trigger reevaluation, not direct admission or satisfied coverage. The existing scorer must still verify execution entry, USD amount, post-entry bounds, source evidence and approved thresholds.

## Migration and rollback

The receipt schema is initialized by the existing explicit consumer-demand additive migration, including when runtime migrations are disabled. No existing price, wallet, candidate or demand records are rewritten. An older release can ignore the additive table.

## Acceptance

Tests cover wallet-only consumers, idempotent arrivals, active-owner isolation with deferred replay, missing/invalid/out-of-range points, price corrections and rotating batches. Run complete tests, type checks, build, import smoke, boundaries and browser tests before deployment. Read-only production acceptance must verify receipt writes, queued ability evaluations, disabled delivery, six services and disk safety.

## Remaining boundaries

A canonical price fingerprint is a wakeup mechanism, not a full-range extrema certificate. Historical timestamp/provenance repair, extended recovery intervals, terminal recovery reopening and provider precision remain separate work. This increment does not mark the entire lifecycle complete.
