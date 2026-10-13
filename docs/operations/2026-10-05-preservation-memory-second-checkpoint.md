# Preservation memory and cleanup checkpoint

## Decision

Production migration remains NO-GO. No production database switch, release switch, or delivery activation was performed. Production services were restored after the previous rehearsal; this patch did not perform remote operations.

## Implemented scope

- Import each source chunk within a separate frame returning only its acknowledgement result. Force a resource/GC checkpoint after that frame returns and before reading the next chunk.
- Permit only the exact `ROLLBACK` statement to bypass closed resource admission. Keep deadline, runtime, and physical SQL budget checks. Do not permit COMMIT or application writes after resource failure.
- Report original failure classification and rollback attempts, acknowledgements, and failures separately. An acknowledged rollback does not erase COMMIT uncertainty.
- Preserve sticky peak RSS, fresh source validation, source pins, row windows, SQL provenance, and existing acceptance limits.

## Validation

- Targeted tests: 100 passed, 1 skipped.
- Parent full suite: 299 files passed, 25 skipped; 2,625 tests passed, 107 skipped.
- Database test, root, and PostgreSQL services type checks passed.
- Independent four-file review found no introduced P0/P1 issue.
- Two synthetic continuous imports processed 65,536 rows using actual PG Bind serialization without PG connections. Parent test peak RSS was 261,947,392 bytes, below the 268,435,456-byte limit. This is not Linux or real PostgreSQL capacity acceptance.
- Trusted service schema V3 fingerprint remained `b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383`.

## Frozen source hashes

```text
a440592fe78d8666ebcea385b37d42bab9267b9a94da19ffe2160ef20c83242b  packages/database/src/postgres-full-data-import.ts
6460959bfc0c31c4ab90cee8702d34f04bb17fefee3caa75429f2ee2380f7b40  scripts/rehearse-postgres-full-preservation.ts
aeedf4d556e5dd2dec00f64c52d6a67b852924d6e6a86f58bf1f35946a67b434  scripts/test/preservation-source-memory.test.ts
5d363e539ed8a27c9cb96175108bee121efb0b4b276bd633e521ec7a9a6e9980  scripts/test/postgres-full-preservation-rehearsal.test.ts
```

## Remaining acceptance and scheduling constraints

The previous real host throughput was approximately 3,555 rows/second. Importing 6,023,033 rows therefore needs approximately 28.2 minutes, excluding fresh validation and independent parity. Fresh validation took approximately 445 seconds. Under a 15-minute invocation budget, only approximately 455 seconds remain for import. At least four invocations are needed; repeated validation plus import alone takes approximately 57.9 minutes. Provisioning, parity, cleanup, and interruption checks add time. This does not safely fit the existing 55-minute watchdog or 60-minute resource maintenance window.

Do not rerun a known-infeasible full rehearsal, waive validation, increase limits, or automatically extend maintenance. A proposed staged rehearsal must define nonce-owned fixture retention, single ownership, absolute cleanup deadline, acknowledged chunk boundaries, uncertain-COMMIT reconciliation, independent parity, and restoration after each maintenance window. Retaining a fixture across windows requires explicit authorization before implementation/execution of that retention behavior.

Review gaps remain: a never-returning rollback relies on the existing migration runtime/client hard deadline rather than a new wrapper completion timeout; the 15-minute bound must remain enforced by pinned configuration/external launcher. Synthetic tests do not prove native COMMIT/ROLLBACK timing, full host RSS, or parity.

Formal readiness still requires full real import/resume/parity, independent same-data rollback acceptance, and a final fenced source snapshot. Formal production cutover requires confirmation.
