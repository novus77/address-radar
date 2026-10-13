# Paced immutable preservation source checkpoint

## Scope

This is backup-derived preservation only. It grants no production cutover,
business activation, eligibility, cohort import, or fresh-chain authority.
The original protected backup and export remain untouched.

## Reader

`scripts/preservation-source-reader.py` accepts only the fixed authenticated
preparation bundle and manifest-listed chunk filenames. It runs as an OS-only
root reader; PostgreSQL always uses the dedicated non-superuser nonce migrator.
Reads are 64 KiB with a 32 MiB/s ceiling. Each raw file digest is freshly checked
against the pinned manifest, with exact device/inode/size/mode/uid/gid/mtime_ns/
ctime_ns identity before and after. Only page-aligned, already-read clean
immutable file ranges receive POSIX_FADV_DONTNEED. Successful advice is an OS
acknowledgment, not a guarantee of actual eviction. Unsupported advice is counted;
unexpected advice failures stop the reader. No live database, global drop_caches,
sysctl, permission change, or configuration mutation is used.

The previous full validation receipt lacks a complete exact file identity
inventory. Consequently this executable does not reuse that witness: all reads
remain freshly hashed. The tested recent-witness predicate requires explicit
`recent-isolated-cached-witness` scope, exact identity, known hash, complete
validation and age at most 15 minutes. It is not wired as a hash-skipping path and
does not change formal final-cutover guarantees.

The Node adapter uses one persistent Python helper, bounded binary framing and
one allocated chunk buffer, not base64 payloads or one process per row/file.
One reusable fatal UTF-8 decoder replaces per-row decoder construction. Every
existing manifest/chunk/table validation remains mandatory. The source I/O
port has asynchronous context scope and is not permission or verification proof.

## Limits and atomicity

Unchanged limits: memory PSI some avg10 at most 1; MemAvailable at least 1 GiB;
disk reserve at least 5 GiB; Node peak RSS at most 256 MiB; old-space 96 MiB.
Each stage retains its explicit deadline. Helper checks pressure while reading;
the runner and external monitor also stop on limits. Inserts remain set-based
64-row/512-KiB windows inside the same outer chunk transaction. The original
chunk identity, raw body and row mappings commit with the receipt; restart
checks committed receipts and exact bodies. No chunk is split across commits.

The four preservation ledgers retain both original chunk bodies and row bodies:
approximately twice the 5.34 GB payload before indexes, TOAST and WAL. File-system
free-space change is not an isolated database growth measurement.

## Actual checkpoint, 2026-10-04

Previous measured real calibration remains valid historical evidence:
2,842 rows; original 16,775,058-byte chunk; 162 physical SQL statements;
146,104,320-byte peak RSS; 33,906,688-byte PostgreSQL growth including rolled-back
storage; acknowledged source rollback. This is not a durable historical import.

The new paced-reader fixture attempt created isolated database
`radar_rehearsal_a41c2d4a2f6fb2f6`, physical system identifier
`7692720706351586515`, and stopped at calibration's initial resource guard:
PSI 1.30 exceeded 1 before source reading or any SQL. Elapsed 0.402 seconds;
physical SQL 0; historical commits 0; observed process peak RSS 53,936,128 bytes;
available memory 1,180,418,048 bytes; disk free 30,439,796,736 bytes.
Guarded fixture/tunnel cleanup was confirmed.

Receipt:
`/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-Cbe8kK/calibrate.json`

A subsequent fixed read-only 25-second host probe recorded PSI
0.65/0.44/0.36/0.24/0.13/0.99, MemAvailable at least 1,223,036,928 bytes and free
disk at least 30,482,563,072 bytes. The actual retry was rejected by the platform
approval gate, citing an unconfirmed slot release. It was not run indirectly.
The previous fixture was already cleaned and the sole slot was explicitly
released to Boyle. No current preservation fixture remains active.

Therefore this checkpoint provides no new full-import, resume or independent
6,023,033-row parity success. The old complete source-validation result is not
PostgreSQL insertion throughput. The exact next action is an explicitly
authorized sole-slot rerun of the built runner under the same limits, after
pressure is safe. The target must be a fresh lifecycle nonce, not old 5433.

## Tests

Run `python3 scripts/test/preservation-source-reader.test.py` for nine tests
covering unsupported/failed advice, page alignment, exact stream bytes/hash,
pressure stop, corrupt bytes and metadata/witness invalidation. Scoped Vitest
also exercises importer atomic rollback/resume and corrupted filesystem input.
`scripts/test/preservation-source-port.test.ts` tests callback failure cleanup
and asynchronous reader isolation. These are protocol/unit tests, not a
substitute for the blocked actual full PostgreSQL rehearsal.

