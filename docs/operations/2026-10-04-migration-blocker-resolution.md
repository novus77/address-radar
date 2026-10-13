# Migration blocker resolution checkpoint

## Boundary

This supplements, rather than replaces, the consolidated migration preparation report. Production remains on SQLite. No production business import, release switch, writer fence, service restart, or gateway delivery was performed by this work. Private nonce fixture installation and cleanup are not production cutover authorization.

## Genuine dispatcher process-tree memory

The previous default launch used a Node supervisor, a tsx CLI intermediary, and the service process. The launch now uses the protected Node executable with `--import` and the sealed absolute `tsx/dist/loader.mjs` file URL. The sealed working directory supplies the verified `tsconfig.json`; external loader configuration remains refused. The complete release inventory now requires the loader in addition to the existing entry, CLI, and configuration files. IPC lifecycle identity, deadlines, and clean-drain requirements remain unchanged.

The offline direct-loader test verifies that the TypeScript program reports the PID of the directly spawned child over IPC. The first Linux attempt after the implementation change failed because the fixture observer still asserted the old CLI arguments; it was not accepted as a resource pass. After updating that observer, all six real default dispatches passed in the guarded same-nonce PostgreSQL 16 fixture.

Actual acceptance evidence:

| Service | Peak process-tree RSS bytes | Ready | Polls | Drained | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| scanner | 227446784 | 1 | 1 | 1 | 0 |
| automation | 254820352 | 1 | 1 | 1 | 0 |
| wallet-monitor | 253018112 | 1 | 1 | 1 | 0 |
| wallet-analysis | 232943616 | 1 | 1 | 1 | 0 |
| historical-backfill | 242376704 | 1 | 1 | 1 | 0 |
| console | 245932032 | 1 | 1 | 1 | 0 |

The original process-tree ceiling remains 268435456 bytes. Minimum observed available RAM was 1188876288 bytes and minimum free disk was 30274027520 bytes. Console completed two GET requests and one rejected POST. External fetch count was zero, SQLite fallback was false, and coverage remained false. Services ran sequentially, so this is not concurrent six-service capacity proof or natural wallet coverage.

After the receipt field rename, the offline regression run passed 57 tests across two files with two live opt-in tests skipped. Database test types and the PostgreSQL services script types both passed. Those skipped tests are not included in the separate nine-test real Linux acceptance result above.

Fixture identity: `radar_rehearsal_89781060e3678545`, matching schema suffix `_schema`, private port 5434. The v2 17-support schema and synthetic native coordinator marker were physically committed only within that fixture. Sealed artifact and cluster cleanup were confirmed. The test run passed 9 tests with exit zero.

Log: `/private/tmp/address-radar-direct-loader-rehearsal-updated-20261004.log`. That immutable log still uses the old fixture field name `genuineTsxCli`; its observed arguments were the direct loader arguments. Future fixture receipts use the accurate name `genuineTsxLoader`.

## Full preservation source pressure

Still open at this checkpoint. The previous full attempt stopped during fresh source verification at PSI some avg10 1.69, before any historical rows or chunks were committed. Passing dispatcher launch does not discharge this independent guard. Optimization must preserve fresh source digests, immutable file identity, complete typed parity, bounded resident memory, and the original pressure/reserve limits. A successful synthetic memory test is not a full preservation receipt.

A read-only production checkpoint at `2026-10-04T09:47:06Z` showed total RAM 4104122368 bytes, available RAM 1387945984 bytes, and only 16384 bytes of free swap out of 2147479552. Memory PSI some avg10 was zero, but avg60 was 0.60 and avg300 was 1.43. The instantaneous zero does not establish a sustainable full-scan budget. Available disk was 30459658240 bytes. All six business services remained active/running with NRestarts zero. No memory reclamation, cache dropping, service stopping, or configuration change was performed.

## Writer fencing, final snapshot, and compatible rollback

