# Consumer History Range Rescheduling SPAC

## Scope

Continue Task 4 without changing opportunity, admission, amount or chain policy. A completed shared recovery job may predate a consumer's required interval. Older jobs terminated with `historical_market_range_unavailable` before wallet-only consumer intervals were connected.

## Preconditions and safety

- Consider only pending `market_range_missing` demands with valid supported-chain, nonfuture, maximum 30-day individual purchase windows.
- Coalesce by canonical token key; preserve Solana case.
- Inspect actual finite positive named-source price points using the existing hourly recovery request coverage tolerance. This check is only for fetching, not strict opportunity complete-range proof.
- Process at most 25 completed or exact range-unavailable terminal jobs per planning tick, with a 30-minute per-job recheck cooldown.
- Never touch running leases, pending work, failed backoff, cursors, attempt counts or unrelated terminal reasons.
- Store the last dispatched requested envelope. Unchanged envelopes must not repeatedly reopen a completed job just because strict consumer coverage remains pending.
- New envelope bounds may cause another bounded request when actual request-level price coverage is missing.
- Only `historical_market_range_unavailable` dead letters may reopen after valid consumer intervals become available. Unsupported-chain, missing-pool and unverified-milestone terminals are not covered.
- Requeue through a compare-and-set on old status/update timestamp, preserving priority, cursor and attempts.
- Atomically append an audit of previous status/error and requested bounds. Audit plus job transition plus request manifest must commit together.
- Request manifests describe scheduling, not provider coverage or satisfied consumers.

## Schema

Add `consumer_history_recovery_requests` and `consumer_history_recovery_audits` through the existing explicit consumer-demand additive migration. Runtime migrations remain disabled in production. Retain all existing business facts, attempts and failure history.

## Validation

Test first wallet-only requeue, unchanged interval idempotency, expanded interval handling, coarse canonical coverage avoiding unnecessary fetch, exact terminal recovery with retained original error, active/failed/unrelated terminal preservation and cooldown behavior. Run all local checks before commit/deploy. Read-only acceptance must inspect actual audit rows, request manifests, job states, six services, delivery=false and disk safety.

## Remaining boundaries

Disjoint intervals still share an envelope; source-specific precise extrema/continuity certificates remain necessary for complete-range proof. Coarse recovery coverage must not produce a false non-hit, stable ability classification or candidate admission. Shared provider budget and genuine source coverage remain upstream dependencies.

## Local checkpoint

Targeted range/dispatch/wakeup tests: 18 passed. Full suite: 777 tests across 193 files passed. Build, type checks, package imports, module boundaries and both desktop/mobile browser tests passed. Full coverage certification remains open.
