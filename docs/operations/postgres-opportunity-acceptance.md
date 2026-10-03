# Isolated PostgreSQL Opportunity Acceptance

## Scope

This Task 9 foundation evaluates exact-decimal, evidence-backed 3x/5x opportunities without requiring a sale. A verified purchase of at least 50 USD owns an independent 30-day window. Stablecoin nominal USD remains explicitly estimated. Entry prices require execution evidence; current page prices are not entry proof.

Immutable market revisions and immutable evaluation versions are separate from the current sample head. A transaction locks the sample and binds its current execution fingerprint before updating the head and producing a semantic downstream work intent. Clock-only refreshes do not produce new work. Stale execution versions and unsupported tiers cannot update the head. Incomplete inputs do not erase a proven hit for the same execution version.

Pending price-quality review, pre-entry candles, candles overlapping entry, missing execution evidence, and elapsed windows without complete coverage remain distinct from failed opportunities. Numeric anomaly/liquidity thresholds and complete-non-hit coverage requirements are unconfigured, pending operator confirmation. Provider validation is an upstream responsibility, not something this fixture proves.

## Verification

Build workspace packages, then run `scripts/verify-postgres-opportunity-acceptance.ts` with an explicit acceptance URL in `ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL` and `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`. Never expose the connection URL in arguments or logs. The acceptance adapter only accepts loopback `_test` databases with bounded connection budgets.

The exclusively owned single-connection runtime creates transaction-local temporary tables, records a synthetic attributable 50 USDC purchase, verifies 3x then 5x revisions, rejects immutable conflicts and stale/unsupported evaluations, and proves two semantic downstream intents rather than timestamp-driven queue growth. All fixture writes are rolled back and table cleanup is checked. The integration suite also injects an interruption and checks rollback.

## Deployment boundary

Publish only an isolated operations artifact. Do not migrate SQLite, apply permanent business tables, switch the current release, restart business services, resume FOMO, add follows, authorize candidates, or enable delivery. Synthetic rollback acceptance does not prove real FOMO coverage, durable ingestion, review-authorized execution replacement, stable capability, admission, signal projection, or production database cutover.

Next dependencies: authorized execution-revision application and affected-sample recomputation; durable opportunity consumer activation; distinct-token rolling-30-day capability projection; identity/manual-authorization read models; real-source coverage; approved production schema/write-path migration. Historical task completion alone is not any of those proofs.
