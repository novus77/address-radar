# G11 isolated six-root-service rehearsal

## Actual result

On 2026-10-04, the opt-in test in `scripts/test/postgres-six-service-runtime-rehearsal.test.ts` passed against a fresh private PostgreSQL 16 cluster. Vitest reported **one file, four tests passed, zero skipped; suite duration 83.60 seconds**. Three cases are offline fixture/signature/packaging checks; one case is the actual six-service PostgreSQL rehearsal. The final scoped strict TypeScript check exited 0.

The sealed-runner packaging blocker was resolved without changing a verifier. The test used the installed local esbuild, explicit current workspace-source aliases, a self-contained root export bundle, an explicit file hash manifest, and the existing verified Linux Node 24 executable copied into a new nonce-only root-owned directory. No dependency download occurred. The application ran as the existing non-root `address-radar` user.

Database: `radar_rehearsal_c8d75c3dc738db7e`.
Schema: `radar_rehearsal_c8d75c3dc738db7e_schema`.
Generation: `synthetic-root-c8d75c3dc738db7e`.
Sealed fixture root: `/opt/address-radar-rehearsal/c8d75c3dc738db7e`.

The final credential-free receipt is preserved locally at `/private/tmp/radar-g11-c8d75c3dc738db7e-receipt.json`. It does not contain connection URLs, passwords, private signing keys, or source rows.

## Real execution coverage

Each service used its distinct restricted database role and the real exported `runPostgresServiceEntrypoint` with a delegating runtime instrumentation port. Neither `verifyPostgresServiceRelease` nor `verifyPostgresServiceStartup` nor the dedicated writer-startup verifier was mocked or replaced. Root files were not edited.

| Service | Ready | Completed poll/read cycle | Drained | Observed awaited service UOW completions |
| --- | ---: | ---: | ---: | ---: |
| scanner | 1 | 1 | 1 | 8 |
| automation | 1 | 1 | 1 | 10 |
| wallet-monitor | 1 | 1 | 1 | 5 |
| wallet-analysis | 1 | 1 | 1 | 7 |
| historical-backfill | 1 | 1 | 1 | 5 |
| console | 1 | 1 | 1 | 3 |

The 38 observed UOW completions include reads and empty queue/lease work. They are **not 38 business mutations**, and do not enumerate every internal probe transaction. Runtime completion and shutdown were awaited; all six runtime closures completed with no tracked operation left in flight.

Real SQL inside the authorized service UOW verified PostgreSQL 16 server version, current database, current user, and installed namespace. Actual driver probes pinned generation, service, schema fingerprint, and server port 5434. No ordinary service pool was exposed or used outside the bridge. The forbidden SQLite path remained absent; the root path stayed on the explicitly selected PostgreSQL driver. An unused `node:sqlite` import in the shared export closure emits Node's experimental warning; this is not an opened SQLite backend or fallback.

The reviewed v2 schema installed with all 17 support tables. The preserved fingerprints are:

- v1: `9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22`.
- v2: `cecbd7d9218d0a91022c221d1086244fcb5e91cb5de8ac2639e7378c19070ea6`.

Setup used the dedicated migration runtime with capability mode `isolated`, an authenticated synthetic same-nonce empty-namespace receipt, and narrow system-control function grants. It did not borrow `approved_cutover` authorization or use a business runtime as the schema owner. Native coordinator prepare, selection, and first-write transitions physically committed. The first write atomically inserted the fixture generation and price lease with its durable marker.

All six actual startup bridges read revision 3, phase `postgres-written`, the same first-write receipt, and three signed journal entries. Each observed the real `no_prior_writes` check. The current startup store performs its read-only SELECT protocol through `runtime.run`; there is no separate `readOnly` driver port. This test does not misrepresent every writer startup UOW as a physical READ ONLY transaction.

First-write receipt: `b090ee5fe3a229f63ee31d300a56246cff551804d46a7bc3c1442434d908468d`.

External fetch calls were zero for every service. No provider inputs or source captures were supplied. A loopback-only absent-provider endpoint let the genuine Solana collector configuration load; empty wallets generated no acquisition request. The global fetch refusal guard was never invoked. Empty/deferred work is the intended synthetic fixture outcome, not natural wallet proof.

