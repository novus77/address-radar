# Consolidated database migration preparation and acceptance contract

Date: 2026-10-04. Scope: complete the six preparation workstreams together before a production cutover.

**Disposition: NO-GO for production migration.** Code-level preparation, isolated fixtures, and the full source SQLite restoration are not authorization to import production business data, select PostgreSQL, switch a release, restart production services, or enable delivery. Ordinary implementation and fixture fixes are handled within the approved development scope, without individual approval requests.

## Six-workstream evidence matrix

| Workstream | Demonstrated evidence | Remaining acceptance condition |
| --- | --- | --- |
| 1. Complete preservation and restore | Immutable SQLite backup restored with exact ordered typed-row parity: 141 tables, 6,023,033 rows, 1,548 chunks; foreign-key violations 0; no truncation | Obtain a fresh final snapshot only after the complete writer fence. The old verified backup is not that final snapshot |
| 2. PostgreSQL driver, schema, roles and capacity | Real isolated PG16 v2 installation, all 17 support tables; 105 service permission EXPLAIN probes; authority and provider-immutable mutations denied; 81-table pg_dump/restore parity | Bind actual production database, namespace, roles, generation, independently approved namespace receipt and measured capacity. Sequential fixtures do not prove six-service concurrent capacity |
| 3. Lossless resumable import and reviewed cohort | Largest source chunk: 2,842 rows / 16,775,058 bytes round-tripped exactly and rolled back; 162 actual SQL statements. Small real preservation/import retry and same-transaction cohort mechanics demonstrated | Full PG preservation, interrupted import, resume and independent typed parity for all 141 tables remain unpassed. Diagnostic cohort selection is not an approval |
| 4. Six real service compositions | Six actual restricted-role `runPostgresServiceEntrypoint` startups, one cycle each, awaited shutdown, native PG bridge and durable startup verification passed | Genuine deployed dispatcher/tsx/CLI/IPC proof is a separate gate. The first scanner CLI attempt failed without an adequate diagnostic; failure retention is being corrected. Natural-source coverage and operator API parity are not established by empty fixtures |
| 5. Writer fence, atomic first write and rollback | Actual child FD census; native import/marker/journal commit and physical rollback fixtures; commit-uncertain reconciliation; signed compatible-PG rollback contract | Approve and establish the complete operational fence, eliminate unknown writer scopes, capture final snapshot, and provide an independently approved PostgreSQL-compatible rollback release |
| 6. Complete testing and real business acceptance | Earlier aggregate checkpoint: 293 files / 2,428 tests passed, 25 files / 106 tests skipped; Python reader tests 9 passed; actual PG fixtures have separately recorded results | Run the final frozen-tree aggregate and deployed-path gate. A natural wallet execution, provenance, risk/independence and derived consumer receipts still require real data evidence; skips and empty cycles are not a business closed-loop pass |

## Full-preservation attempt: exact observed result

The optimized bounded reader uses fixed-path allowlisting, 64 KiB blocks, a 32 MiB/s ceiling, before/after file identity checks, fresh SHA validation, and `POSIX_FADV_DONTNEED` only for already-read complete clean immutable-source pages. It does not skip hashes using a cached witness, drop global caches, touch the live SQLite files, or increase the approved limits.

| Phase | UTC observation | Result |
| --- | --- | --- |
| Install | 08:34:45.874–08:34:46.279 | 10 SQL statements, one isolated DDL commit |
| Fresh-source validation in interrupted-import phase | 08:34:50.191–08:35:09.679 | Stopped before any historical data commit: memory PSI `some avg10 = 1.69`, limit 1 |
| Resume | Not started | No evidence |
| Independent full typed parity | Not started | No evidence |

History committed: **0 / 6,023,033 rows; 0 / 1,548 chunks; 0 / 141 completed tables**. DDL and read-only commits must not be counted as historical business-data progress.

Observed reader diagnostics: 71 digest reads, 208,769,896 bytes, 3,215 successful DONTNEED returns; peak runner RSS 237,862,912 bytes; minimum available RAM 1,113,796,608 bytes; minimum free disk 30,422,958,080 bytes. No final PG growth measurement was obtained. At 08:38:01Z the owned fixture directory, cluster listener and local tunnel were absent.

The confirmed failure is a **memory-pressure safety-gate exceedance**, not a demonstrated OOM, full disk, connection rejection, or proof that the importer retains the complete dataset. RSS and global PSI alone cannot establish that causal attribution. The approved RAM, PSI, disk, row, SQL and transaction limits must not be raised to turn a failure into a pass. Further full attempts need a better demonstrated resource plan or isolated capacity; repeated unchanged retries are not acceptance.

### Separately confirmed deployed-path limit

After the diagnostic and command-clock repairs, the parent ran the genuine dispatcher/CLI opt-in test again. Eight offline tests passed; the single live test failed after 71.681 seconds. Private fixture `radar_rehearsal_0a48e260424302be` installed v2 and physically committed the native first-marker/journal, then the scanner watcher stopped on **`G11 dispatcher/CLI process-tree RSS guard`**. The applicable limit is 268,435,456 bytes for the whole dispatcher/CLI process tree, not the RSS of one service process. Ready, poll and drain receipts were all zero, and the other five CLI services were not attempted.

