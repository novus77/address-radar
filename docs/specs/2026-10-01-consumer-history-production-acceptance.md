# Consumer History Production Acceptance

## Verified release and local checks

- Dispatch commit: `d9b55ea`.
- Semantic wakeup commit and production release: `58263ad-consumer-wakeup`.
- Targeted tests: 20 passed.
- Full unit tests: 761 passed across 190 files.
- Build, type checks, package import smoke and module boundaries passed.
- Desktop/mobile console tests: 2 passed.
- Narrow additive migration completed; no existing business rows were rewritten.

## Production snapshot

Read-only snapshot at `2026-10-01T07:39:04.137Z`:

- All six Address Radar services active; each `NRestarts=0`.
- Every service process retained `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
- Current release: `/opt/address-radar/releases/58263ad-consumer-wakeup`.
- Consumer wakeup receipts: 25.
- Dispatched receipts: 1; the receipt is linked to an actual ability evaluation job by consumer and creation timestamp.
- Deferred fingerprints: 24. These remain durable while their consumers already have active ability evaluations.
- Since the first dispatch acceptance snapshot: 63 new market-history jobs pending, 13 historical-research jobs pending, 13 market-enrichment jobs pending and 1 early-buyer job pending. These counts include other existing planners, not just the new demand planner.
- Consumer tokens without the matching recovery job: 1,834, down from 1,882 in the first snapshot. This is a net change, not a fixed-cohort completion rate.
- Positive-hit demands: 7,092 satisfied and 19,442 pending. Complete-range demands: 26,534 pending.
- Canonical price rows by source: GeckoTerminal OHLCV 138,812; DefiLlama chart 46,432; Fomo history 27,798. These are totals, not newly produced rows in this acceptance window.
- Sampled last-five-minute scanner/automation logs: zero SQLite lock or missing-table errors.
- Available disk: 3,123,585,024 bytes, above the deployment guard but with limited headroom.

## What this proves

Persisted consumers now reach bounded recovery dispatch. Wallet-only consumers can request history without a canonical buy. A canonical-price fingerprint can create an actual ability evaluation, independently of token-wide owner processing. Busy consumers retain undispatched work.

## What this does not prove

No new shared recovery job in this short snapshot had completed. Sustained provider throughput, consumer full-range satisfaction, all-chain coverage and end-to-end new-address/signal generation are not certified. Services running and tasks queued are not lifecycle completion.

## Next dependency-ordered work

1. Model extended/disjoint requested intervals after a shared recovery job has completed, without resetting active leases or endlessly requeuing unchanged intervals.
2. Recover old range-unavailable terminal jobs only with valid newly available consumer prerequisites and an audit record.
3. Publish provider precision/continuous-extrema certificates; do not promote hourly point coverage into strict complete-range evidence.
4. Continue source capability/shared-budget work, genuine historical fact recovery and downstream identity/ability/signal acceptance.
5. Address storage growth before the 3 GB deployment safety guard is crossed; do not delete active business data.

Task 4 and the full development plan remain open.
