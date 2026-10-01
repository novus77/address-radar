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

### Checkpoint 3 production result

Commit: `fe55741`.
Production release: `/opt/address-radar/releases/fe55741-data-flow-trace`.

- Full regression: 715 tests passed; type checking, build, smoke, boundaries and two end-to-end cases passed.
- Six production services active, zero automatic restarts, Gateway delivery disabled.
- A real trader trace returned attributed evidence, admissions, ability, purchases and monitoring sections.
- A real token trace returned inventory, fact status, fifteen evidence rows, recovery and projection sections.
- Read-only market-time audit reported its 1,000-row cap of suspect timestamp mismatches; the report is not exhaustive and no repair was applied.
- Bounded old-fact revision and affected downstream reevaluation must follow a provenance audit. These rows must not be automatically discarded or counted as trustworthy historical coverage.
- Execution-basis policy confirmation remains the next blocking checkpoint; the entire four-phase plan is not complete.

### Execution-basis policy confirmation and foundation

The user approved nominal USD valuation for verified USDT/USDC contracts or mints.
Amounts derived this way are estimates, not historical USD oracle observations.
Entry prices must be derived from the actual quote and token quantities of the
same confirmed execution. Current market prices are not execution prices.

The execution-basis foundation nets refunds and repeated asset movements,
requires verified stablecoin identities, and refuses ambiguous multi-token or
multi-quote allocation. Failed or unverified executions and transfers without
swap confirmation cannot produce an estimated basis. Fourteen targeted tests
cover these boundaries. This foundation is not yet wired into production
collectors or durable provenance. Task 3 remains in progress; this is not a
production remediation or an end-to-end acceptance result.
