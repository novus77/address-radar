# PostgreSQL preservation staging round-trip acceptance

## Scope

This acceptance verifies the preservation codec and transaction boundary, not the
future business PostgreSQL schema. It uses the existing restricted loopback test
driver and only four TEMP tables, each ON COMMIT DROP. No permanent schema, source
database, application consumer or delivery configuration is modified.

The supplied synthetic boundary fixture is not a real trade and does not satisfy
the real purchase, 30-day coverage, identity or signal acceptance gates.

## Storage guarantees under test

- SQLite INTEGER values remain signed 64-bit values, never JavaScript numbers.
- SQLite REAL stays DOUBLE PRECISION; original double bytes are checked using
  float8send, including subnormal values, negative zero and maximum finite values.
- Observed source strings remain UTF-16LE byte payloads in staging BYTEA. This
  avoids silently losing NUL or isolated surrogate code units that PostgreSQL
  TEXT/JSONB cannot preserve. This is a staging preservation choice, not the
  approved encoding for future business text columns.
- BLOB, NULL and TEXT remain distinct.
- Primary-key payloads, row fingerprints, root references and dependency edges
  are checked after reading the staged data back.
- Bundles with incomplete declared dependencies, incomplete global delivery/budget
  protection, modified fingerprints or dangling edges are rejected before probing
  a database or opening a write transaction.
- A duplicate primary-key failure after the first staged write forces SQLSTATE
  23505. Cleanup is then verified on the same backend session, not a different pool
  connection that would hide leftover temporary state.

This codec preserves values observed by the SQLite reader. It does not reconstruct
original file encoding or bytes that a prior decoder has already lost.

## Running against an approved isolated acceptance database

~~~bash
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false \
node --import tsx scripts/verify-postgres-preservation-acceptance.ts
~~~

Provide ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL through the existing private test
environment. Do not paste credentials into command logs. The driver still requires
a restricted loopback test database; do not weaken it for a business destination.

The integration test uses ADDRESS_RADAR_POSTGRES_TEST_URL:

~~~bash
node node_modules/vitest/vitest.mjs run packages/database/test/postgres-preservation-acceptance.test.ts packages/database/test/postgres-preservation-acceptance.integration.test.ts
~~~

Without a configured test database the integration test is skipped, not passed.
Unit codec checks are not a substitute for a real PostgreSQL execution.

## Report and remaining gates

The report contains row/cell/edge counts, fingerprints, rollback and cleanup results,
sourceData=synthetic_only and productionMigrationReady=false. It excludes raw
payloads, original keys, credentials and connection URLs.

Formal business-driver/schema/role provisioning, actual source-to-business column
mapping, Unicode/domain handling, coherent snapshot plus delta journal, per-purchase
reconstruction, real market coverage and separately approved cutover remain pending.
Post-cutover reverse replay is not proven by this temporary-table rollback test.
No old capability, admission or consumer completion result is promoted.
