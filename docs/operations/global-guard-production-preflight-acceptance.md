# Global Guard Production Preflight Acceptance

## Source-side acceptance

The production read-only probe captured one SQLite snapshot at
`2026-10-03T14:47:00.565Z` and completed its reads at
`2026-10-03T14:47:00.891Z`. Total reader invocation elapsed time was 344 ms.

Snapshot ID: `c7dfed18-5942-4f6d-bd99-cb64be01677f`.

Source fingerprint:
`e5b8d1f2e2b7d7bc537a275dd1ad6bb338a66a8d51f0085e92167104d034d611`.

| Ledger | Rows | Pages | Source coverage |
|---|---:|---:|---|
| broadcast_records | 8 | 1 | Complete |
| evidence_consumption | 8 | 1 | Complete |
| economic_evidence_consumption | 8 | 1 | Complete |
| outcome_observations | 0 | 0 | Complete |
| signal_outbox | 0 | 0 | Complete |
| signal_outbox_migration_review | 8 | 1 | Complete |
| provider_budget_usage | 8,280 | 33 | Complete |
| provider_request_gates | 2 | 1 | Complete |
| historical_backfill_credit_usage | 5 | 1 | Complete |

The complete inventory included 8,319 rows in 39 bounded pages. Serialized typed
row representations consumed 4,328,841 bytes under the diagnostic byte cap. This
is not a measurement of database size or growth. All nine ledgers reached their
exhaustion read with no reported issue. No cap was increased to achieve this result.

## Safety observations

All six business services were active and reported `NRestarts=0`. Each main
process had exactly one `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` flag.
The probe used the running Node executable and modules supplied through standard
input. It did not create a permanent export, write business data, change a release,
restart a service, enable delivery or resume FOMO collection.

## Local acceptance

All 12 new isolated reader tests passed. The targeted run spanning this reader
and legacy purchase reconstruction passed 30 tests. Database test type checking
and the complete TypeScript build passed. The complete suite passed 1,135 tests,
with 96 skipped, using two workers. Skipped tests remain outside this evidence.

The tests establish single-snapshot behavior during concurrent WAL writes,
bounded paging beyond 1,000 rows, storage-class preservation, failure limits and
page-acknowledgement handling. A temporary TypeScript inference cycle in page
hash chaining was corrected by explicitly typing the page identity and page;
this did not change the ledger format or any business rule.

## Not established

No sink was installed in the production probe. Consequently
`exportAcknowledged=false`, `targetRoundTripVerified=false`,
`purchaseDependenciesVerified=false` and `productionMigrationReady=false`.
Only source-side inventory completeness passed. This is not a PostgreSQL
round-trip test, a restorable backup, purchase reconstruction acceptance or a
formal migration of all 141 source tables.

The old purchase reader still correctly refuses a preservation slice whose
global/dependency flags are incomplete. This independent ledger report must not
be used to overwrite those flags or to join evidence from unrelated snapshots.

## Next dependency-ordered work

1. Stage actual ledger pages and their manifest in the restricted PostgreSQL
   acceptance database using temporary structures only. Independently verify the
   restored values, ordered counts, page chain and rollback behavior.
2. Compose ledger and per-purchase dependency preservation from one consistent
   source snapshot, retaining referenced parent rows and all execution revisions.
3. Verify original swaps, exact source quantities, economic identity and price
   coverage before proposing business data imports.
4. Present the final migration, activation, rollback and cutover approval package
   together. No formal migration or release/service cutover is authorized by this
   preflight result.