## Final bounded follow-up and freeze

The parent directly confirmed sole5434 ownership. No approval rejection was
bypassed. All actual fresh fixtures below completed guarded lifecycle cleanup;
no own cluster, tunnel, source-reader child or runner remains active.

- SZ9ZNI / b03d41f1f159d6b1: calibration externally stopped after 1.655865 s.
  MemAvailable minimum 1,054,650,368 bytes violated the 1 GiB floor. External
  Node RSS peak 128,471,040 bytes; disk minimum 30,437,142,528 bytes. SIGTERM
  left no calibration report; no durable history receipt is asserted.
- wppbaz / ef21f9b2f51a9c02: stale compiled installation entrypoint rejected
  arguments before SQL in 0.404023 s. The owned test literal type was then
  corrected, strict typecheck passed and the new entrypoint was built.
- t6BaCY / 2226d5e0067fa85b: repaired installation stopped before SQL at
  initial PSI 1.12 > 1 in 0.403216 s. Physical SQL 0; Node high-water RSS
  53,936,128 bytes; available RAM 1,291,116,544 bytes; disk free
  30,436,675,584 bytes. Target growth was not queried after pressure failure.

Latest receipt:
`/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-t6BaCY/install.json`

Full outcome: NOT ACCEPTED, full import not started. Acknowledged durable
history rows/chunks 0; reconciled resume chunks 0; independent typed parity
rows/chunks 0; completed imported tables 0. Planned totals remain 141 tables,
6,023,033 rows and 1,548 chunks. Prior calibration rollback and prior complete
source validation do not establish PostgreSQL import, resume or parity.

The private runner now supports an explicit four-ledger installation stage.
`PRESERVATION_USE_PRIOR_CALIBRATION=1` checks the trusted WCoujH receipt's exact
source pins, known physical system identifier, 162 native SQL statements,
acknowledged rollback and 146,104,320-byte measured RSS. This is resident
allowance only, never cached source validation or target authorization.
Fresh manifest/chunk/table hashes remain mandatory. Ledger installation uses
the actual restricted migration runtime and authenticated isolated capability.
There is no active business import or production authority.

An unimplemented startup-admission test draft was withdrawn. The parent's
bounded-progress instruction ended further pressure retries. Remaining blocker:
the host has not sustained the unchanged RAM/PSI limits through fixture startup
and ingestion. No threshold, RSS, time, SQL budget or production process was
changed to work around this. Code is frozen and sole5434 is explicitly released
directly to Boyle for the queued CLI/IPC supplement.

Final scoped checks: Python 9 passed; Vitest 115 passed / 1 skipped in seven
files; strict owned-source/test TypeScript and both entrypoint syntax checks
passed. They are protocol/unit evidence, not full PostgreSQL acceptance. The
parent's aggregate 293-file/2,428-test checkpoint predates the final repair.

### Touched owned paths for this follow-up

- `packages/database/src/postgres-full-data-import.ts`
- `scripts/preservation-source-reader.py`
- `scripts/preservation-source-reader.ts`
- `scripts/rehearse-postgres-full-preservation.ts`
- `scripts/calibrate-postgres-preservation-chunk.ts`
- `scripts/postgres-preservation-fixture-authority.ts`
- `scripts/execute-postgres-preservation-fixture.mjs`
- `scripts/run-private-postgres-preservation-fixture.mjs`
- `scripts/test/preservation-source-reader.test.py`
- `scripts/test/preservation-source-port.test.ts`
- `scripts/test/preservation-resident-calibration.test.ts`
- `docs/operations/postgres-preservation-source-pressure-checkpoint.md`

New APIs: `FullDataPreservationSourceReader`,
`withFullDataPreservationSourceReader(reader, operation)`,
`readFullDataPreservationSourceFile(directory, file, maximum)`,
`createPacedPreservationSourceReader(helper, expectedSha256, deadlineAtMs)`,
`immutablePreservationDirectory`, `validatePreservationResidentCalibration(input)`.
The calibration validator checks shape/lineage only; the caller must separately
authenticate the historical receipt. None of these grants eligibility, source
trust, target capability, or cutover authority.

## One optimized actual attempt: 2026-10-04 final receipt

