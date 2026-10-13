# Resource maintenance and full preservation acceptance

## Decision

The resource-only pause and restoration path passed actual host acceptance. Full PostgreSQL preservation acceptance remains NO-GO because the resume process exceeded its existing RSS limit. No production database or release switch occurred.

## Maintenance repair acceptance

The previous pause failure was traced to an explicitly stopped service exiting with status 143 and being classified by systemd as failed. The controller previously waited exclusively for inactive/dead. Actual host lifecycle logs and an isolated systemd exit-status probe established the representation `Result=exit-code`, `ExecMainCode=1`, and `ExecMainStatus=143`; this combination alone does not prove a SIGTERM or a safe writer fence.

The repaired controller accepts this resource-quiescent state only with original active MAIN membership, a successfully dispatched stop receipt bound to the same running instance, PID zero, an empty original cgroup, and no inflight jobs. It preserves private stop proof and rechecks it for paused-state verification. Original failed auxiliary services remain untouched.

Restoration now performs bounded startup checks for transient missing environment evidence on Type=simple services. Explicit true, duplicate or invalid values, configuration drift, and failed final verification remain errors. Restoration success still requires positive false evidence and stable process identity. No production exit-status configuration was changed.

Helper SHA256: `76916e06254d6a5f15a329b19b79ea2afd62db87b03faf13e611c418ee7a5256`.

Test SHA256: `ffc33b17ba050fdbcb38bbe834d611c1ae98d2b5b5b8b2ce7c4adae96af79d0d`.

All 73 controller regression tests passed in the parent run. An independent reviewer read the changed methods and tests and reported no P0/P1 in the reviewed scope. New-version actual watchdog and manual no-ops both returned restored, using nonces `cb20c608e2d3e567` and `6ea9be264263fb32` respectively.

## Actual resource window

Nonce: `32fd68516a81ea3f`.

Baseline SHA256: `dcc2b43f0f30e2b7ee0711f099a78ce5e14c5878657270e7943b6fa54e29137c`.

The independent 55-minute recovery timer was armed. Pause completed successfully; six MAIN services and five application timers were quiescent. FOMO collector, login, and noVNC retained their original processes. Available memory after pause was 3,192,627,200 bytes and filesystem free space was 30,429,270,016 bytes. This was resource maintenance, not formal migration fencing.

## Private preservation results

Source scope: 141 tables, 6,023,033 rows, 1,548 chunks, immutable backup-derived data.

| Stage | Result | Evidence |
| --- | --- | --- |
| Install | Passed | Exit 0; no historical rows committed during ledger installation |
| Interrupt | Passed | Fresh source validation; durable commit of 2 chunks and 4,097 rows; intentionally interrupted afterward |
| Resume | Refused by resource guard | External RSS 269,717,504 bytes exceeded 268,435,456 bytes; process terminated after about 180 seconds |
| Full parity | Not accepted | No complete 141-table PostgreSQL parity result |

Interrupt ran from `2026-10-04T14:47:58.741Z` to `2026-10-04T14:55:15.807Z`. Its report recorded 620 physical SQL statements, 6 acknowledged commits, fresh source hashing without a cached witness, maximum memory PSI avg10 of zero, and a process RSS peak of 261,926,912 bytes. The commit count includes control transactions and must not be interpreted as six imported chunks.

Resume ran from `2026-10-04T14:55:22.859Z` to `2026-10-04T14:58:23.078Z`. Available system memory remained at least 3,009,470,464 bytes. The new blocker is the runner's own RSS budget, not system memory reserve. No completed resume-stage receipt was produced; do not infer additional acknowledged progress from older reports copied into its evidence bundle.

Prior calibration was reused with authenticated provenance. Its commits and memory figures are historical calibration evidence, not current full-run import progress. Fresh source validation was not skipped.

Evidence directory: `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-9qWnKZ`.

Execution log: `/private/tmp/address-radar-full-preservation-maintenance-32fd68516a81ea3f.log`.

## Recovery and boundaries

Private lifecycle cleanup was confirmed. The shell exit recovery returned `status=restored` and `phase=restored`. All six MAIN services were active/running; all five application timers were active/waiting. FOMO processes remained unchanged; the originally failed protocol-audit auxiliary service was preserved.

Independent post-recovery process checks confirmed `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` for all six MAIN services. Both window transient units were not-found/inactive/dead. Current release remained `/opt/address-radar/releases/4b48fc2-forward-token-code`.

The 4,097 committed rows existed only in the isolated rehearsal instance, which was cleaned up. They are not migrated production data. Source data, production configuration, business eligibility rules, and release bindings were not changed.

## Next gate

Investigate and reduce the preservation runner's RSS peak without raising resource limits, skipping fresh source hashes, or weakening reconciliation/parity checks. Add focused memory regression coverage, then repeat the private full import/resume/parity under a separately supervised resource window. Formal migration still requires its final fenced snapshot and independently accepted rollback evidence.
