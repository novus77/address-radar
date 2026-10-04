# Reviewed Purchase Reverse-Index Maintenance

## Approved scope

The operator approved a consistent production SQLite backup, creation of one
nonunique reverse-lookup index, and read-only revalidation. This approval does
not authorize formal PostgreSQL migration, release cutover, service restart,
business-row correction, data deletion, or gateway delivery.

The reviewed source is `/var/lib/address-radar/address-radar.db`. The affected
table is `canonical_trader_event_observations`.

```sql
CREATE INDEX "idx_canonical_trader_event_observations_observation_id"
ON "canonical_trader_event_observations" ("observation_id", "canonical_event_id");
```

## Execution gates

- All six business services must remain active; actual process environments
  must each contain exactly `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
- Preserve the initial release, process identities, and restart counts.
- Refuse index-name collisions, reviewed schema mismatches, and schema drift
  between the backup snapshot and index transaction.
- Require backup size plus a conservative index/WAL reserve and at least 3 GiB
  of remaining disk headroom. Check remaining headroom during backup.
- Require targeted tests, full tests, test types, project builds, and root types
  before production execution.

## Backup and audit

`scripts/apply-reviewed-purchase-reverse-index.py` creates a unique private
operation directory under `/var/backups/address-radar/index-maintenance/`.
The backup is exclusive-create, mode `0600`; the directory is mode `0700`.
Existing backups and operation directories are never overwritten.

The SQLite online backup reads one pinned source snapshot. Release that source
snapshot before validating the backup to avoid pinning production WAL during
the longer validation phase. Reopen the standalone backup read-only, require
`PRAGMA quick_check` to return `ok`, verify metadata, and record its SHA-256.
This is a quick-check result, not a claim that every business invariant or a
full `integrity_check` has passed.

The durable operation journal records approval scope, code digest, source
inode/device, backup verification, index ownership, service guards, and phase.
Audit files are fsynced before the corresponding transaction can commit.
Do not output account identifiers, raw event payloads, or process credentials.

## Bounded index transaction

Use one `BEGIN IMMEDIATE` attempt, a 250 ms lock wait, and a 5 second transaction
deadline. Hash the ordered link contents before and after index creation in
that same writer transaction. Require the nonunique BINARY key definition and
an indexed `SEARCH` query plan. Record ownership durably before `COMMIT`.

An error before commit rolls back the index transaction. Do not retry lock
contention autonomously. Business services remain running throughout. Backup,
quick-check, hashing, and the overall remote execution have separate bounds.

## Unknown outcomes and rollback

If SSH disconnects or execution is terminated, do not rerun with a new operation
identity. Inspect that operation's journal and `sqlite_schema` read-only first.
An `index_prepared` journal alone is not proof that commit succeeded.

Never drop a committed or pre-existing index automatically. Any later approved
index rollback must verify that its current table, definition, uniqueness,
collation, and key order match the recorded ownership. Restore from the backup
only under a separate outage/restore approval; blindly replacing a live source
would discard legitimate changes made after the backup.

## Read-only acceptance

Run the existing purchase dependency and market inventory preflights against
the same previously reviewed source/event hash. The expected local improvement
is removal of `unindexed_dependency_lookup` for the link table and transition
of its reverse lookup to `already_covered` with `SEARCH`.

Keep reporting historical price gaps, independent provenance gaps, unresolved
identity dependencies, and global-guard coherence requirements. Two historical
market points are not a complete 30-day price coverage proof. A functioning
index is not proof of transaction accuracy, trader eligibility, migration
readiness, or full closed-loop acceptance.

Verify services, restart counts, release, delivery flags, recent bounded SQLite
error logs, and remaining disk after execution. Preserve the verified backup
and journal for the subsequent separately approved migration stage.
