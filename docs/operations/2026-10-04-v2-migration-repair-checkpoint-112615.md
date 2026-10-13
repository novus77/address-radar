# V2 migration repair checkpoint

## Decision

NO-GO for production migration. Production has not been stopped, migrated, or switched during this repair pass. Passing local adapter tests do not establish full import, writer-fence, or rollback acceptance.

## Completed local repairs

- Repaired two coordinator parser errors.
- Made both V2 JSON CHECK constraints reject SQL NULL using COALESCE.
- Corrected closure snapshot test counts to decimal strings; the negative test now rejects numeric counts.
- Upgraded coordinator fixtures to V2 signed closure, plan/journal binding, and atomic native first-write marker coverage.
- Coordinator 207, closure 48, and root 115 tests passed: 370 total. Database test type checking passed.
- Root, dispatch, and console-progress tests passed: 177 total, overlapping the root tests above. Root strict type checking passed. These counts must not be added together.

## Incomplete installation and native rehearsal work

Installation-layer targeted testing reported 130 passed and one failed. The installer throws synchronously where its Promise-based API is expected to reject. V3 helper tests, final schema fingerprint, and installation acceptance remain incomplete.

G11 V2 fixture changes were written, but offline testing reported 10 passed, two failed, and two opt-in tests skipped. The V1 negative command fixture needs its version field omitted. The native fixture still selects physical schema version 2 instead of the explicit V2 protocol's version 3. Strict G11 type checking has not completed. No actual V2 six-service Linux rehearsal has run.

The permission reviewer refused further installation and G11 repairs under earlier freeze instructions. Owners stopped without retrying or switching tools. A fresh explicit authorization must lift the local freeze before those repairs resume.

Required local repair scope:

- apps/automation/src/postgres-service-schema.ts
- apps/automation/test/postgres-service-schema.test.ts
- packages/database/test/postgres-business-schema.test.ts
- scripts/test/postgres-six-service-runtime-rehearsal.test.ts

The complete regression suite has not passed on this combined V2 revision. Older full-suite results are not current acceptance.

## Production read-only observation

Observed at 2026-10-04T11:26:15Z:

- All six main services active/running; NRestarts=0 for each.
- All six running processes have ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false.
- Release: /opt/address-radar/releases/4b48fc2-forward-token-code.
- Available disk: 30,436,556,800 bytes.
- MemAvailable: 1,288,436 KiB; SwapFree: 84 KiB.
- Memory PSI some avg10=0.44, avg60=0.97, avg300=1.14; full avg10=0.44, avg60=0.70, avg300=0.83.

Disk capacity is no longer the immediate blocker. Concurrent full preservation rehearsal still requires an approved bounded resource window; nearly exhausted swap is not a capacity waiver.

## Remaining migration gates

- Finish local V2 schema/helper/G11 repairs, strict types, and full regression.
- Run actual private PostgreSQL V2 six-service acceptance without weakening existing guards.
- Test bounded maintenance and restoration before a resource-only maintenance window. Preserve operator FOMO login surfaces, collectors, databases, and backups.
- Complete full source import, interruption/resume, typed parity, and restore acceptance against an immutable snapshot.
- Obtain complete production writer scope and signed target/window/budget bindings, actual fence, fresh final consistent snapshot, and independently verified same-data PostgreSQL-compatible rollback evidence.
- Execute formal production migration only after all gates pass and the final scoped cutover is approved.

No historical V1 receipt or SQLite-only rehearsal may be relabeled as V2 or full PostgreSQL migration acceptance.
