# PostgreSQL Acceptance Driver Wiring

## Scope

This slice connects the existing asynchronous unit-of-work contract to the project-owned, pinned `pg` dependency. It provides an explicitly constructed acceptance runtime, not a SQLite replacement or automatic startup path. Existing business processes remain on their previous database/release; browser capture and gateway delivery remain disabled for this verification.

The factory accepts only credential-bearing, explicit-port loopback PostgreSQL URLs whose database is a simple identifier ending in `_test`. URL query parameters and fragments are rejected so they cannot override the target. Configuration errors never reproduce the credential-bearing URL. No environment fallback, migration, schema initialization, transaction retry, external request, or browser operation is performed by construction.

## Connection lifecycle

- Acceptance-only maximum: one or two connections; all connection, idle, statement, and lock budgets must be explicit positive bounded integers. These are not business pool defaults.
- Construct lazily; acquire a single native client for each outer transaction and reuse it for nested repository composition.
- Preserve native string representations of PostgreSQL BIGINT and NUMERIC; do not install process-global type parsers.
- Preserve the existing uncertain-commit behavior; never automatically replay a transaction callback.
- Report bounded connection counts and idle-error SQLSTATE only; do not log raw driver errors or connection strings.
- On explicit shutdown, refuse new root transactions, drain existing checked-out work, and close idempotently.
- Require a target probe to confirm database/user and the server's loopback address before acceptance reporting.

Implementation follows the [node-postgres pool lifecycle](https://node-postgres.com/apis/pool) and [explicit connection configuration](https://node-postgres.com/features/connecting). Transactional repositories receive only the existing transaction interface, not the native pool.

## Verification

```bash
pnpm exec vitest run packages/database/test/postgres-acceptance-driver.test.ts
ADDRESS_RADAR_POSTGRES_TEST_URL="$ISOLATED_TEST_DATABASE_URL" \
  pnpm exec vitest run packages/database/test/postgres-acceptance-driver.integration.test.ts
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false \
  ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL="$ISOLATED_TEST_DATABASE_URL" \
  pnpm exec tsx scripts/verify-postgres-driver-acceptance.ts
```

The real-driver suite covers target identity, exact decimal/integer transport, batch-result adaptation, same-client nested transactions, rollback, bounded saturation, draining shutdown, and idle-backend failure. Backend termination is a test-only action in a disposable local PostgreSQL container; never run that regression against the production acceptance instance. The standalone verification uses only temporary rollback probes and read queries, not backend termination or persistent business tables.

Missing opt-in connection URLs mean integration tests were skipped, not passed. Keep earlier default-five-second test timeouts distinct from any diagnostic run with an extended runner budget. Do not claim complete business closure from a connected pool or temporary-table probe.

## Remaining activation gates

A production write-path switch, business schema activation/migration, legacy workflow freeze, retention cleanup, and browser-source resumption still require their separate authorizations. Real execution/ownership resolution, downstream opportunity/ability projections, identity grants, and real Live Feed coverage remain implementation/acceptance dependencies.
