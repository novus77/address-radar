# DefiLlama Request Boundaries: Production Acceptance

## Release and verification

Release: `5aeaa55-defillama-pages`. Rollback release: `82052f9-provider-budget`.

Passed 15 targeted tests, 794 unit tests across 197 files, build, typecheck, package import smoke checks, module boundaries, and two desktop/mobile browser tests. The regression cases failed against the previous implementation and passed after adding request hooks and per-page timeout boundaries.

## Production observations

At 2026-10-01T10:44:21Z, the current release was correct. All six services were active, NRestarts=0, and ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false. The last five minutes contained zero matching SQLite contention, invalid budget reservation, missing-table, or fatal log entries. Active oversized history request manifests: zero.

At 2026-10-01T10:46:07Z, a real `defillama:public` shared gate row was observed. Its next_request_at minus updated_at was 3,000 ms, matching the existing 20-call logical ceiling. This proves actual use of the configured gate, not complete coverage, exact per-page budget attribution, or a production HTTP-429 cooldown exercise. Local tests verify cooldown propagation.

Disk available at follow-up: 3,079,122,944 bytes. Both current and rollback releases were retained. No cleanup or delivery activation was performed during this checkpoint.

## Progress

Compared with the provider-budget acceptance at 2026-10-01T10:25:12Z:

- Distinct opportunity-v4 ability entities: 262 -> 275 (+13).
- Candidate evidence facts: 1,439 -> 1,439 (no change).
- Early trade recovery completed at the first new snapshot: 1,702 -> 1,704 (+2).
- Recovery satisfied: 2,174 -> 2,176 (+2).
- Candidate evidence blocked: 1,888 -> 1,905 (+17).
- Runnable: 117 -> 162; converging remained false.

These snapshots span different release windows and do not establish a causal throughput improvement from this patch.

## Remaining bottlenecks

Accumulated failed recovery tasks at follow-up included historical_market_coverage_unavailable (497), early-buyer waiting_result (387), market_price_unavailable (321), milestone supply unavailable (122), and queued FOMO token history (110). Historical market abort records (78) are accumulated failures, not demonstrated new failures caused by this release.

Task 5 remains open for physical per-page budget attribution, durable partial-page retention, and chain/source capability coverage. Task 4 still requires strict coverage proof. Full lifecycle acceptance has not passed; no reliable completion estimate is available.
