# PostgreSQL Backup Production Acceptance

Date: 2026-10-09. All local timestamps use Asia/Shanghai (UTC+08:00).

## Accepted scope

The first native PostgreSQL business-schema backup, its dedicated daily schedule,
and an independent data restore of that exact archive passed. This closes the
current backup deployment stage, not full database disaster-recovery acceptance.

The archive contains structure and data for `address_radar_business`. It is not a
schema-only export. No production business data, previous restorecheck database,
or historical backup was modified or deleted. Existing SQLite backup timers were
not enabled or changed. Gateway delivery remains disabled.

## Production deployment

Deployment receipt time: **2026-10-09 09:44:59.074 +08:00**.

The deployment reused `address_radar_readonly_operator` and its existing private
credential without adding database privileges or increasing its connection limit
of one. The actual native dump proved that libpq authenticated over the Unix
socket using the generated private passfile; socket matching was not inferred
from path syntax alone. No credentials are recorded here.

An exact HBA rule was inserted before the existing local reject rule:

```text
local address_radar address_radar_readonly_operator scram-sha-256
```

HBA parsing reported zero errors and configuration reload succeeded. PostgreSQL
was not restarted and no public TCP access was added. The original HBA was saved
privately before the change.

| Artifact | Production path | SHA256 |
| --- | --- | --- |
| Deployment receipt | `/var/lib/address-radar-maintenance-tools/postgres-backup-deploy-62b75702e35cb6e2/deployment-receipt.json` | `a09c8c5e5339b40024ebe65b9623f6f9ade88b4085f2137f18052c9fb222b692` |
| Original HBA copy | `/var/lib/address-radar-maintenance-tools/postgres-backup-deploy-62b75702e35cb6e2/hba-original.conf` | `5f43715c63bd50269ff79aa62f8e75161d4301ac9bfebf7e2bbf228c8ab321d5` |
| Installed HBA | `/etc/postgresql/16/radarproduction/pg_hba.conf` | `efe885c4b393253d0eda10e05f7e70c229d4d2769f838f28607de73ba3d0eba8` |
| Reviewed backup tool | `/var/lib/address-radar-maintenance-tools/postgres-backup/backup-postgres-business-schema.py` | `aa994eecd1e68618ebda24de27921b260a96c394a24009bed4a111773006b589` |
| Rendered service | `/etc/systemd/system/address-radar-postgres-backup.service` | `fcf4e161f062e85e7bd8d9cc351d29a81681a3aa6db6eecf614dbb40c3475230` |
| Rendered timer | `/etc/systemd/system/address-radar-postgres-backup.timer` | `934b6641a1054b01f4773cb7121b7decae0cd10b6901dffa6f345a0cdc3f0c21` |

The tool is root-owned `0400`; job configuration and passfile are root-owned
`0600`; `/var/backups/address-radar/postgres` is root-owned `0700`. The rendered
service invokes Python with `-I -B` and uses control-group termination.

## First native backup and schedule

Run ID: `20261009T014457Z-5ab012cc1aa64f44`.

| Artifact | Production path | SHA256 |
| --- | --- | --- |
| Archive | `/var/backups/address-radar/postgres/20261009T014457Z-5ab012cc1aa64f44/business.dump` | `22bf885753817e6187c897795a5c16bde5f3cd300c0f41ff5784864559fae1e3` |
| Backup receipt | `/var/backups/address-radar/postgres/20261009T014457Z-5ab012cc1aa64f44/receipt.json` | `1077298d255f7542365b1ff92347f8f12ebe40a7b70ab979c83dcf50f371b488` |
| Last-good marker | `/var/backups/address-radar/postgres/last-good-20261009T014457Z-5ab012cc1aa64f44.json` | `59458fcfd0a9690893f07d88a4d777171db42915f55a27caaf31d9ae42fc9ce6` |

Archive size: **1,825,211 bytes**. The service reported `Result=success` and
`ExecMainStatus=0`. Archive bytes, receipt pin, marker binding, and private file
permissions were independently checked before timer activation. A marker's mere
existence is not the acceptance criterion.

Native tools: PostgreSQL 16.15, Ubuntu 16.15-0ubuntu0.24.04.1.

```text
pg_dump  /usr/lib/postgresql/16/bin/pg_dump
SHA256   5abfee921d2efd952aa91912b033285820575df17840bb1faf69f8f9b0431e8d
pg_restore /usr/lib/postgresql/16/bin/pg_restore
SHA256     eb91db5f9ce7a1e4d8a72a9319544f5944ef00b6741c948b85e0a2ed532f9ad4
```