This identifies a different resource contract from full-preservation PSI and rules out treating the original opaque scanner exit as a proven source/ACL failure. The failed attempt did not record a numerical peak; do not invent one. Failure receipts now also retain measured peak process-tree RSS and minimum RAM/disk for any future bounded attempt. The closure already uses a thin dispatcher parent. Changing an aggregate envelope or deployment launch architecture needs an explicit reviewed resource plan and new acceptance, not merely removing the watcher assertion.

The sealed fixture cleanup completed and the nonce lifecycle finally returned. No production backend, release, environment, service or delivery setting was changed. The full aggregate can pass with the opt-in live tests skipped; that must not override these two failed real-resource gates or imply migration readiness.

See `postgres-preservation-source-pressure-checkpoint.md` and `postgres-full-preservation-rehearsal.md` for the scoped attempts and limitations.

## Preservation versus activation

### Final frozen-tree test and production checkpoint

The complete test set passed as two sequential, complementary partitions: the unchanged heavy synthetic memory test ran alone (one test/file passed), followed by the remaining complete suite (2,442 tests / 295 files passed; 107 tests / 25 files skipped). Total: **2,443 tests / 296 files passed**, with no assertion or timeout changes. Previous all-at-once and two-worker runs timed out; those attempts are not relabeled as passing. The isolated result excludes concurrent test contention but is not a Linux pressure or PG-capacity proof.

Production and test project type checks, the PostgreSQL service script project, and strict independent checks of both rehearsal test files passed. The synthetic memory regression read 89,615,046 and 268,845,702 bytes; peak RSS was 133,709,824 and 145,375,232 bytes, with zero surviving chunk buffers after GC and maximum concurrent reads one. This supports bounded buffer lifetime in that scenario only, not a universal exclusion of retention or the real host-pressure cause.

At **09:26:35.761766Z**, all six production services were loaded, active/running, with `NRestarts=0` and the exact gateway flag `false`. The release still pointed to `/opt/address-radar/releases/4b48fc2-forward-token-code`; no private `5434` listener remained; free disk was 30,462,201,856 bytes. Production business migration and cutover were not performed. The complete machine-readable checkpoint is [the consolidated results receipt](2026-10-04-consolidated-migration-preparation-results.json).

| Data class | Required treatment |
| --- | --- |
| All source SQLite tables and typed values | Preserve completely with immutable source bindings, exact counts/digests and resumable receipts. Preserve NULL, blobs, maximum integers and original event data without lossy conversions |
| Trader identities, wallet bindings, notes, labels and explicit manual permissions | Preserve provenance and ownership. Do not merge identities, infer a missing wallet, or convert an ordinary label into a radar grant |
| Original trades, opportunity evidence, revisions and deduplication keys | Preserve original facts and revision audit. Recalculate only from actual execution evidence. Never substitute a current quote for an entry price |
| Old evaluations, candidate decisions, historical tasks and signal projections | Preserve as historical/audit data. Do not automatically promote old qualification, resume bulk historical mining, replay delivery, or declare them new-generation progress |
| Reviewed forward monitoring cohort | Activate only the reviewed exact profile/generation/owner bindings. Earlier 216 bindings / 192 enabled profiles / 108 entities are diagnostic counts, not an approved stable-capability cohort |
| Raw hot events | Apply the confirmed 15-day hot policy without deleting evidence required by a 30-day buy observation, unfinished consumers, revisions, deduplication or recovery |
| Price/source gaps | Remain deferred or explicitly unverifiable. Missing data is not a failed trading sample, a zero price or successful consumer acknowledgement |
| External FOMO databases and bridge artifacts | Remain separately classified and protected. They are not implicitly covered by the main 141-table migration |

Historical preservation and active forward eligibility are different products. Preserving six million old rows does not prove new opportunities, resolved identities, successful backfills or signal readiness.

## Complete writer boundary

The corrected 06:42:51–06:42:52Z census sampled 18 PIDs / 409 FDs and found 38 writable main-database/WAL/SHM FDs in six child workers. Parent MainPID-only checks would have missed them. These observations are not a fence authorization or proof of future quiescence.

The proposed minimum inventory covers 12 services and five timers, including the six business services and these additional active timers:

- `fomo-address-radar-input-sync.timer`: bidirectional JSON/JSONL bridge and three cursor writers. Preserve streams/cursors and fence both directions.
- `fomo-address-radar-backup.timer`: opens SQLite without read-only mode and executes VACUUM INTO plus old-backup pruning.
- `fomo-radar-protocol-audit.timer`: its ExecStart script was missing. A failed current service does not prevent its active timer from executing later.

The extra backup resolves to `/var/lib/fomo-address-radar/address.sqlite` and `/var/lib/fomo-address-radar/customer.sqlite`, not `/var/lib/address-radar/address-radar.db`. Keep both external databases intact. Do not use either path as a cleanup or implicit migration target.

