# Bounded Private PostgreSQL Full-Preservation Rehearsal

## Scope and current prerequisites

This is backup-derived preservation, not operational cutover evidence. It does not create schemas or roles, execute business DDL, select PostgreSQL, fence writers, activate services, merge owners, or import legacy history into an active cohort. Production remains held for consolidated authorization.

The completed immutable export reported by the parent is under `/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf`: 141 tables, 6,023,033 rows, 1,548 chunks. Supply the actual bundle subdirectory, not an assumed path. Actual manifest/snapshot/catalog digests must come from independent verified export evidence; the script refuses count/hash mismatches. It does not rehash the source SQLite snapshot and cannot certify snapshot freshness or writer fencing.

Boyle owns private cluster lifecycle and the only loopback 5434 scheduling slot. Never connect to 5433, reuse its roles, modify its HBA, or start a second overlapping fixture. Wait for an explicit lifecycle handoff. The fixture DB and schema must match `radar_rehearsal_<16 lowercase hex>[_lowercase letters]` with the same nonce. The dedicated migration role must own only that exact schema, have no database CREATE/TEMP or other schema/relation authority, and have the narrowly approved `pg_control_system()` capability needed by the actual runtime system-identifier probe.

Provision only the four historical ledgers using the existing `createFullDataPreservationSchemaSql(schema)` under Boyle's independently authorized fixture lifecycle. The runner never installs them. It constructs the actual `createPostgresMigrationRuntime` with `mode: isolated`, `purpose: schema_install` because preservation-only namespaces have no business ledger. This mode is not an authority bypass: the external adapter must explicitly authorize the exact preservation purpose, source pins, target, role, physical cluster, expiry and budgets. It must reject production and unexpected SQL scope. No `approved_cutover` fallback exists.

## Operator adapter and independently pinned private config

The reviewed, private ESM authority module exports `createPreservationFixturePorts(config)` returning a fresh dedicated `pool` and the external `assertAuthorized` callback required by `PostgresMigrationRuntimeOptions`. Credentials stay in that module/private secret source, not command-line arguments or evidence. Both the config file and authority module are mode 0600 regular files; ancestor symlinks and unsafe writable ancestors are rejected. Root and sticky temporary ancestors are permitted. Module transitive dependencies and the execution host remain part of external code trust; a module digest alone does not authenticate approvals.

The config contains exactly these fields:

```ts
interface PreservationRehearsalConfig {
  version: 1;
  stage: "interrupt" | "resume" | "parity";
  bundleDirectory: string;
  evidenceDirectory: string;
  storagePath: string;
  authorityModule: string;
  authorityModuleSha256: string;
  approvalRef: string;
  deadlineAtMs: number;
  expected: {
    manifestSha256: string;
    snapshotSha256: string;
    catalogFingerprint: string;
    tables: number;
    rows: number;
    chunks: number;
  };
  target: PostgresMigrationTarget;
  resources: {
    reserveBytes: number;
    maximumTargetGrowthBytes: number;
    minimumAvailableMemoryBytes: number;
    maximumRssBytes: number;
    maximumMemoryPsiAvg10: number;
    maximumResidentChunkBytes: number;
  };
  maximumTotalQueries: number;
  maximumTransactionMs: number;
  maximumQueriesPerTransaction: number;
  interruptAfterCommittedChunks: number;
}
```

The externally supplied config SHA-256 must be independently reviewed; do not compute it from an unreviewed self-asserting config and treat that as approval. Change stage/expiry only in a newly reviewed config. Keep the source operation/manifest and target identity unchanged for restart reconciliation.

## Explicit low-pressure budget

