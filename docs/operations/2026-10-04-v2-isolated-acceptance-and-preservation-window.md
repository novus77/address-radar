# V2 isolated acceptance and remaining preservation gate

## Decision

Production migration remains NO-GO. Local regression and actual V2 six-service startup acceptance passed. Full preservation import/resume/parity, fresh final writer fencing, and independent same-data compatible PostgreSQL rollback acceptance have not passed. No production business database or release was switched.

## Accepted repairs and local results

- Installation helper rejects invalid inputs through its Promise interface.
- Explicit protocolVersion 2 selects physical service schema 3. Inherited protocol choices are rejected. Legacy schema versions 1 and 2 remain unchanged.
- Coordinator and cohort integration fixtures bind V2 signed closure, journal, plan, independent synthetic rollback proof, and atomic native first-write markers without restoring V1 write authority.
- Both V2 JSON constraints fail closed on SQL NULL.
- Parentheses around extracted JSON operands correct PostgreSQL subtraction precedence in exact-key checks. The first actual V2 installation exposed this issue; a fresh isolated run validated the repair.
- Final trusted schema 3 fingerprint: b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383.
- Registry contains 79 tables, including 19 support tables. Four independently installed preservation ledger tables are not silently added to that registry.

Final frozen full regression: 298 files passed, 25 files skipped; 2613 tests passed, 107 skipped. The separately isolated source-memory test passed in one additional file. Thus these two local runs cover 2614 distinct passing tests in 299 files. Opt-in skips are not production acceptance.

Database and automation production/test project type checks passed. Root entry and G11 source/test strict type checks passed.

Local full-suite log: /private/tmp/address-radar-v2-ddl-fixed-full-regression-20261004.log.

## Actual private PostgreSQL 16 V2 six-service acceptance

The fresh same-nonce target was radar_rehearsal_ff7ab361e7d7ad29, schema radar_rehearsal_ff7ab361e7d7ad29_schema, port 5434. Its signed authority was synthetic and restricted to this private target.

- Schema 3 with physical V2 ledger and marker installed.
- Coordinator commit followed by physical reconciliation of ledger, marker, and business heads passed.
- All six actual native loader/CLI/IPC service children became ready, polled once, drained once, and exited 0.
- No SQLite fallback; external fetch calls were zero.
- Console made three requests under the existing read-only guard.
- Maximum observed whole-process-tree RSS was 252518400 bytes, below the unchanged 268435456-byte ceiling.
- Minimum observed MemAvailable was 1115332608 bytes; minimum free disk was 30220701696 bytes.
- Sealed fixture and private cluster cleanup both confirmed.
- Actual opt-in file result: 17 tests passed. This includes offline tests already covered above; do not sum the counts.

This is sequential isolated startup/marker evidence, not six-service concurrent production capacity, complete historical data coverage, external production authorization, or actual independent production rollback acceptance.

Log: /private/tmp/address-radar-v2-native-six-services-ddl-fixed-20261004.log.

## Full preservation attempt

A new read-only resource observation at 2026-10-04T12:21:45Z showed memory PSI some avg10=0.18, materially below the earlier blocked attempt. This justified one bounded retry, not a guard waiver.

The private full-preservation run used a 55-minute total deadline and unchanged resource guards. Installation ran from 2026-10-04T12:22:54.910Z to 12:22:55.313Z and failed with preservation_rehearsal_memory_pressure:

- Memory PSI avg10: 3.14.
- Available memory at refusal: 1332396032 bytes.
- RSS at refusal: 54185984 bytes.
- Free disk at refusal: 30377664512 bytes.
- Physical SQL statements, commit attempts, acknowledged commits, and acknowledged rollbacks: all zero for this installation attempt.
- Lifecycle cleanup confirmed; productionAuthorized=false.

The report includes a reused prior single-chunk calibration. Its recorded commits are historical calibration evidence, not new full-import progress.

Evidence: /var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-0Cu2YX/install.json.

The immutable source still represents 141 tables, 6023033 rows, and 1548 chunks. Its complete PostgreSQL import, interruption/resume, typed parity, and restore remain unaccepted. Do not retry under unchanged resource conditions.

## Proposed resource-only maintenance scope requiring explicit approval

Maximum window: 60 minutes. Record original states before any action. Pause the six main Address Radar services, the five application timers, and their corresponding synchronization/backup/audit jobs. Preserve the FOMO login page, noVNC, collector, all business databases, event data, immutable snapshots, and backups. Do not formally migrate, change the release, or enable delivery in this resource-only window.

Restoration must follow recorded prior states and be independently scheduled before pausing writers. Success, failure, cancellation, and timeout must all restore the recorded service/timer states; failed or inactive one-shot units must not be arbitrarily started. The tested runner deadline alone is not proof of production restoration orchestration.

Use only the old immutable source and a private PostgreSQL target to establish full import/resume/parity. Validate the bounded stop/restore orchestration before executing the window. Abort safely if resource or disk guards refuse, retaining diagnostic evidence and restoring prior states.

## Subsequent formal cutover gates

- Full preservation and restore accepted under unchanged guards.
- Complete approved writer scope, including timers, bridges, operators, deployment admission, and scheduled writers.
- Explicit signed target, time window, budgets, and pinned artifact bindings.
- Actual fence with no residual source writer handles or mappings.
- Fresh final consistent snapshot and typed parity, not the older rehearsal snapshot.
- Independently verified retained-data compatible PostgreSQL rollback release and evidence.
- Final scoped production cutover approval and post-switch closed-loop acceptance.

Local and synthetic private receipts cannot grant production write authority or replace these gates.