The offline generation projection hash is
`7f3394a56f170198d07f4a384a8e14639e54d48eb132be95857760bb24e7fe4d`,
encoding `pg-restore-table-data-sql-v1`, over 967 bytes. It is not a substitute for
an independently verified generation/cohort recovery result.

The new timer was enabled only after the successful first run. Observed state:
`enabled`, `active/waiting`, with randomized delay `15min`. Schedule: daily
**02:15 UTC**, randomized delay at most 15 minutes, `Persistent=false`, and
`WantedBy=timers.target`. The next elapse observed at deployment was
**2026-10-09 10:28:59 +08:00**; this records scheduling, not a subsequent run.

Limits: tool total deadline 45 seconds; systemd start timeout 50 seconds and stop
timeout 5 seconds; archive cap 64 MiB; disk floor 3 GiB. Admission reserves the
archive cap and metadata margin above the floor, and capacity is checked during
execution. There is no automatic deletion or backup-retention pruning. Capacity
failure must refuse a new backup rather than remove existing artifacts. A
26-hour stale-backup alert remains an operational follow-up, not a deployed
capability claimed by this receipt.

## Independent data restore

Restore receipt time: **2026-10-09 09:46:49.364 +08:00**.

A new unique database, `address_radar_restorecheck_20261009_8259cc0d3bfa`, was
created without overwriting the earlier restorecheck database. Restore used
`--exit-on-error --single-transaction --no-owner --no-acl`, a 45-second restore
limit, and the bounded archive whose SHA256 appears above. Restore exited zero.
Validation statements were limited to three seconds.

| Validation | Result |
| --- | --- |
| Schema version | 3 |
| Cohort wallets / distinct entities | 216 / 122 |
| Strategy generations / cohort generations | 1 / 1 |
| Profile versions | 216 |
| Missing generation / missing profile / extra profile | 0 / 0 / 0 |
| Missing live address-only import anchor | 0 |
| Missing channel version | 0 |
| Missing or conflicted identity binding | 0 |
| Missing or changed head / orphan head | 0 / 0 |
| Constraints / unvalidated constraints | 258 / 0 |
| Indexes / invalid, not-ready, or non-live indexes | 119 / 0 |
| Database connection limit | 1 |
| PUBLIC database privileges | None |
| Default and validation transaction read-only | on / on |

The restorecheck database is retained with default read-only enabled; no deletion
or further writes are authorized by this acceptance. Default read-only is an
operational freeze, not a claim that a privileged administrator cannot override
it.

```text
Receipt:
/var/backups/address-radar/postgres/20261009T014457Z-5ab012cc1aa64f44/address_radar_restorecheck_20261009_8259cc0d3bfa-receipt.json
SHA256:
7248d44a7173c46f1beb4a3ae049b8c0a0c70fa2bc995ee6cb9d8a6513c6b856
```

## Production service and business-data boundary

The six production services were active with `NRestarts=0` in the reported
stability snapshot. During backup deployment, their PIDs, active states, and
restart counters remained identical to the pre-deployment snapshot. Wallet
monitor uses its dedicated OS identity; the other five retain `address-radar`.
This is point-in-time evidence, not a promise of future uninterrupted operation.

The read-only inventory at **2026-10-09 08:21 +08:00** found zero capture raw and
normalized records, fact inputs and attestations, purchase samples, economic
trades and trade revisions, and token discovery links/watches. Provider lease
activity and collector checkpoints are not evidence of completed business
ingestion. Those zero counts were not remeasured during the backup deployment;
this document does not claim a successful trading or radar loop.

## Explicit exclusions and freeze

- Role, membership, ownership, and ACL reconstruction have **not** passed an
  independent full-recovery acceptance. `--no-owner --no-acl` restore counts do
  not prove security-policy recovery.
- This is not a complete cluster backup; cluster globals and dependencies
  outside the selected schema require a separate recovery contract.
- WAL archival/PITR and a guaranteed recovery time have not been implemented or
  verified by this work. Daily logical backups target approximately a 24-hour
  RPO only while scheduled backups continue succeeding.
- Business-data deletion, a 15-day business retention policy, and automatic
  backup deletion were not implemented or authorized by this acceptance.
- Local independent review passed 25 tests; the native backup and restore
  results above are separate evidence, not inferred from those mock tests.

The current backup stage is complete and frozen. Preserve its archives,
receipts, HBA original, and restorecheck databases. Further security-recovery or
monitoring work must retain these boundaries and must not relabel this data
restore PASS as full disaster-recovery or radar-loop completion.