- Linux only; `/proc/meminfo`, `/proc/self/status`, `/proc/pressure/memory` must be readable. Unknown measurements fail closed.
- At least 1 GiB `MemAvailable`, at least 5 GiB disk reserve. Initial free space must additionally cover the explicitly approved maximum target growth.
- The default resident-chunk ceiling remains 2 MiB. A larger chunk requires an explicit externally trusted `residentChunkAllowance`, bound to the exact manifest and source chunk digest, an actual rollback calibration and measured RSS no greater than the explicitly reviewed ceiling. The private prepared fixture uses only the actual inventory maximum, 16,775,058 bytes, never the entire 16-MiB envelope by assumption. No backup is rewritten or rechunked.
- Shell wrapper uses `nice -n19`, idle `ionice -c3`, 96 MiB old-space heap and a one-hour hard process deadline. Node 24 and the reviewed tsx loader must be explicitly supplied. No host/cluster memory setting or production service is changed.
- RSS ceiling is explicitly configured and hard-capped at 256 MiB; use a lower reviewed ceiling given actual headroom. The fixed private wrapper additionally samples Linux resources every 200 ms and terminates its own process group on the 1-GiB RAM, 5-GiB disk or 256-MiB RSS boundary. Node high-water RSS is retained, not only end-of-run RSS. Pressure never increases approved budgets.
- Per-transaction timeout is at most 60 seconds, statement timeout at most 30 seconds, work memory 1 MiB and parallel query workers zero. Physical SQL is bounded to one million for a run and each transaction has a separately explicit ceiling.
- Database size is sampled every 25 import transactions/parity chunks. WAL and filesystem pressure are separately covered by disk reserve monitoring. No diagnostic all-history join is used.

Raw chunk bodies plus individual row bodies duplicate approximately twice the export payload before table/index overhead and WAL. Initial sizing enforces at least this payload floor but cannot promise that it covers all physical growth. Report database growth, minimum disk/RAM, peak RSS/PSI and elapsed time; never substitute these for a production capacity approval.

The parent measured approximately 1.22 GiB available memory with swap almost exhausted at 06:00:11Z. That leaves little headroom above the one-GiB guard. No complete full-history PostgreSQL run is claimed by this tooling delivery.

## Executable private lifecycle and memory repair

`inspect-full-preservation-bundle.py` reads only the exact independently pinned manifest and planned regular-file metadata through the authorized root file reader. PostgreSQL permissions are not widened. The real inventory found 5,336,768,356 export bytes and 1,087 chunks above 2 MiB; the largest is `table-0044-chunk-000000.json`, SHA-256 `1328e4403d467c4aa7f7ef4cee43a85ea59347263caf0250b4f76be36fb6f8b3`.

The first actual calibration stopped after 1.24 seconds on the external memory-reserve boundary: minimum `MemAvailable` 1,063,104,512 bytes, sampled Node RSS 196,403,200 bytes, free disk 30,458,925,056 bytes. The private lifecycle confirmed cleanup. This is a measured failed calibration, not successful ingestion or full-history parity.

The repaired verifier `verifyOpaqueFullDataPreservationChunk` retains one bounded original chunk and raw row byte views, parses only one row at a time, and verifies the exact canonical envelope, raw chunk digest, storage-class rules and raw canonical row bytes. It never retains a whole-chunk JSON tree or creates business values. `readOpaqueFullDataPreservationBundle` performs complete per-table content verification using that representation.

An importer `executionBudget.opaqueRowWindows` explicitly selects parameterized `UNNEST` pages. The prepared fixture uses at most 64 rows and a 512-KiB page goal; a single larger row is governed by the separate hard 2-MiB row limit. All pages, original chunk BYTEA, receipt and verification proof stay in the same outer chunk transaction. Retry and independent parity receive original chunk BYTEA in 512-KiB slices rather than a full 32-MiB hexadecimal reply. No per-row round trips or concurrent PG writes are used.

`calibrate-postgres-preservation-chunk.ts` exercises the largest actual pinned chunk using the dedicated migration runtime and real PostgreSQL BYTEA round trips, then deliberately rolls back all source rows. Only its four preservation ledgers may be provisioned. The explicit 60-second transaction bound remains. A positive calibration is required before the larger-chunk allowance can be consumed.

