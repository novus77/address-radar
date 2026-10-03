# Row-level preservation preflight

## Purpose

This stage reads declared legacy source rows and their preservation dependencies in
one SQLite read transaction. It preserves the exact observed SQLite storage values,
including integer values beyond the JavaScript safe integer range. It does not
import them, create new purchase samples, approve eligibility or execute retention.

It complements full-data-migration-preflight. Neither tool is a production importer,
a proof of complete historical market coverage, or authorization to cut over.

## Isolated usage

Use an existing isolated fixture or an already-authorized coherent source copy.
Create a request identifying complete primary keys:

~~~json
{
  "roots": [
    {
      "reference": "reviewed-wallet-event",
      "reason": "trade_evidence",
      "row": {
        "table": "wallet_monitor_execution_bases",
        "key": { "source": "solana_rpc", "event_id": "event-id" }
      }
    }
  ]
}
~~~

~~~bash
pnpm exec tsx scripts/full-data-row-protection-preflight.ts --database /path/to/source.sqlite --request /path/to/request.json
~~~

Exit 0 means the declared dependency slice completed without reported blockers,
not that a production migration or full business loop is ready. Exit 1 reports
missing records, unindexed lookups, reconstruction requirements or read limits.
Exit 2 reports invalid input or a catalog/read failure.

The CLI emits counts, table names, hashed references and blockers. Raw payloads,
wallet keys and original request references are not printed. The in-process bundle
contains the actual typed source values and must be treated as sensitive evidence.
No bundle file is written automatically.

## What is protected

- Complete composite keys are required. Wallet execution bases and observations
  remain associated by source and event_id together.
- SQLite foreign-key groups are read with their id/seq grouping; composite parents
  are not reconstructed from the flattened earlier inventory.
- Declared rows retain foreign-key ancestors recursively, with cycle deduplication.
- Wallet observations retain execution bases, available heads and identity parents.
  Projected observations additionally require their trader and raw event records.
- Heads retain current revisions, full available revision history including revision
  zero, and recorded consumer requests. Missing required revisions are blockers.
- Canonical events retain observation links and raw facts. Reverse observation
  lookups are attempted only with an adequate index prefix.
- Source observations retain enrichment revisions and conflict representations.
- All available delivery deduplication, frozen outbox review and shared provider
  budget/cooldown rows are selected within the same bounded preservation budget.
- Old trader/token aggregates are preserved but always marked as requiring
  per-purchase reconstruction. No 30-day completeness or new eligibility is inferred.

The declared scope is intentionally narrower than all semantic relationships.
JSON-embedded source-event references, market windows, candidate milestone links,
identity conflict review and policy provenance still require dedicated adapters.

## Bounds and failure behavior

The local default is 1,000 rows and 8 MiB of encoded included source values. These
are development safety limits, not production provider/API budgets or business
thresholds. Hitting either limit makes the report incomplete. They do not guarantee
a wall-clock deadline or prevent allocating one oversized SQLite value; use an
external process timeout for approved large-source diagnostics.

Non-guard related lookups must have an ordinary non-partial index or primary-key
prefix covering their equality filters. The tool does not create an index or fall
back to an unbounded reverse scan. Global safety-ledger reads have no filter and
stop at the preservation budget.

The observed production index inventory has no observation_id-leading index on
canonical_trader_event_observations. This tool therefore reports that reverse
lookup as blocked. The regression test adds such an index to an isolated fixture
only. No production index or database change is made in this stage.

Source byte immutability is tested against an isolated fixture, not asserted for
concurrent live WAL files. Row fingerprints include typed original values and are
not a substitute for retaining replayable evidence.

## Still required before migration

Target DDL and precision mapping, a complete semantic reference inventory,
per-purchase reconstruction, 30-day market coverage, real purchase receipts,
coherent backup/delta journal, exact isolated target round-trip and separately
approved production migration/cutover remain gates. Legacy completion receipts are
not promoted, FOMO stays paused, and signal delivery stays disabled.

## Tests

~~~bash
pnpm exec vitest run packages/database/test/full-data-row-protection.test.ts
pnpm --filter @address-radar/database typecheck
~~~
