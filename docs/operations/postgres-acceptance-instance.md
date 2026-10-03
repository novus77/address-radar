# Isolated PostgreSQL Acceptance Instance

## Scope and authorization

The operator approved a new resource-limited, loopback-only PostgreSQL instance on `152.32.185.240`. This approval does not activate the forward business pipeline, migrate SQLite, change business services, resume browser capture, or enable signal delivery.

The existing six business services and their process IDs must remain unchanged. Gateway delivery must remain `false`. The paused FOMO capture process must remain stopped. The active release pointer must remain unchanged throughout infrastructure provisioning.

## Installation contract

- Ubuntu 24.04 signed distribution packages, PostgreSQL major version 16.
- Refuse package upgrades/removals, existing clusters, occupied database ports, and overwrites of prior acceptance installation state.
- Temporarily deny package-maintainer service actions and suspend `needrestart` during package installation. Remove only the script's unchanged temporary policy.
- Install cluster-management/client packages before the server; disable automatic `main` cluster creation.
- Create only `16/radaracceptance`, configured for manual startup. A reboot does not automatically activate it.
- Listen only on `127.0.0.1:5433`; no external firewall opening.
- Database `address_radar_acceptance_test`, separate from every production SQLite file.
- Restricted login `address_radar_acceptance`: no superuser, role creation, database creation, or replication privileges; connection limit 8. Authentication permits only this database over loopback.
- Store the generated acceptance connection URL in root-owned mode `0600` `/etc/address-radar/postgres-acceptance.env`. Never print, commit, or add it to business service environments.

## Resource and durability envelope

| Setting | Acceptance value |
| --- | --- |
| systemd memory high / maximum | 384 MiB / 512 MiB |
| systemd additional swap | 0 |
| CPU quota | 50% of one CPU |
| task maximum | 64 |
| PostgreSQL shared buffers | 64 MiB |
| Connections / per-operation work memory | 12 / 2 MiB |
| Maintenance / autovacuum work memory | 32 MiB / 16 MiB |
| Parallel query/maintenance workers | Disabled |
| Temporary file limit | 64 MiB per process |
| WAL checkpoint target | 256 MiB; not a hard disk quota |
| Statement / lock / idle transaction timeouts | 30 s / 5 s / 30 s |
| Data checksums / fsync / synchronous commit / full-page writes | Enabled |

These are isolated acceptance limits, not approved production capacity or pool-size defaults. Total query memory can exceed a single `work_mem` setting; the cgroup is the final limit. An out-of-memory termination fails acceptance rather than weakening durability. See the [PostgreSQL resource configuration reference](https://www.postgresql.org/docs/16/runtime-config-resource.html).

Dedicated diagnostic logs use daily logrotate with `maxsize 5M` and three rotations. Rotation is schedule-driven, not a hard instantaneous disk bound. SQL statements and error parameters are not logged. Existing business logs are untouched.

## Execution

The script requires root, explicit installation approval, and the currently paused capture PID. Do not reuse a stale PID without confirming the paused process identity.

```bash
sudo env ADDRESS_RADAR_PAUSED_CAPTURE_PID=1269600 \
  bash scripts/provision-postgres-acceptance.sh --approved-isolated-instance
```

On failure, stop only the new acceptance cluster and preserve its data/configuration. Never remove its files to make a failed run look successful. A partial installation requires review before another attempt; this script deliberately refuses blind overwrite/recreation.

## Required acceptance evidence

1. Package installation adds packages without upgrading or removing existing packages.
2. Only the named cluster exists and only loopback port 5433 is listening.
3. Restricted-role connection, transactional insert, and rollback pass in the acceptance database.
4. Administrative-database access is denied for the acceptance role.
5. Actual systemd resource properties match the limits.
6. The six business services remain active with identical PIDs/restart counters, release pointer unchanged, delivery disabled, and paused browser capture preserved.
7. Console remains reachable; at least 512 MiB available memory remains after startup.

This evidence establishes infrastructure readiness only. Repository integration tests, real execution verification, identity attribution, opportunity/ability consumers, live-feed coverage, retention, and an separately approved write-path cutover remain distinct acceptance gates. No completed infrastructure check proves end-to-end business closure.
