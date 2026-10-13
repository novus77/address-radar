# Consistent SQLite Snapshot and Full Preservation Rehearsal

This tool prepares an isolated migration artifact. It never activates consumers, changes the source schema, merges identities, resumes FOMO/historical mining, or enables delivery. A passing local fixture is not a passing production migration.

## Snapshot

`scripts/consistent-sqlite-migration.py snapshot` uses SQLite's online backup API from a read-only source connection. It includes committed WAL contents without running a checkpoint. The pinned source read transaction ends before destination integrity verification and SHA-256. The new target is exclusive and mode 0600; failed output remains a private, unverified artifact, never a completed backup.

The scheduled backup script now delegates to this tool. Its existing pages-per-step, sleep, free-space reserve and overall timeout controls remain explicit. Timestamp collisions fail instead of overwriting a backup. Scheduled retention considers only ordinary timestamp backup directories and skips maintenance/migration markers. Do not place a protected migration artifact under an ordinary pruning policy.

The recorded approximately 273-second verification of the real maintenance snapshot indicates that the old 300-second scheduled deadline may need a separately reviewed capacity budget. The tool fails closed; it does not silently extend this budget. Disk, WAL growth during the pinned snapshot, source writer pressure, and available memory must be measured before a production-sized rehearsal.

```bash
python3 scripts/consistent-sqlite-migration.py snapshot \
  --source "$SOURCE_SQLITE" --target "$NEW_PRIVATE_SNAPSHOT" \
  --operation-id "$OPERATION_ID" \
  --deadline-seconds "$APPROVED_DEADLINE_SECONDS" \
  --minimum-free-bytes "$APPROVED_FREE_SPACE_RESERVE" \
  --pages-per-step "$APPROVED_BACKUP_PAGE_BATCH" \
  --sleep-ms "$APPROVED_BACKUP_SLEEP_MS"
```

## Full export

Export requires a closed, non-WAL snapshot with an explicitly matching SHA-256. It refuses a live WAL source. Source connections are read-only and do not invoke application schema migration, registry outbox drains or consumers.

The catalog retains table DDL, views/triggers/index SQL, table-xinfo columns, grouped composite foreign keys, index-xinfo collation/direction, internal autoincrement sequences, encoding and application/user versions. All non-system tables are included, including empty tables. Virtual tables or a table without a replayable ordering require an explicit adapter; they are not silently omitted.

Rows preserve SQLite storage types: NULL, integer decimal strings, real hexadecimal strings, BLOB base64 and TEXT raw database-encoding bytes in base64. This protects large integers, exact observed floating-point values and invalid text bytes. Historical nonfinite REAL values can be preserved but are not valid active trade evidence. Preservation never upgrades original numeric precision, identity ownership or data quality.

Private chunks contain operation/snapshot/table/ordinal/start-row lineage. Every chunk has a byte digest; every table has a row count and ordered content digest. The manifest is fsynced atomically after chunk progress. Resume requires the same snapshot, catalog and chunk limits and reconciles existing bytes; completed chunks are never overwritten. An incomplete manifest is not import-ready.

```bash
python3 scripts/consistent-sqlite-migration.py export \
  --source "$VERIFIED_SNAPSHOT" --source-sha256 "$SNAPSHOT_SHA256" \
  --target "$NEW_PRIVATE_BUNDLE_DIRECTORY" --operation-id "$OPERATION_ID" \
  --deadline-seconds "$APPROVED_DEADLINE_SECONDS" \
  --minimum-free-bytes "$APPROVED_FREE_SPACE_RESERVE" \
  --maximum-chunk-bytes "$APPROVED_CHUNK_BYTES" \
  --rows-per-chunk "$APPROVED_CHUNK_ROWS"
```

For an explicitly reconciled interruption, add `--resume` with the same operation identity and limits. Export scans the immutable snapshot in deterministic order; resume may rescan verified prefixes. It is not a live change-capture mechanism, and must not be used to imply that timestamp-based final deltas are complete.

## Isolated restoration

Restore verifies the complete bundle before creating an exclusive new target. It recreates source tables, inserts lossless values without firing source triggers during import, then restores indexes/views/triggers and sequence/version metadata. It checks integrity, exact catalog and every table's ordered value/count digest. Text bytes are interpreted under the recorded database encoding, not assumed to be UTF-8.

Unresolved source foreign keys can remain in historical preservation. A bounded foreign-key diagnostic is reported, never hidden or converted into new eligibility. Production import additionally needs the complete semantic-reference and row-crosswalk audit.

```bash
python3 scripts/consistent-sqlite-migration.py restore \
  --source "$COMPLETED_PRIVATE_BUNDLE_DIRECTORY" \
  --target "$NEW_ISOLATED_RESTORE_SQLITE" \
  --deadline-seconds "$APPROVED_DEADLINE_SECONDS" \
  --minimum-free-bytes "$APPROVED_FREE_SPACE_RESERVE"
```

## Acceptance boundary

The receipt always reports business activation and delivery false, and production migration readiness false. To claim a production-sized preservation rehearsal, attach the verified source snapshot identity, all 141 table receipts, measured limits, full restore receipt and app read checks. Source catalog parity alone, or this tool's unit tests, cannot substitute for those artifacts.

A formal switch still needs a provisioned business PostgreSQL schema, typed active projections, all writer/input fences, a final coherent delta or fenced snapshot, six-service wiring, provider/authorization revalidation and rollback after new writes. Raw retention and backup deletion remain separate approvals.
