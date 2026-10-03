# Consistent Global Guard Ledger Preflight

## Purpose and boundaries

The old per-purchase preservation slice can reach its row limit while reading the
provider budget ledger. Do not raise that slice limit until an arbitrary purchase
appears reconstructable, or interpret a truncated slice as missing source data.

This independent reader inventories all nine delivery, consumption, outcome,
outbox-review and provider-budget ledgers. It uses one read-only SQLite connection
and one pinned read transaction. It is not a business importer or a migration
authorization. Purchase dependencies, original execution validation and target
round-trip verification remain separate gates, always false in this report.

No existing dependency-completeness flag is changed by this reader. It does not
automatically unlock the legacy purchase reconstruction tool. A future coordinator
must verify matching source snapshots and complete target restoration before
composing those gates.

## Consistency and paging

1. Open an existing regular file with `readOnly`, `query_only` and no migration or
   registry initialization.
2. Pin the SQLite snapshot before inspecting schemas or awaiting a page sink.
3. Preflight every required table and its known primary-key shape. Missing or
   unsupported schemas block the operation before any page acknowledgement.
4. Walk each table using its ordered primary key and a tuple keyset cursor. Do
   not use growing OFFSET scans or a separately opened connection per page.
5. Inspect page payload sizes before materializing source values. Retain observed
   NULL, INTEGER, REAL, TEXT and BLOB classes; preserve 64-bit integer digits and
   do not promote a legacy REAL to exact financial decimal precision.
6. Hash every ordered typed row, chain the pages across the snapshot, and retain
   schema and per-table content fingerprints. Empty tables are explicitly listed;
   they are not inferred from missing pages.
7. Finish only after an exhaustion read for every ledger. Roll back the read
   transaction and close its connection on success, blocked reads or sink errors.

Rows and pages delivered to the optional sink are frozen. The sink must acknowledge
the exact page fingerprint. A callback acknowledgement is not independent proof
of PostgreSQL persistence or of a restorable backup.

## Safety limits

Defaults are operational diagnostic caps, not approved provider request budgets:
256 rows per page, 100,000 total accepted rows, 32 MiB of serialized typed row
representations and a 5-second elapsed-time budget. Caller overrides are validated
against hard ceilings. Reaching any cap produces a blocked, incomplete report;
it must not be treated as an empty or fully preserved ledger.

Time checks run between bounded SQLite statements. They cannot preempt a
synchronous statement or uncooperative callback. Production execution also needs
an outer process timeout; a prolonged snapshot can pin WAL retention. A timed-out
asynchronous sink receives an aborted signal and must stop cooperatively. Partial
target staging must be rolled back by its own transaction owner. Source rollback
cannot roll back an unrelated target database.

The byte counter represents serialized preserved cells, not disk usage or database
growth. Raw page size is checked before reading large payloads into JavaScript;
base64, escaped-text and metadata overhead are checked again before page delivery.

## CLI

Build the database package first, then run with the configured Node runtime:

```sh
node scripts/global-guard-snapshot-preflight.mjs \
  --database /path/to/source-snapshot.db \
  --page-size 256 --max-rows 100000 \
  --max-bytes 33554432 --max-duration-ms 5000
```

The CLI installs no sink and prints only a manifest: no original ledger rows,
payloads, provider credentials or wallet identities. A complete source inventory
therefore still has `exportAcknowledged=false`, `targetRoundTripVerified=false`
and `productionMigrationReady=false`.

Exit codes: 0 for complete source inventory, 1 for blocked or incomplete inventory,
2 for invalid arguments or source-opening failure. None implies business activation.

## Acceptance and next integration

Isolated tests cover more than 1,000 budget rows, cross-page uniqueness, exact
storage classes, a concurrent WAL writer, missing tables, nullable legacy keys,
row/byte/time limits, wrong acknowledgements and redacted sink failures.

The next integration must stage actual pages and the manifest in the restricted
PostgreSQL acceptance database, verify typed values and page-chain counts, prove
partial rollback, and preserve referenced business parents separately. A source
manifest by itself is not a permanent export, a backup, a global live-delivery
authorization or proof that all 141 business tables have been migrated.
