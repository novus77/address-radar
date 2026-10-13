# Bounded PostgreSQL Business-Schema Backup

## Scope and deployment boundary

This independent Python tool backs up the structure and data of `address_radar_business` using PostgreSQL 16 `pg_dump --format=custom --schema=address_radar_business --strict-names --no-owner --no-acl`. It never uses `--schema-only`, touches SQLite, deletes old backups or business data, or installs/enables any service or timer. It is separate from the stability c build and release ownership.

Code and local tests are provided only. Parent deployment must follow review. Do not reuse or enable the existing SQLite backup script or its timer.

## Safe defaults and required inputs

The backup root must already exist as a root-owned directory with mode `0700`. Configuration and passfile must be root-owned regular single-link files with mode `0600`. All path ancestors must be root-owned and not group/world writable; symlinks and path normalization tricks are refused. Use real PostgreSQL binary paths, not distribution wrapper symlinks, and independently pin both binary SHA256 values. `pg_restore` is used offline for archive inventory and generation hashing, not for a database restore.

The defaults and enforced ceilings are a 45-second total deadline and a 64 MiB dump cap. The minimum disk floor is 3 GiB. Admission requires the floor plus the configured dump cap and a 64 KiB metadata reserve; the floor is rechecked throughout subprocess polling and before writes and publication. The receipt records the actual budgets. Defaults should remain unchanged unless a smaller cap/deadline or larger disk floor is explicitly selected.

Only an explicitly supplied Unix-socket host is accepted. Ambient libpq credentials and service configuration are not inherited. The passfile is inherited through a validated descriptor; its contents never enter arguments, receipts, stdout, or stderr. Backup connections request read-only transactions. A dedicated read-only backup role must be provisioned separately; this tool neither creates roles nor changes grants. Do not enable row security as a way to silently omit backup rows.

Example configuration, with binary pins supplied by the deployment owner:

```json
{
  "backupRoot": "/var/backups/address-radar/postgres",
  "pgDump": "/usr/lib/postgresql/16/bin/pg_dump",
  "pgDumpSha256": "REPLACE_WITH_VERIFIED_SHA256",
  "pgRestore": "/usr/lib/postgresql/16/bin/pg_restore",
  "pgRestoreSha256": "REPLACE_WITH_VERIFIED_SHA256",
  "passfile": "/etc/address-radar-postgres-backup/pgpass",
  "host": "/run/postgresql",
  "port": 5432,
  "database": "address_radar",
  "schema": "address_radar_business",
  "username": "address_radar_backup",
  "timeoutSeconds": 45,
  "maximumBytes": 67108864,
  "minimumFreeBytes": 3221225472
}
```

Omit `runId` for a unique timestamp/random identifier on every scheduled invocation. An explicitly supplied identifier is never reused. The example pins are intentionally invalid until rendered; there is no secret in this example.

```bash
python3 scripts/backup-postgres-business-schema.py --config /absolute/root-private/job.json
```

This command is documentation, not a deployment instruction or evidence of a production run.

## Publication, failure, and last-good semantics

One nonblocking filesystem lock serializes this tool for a backup root. Each run creates a private, exclusive directory and streams the archive into `business.dump.partial`. The supervisor drains and bounds stderr without logging it, limits archive bytes before writing, checks the same original deadline, and retires the entire subprocess group on success or failure. CLI wall-clock alarms also cover preparation and filesystem work; systemd provides an independent process-group timeout.

Successful dumps must have custom-archive magic and pass an offline table-of-contents check for `forward_strategy_generations`. The generation table is rendered with `pg_restore --data-only --schema=address_radar_business --table=forward_strategy_generations --no-owner --no-acl --file=-`; no target database is supplied or connected. `generationHash` is the SHA256 of these exact bounded SQL bytes, identified as `pg-restore-table-data-sql-v1`. This is an archive-bound projection hash, not a claimed canonical logical row hash or restored row-count verification.

After artifact fsync and validation, the archive becomes `business.dump`. The receipt includes schema, generation hash/encoding, archive size/SHA256, tool pins/versions, budgets, and explicit incomplete-restoration flags. Receipt and success records are published atomically without replacing an existing file, with file and directory fsync. Only the successful publication's temporary metadata alias is removed; archive contents and previous receipts/markers are never deleted.

Last-good records are append-only `last-good-<runId>.json` files, not a mutable pointer. Previous verified records remain byte-for-byte intact on every failure. Select the latest verified `completedAtMs` only after validating its receipt and archive pins; do not infer success from a directory or dump filename. A publication fsync failure reports `publication_uncertain`; retain all artifacts and reconcile, rather than automatically retrying or selecting that new record.

Failures retain partial artifacts and any diagnostic metadata already published. Output contains only fixed refusal codes or safe receipt pins; raw exceptions and database stderr are never emitted. No automatic retention deletion is implemented. Parent policy should retain verified backups for at least 15 days, retain migration originals separately, and stop new runs when capacity is insufficient.

## Scheduling and alert contract

The new service has no installation target. The `.timer.in` file has no usable schedule until the parent renders `@PARENT_APPROVED_BACKUP_INTERVAL@`. Neither template is enabled by this work. After review, the parent may approve a daily schedule and an independent alert if the newest verified successful backup is older than 26 hours or missing. Alert delivery and timer deployment are not implemented or claimed here. The earlier SQLite timer must remain unused for PostgreSQL assurance.

Daily logical backups target an RPO of approximately 24 hours; this is not PITR. A 26-hour stale-backup alert detects missed runs but does not guarantee RPO. No WAL archival or continuous recovery capability is provided.

## Independent restore and security contract

Restore verification must use a separate empty PostgreSQL 16 database/cluster with private socket access and no production service connection. It must verify schema, constraints/indexes, generation bindings, sequence state, and counts against the captured backup. This script never performs that restore. Schema selection does not automatically include dependencies outside the selected schema.

For custom archives, `pg_dump --no-owner` does not replace the need for `pg_restore --no-owner --no-privileges`. Roles, memberships, ownership/ACL reconstruction, database-level settings, credentials, extensions, tablespaces, and cross-schema dependencies require an independently reviewed recovery contract. This artifact is not a complete database-cluster backup and cannot authorize production recovery or service activation.

Existing restore evidence was reported by the parent for the earlier archive, not produced by this new tool: schema 3, 216 wallets, 122 entities, one generation, with `readonly=on` verification. The dump is 1,139,501 bytes with SHA256 `dacb5194fb37349cb10a6c46bb86dbf69c10e6b0401d4cedb912a48d9991f116`. The root-private `0600` receipt is `/var/backups/address-radar/postgres-address-only-20261008a/business-restore-count-receipt-20261009.json`, SHA256 `0938352f1cc3a0ff3079e707b7c5e1f3786fa59f498145fcdc3086e0b98b118b`. This evidence must not be relabeled as a run of this tool or full disaster-recovery acceptance.

## Local validation and review handoff

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test/backup-postgres-business-schema.test.py
```

Tests use real short-lived fake PostgreSQL executables and filesystem writes in temporary directories. Root identity and the temporary directory's sticky writable ancestor are simulated for local non-root execution. They do not connect to PostgreSQL or establish native production root-path or restore acceptance.

Aristotle review should focus on descriptor-bound path validation, exclusive publication and uncertain fsync handling, aggregate deadlines and process-group retirement, continuous disk/size limits, offline generation-hash semantics, and the separate role/ACL recovery contract. Deployment and scheduling remain parent-owned after review.
