# Full Data Lifecycle Execution Checkpoints

Date: 2026-10-01, Asia/Shanghai

This is an incremental execution record, not a claim of full lifecycle acceptance.

## Checkpoint 1 — Read-only diagnostics foundation

Commit: `4614a61`.
Production release: `/opt/address-radar/releases/4614a61-data-flow`.

- Added version-specific distinct-trader metrics and explicit unknown denominators.
- Separated collection rows, recent event rows, fact records and task records.
- Targeted tests: five passed; full regression: 711 passed.
- Type checking, build, built-package smoke, boundaries and two desktop/mobile end-to-end cases passed.
- Production endpoint returned `data-flow-v1`; all six services active and Gateway delivery disabled.
- Authoritative historical cohort coverage is not established by this foundation.

## Checkpoint 2 — Temporal and identity integrity

Commit: `2828285`.
Production release: `/opt/address-radar/releases/2828285-temporal-integrity`.

- Market observations and milestone observation callbacks use the provider's market timestamp instead of historical purchase time.
- Invalid/future market timestamps cannot be persisted as historical quotes.
- Solana ownership matching preserves case; EVM ownership remains case-insensitive.
- Added read-only market-timestamp audit and data-flow CLI.
- Targeted scanner/monitor regression: twelve passed; full regression: 714 passed.
- Type checking, build, built-package smoke, boundaries and two end-to-end cases passed.
- Six services restarted successfully with zero automatic restarts; Gateway delivery remained disabled.
- Existing suspect observations and derived assessments have not been deleted or rewritten. Audited bounded repair remains a separate migration checkpoint.

## Checkpoint 3 — Trace and conservative audit

- Added bounded token/trader trace sections with parameterized identity selection, schema availability and truncation indicators.
- Closure audit uses opportunity strategy-specific counts and latest stable state per trader.
- Absent dependency rows are included in missing data; partial/degraded records are not silently counted as fully satisfied coverage.
- The audit no longer returns ready solely because tables contain rows; authoritative cohort/source coverage remains an explicit warning.
- Targeted trace/progress tests and type checking passed. Full regression, build, smoke, boundaries and desktop/mobile cases passed before commit.
- Release and production acceptance are recorded after deployment, not inferred from local tests.

## Outstanding decisions and work

- Execution-basis normalization is blocked from policy-changing rollout until the user confirms whether stablecoin nominal USD amounts may pass amount gates or require historical USD exchange-rate evidence.
- No new scoring weight, unknown-age route, bundle exclusion or retention period has been introduced.
- No production database migration or old-fact repair has been performed.
- Remaining plan phases, authoritative frozen-cohort denominators, source ownership cutover, historical acquisition, consumer-specific coverage, complete strategy dispatch and full real-chain acceptance remain outstanding.