`run-private-postgres-preservation-fixture.mjs` consumes Boyle's SHA-pinned lifecycle, checks local/remote connection-record correspondence without logging secrets, and uploads only a bundled reviewed runner and private records into the same nonce-owned temporary fixture. Root access is restricted to protected source reads and private-file delivery; every PG connection uses the fresh non-superuser migration actor. It starts separate calibration, interruption, resume and parity processes serially, retains private receipts locally, and lets the guarded lifecycle clean up its own cluster. The fixed runtime probe found `/usr/local/bin/node` v24.21.0. This deployment never touches a production release.

Build the standalone entry with the repository's existing esbuild/pg dependencies, not a remote install. Provide an explicit reviewed fingerprint helper in `PRESERVATION_FINGERPRINT_HELPER`; it hashes the exact four schema-specific DDL statements. The helper is not a source snapshot hasher. The preparation wrapper uses explicit 20-GiB growth headroom, a 900-second stage deadline, 96-MiB old-space heap and optional explicitly exposed GC to release dead source/network buffers. It does not change host or cluster resource configuration.

Import source content is verified once by the importer before its first ledger write. Read-only target-size/restart metadata probes may precede that pass. Independent parity verifies each source chunk and per-table digest again. The SQLite snapshot is not repeatedly rehashed. Receipts include phase, acknowledged new rows/chunks, successfully revalidated prior chunks, exact SQL counts, observed growth, pressure and actual rate; a partial/failed phase is not converted into completion.

## Actual isolated checkpoint, 2026-10-04

The fixed source inventory independently matched the parent's manifest/snapshot/catalog pins and all 1,549 source files were root-owned, private regular files. No source content or permissions were changed. The prepared fixture used fresh same-nonce DB/schema `radar_rehearsal_bcd0ba4896b68e81` / `radar_rehearsal_bcd0ba4896b68e81_schema`, loopback 5434, dedicated non-superuser migrator, actual system identifier `7692712758958352219` and the actual migration runtime.

Real PostgreSQL exposed an ordering defect hidden by the small/mock fixtures: casting `row_ordinal` or `ordinal` to text creates an output alias, and an unqualified `ORDER BY` then sorts that text alias. The importer and parity queries now qualify the original BIGINT column with `preserved_rows` / `preserved_chunks`. Regression fixtures include 17 rows and 12 chunks. No lineage comparison was weakened.

Largest real chunk calibration passed: 2,842 original rows, 16,775,058 raw chunk bytes, 16,771,987 row bytes, maximum row 6,896 bytes. All original row bodies and sliced chunk bodies round-tripped through real PostgreSQL in one transaction, followed by deliberately acknowledged rollback and zero operation records. It took 3,715 ms internally / 4.021 seconds including the fixed wrapper. Node high-water RSS was 146,104,320 bytes (the external 200-ms sample saw 138,559,488); minimum externally sampled available RAM was 1,239,162,880 bytes. Actual physical SQL count was 162: four acknowledged non-source commits (DDL/read-only measurements), one acknowledged source-DML rollback. Database bytes grew from 7,904,279 to 41,810,967, a measured 33,906,688-byte physical increase despite rollback. This is lossless codec/transaction evidence, not durable imported historical receipts, and no storage-class distribution is claimed from this calibration report.

The subsequent real 141-table attempt failed closed after 300.386 seconds. Complete filesystem/content verification returned before the first importer UOW invocation; source throughput was approximately 20,068 rows/second over that phase, not a PG insertion rate. The first ledger transaction was prevented by observed memory pressure: PSI `some avg10` peaked at 13.51 against the explicitly configured 1.00 limit. Maximum internally recorded RSS was 244,297,728 bytes; the external sampled peak was 247,042,048 bytes. External minimum RAM was 1,083,256,832 bytes and disk free was 30,369,316,864 bytes. The failure was not a missing connection, SQL timeout, source pin mismatch or disk shortage. No approved resource ceiling was raised.

