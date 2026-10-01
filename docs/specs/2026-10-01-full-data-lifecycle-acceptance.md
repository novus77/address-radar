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

### Task 3: RPC collector execution basis and durable provenance

Implemented the approved nominal USDT/USDC valuation policy in the Solana and
EVM block collectors. Valuation requires a confirmed successful execution,
swap evidence, a single net token asset, and a single supported net quote asset.
Solana uses wallet-owned balance deltas; EVM uses receipt transfer evidence and
ERC-20 decimals queried at the execution block. Neither path uses a current
market price or current market capitalization as a historical execution fact.
Multiple accounts for the same token are netted into one economic observation.
Ambiguous allocation and mixed native payments remain unvalued.

Indexed EVM transfer history remains useful for raw wallet activity discovery,
but its transfer lists alone do not establish a successful swap execution.
Such observations explicitly carry an unavailable execution basis until receipt
recovery confirms the execution. Historical receipt recovery and native-asset
historical USD valuation remain outstanding work, not accepted source coverage.

The additive wallet_monitor_execution_bases table stores execution provenance
by source and event ID. It does not rewrite or delete existing trading rows.
Identity-delayed projection retains the basis across process restarts. Late
basis enrichment reprojects the existing event without creating another trade;
unchanged replays do not create another basis row or another source event.
Runtime wallet normalization preserves the optional execution-basis contract.

Targeted regressions reproduce and cover spot-price contamination, failed
executions, multi-token allocation, same-token multi-account allocation, mixed
native payments, metadata persistence, delayed identity linking, and idempotent
late enrichment. The latest full unit suite passed 742 tests. Production
migration, collector acceptance with live receipt provenance, consumer coverage
validation, and repair of previously contaminated observations remain pending.

Deployment preflight found approximately 2.99 GB available on the production
root volume, below the existing 3 GB minimum. No production release switch or
schema migration was performed. Approval was requested for narrowly scoped
cleanup of obsolete deployment artifacts, preserving databases, event data,
backups, and the current and rollback releases. Do not bypass the disk gate.

### Production migration and startup follow-up

Limited cleanup removed only generated JavaScript, declarations, and source maps
from older, non-current, non-rollback releases, reclaiming 74,383,360 bytes.
Sources, dependency installations, databases, events, backups, the active release,
and its immediate rollback release were preserved. Audit:
`/var/log/address-radar/artifact-cleanup-702e237.log`.

Release `702e237-execution-basis` was switched into production. Acceptance found
that runtime migrations were explicitly disabled, so startup did not create the
new table. It also caught one wallet-analysis startup failure caused by WAL
configuration occurring before the connection's busy handler was installed.
Neither failure is counted as successful acceptance.

An explicit additive transaction created the execution-basis table with services
stopped, and services were restarted sequentially. Wallet observation row counts
before and after that transaction were both 120,766. No legacy bulk migration was
run. Read-only checks then found a real unavailable-basis observation and its
source-ledger enrichment, proving collection-to-provenance persistence. No live
estimated execution sample was present at that checkpoint; live estimated-price
acceptance remains pending, rather than inferred from service health.

The follow-up adds a dedicated, idempotent migration command that only creates
execution-basis storage, reuses the same SQL in schema initialization, installs
the busy handler before WAL setup, and adds a deployment script that explicitly
runs the narrow migration and verifies the resulting table. Full verification:
744 unit tests, type checks, build, package imports, boundaries, and two browser
end-to-end tests passed. Initialization ordering reduces the observed startup
race; it does not prove that every possible SQLite contention is eliminated.

### Verified release: f3226d6-execution-migration

The follow-up release was deployed using the explicit execution-basis migration
command. All six services were active with NRestarts=0 at the acceptance
checkpoint. The resulting table columns were verified. Every service retained
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false. Available root disk space was
3,058,356,224 bytes at the final disk checkpoint.

Production collector persistence produced 105 provenance-bearing observations:
18 nominal stablecoin estimates, 85 awaiting swap confirmation, and two lacking
supported quote valuation. The 18 estimates comprised eight buys and ten sells;
all 18 were projected and all passed the amount/token-quantity/entry-price
consistency check. None carried current market capitalization as historical
execution capitalization. Source-ledger enrichment also contained 105
execution-basis records. The sampled five-minute journal window had zero
missing execution-basis table errors and zero SQLite lock messages.

A separate read-only replay fetched two genuine historical Solana transactions
from RPC. One remained unvalued without a supported historical quote. The other
correctly derived amountUsd=300 and priceUsd=0.00018074194980316943 from its
stablecoin spend and token receipt. The replay persisted nothing and delivered
no signals. This verifies a genuine execution sample, not a simulated trade.

Unrecognized swap evidence and missing native-asset historical valuation remain
coverage limitations. These observations must not be silently counted as fully
valued trades, successful early-buyer recovery, or complete candidate coverage.
Consumer-specific range coverage, historical repair, and the remaining phases
of the development plan are not accepted as completed by this checkpoint.
