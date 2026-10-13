# Preservation memory optimization checkpoint

## Scope and current decision

The user authorized continued optimization until migration readiness. Production migration remains gated by full preservation parity, final fenced-source evidence, and independent rollback acceptance. Resource limits, fresh hashes, canonical data validation, and business eligibility rules are unchanged.

## First optimization

The full importer source-validation loop previously checked only its deadline and did not propagate the rehearsal's GC, resource, and pressure checks. The repaired validation frame returns only counts before invoking the optional external checkpoint. The rehearsal supplies its existing fail-closed checkpoint. The default library API remains compatible.

Frozen files:

```text
ec6a57068e99525e4c96fa621d83c631a9d664805d1562dffc01c788303e6b0e  packages/database/src/postgres-full-data-import.ts
d7bb1d0a581cf85073d09dc1c59cf7b484af9a6e9e307edb97d5fdf6b534e368  scripts/rehearse-postgres-full-preservation.ts
743944c7cdb33af2208439f00e6b054e5706e9bd1a4aac0ada83036da67ff01d  scripts/test/preservation-source-memory.test.ts
```

Targeted testing passed 91 tests with one skipped. Parent full regression passed 299 files and 2,616 tests; 25 files and 107 tests were skipped and do not constitute acceptance. Database test, root, and PostgreSQL-service type checks passed. Independent source review found no P0/P1 in the changed scope. A same-process synthetic workload verified about 514.8 MiB with peak RSS 228.3 MiB and no surviving chunk buffers after GC; this is not full Linux-host capacity evidence.

## Actual host results

The first window (`870753aaaf23f3eb`) failed during isolated-instance preparation, before any stage receipt. Its generic lifecycle report did not establish the exact failure cause. Production services restored successfully. Subsequent independent checks found no private rehearsal directories or port 5434 listeners. A pinned isolated lifecycle no-op then confirmed successful creation and cleanup. No ownership or permission guard was bypassed.

The second window used nonce `9f890a7acd71a686` and baseline SHA256 `8d1fb07290cd7956e9c8faf0c8922f52edc39366725aaf36298237e77399a7ef`. Pause passed with the independently armed recovery timer; FOMO collector, login, and noVNC retained their original PIDs.

| Stage | Result |
| --- | --- |
| Install | Passed |
| Interrupt | Fresh source validation passed; 2 chunks and 4,097 rows committed before intentional interruption |
| Resume | Previous 2 chunks reconciled; 311 additional chunks and 1,182,562 additional rows acknowledged; failed before completion |
| Full parity | Not run to successful completion |

Resume ran from `2026-10-04T15:46:47.429Z` to `2026-10-04T15:59:45.847Z`. The failure report recorded 330 transactions, 329 acknowledged commits, zero acknowledged rollbacks, and 80,819 physical SQL statements. Its phase was `import_chunks`; source validation had completed. These control-transaction totals are not chunk counts.

The process's recorded peak RSS was 268,582,912 bytes, 147,456 bytes above the unchanged 268,435,456-byte limit. External sampling recorded 268,189,696 bytes, below the limit; interval sampling and historical peak measurement need not agree. Available memory remained above 2.94 GB. The stage exited internally with code 1, not an external RSS kill. Its generic failure category was `FAILED_OR_COMMIT_UNKNOWN_RECONCILE_BEFORE_RETRY`; precise original failure attribution and rollback outcome require further diagnosis.

All acknowledged rows existed only in the isolated rehearsal, which was cleaned up. They are not production migration progress.

Evidence: `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-I3HyoK`.

Log: `/private/tmp/address-radar-full-preservation-maintenance-9f890a7acd71a686.log`.

## Recovery

Private lifecycle cleanup was confirmed. Exit recovery returned `status=restored` and `phase=restored`. All six main services and five application timers returned to their original active states. Gateway verification remained required by the restore controller. FOMO processes and the originally failed protocol-audit auxiliary state were preserved.

Both window transient units were independently confirmed not-found/inactive/dead. Current release remained `/opt/address-radar/releases/4b48fc2-forward-token-code`. No production database or release switch occurred.

## Next optimization scope

Independent code diagnosis identified a weaker import-frame release boundary, temporary PG bytea/array encoding copies, and a control-flow risk where a sticky resource error can also reject ROLLBACK. Zero acknowledged rollbacks alone does not prove that this last path occurred in the host run.

Prioritize a single-chunk import frame with a released-reference checkpoint before the next read, and a narrowly scoped, bounded rollback-cleanup path. Continue to forbid new writes and COMMIT after resource failure. Preserve safe original error categories and positive cleanup acknowledgement; ambiguous outcomes must remain unacknowledged. Do not reset historical RSS, switch to instantaneous measurement to pass, raise limits, skip fresh source verification, or substitute partial import for full parity.
