# Migration continuation checkpoint

## Operator authorization

The operator authorized continued development, tests, maintenance commands and migration execution until the database migration is complete. This authorization does not replace native measurements, scoped admission, independent verification or rollback acceptance.

## Measured production state

- PostgreSQL 16 `radarproduction`, port 5432, database `address_radar` is online.
- Native system identifier: `7693392208475083526`; database OID: `16391`.
- Migrator OID: `16384`; scanner: `16385`; automation: `16386`; wallet monitor: `16387`; wallet analysis: `16388`; historical backfill: `16389`; console: `16390`.
- All seven roles remain NOLOGIN, with connection limit 1 at this checkpoint.
- `address_radar_business` namespace count is zero. No production data import or business cutover has occurred.
- All six business services are active with NRestarts 0. Earlier manual maintenance restarts are not represented by that counter.
- All six live process environments explicitly contain `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
- Root filesystem available bytes at measurement: `26837065728`.

## Executed local validation

- Full Vitest run: 307 files passed, 25 skipped; 2678 tests passed, 107 skipped.
- Database test TypeScript compilation: passed.
- Maintenance helper: 82 tests passed.
- Supervisor and host adapter: 70 tests passed.
- Segmented pipeline and entry: 58 tests passed.
- Segmented launcher: 18 tests passed.
- Authority bootstrap: 17 tests passed.
- Migrator activation and schema installer: 11 Python, 11 Node and 4 native-UOW adapter tests passed. These are not production PostgreSQL acceptance.

## Frozen tooling and code review

- Reviewed maintenance helper `e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d` installed exclusively under the matching `/var/lib/address-radar-maintenance-tools/` hash directory.
- Maintenance scoped review closed pause/restore budget and invocation-empty response binding findings.
- Bootstrap scoped review closed coordinator/closure kind interoperability findings. No native keys, installed trust or signed evidence were created.
- Activation candidate SHA: `661fc94ef40bed9ce9dfce7cf7df289ea36740d761b713cbea3b0844ac253944`.
- Schema installer candidate SHA: `6c224ca7ff8ad32c3d6d4c0e805f01722f01e4077248d604d96b6f8e35dc8f84`.
- Activation/schema implementation review and actual protected deployment inputs are still pending. Do not run null templates.

## Remaining execution gates

1. Review and deploy private migration authentication and schema installer with actual protected pins and an explicit credential expiry.
2. Admit isolated native testing without an environment bypass or fabricated acceptance, then verify managed maintenance, ACL/freeze continuity, segmented import and independent parity.
3. Complete actual writer discovery and protected evidence collectors; unknown writer scope remains a blocker.
4. Fence final source writers, acquire a fresh final snapshot and migrate all retained data with exact independent accounting and native commit receipts.
5. Prove compatible PostgreSQL rollback, apply reviewed cutover configuration and perform end-to-end production acceptance.

The October 4 immutable backup is rehearsal input only, never the final production migration snapshot. After the first PostgreSQL business write, rollback must retain PostgreSQL data; switching back to an old SQLite snapshot is prohibited. Signal delivery remains disabled throughout.

## Native rehearsal source admission correction

The manifest at the fixed rehearsal bundle path was read directly with a bounded NOFOLLOW descriptor. Native measurements matched size 545010, root owner, mode 0600, link count 1, SHA256 `d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c` and operation ID `preparation-20261004-largechunk-9c8ae4bf`. However, the actual immutable flag was false. Prior descriptions of this backup as immutable were not proven and must not be treated as acceptance. The adapter correctly refused source admission. No fixture, import or arm was performed. Exact source sealing and fresh native proof are required before retrying; the immutable gate must not be weakened.

## Continued native execution checkpoint

The protected read-only builder diagnostic (`d16a5c422447666dbd142679fc3d522075a3bc40a61514382a289fe0ae648708`) identified a fresh `empty_target_memory_guard` refusal. No activation candidate existed and no authentication mutation occurred. The original guard thresholds remain unchanged.

A fresh resource-maintenance baseline was captured with nonce `749e1b50a38d062f` and SHA `e87b6ac2bed3719cd2830d01305fd3935fb7598b993fc4b27f19730df4284a18`. An independent 55-minute restoration timer was armed. The managed pause completed with status zero, its control group became empty, and no pending systemd jobs remained. This is resource maintenance, not a formal writer fence.

The next read-only diagnostic passed the resource guard but refused with `host_command_failed` in `target_metadata_query`. An independent read-only PostgreSQL metadata query succeeded: system identifier `7693392208475083526`, database OID `16391`, no business schema, and seven expected roles with NOLOGIN, connection limit one and null passwords. The candidate builder transport remains under diagnosis; authentication was not applied.

Reviewed source tools were installed in new root-protected namespaces after actual hash verification. Parent executed 27 sealer and 23 launcher tests successfully. The managed source-sealing invocation is `631ada5f66654a4595bba399134a0182`, unit `radar-source-seal-391a70cf82bd654e.service`, control-group device/inode `29/23400745`, initial main PID `3431603`. The effective oneshot hard deadline is `TimeoutStartSec=900`; systemd ignores RuntimeMaxSec for Type=oneshot. MemoryMax is 256 MiB and CPUQuota is 50 percent. No native sealing success is claimed until receipt verification and independent terminal-empty measurement.

The original archived source is an isolated rehearsal input, not a fresh final production snapshot. Formal generation-bound writer admission, independent snapshot/compatibility evidence, full import parity and production cutover remain required. No production migration completion is claimed.

## Actual guarded outcomes and business restoration

The candidate SQL construction defect was reproduced against the exact failing-query hash and repaired by adding the missing explicit concatenation operator before the role-name join. New builder SHA `f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f` passed the native read-only diagnostic and seven parent regression tests. The actual authentication candidate canonical SHA is `2ebcf7cf58b3f83153125ce40d4eef27cdc96037ca51a40e6314345cc796dae2`.

Authentication apply returned `authentication_failed_preserved`. Independent checks found actual role LOGIN/password and HBA changes; this is partial application, not a clean failure without mutation. The original journal has only role acknowledged and `pending=hba`. HBA raw SHA is `f4871503662bf298c9b730c3017eb19339771328a5928b614197fe10e21d6821`. No apply replay, credential renewal or journal rewriting was attempted. The protected read-only observer identified `direct_migration_identity` after a successful native SQL execution; exact metadata mismatch remains under diagnosis. No recovery record was persisted.

Source sealing returned `deadline_or_lease_lost` with exit status one. The invocation identity remained the recorded value, MainPID was zero, the original cgroup path was absent, and no systemd jobs remained. The control directory contained only the exclusive lock; no prepared or mutation journal was produced. No native sealing acceptance or source mutation is claimed.

The resource window was explicitly restored after those termination checks. Restore invocation `82d7e01fe4884256aabaf4eb3674dcee` returned restored with status zero and an empty control group; its retained exited unit was then retired. All six services are active with NRestarts zero. Their actual new process environments were independently read and every `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED` value was exactly `false`. Backend and release remain unchanged; production data has not been imported.

## Native continuation: sealed source and restored services

The archived rehearsal source was sealed by native unit radar-source-seal-0f421da79b368ec5.service (invocation 7a4099f390b64176a6e939f0a057877b). Its native success receipt covers 1,549 files and one directory; manifest SHA256 d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c. The managed process exited and its cgroup disappeared. This is source preparation, not production import acceptance.

Maintenance window 6a5dd00239c84f17 was explicitly restored. All six business services were subsequently active with NRestarts=0, the watchdog timer was absent, and the existing release remained unchanged.

The protected authentication recovery consumer independently passed native full-mode verification. The original pending HBA journal was preserved; historical acknowledgement was not fabricated and credentials were not renewed.

The latest full test run had one failure in preservation-source-memory.test.ts (preservation_rehearsal_rss_limit), with 2,681 tests passing and 107 skipped. The unchanged memory guard remains mandatory. Schema executor lifecycle review and production writer-fence review remain open. No production business schema installation, production import, or backend cutover has occurred.

## Latest native schema attempt and current blockers

The five-version schema closure was independently reviewed and installed into a new protected namespace. The new full authentication consumer passed actual native verification. Candidate 7d33863ac425f4531ceb9c036cdadbe3ddf8768570899b6311a42088e5f08278 was generated and reviewed.

Managed unit radar-production-schema-7d33863a.service returned schema_operation_failed_preserved; invocation 564d6c473d504e3eb76604e2dd636a39 exited with MainPID=0 and empty cgroup. No apply replay was performed. Independent read-only PostgreSQL catalog observation found no address_radar_business namespace at the unchanged target epoch. A separate reviewed read-only preflight subsequently passed and explicitly reported no schema intent write or DDL execution. The original attempt remains unresolved and must be diagnosed before any further mutation.

Parent full regression v3 had 314 passing files and 2,685 passing tests, with one failed suite caused by the in-progress sqlite-writer-boundary-lock.js dependency. The sticky RSS regression passed at 230,883,328 bytes under the unchanged 256MiB limit. Final software acceptance remains open until the writer module and type checks pass. No production import or backend cutover has occurred.

## Production schema installed; isolated preservation still incomplete

The explicit second schema attempt ran inside resource-only maintenance window f31094a768ce52b1, with the original watchdog and baseline SHA d219136aa3f566be997dababd5de7b7c4b357492844c5ec28a72fb5fd3501dd9. After fresh absence and target-epoch guards, unit radar-production-schema-7d33863a-attempt2 (invocation 62ef76ac0a624f7784c68a20801d075e) succeeded in 32.816 seconds. Ledger SHA: 1da609302e537321d2ab5cfdc68372fbe178e44fd1f1b2a57f8536247aae86e9. Independent postgres peer observation and complete verifyLedger comparison passed. Schema journal pending=null and the same ledger digest were independently confirmed.

The resource window was explicitly restored. All six business services were active with zero restarts and their actual process delivery environment false; its timer was absent. No business data was imported and no backend was switched.

Parent full regression v4 passed 316 files and 2,685 tests (25 files/107 tests skipped); database type check passed. This precedes subsequent writer cleanup changes and is not their final full acceptance.

The isolated preservation controller first encountered a circular top-level-await import before dispatching host work. The reviewed adapter fix used a new MoUNY9 admission. Its actual native run failed with reconciliationRequired=true and lifecycleCleanupConfirmed=false. Six business services remained active, no jobs were running, and no maintenance window remained. The fixture expiry watchdog f3bc958ccb499ce6 is retained. Pure read-only ownership diagnosis verified the armed record, open control with no producer, and artifact identity/code pins, but found the private fixture path absent. This is not yet durable cleanup proof; do not replay the failed fixture or forge acknowledgement. Production migration remains incomplete.

## Continuation: protocol upgrade staging and isolated cleanup guards

The protocol-v3 protected bundle was staged on production with release inventory SHA 1173fcffb8d735a9de4917a5d7aa8093e311edd8df21344895c751e0ca07f2d0 (1810 entries, 12468075 bytes). Upgrade candidate canonical SHA is 4e15f36ccac896dc8149579bdc661d8c1e580c705019a452fdb0750310d819dc. Native read-only roles and preflight passed; this is not an import or capacity acceptance.

The maintenance window 62cc2460793eae3e refused during pause with baseline_state_changed:address-radar-fomo-verification-sync.timer. No upgrade apply or intent was executed. Independent observation confirmed ledger version [1], unchanged epoch, six services active/running with NRestarts=0 and actual delivery=false. The window was restored. Configuration hashes matched; the refusal-time runtime tuple was not recorded. Journal timing is consistent with a timer/oneshot lifecycle race, but no unrecorded state is asserted as measured.

The isolated cleanup quiet helper v5 (SHA 382eee7dee64506224fee547e5874cc2ef0ca82aa06722cb25a3969c915d8aab) passed 31 local tests and scoped independent code review. Native execution still must prove deployment pins, restorer admission, child terminal, original timer restoration and independent cleanup receipt. Original expiry evidence remains retained until those proofs exist.

Private CUD and snapshot collectors received fixes for invocation propagation, request-bound fixture receipts, and column-level cross-schema privileges. Native collector acceptance and independent review remain required. No production business import, backend cutover, application-role activation, or gateway delivery has been claimed.

## Independent cleanup closure and current regression gate

The isolated failed-fixture artifact cleanup completed once under quiet request 32bdae2507201bcd. Independent observation confirmed artifact and fixture absence, exact child terminal ACK with exit 0, unchanged original state SHA 5a256a44fbcbe6740e3ec5db1e24411c0952b64450859652c525bbebe7276123, and both sync timers restored active/waiting. Cleanup receipt SHA is 6475e4dbfa3565ab7877f7ed6f0e3b28dcb767cbb8ef8ecc96250c51738f8c59. The original expiry watchdog remained retained at this checkpoint pending separate exact-unit retirement; historical lifecycle ACK was not fabricated.

Parent-executed full regressions passed: 326 files and 2693 tests, with 25 files and 107 tests skipped. Database package type checking passed. The synthetic bind test peak RSS was 223232000 bytes; this is not native production capacity proof. Log: /private/tmp/address-radar-migration-regressions-20261006-v5.log.

Independent scoped review closed the private CUD invocation/fixture/column-ACL fixes and snapshot cleanup/signing code gate. Native ACL, managed lifecycle, capacity, actual writer scope closure, initial-prepare authority and fresh final snapshot acceptance remain outstanding. Migration is not complete.
