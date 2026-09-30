# Scanner Source Observation Conflict Incident

## Incident summary

On 2026-09-27, `address-radar-scanner.service` entered a deterministic retry loop while processing repeated source observations. The same observation identity was reconstructed with changed collection metadata, producing the same `observation_id` and a different content fingerprint. The source ledger threw for every event and the scanner emitted a complete stack trace without backoff.

Observed rate:

```text
59,873 lines / 30 seconds
8.8 MB / 30 seconds
```

The combined syslog and journald growth pushed the root filesystem to 88% usage.

## Preserved evidence

The bounded evidence captured before cleanup is stored on the operator machine:

```text
/tmp/address-radar-scanner-20260927T030842Z.log
/tmp/address-radar-syslog-20260927T030842Z.log
```

SHA-256:

```text
fbfed124256ae8c3568b7c088f6135864282b004566c6782e161619064bca1a5  address-radar-scanner-20260927T030842Z.log
65d0fc0ad4ead066e7af3a3d42e75fd5cc0d4b58fd0655704ef646bccfd919d7  address-radar-syslog-20260927T030842Z.log
```

## Containment performed

- Stopped `address-radar-scanner.service` only.
- Reset the stopped unit from `failed` to `inactive` because the existing unit treats `SIGTERM` exit 143 as a failure.
- Kept automation, wallet monitor, wallet analysis, historical backfill, and console active.
- Rotated journald and retained no more than 1 GB.
- Truncated runaway syslog files after preserving evidence.
- Reduced `/var/log` from approximately 4.1 GB to 1.0 GB.
- Reduced root filesystem usage from 88% to 80%.

No database, import file, or completed backup was deleted.

## Root cause

`SourceObservation.observationId` is derived from source, source event ID, and payload version. The content fingerprint also includes `collectedAt` and the complete payload. Recollecting an otherwise unchanged event with a new collection timestamp therefore looks like conflicting content.

The scanner catches the exception at the per-observation boundary, logs it, and immediately continues. The next collection pass reconstructs the same observations and repeats the loop.

## Resume gate

Do not restart the scanner until all conditions hold:

- Semantic duplicate tests pass.
- Genuine conflicts are persisted without throwing.
- Duplicate observations do not re-enter aggregation or signal evaluation.
- Scanner error aggregation and per-collector backoff tests pass.
- The scanner systemd unit has a bounded log rate.
- Server-side smoke tests pass in an immutable release directory.
- Root filesystem has at least 20% free space.
- Gateway delivery remains disabled.

After deployment, resume the scanner and observe a 30-minute shadow window. Scanner logs must remain below 10 MB and root disk growth below 50 MB during that window, excluding expected database evidence growth.

## Recovery release acceptance

Before restarting the scanner:

1. Confirm `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
2. Confirm at least 20% free space on the root filesystem.
3. Back up the production database and preserve the previous immutable release.
4. Run database migrations while scanner and automation are stopped. Legacy `waiting_source` automation jobs migrate to `blocked_source` without deleting payloads or cursors.
5. Start console, wallet monitor, wallet analysis, historical backfill, and automation before scanner.
6. Start scanner last and observe logs, disk growth, source conflicts, and queue movement for 30 minutes.

The scanner now uses semantic observation fingerprints. Recollection-only timestamps do not create conflicts. Genuine business-content conflicts are aggregated in `source_observation_conflicts` and do not enter normalized event processing.

Repeated errors are rate-limited in the application and in systemd. Consecutive scanner iteration failures use exponential backoff. The disk guard checks once per minute and prevents new scanner iterations when free space falls below `ADDRESS_RADAR_MINIMUM_FREE_DISK_BYTES`.

Rollback is an atomic release-link change. Restore the pre-deploy database only if the new schema is incompatible with the previous release; do not delete the failed release, conflict ledger, blocked jobs, or source observations.
