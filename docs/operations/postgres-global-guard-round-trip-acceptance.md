# PostgreSQL Global Guard Page Round-Trip Acceptance

## Scope

This verifier reads the nine global guard ledgers from one read-only SQLite
snapshot and stages its actual pages in the restricted PostgreSQL acceptance
database. It uses only temporary tables with `ON COMMIT DROP`. It does not create
permanent business tables, migrate a running service, enable delivery or grant
new policy eligibility.

Both the runtime probe and each PostgreSQL transaction must identify
`address_radar_acceptance_test` and `address_radar_acceptance`. The runtime must
connect through loopback and operate exclusively with one pool connection.
Existing temporary tables with the verifier's names cause a failure; they are
never silently dropped.

## Values and independent checks

Pages are stored as opaque `BYTEA`, not JSONB and not business NUMERIC columns.
Their JSON wire format retains the original SQLite storage tags and string
representations. Embedded NUL, lone UTF-16 surrogates, blobs, signed 64-bit integer
digits and finite REAL strings are not coerced by PostgreSQL JSON or numeric
parsing. Source values remain distinguishable from approved exact business
amounts. This storage codec is an acceptance staging format, not a proposed
authoritative business schema.

After a target read, the verifier validates the original canonical serialization,
every cell's storage class, row key/value correspondence, row hashes, page hashes,
page order, cross-table chain and snapshot identity. It recomputes per-table
content hashes and counts, serialized source bytes and the snapshot fingerprint.
All nine ledgers, including empty ledgers, must match the source manifest.
Omitted, reordered, mixed-snapshot or modified data cannot produce a passing result.

The source sink acknowledges a page only after the temporary target insert
completes. The entire target stage has one transaction owner. If a source sink
times out, any bounded PostgreSQL query still in flight is settled before the
target transaction is rolled back. A page acknowledgement alone is not final
acceptance; independently restored values and the full manifest are required.

## Commit and rollback proof

1. Create temporary page and manifest structures, write actual source pages,
   verify target reads and commit. Confirm that both structures disappeared.
2. Start another transaction on the same backend, create the temporary structures
   and write a manifest prefix. Observe that the prefix row exists.
3. Deliberately insert a duplicate manifest primary key and require SQLSTATE
   `23505`. This must fail after a real target write, not before staging starts.
4. After rollback, confirm both temporary structures are absent on the same
   `pg_backend_pid()` as the success and failure transactions.

Cleanup on a different pooled session is not proof that the original session is
clean. The verifier fails rather than weakening this assertion. Target writes
are limited to the acceptance session's temporary namespace; source rollback
and target rollback remain distinct operations.

## Running

Build the database package first. Supply the acceptance URL through the environment
without printing it or embedding it in a command argument:

```sh
node scripts/verify-postgres-global-guard-acceptance.mjs \
  --database /path/to/source-snapshot.db
```

The CLI requires `ADDRESS_RADAR_POSTGRES_ACCEPTANCE_TEST_URL` and does not read
production credentials itself. Its driver refuses an unrestricted target. Test
URLs should use the same restricted role/database on loopback. Actual production
source reads require a separately guarded invocation that confirms delivery is
still disabled and applies an outer process timeout.

The isolated integration test uses synthetic SQLite records and is skipped when
no test URL is present. A skipped test is not real PostgreSQL acceptance evidence.

## Remaining migration gates

A passing report establishes only a lossless temporary target round trip of the
observed ledger records and their manifest. The schema itself is not recreated:
DDL and schema fingerprints remain inventory evidence, not business-schema parity.
Referenced business parents, per-purchase dependencies, execution revision chains,
canonical economic identity and original 30-day price proofs still need their
own compatible-snapshot acceptance. The report therefore always keeps
`purchaseDependenciesVerified=false`, `businessActivation=false` and
`productionMigrationReady=false`.

## Recorded acceptance evidence (2026-10-04)

- Targeted codec and manifest tests: 14 passed. The environment-gated local PostgreSQL integration test was skipped; it is not evidence of database execution.
- Full local suite: 1,149 passed and 97 skipped. All project test type checks, 15 project builds, and the root TypeScript check passed using the installed compiler directly.
- A separate real PostgreSQL acceptance run used the restricted acceptance role/database on the production host. Its source was a read-only SQLite snapshot; only isolated PostgreSQL TEMP tables were written.
- Source: nine ledgers, 9,182 rows, 42 pages. Snapshot ID: `09ff2dfd-26cf-4efa-a621-a6cd7b07fe6d`.
- Source fingerprint: `5950d3ca62f53ea412c8a0007372219524e101c51150979cc7ad58ee39e9db4a`.
- Target payload round trip, row/page/manifest verification, successful commit cleanup, partial-write failure rollback, and same-session cleanup all passed.
- Six business services were active with `NRestarts=0`; each actual service process had exactly one gateway delivery flag set to `false`. The release was unchanged.
- `businessWrites=false`, `temporaryAcceptanceWrites=true`, `purchaseDependenciesVerified=false`, and `productionMigrationReady=false`.

This evidence does not authorize a permanent import or prove per-purchase dependency closure, typed business-schema compatibility, complete 30-day price coverage, eligibility, or signal delivery. Those remain independent gates.