Console completed three actual loopback requests: GET health, GET closed-loop progress, and POST rejection with HTTP 405. It verified string counts, current-generation scope, `coverageVerified:false`, `gatewayDeliveryEnabled:false`, `legacyTotalsIncluded:false`, and `runnableDelta15m:null`. Stored jobs or intents were not treated as qualification.

## Resource and lifecycle evidence

The exclusive serial order was Mendel preservation attempt and cleanup, then Sartre publisher fixture and cleanup, then this G11 fixture. No heavy import overlapped G11.

The private cluster used loopback port 5434, max_connections 6, shared_buffers 16 MiB, work_mem 1 MiB, short SQL/lock deadlines, and nice 19. Service execution was sequential with one runtime pool connection; setup phases closed their dedicated migration pool before service execution. Node heap was capped at 128 MiB. The fixture retained the 1 GiB available-RAM and 5 GiB free-disk guards, plus an in-process 256 MiB RSS guard sampled every 500 ms.

Measured across the six service processes:

- Maximum process peak RSS: 132,452,352 bytes.
- Minimum sampled MemAvailable: 1,283,465,216 bytes.
- Minimum sampled disk availability: 30,308,630,528 bytes.

The synthetic six-service policy allocation and GRANT-plan capacity inputs are modelled fixture material, not measurements proving simultaneous production pools/reserves on this max_connections 6 cluster. These serial results do not establish production host capacity.

Guarded cleanup confirmed removal of the exact nonce-owned sealed code, copied executable, private credential/deployment files, PostgreSQL cluster, and tunnel. An independent final read-only check confirmed both nonce directories absent and local/remote port 5434 free. The reusable root-owned fixture parent may remain; no long-lived job, service account, environment, unit, or production release was modified. The serial slot was explicitly released to Mendel after cleanup.

## Failed attempts and boundaries

Four preceding fresh-nonce runs failed and are not credited as acceptance: emitted resource-regex escaping, instrumentation of a nonexistent readOnly port, a nonexistent runtime backend property, and total claim budget smaller than the explicit active-stage allocation. Only the new test fixture/instrumentation was corrected. The final total claim allocation is seven, equal to its seven per-stage quotas; empty input and connection limits did not change. Each failed run completed guarded own cleanup. No runtime ACL, root verifier, source trust rule, or core business implementation was changed to obtain a pass.

The durable cutover signatures, observer reports, and retained-compatible-PG rollback authority are explicitly **synthetic same-nonce fixture authority**, including the production-observation protocol branch required by root startup. They are not real production observations, fencing evidence, source-provenance approval, or an actual retained-production rollback rehearsal.

This closes the requested **exported-root-factory** startup/one-cycle/shutdown mechanical scope. It does not prove the dispatcher CLI/tsx loader/IPC process-launch chain: genuine tsx artifacts are included in the sealed inventory, but that launcher was not invoked. It does not prove concurrent six-service capacity, natural transactions, provider publication, business activation, delivery, or the real 141-table preservation/restore. Those remain separate evidence owned by the parent and other rehearsal tasks.

No production import, cutover, service restart, old port 5433 access, existing acceptance database write, HBA change, or production release/environment/unit/user modification occurred. Freeze after this receipt; parent aggregates remaining acceptance work.

## Scoped dispatcher / CLI / IPC supplement

The earlier six-service results are exported-function entrypoint evidence, not deployed CLI evidence. A further function-entrypoint run used database `radar_rehearsal_547a65533ee05d15`, schema `radar_rehearsal_547a65533ee05d15_schema` and generation `synthetic-root-547a65533ee05d15`: four tests passed, zero skipped, 72.73 seconds. Its guarded cleanup and exclusive-slot release completed. That result does not close the CLI scope below.

The owned test now has a separate opt-in dispatcher mode. Its thin sealed parent calls the actual `dispatchPostgresBusinessService(service, process.env)` without a spawn override. The default implementation launches verified Node, the genuine tsx CLI and loader, and the bundled current root script's CLI main. A delegating ChildProcess spawn observer records actual IPC notices; it neither injects notices nor replaces the child/runtime. The actual supervisor must accept matching ready/drained identities and successful child exit. No factory, startup verifier, fact adapter, notify or runtime callback is supplied to the root CLI.