Exactly 15 physical SQL statements and two acknowledged read-only metadata commits occurred in that stage. Historical rows committed: 0; historical chunk receipts committed: 0; successfully resumed chunks: 0; independent full parity rows: 0. PG commit throughput is therefore 0, not an estimate for a successful import. Resume and the separate full parity process were not run. The reported free-disk minima measure whole-filesystem pressure, not attributable target growth. The target's pre-stage database baseline was 41,810,967 bytes and no post-failure database-size sample was taken under the failed guard; exact final target growth is therefore unmeasured.

The lifecycle confirmed cluster/tunnel cleanup and the serial slot was released. Private retained receipts are under `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-WCoujH`, in `calibrate.json` and `interrupt.json`. The immutable remote backup remains untouched. Production selection, source fencing, business activation and the 216/192/4 native cohort latency claim remain unperformed.

Next repair is a bounded, cache-conscious root source reader (fixed path/owner/digest checks; aligned streaming or per-file `POSIX_FADV_DONTNEED` and throttling), plus reduced row-decoder/allocation churn. Preserve the current global content-verification requirement, original chunk identities and atomic chunk receipts. Repeat calibration and the staged native test only after that repair and a released slot. Do not change the PSI ceiling, heap/RSS approval, shared buffers, host swap, production services or backup files to manufacture a pass. This repair and a passing real resume/full-parity run remain explicit work; tooling/unit coverage is not their evidence.

## Three separate process invocation

```bash
NODE_BINARY=/absolute/reviewed/node \
TSX_IMPORT=/absolute/reviewed/tsx-loader.mjs \
bash scripts/run-full-preservation-rehearsal.sh \
  /absolute/private/reviewed-config.json "$EXTERNALLY_APPROVED_CONFIG_SHA256"
```

First run `stage: interrupt` with an explicit receipt count. The runner stops only after the dedicated runtime has acknowledged a chunk COMMIT. This exercises a controlled application/process restart boundary, not a network-loss or crash-during-COMMIT experiment. Save its private receipt and exit the process.

Use a fresh dedicated pool/process for `stage: resume`. It verifies existing operation lineage and bounded receipt accounting, then the unchanged importer verifies each existing chunk/row body rather than trusting the receipt count. It completes missing chunks and independently committed verification checkpoints. Changing a chunk on retry fails. UOW-return means physical COMMIT was awaited; ambiguous commits are reported as failed/unknown requiring a later fresh-process reconciliation, never a fabricated success.

Finally run `stage: parity` in a fresh process to re-read every archived chunk and each matching PostgreSQL ordinal range, compare exact BYTEA bodies and lineage, verify chunk receipts and per-table content digests, and check table counts and operation completion. Queries are bounded by the planned chunk range and response bytes; they do not turn archived cells into business values. Reported storage-class counts, integers outside JavaScript's safe range, blob/text byte lengths and row-byte totals are actual measurements. Opaque text retains the manifest's database encoding; Python real hex/infinity, integer decimal strings, blob and null remain legacy facts with no qualification.

Evidence files are unique mode-0600 JSON files in a precreated mode-0700 directory outside the source bundle. No backup/source artifact is deleted or overwritten. Target cleanup remains solely Boyle's responsibility, after evidence handoff.

## Evidence boundaries

Unit tests exercise config/resource guards, private no-follow file reads, exact typed-byte parity and tamper rejection. Existing importer tests cover atomic chunk rollback, commit uncertainty, changed retry and bounded completion. These are not a passing 6,023,033-row real-PG run. Actual source-to-PG receipt/resume/parity, PG pressure and restart evidence require the externally authorized live fixture adapter, independent source pins, verified chunk-size fit, disk-growth approval and the released scheduling slot.

Native 216-profile/192-enabled/four-provider latency is a separate isolated business-schema fixture with reviewed plans and appropriate migration-runtime authority. The historical runner never calls cohort APIs or makes an all-six-services completion claim. Its 8,710 wrapper/8,718 physical SQL count is modeled-client protocol evidence, not actual PG latency. Boyle's separate small typed-PG experiment is not evidence that this full export has been imported.