Still open at this checkpoint. The writer boundary must cover actual child-process database handles, extra timers, both bridge directions and cursors, operators, and deployment admission. Preparation evidence does not authorize stopping them. Final source verification requires a fresh consistent snapshot after an approved and observed fence.

The companion `postgres-compatible-rollback-release-contract.md` defines the artifact and independently measured evidence required for a PostgreSQL-compatible rollback candidate. After the first PostgreSQL business write, restoring the old SQLite writer release is not an acceptable rollback. No independent production rollback approval has been manufactured by this work.

## Decision

## Source-reader optimization and protected retry

The reader now defers its manifest request instead of doing an extra startup scan, retains only chunk digest metadata, handles short writes, and paces each read block without accumulating a burst allowance during pipe backpressure. The TypeScript framing reader uses bounded segmented header scanning instead of byte-by-byte awaits, fills an allocated body completely before exposing it, and releases consumed pieces. No source digest is cached as validation authority.

The Python reader tests passed 14 cases. The worker's targeted Vitest run passed 99 tests with one live opt-in test skipped, strict reader/framing types passed, and the private fixture build passed. These are local implementation checks, not full PostgreSQL parity proof.

The one protected full retry on `2026-10-04T09:51:34Z` stopped at the initial interrupt-stage resource check after about 0.203 seconds. Memory PSI some avg10 was 2.26, RSS was 55898112 bytes, available RAM was 1337004032 bytes, and free disk was 30415835136 bytes. There were zero physical SQL statements in that stage, zero historical commits, and zero source files or bytes read. The prior install stage committed only the private preservation ledger installation. Lifecycle cleanup was confirmed and production authorization remained false.

This attempt did not exercise the optimized reader. It proves that the host could not sustain entry to the guarded workload at that moment, not that the optimization failed or the reader caused the pressure. Do not repeat unchanged attempts or weaken the pressure guard. Full fresh validation, interrupted import, resume, and independent typed parity remain unaccepted.

Log: `/private/tmp/address-radar-preservation-reader-optimized-20261004.log`. Private evidence directory: `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-57OYMW`.

## Mandatory closure linkage boundary

The new writer-fence closure validator and its 48 tests cover child FD/mmap holders, unexpected writers and timers, bidirectional bridge/cursor state, pinned scope, per-table snapshot completeness, and exact PostgreSQL-compatible rollback material. Coordinator plus closure tests passed 241 cases and database test types passed.

However, an optional execute-time validator is insufficient: a restart could bypass it unless the closure is bound into the plan digest and persisted signed preparation. Mandatory linkage therefore requires an explicitly versioned external evidence format. No default closure should be inferred for v1. The migration phase must be derived from the committed journal and native first-write marker within the UOW, not caller configuration. Format versioning and its compatibility policy require human confirmation before implementation; no production stop/switch is authorized by this code checkpoint.

## Updated decision

The final full regression ran the heavy source-memory test separately, without changing its timeout or assertions, and the complementary suite with two workers. The complementary run passed 2505 tests across 297 files with 107 tests in 25 files skipped. Including the separately passed memory test once gives 2506 passed tests across 298 distinct passing files. The eight framing tests also ran in the isolated first command, but are not double-counted. The 107 skips are not acceptance evidence for their opt-in live scenarios.

Full production package/application TypeScript builds, all package/application test TypeScript builds, and strict standalone checks for the G11 rehearsal, framing, memory, and reader files passed with exit zero.

Required consolidated decision before continuing the blocked boundary: approve an explicit V2 signed policy/bundle/command/durable-state contract and matching ledger fingerprint, with no implicit v1 upgrade or new v1 writer capability. Separately establish a scoped, authorized resource-maintenance window or a suitable isolated-capacity environment before full preservation acceptance. Exact production stop/start lists, approvals, trust roots, rollback artifacts, and final cutover must never be inferred from preparation permission.

The genuine sequential dispatcher launch blocker has passed isolated acceptance. Full preservation, final fencing, and compatible rollback acceptance are still required. Production migration remains NO-GO.