A non-root watcher observes the real poll output, then sends SIGTERM to the actual dispatcher. Console instead performs three real loopback requests before shutdown. It enforces bounded output/deadlines, zero external fetch attempts, available RAM >= 1 GiB, free disk >= 5 GiB and **combined dispatcher/CLI process-group RSS <= 256 MiB**. Services remain sequential, not six-concurrent. The thin parent bundles only the real dispatcher, avoiding a second full service implementation in RAM. The 32 MiB, fewer-than-256-entry closure allowance accommodates the genuine native binary; it does not relax RAM/RSS, SQL, connection or disk guards.

### Pinned dependency artifact

Only official registry metadata and the tarball for `@esbuild/linux-x64@0.28.2` were retrieved into a private nonce directory. No lifecycle scripts, package-manager install, system/global install, production node_modules mutation or target-binary execution occurred.

[Official pinned metadata](https://registry.npmjs.org/@esbuild%2flinux-x64/0.28.2).

- Tarball: `https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.28.2.tgz`.
- Tarball bytes: 4741809.
- Verified registry integrity: `sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==`.
- Extracted binary bytes: 11427952.
- Binary SHA256: `e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100`.

Registry SHA512 integrity authenticates the **compressed tarball**; the required SHA256 authenticates **package/bin/esbuild after extraction**. They are different objects. Retrieval enforced metadata <= 64 KiB, tarball <= 8 MiB, 20-second request deadlines and a fixed three-file archive allowlist. Only fixed files were read from the archive; archive paths were not installed. ELF class, endianness and x64 machine type were checked.

Retained local receipt: `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-cli-artifact-d090a3b58ad75937/receipt.json` (0600). Binary: `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-cli-artifact-d090a3b58ad75937/esbuild-linux-x64` (0600, not executed locally). These are rehearsal artifacts, not production approval. The package helper independently matches the binary against the installed esbuild package's published binary hash and refuses unknown/mismatched material before PG creation.

### Offline versus native acceptance

Offline cases build local-native and pinned Linux closures, parse runner/watch/cleanup programs, invoke the genuine local tsx CLI root main and verify invalid service / missing startup authority refusal without PG. These are closure and CLI-main negative-path checks; **they do not prove successful writer startup or native IPC lifecycle**.

Run scoped offline tests with the retained artifact variables and neither PG run flag:

```sh
ADDRESS_RADAR_REHEARSAL_ESBUILD_LINUX_FILE=/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-cli-artifact-d090a3b58ad75937/esbuild-linux-x64 \
ADDRESS_RADAR_REHEARSAL_ESBUILD_LINUX_SHA256=e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100 \
node node_modules/vitest/vitest.mjs run scripts/test/postgres-six-service-runtime-rehearsal.test.ts
```

**This protocol description is not native dispatcher/CLI/IPC evidence. Use the separately dated real-run receipt; offline passing tests alone do not establish this chain.** Run only after Mendel explicitly confirms own cleanup and releases sole port 5434. No listener is not release. In addition to the reviewed lifecycle path/hash and pinned artifact variables, dispatcher mode requires `ADDRESS_RADAR_RUN_SIX_DISPATCH_REHEARSAL=1` and `ADDRESS_RADAR_REHEARSAL_MENDEL_SLOT_RELEASED=1`. The local slot acknowledgement is coordination, never cutover authority.

Native setup retains strict same-nonce DB/schema, the dedicated isolated migration owner, reviewed v2 schema, six restricted roles and synthetic native coordinator marker/journal. It does not borrow a production role or approved cutover target. Signed observer and retained rollback authority remain synthetic fixture-only. The actual default root startup must verify the native durable proof; this mode does not provide the prior function test's per-UOW instrumentation counters.

Application package CLI wrappers, package-manager invocation and deployed systemd units are not covered by this dispatcher API harness. A native pass would cover only default dispatcher -> Node -> genuine tsx -> root CLI -> real IPC -> bounded drain. Six-concurrent capacity, natural-wallet/source qualification and production authorization remain unverified.

No PG supplement starts while Mendel owns the slot. No production import, switches, writers, gateway, service restart, old5433 or production release/environment/unit changes are authorized.

Local CLI-main checks use a canonical private temporary directory. On macOS, `/var` aliases `/private/var`; passing the alias as argv while the loader resolves a canonical module URL would skip the unchanged strict root main guard. Canonicalizing the fixture path is not a main-guard bypass or production code change.