Operator/deployment admission, child process groups, timers, bridges, backup/pruning scripts, cron/at/user-bus scopes, maintenance and orphan query scopes must all be accounted for. Unavailable enumeration is **unknown**, not empty. The eight system cron candidates and filesystem maintenance exclusions still require explicit evidence; the proposed inventory is not an exhaustive approved exclusion list.

The final fence must disable new admission, prevent future timer invocations, drain or stop authorized writers including children, obtain a fresh complete census, and then capture the final consistent snapshot. No such production stop or fence has been performed in this preparation batch.

See `migration-writer-fence-and-rollback.md` and the separately timestamped census, proposed-inventory, backup-binding and final-addendum observations. All current observation approval/activation/fence flags remain false.

## Atomicity, privileges and rollback

A later bounded CLI attempt exposed a synthetic command-clock race before service startup: separately sampled `deadline` and `authorization.expiresAt` could differ by one millisecond, correctly triggering `EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED`. The fixture now uses one captured issuance time and exactly the same deadline/expiry, with a deterministic advancing-clock regression. No production authorization check was weakened. This distinct fixture defect is not evidence of an application startup, resource or ACL failure.

- The dedicated migration runtime has explicit target, purpose, external authorization, SQL, time, memory and shutdown limits. Caller-held raw pool aliases are not a SQL sandbox; retain the structural restrictions.
- Data import, crosswalk/receipts, first-write marker and cutover journal must share the native transaction. A receipt is acknowledged only after physical COMMIT; uncertain COMMIT requires reconciliation.
- Ordinary consumers cannot edit approval/trust tables. Provider consumers can change only the three explicitly mutable budget fields; immutable authority, genesis/source mappings and safety parameters cannot be self-approved by a worker.
- The 216-profile / 192-enabled / four-budget cohort model requires 8,718 total statements. The explicit 1,000-statement policy rejects it and rolls back. The 10,000-statement fixture is not an implicit production budget increase; approve a matching bounded plan or a separately designed resumable cohort plan.
- After the first PG business write, never restore old SQLite writers, timers or bridge cursors as a rollback. The old SQLite-only `4b48fc2-forward-token-code` release is not a PostgreSQL-compatible rollback release.
- A fixture signature proves its synthetic scope, not natural transaction provenance, production namespace approval or human cutover authorization. Do not reuse fixture keys or receipts as production authority.

## Service and downstream conditions

- Only reviewed chain/genesis/provider/token mapping combinations may publish execution or price facts. No unsupported Robinhood chain-family fallback, source trust guessing or identity merge.
- The actual PG publication fixture verified five facts, five attestations and four wakes, physical multi-candle rollback, idempotence and dropped-commit-ack reconciliation. These are isolated fixture counts, not new production facts.
- Source acquisition must finish outside a database transaction; published facts, attestations and consumer wakes must commit together. Missing authentic execution or source authority stays deferred.
- Price retry cursor/cooldown is currently process-local: `durableCheckpoint=false`, `coverageVerified=false`. Restart-safe coverage and exactly-once claims are not established by that implementation.
- Console GET/progress and POST rejection were tested. That is not proof of full legacy console mutation/identity/tag API parity or a replacement production backup schedule. Assess these capabilities explicitly before switching a production workflow that depends on them.
- Closed-loop counts must stay generation-bound and lossless. Unknown deltas remain null; legacy totals, empty polls and successful service starts cannot stand in for evidence progression.
- Risk/funding independence, approved source validators/keys and provider budgets remain independent inputs. Do not invent their core thresholds or infer two independent traders merely from two accounts.

## One consolidated production go/no-go package

Formal cutover is held until the package contains all of the following, with no unknown scope silently treated as passed:

1. Exact production target/namespace/roles/generation and protected externally approved provisioning bindings.
2. Complete writer/operator/timer/bridge inventory, approved exclusions, final fence evidence and fresh final source snapshot.
3. Full preservation, forced interruption, resume, independent typed parity, measured target/WAL/temp growth and validated restore.
4. Reviewed cohort, import resource/statement plan and accurate retained-versus-active classification.
5. Genuine deployed-path startup/drain, capacity and required console/backup operational parity.
6. A proven compatible PostgreSQL rollback release, atomic first-write/journal and reconciliation procedure.
7. Actual source credentials/validator authority, chain/token mappings and confirmed business/safety rules needed for a natural address-channel acceptance.
8. Frozen-tree test/type results and actual wallet-to-normalization-to-opportunity-to-capability-to-signal consumer evidence, with waits and unverifiable gaps explicitly distinguished.

Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`, FOMO acquisition paused and full historical mining disabled throughout preparation and acceptance. Do not create a natural transaction, manufacture a high-multiple opportunity, lower eligibility thresholds, or deliver a signal to make the checklist pass.

Only one consolidated authorization is requested at the genuine production-operation boundary. Ordinary fixture, parser, loader and code repairs do not require repeated human questions. If any required gate fails, do not select/activate the production PG backend and do not claim that all six workstreams or the complete business loop are finished.