This section supersedes the earlier not-started checkpoint. The parent directly
assigned sole5434 for ONE attempt; Boyle remained offline. Three permitted
read-only stabilization samples at 08:32:01/06/11Z passed: PSI some avg10
0.04/0.03/0.01, full avg10 0, RAM minimum 1,387,380,736 bytes and disk minimum
30,469,865,472 bytes. Sampling ended after ten seconds, not an unbounded loop.
An initial platform denial incorrectly applied Boyle's offline CLI/IPC scope.
The same original command was admitted after read_thread confirmed this task's
current direct human full-preservation authorization. No alternative execution
path or approval bypass was used.

Fresh target: radar_rehearsal_f1778802dc47a810;
schema radar_rehearsal_f1778802dc47a810_schema;
restricted role radar_rehearsal_f1778802dc47a810_migrator;
actual physical system identifier 7692728260971308930.

| Phase | Absolute UTC start | Absolute UTC end | Actual outcome |
| --- | --- | --- | --- |
| install | 08:34:45.874Z | 08:34:46.279Z | PASS; four preservation ledgers, 10 physical SQL, one acknowledged DDL transaction; history rows/chunks 0 |
| interrupt/full import | 08:34:50.191Z | 08:35:09.679Z | FAILED during fresh-source verification; source_reader_pressure; 15 physical SQL, two acknowledged read-only transactions; history rows/chunks 0 |
| resume | not started | not started | 0 reconciled chunks; no resume proof |
| independent typed parity | not started | not started | 0 rows/chunks; no typed parity proof |

The full importer was genuinely invoked; this was not another large-chunk
calibration. Its mandatory complete source verification did not finish, so it
never entered a history-writing transaction. No deliberate post-chunk
interruption was reached. Completed imported tables: 0 of 141. Durable history
rows: 0 of 6,023,033; durable chunks: 0 of 1,548. Full completion, resume and
independent typed parity remain NOT ACCEPTED. Old calibration/SQLite/source
validation cannot substitute for these missing PostgreSQL results.

The cache-friendly source port completed 71 digest-checked read responses,
208,769,896 bytes, 3,215 acknowledged already-read-page DONTNEED calls and zero
unsupported-advice responses. These counters include manifest reads and are
not a semantic row count or total physical I/O measurement; bootstrap and the
failed partial read are not included. No cached witness was used. OS advice
success does not guarantee page eviction. Raw chunk identities were unchanged.

Observed interrupt-phase pressure maximum: PSI some avg10 1.69, over the
unchanged ceiling 1. Node RSS peak 237,862,912 bytes, below 268,435,456;
external minimum MemAvailable 1,113,796,608 bytes, above 1 GiB; external minimum
free disk 30,422,958,080 bytes, above 5 GiB. Elapsed 19.487829 seconds; longest
observed read-only native transaction 35 ms. Baseline database size 7,904,279
bytes. No final database-size query was attempted after pressure failure, so
actual final target growth is unknown; file-system free-space changes are not
PostgreSQL growth. Acknowledged historical insert throughput is 0 rows/s.
These observations prove a pressure guard trip, not which production workload
or allocation caused the system-wide PSI increase.

No second actual attempt or additional stabilization loop was run. All guards,
SQL/transaction/operation deadlines, heap/RSS and source pins remained unchanged.
No production process, system cache, host configuration, source, or backup was
mutated. Guarded lifecycle cleanup completed. Independent read-only checks at
08:38:01Z found zero remote5434 listeners and the exact own nonce root absent;
local check at 08:38:01.859Z found no5434 listener. All own local/remote sessions,
cluster, pool, tunnel, source helper and runner ended. Sole5434 was explicitly
released directly to Boyle after these checks for the queued CLI/IPC supplement.

Private retained receipts:
`/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-aEgsmR/install.json`
and
`/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-aEgsmR/interrupt.json`.
The raw source data and credentials are not included in the handoff.

Ordinary owned change for this attempt: remote Unix-millisecond phase start/end
fields and UTC progress output in scripts/run-private-postgres-preservation-fixture.mjs.
Post-fix checks: Python 9 passed; scoped Vitest 115 passed / 1 skipped;
entrypoint node syntax check passed. Earlier scoped strict TypeScript remains
applicable because no TypeScript changed in this attempt. Code and evidence
handoff are frozen. Remaining concrete blocker is sustaining the already
approved PSI ceiling throughout source ingestion on this host, not missing
connectivity, missing isolated authority, missing source permission, or another
calibration prerequisite. Any next full run requires a separately coordinated
capacity decision; this receipt does not authorize threshold or budget changes.
