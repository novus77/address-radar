# PostgreSQL production role and resource plan

This document describes the offline planner in `packages/database/src/postgres-business-provisioning.ts`.
It emits SQL and explicit prerequisites. It does not connect to a server, execute SQL,
deliver credentials, install a schema, inspect production, or authorize migration.
A generated plan always has `productionMigrationReady: false`; real permission,
live capacity, and credential provisioning proofs remain `unknown`.

## Role and database boundary

The caller supplies one fresh dedicated business database, its business schema,
generation, a migrator role, and six distinct service roles:

| Service | Planned authority |
| --- | --- |
| scanner | SELECT/INSERT/UPDATE/DELETE on named active business tables |
| automation | SELECT/INSERT/UPDATE/DELETE on named active business tables |
| wallet-monitor | SELECT/INSERT/UPDATE/DELETE on named active business tables |
| wallet-analysis | SELECT/INSERT/UPDATE/DELETE on named active business tables |
| historical-backfill | SELECT/INSERT/UPDATE/DELETE on named active business tables |
| console | SELECT only; database-specific default read-only transactions |

All seven identities must differ. Acceptance/test identifiers, administrative
names, SQL injection, unknown fields, and incomplete service allocations are
refused. Role and database creation intentionally have no adoption or
`IF NOT EXISTS` path. Existing names are a collision requiring parent
reconciliation, not permission to reuse the acceptance target.

Every role is created `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION NOBYPASSRLS`. Runtime roles receive no membership grants.
The plan also revokes migrator membership from all service roles.
`NOINHERIT` alone does not prohibit `SET ROLE`; fresh identities without
memberships are essential. Private credential provisioning must preserve these
attributes and must not add direct or indirect membership in migration,
ownership, predefined privileged, or other write roles.

The migrator owns only the newly created business database and its schema objects.
It is not a cluster administrator. Operator and backup connection reserves do not
grant operator/backup privileges or create additional login identities; their
separately reviewed identities and bounded operational paths remain parent work.

PUBLIC database privileges, including CONNECT, CREATE and TEMPORARY, are removed.
Service roles receive CONNECT but no database CREATE/TEMPORARY, schema CREATE,
table ownership, REFERENCES, TRIGGER, sequence authority, or ledger writes.
PUBLIC and service privileges on the public schema are revoked.
The two versioned schema ledger tables are explicitly readable, never writable
by runtime. Five worker roles share the current active-table CRUD envelope;
this does not claim that every service needs every table. Parent integration may
narrow that envelope using actual repository calls and isolated permission proof.

## Explicit stages and unchanged schema fingerprints

1. Review fresh-name absence and target identity using the parent's authorized tooling.
2. Review the transactional `cluster-roles` statements with an independently
   authorized cluster bootstrap identity.
3. Review `cluster-database` separately: CREATE DATABASE cannot run in a transaction.
   The database uses `template0`, not an acceptance database template.
4. Review `database-lockdown` in that new database.
5. Provision the migrator through the mandatory external private credential channel
   before opening a migration-role UOW. Runtime logins remain disabled.
6. Use the existing explicit `installPostgresBusinessSchema` with the dedicated
   migrator and the returned exact schema plan. The namespace must start absent.
7. Review `post-schema-grants` only after that installation has committed.
8. Provision and activate private runtime login credentials externally, then prove actual permissions.

These are review stages, not instructions to execute production commands now.
The planner deliberately does not create the business schema first: doing so
would conflict with the existing installer's new-namespace refusal contract.
No typed module SQL, version boundary, ledger SQL, or existing fingerprint is
modified. A supplied versioned plan must match the current registry exactly.
Active table grants are derived from that approved plan's named CREATE TABLE
statements, not from `GRANT ... ON ALL TABLES`.
Future tables and sequences receive no automatic service grants; future
migration modules need a separately reviewed grant plan. Global default PUBLIC
function EXECUTE is revoked for objects created by the migrator.

Creating roles can succeed before CREATE DATABASE fails. There is no automatic
drop, overwrite, privilege repair, or cleanup. The parent must reconcile a
partially provisioned operation explicitly before retrying.

## Optional archive access

Archive access is denied by default. To request it, the caller must supply an
archive namespace, a nonempty identifier prefix ending in an underscore, an
explicit prefix-matching table allowlist, and `allowRuntimeRead: true`.
Only SELECT is granted, including for console. No wildcard SQL or future-table
default grant is emitted. Ledger names and active business-table collisions
are refused. An archive inside the business namespace does not remove the USAGE
needed for active business tables.

Archive objects must already have been provisioned through the parent's approved
preservation path before archive statements are considered. This planner neither
creates them nor copies or activates historical data. Omitting archive configuration
does not identify or prove absence of other archives; private database ownership,
fresh roles, and isolated checks remain necessary.

## Explicit measured host capacity

There are no guessed production resource defaults. Every pool supplies both
instance count and maximum connections. Each service role's CONNECTION LIMIT
covers all its instances. The caller also supplies migration, operator, backup,
PostgreSQL-reserved and other-host connection allocations, plus queue, connection,
idle, statement, lock, idle-transaction, shutdown, work_mem and measurement-age limits.

```text
runtimeConnections = sum(instances * maximumConnections for all six services)
databaseConnectionLimit = runtimeConnections + migrationConnections
                        + operatorConnections + backupConnections
hostRequiredConnections = databaseConnectionLimit + postgresReservedConnections
                        + otherHostConnections
hostRequiredConnections <= serverMaximumConnections

requiredRamBytes = measuredPeakRamBytes + ramMarginBytes
requiredDiskBytes = measuredPeakDiskBytes + measuredPeakWalBytes
                  + measuredPeakTempBytes + diskMarginBytes
```

Available RAM/disk, measured peaks, and positive margins are explicit decimal
byte strings evaluated with BigInt. Known measured zero WAL/temp values are
accepted; missing, unknown or malformed measurements are refused. Disk, WAL and
temp components must be disjoint increments on the measured storage budget;
do not double count WAL/temp already included in measuredPeakDiskBytes.
Separate filesystems require parent-side per-volume checks in addition to this
aggregate gate. RAM peak must cover the entire six-service, migration and reserved
operational composition; work_mem is per executor operation, not a whole-host cap.

Capacity input binds a host identity, measurement artifact reference, exact
resource-policy fingerprint, measuredAt, validUntil and caller-supplied now.
A missing, stale, future, expired, unrelated or insufficient measurement refuses
the plan. Use `postgresBusinessResourcePolicyFingerprint(resources)` to identify
the exact measured allocation. Changing instance counts, pools, reserves,
timeouts, queue policy or work_mem invalidates that measurement binding.

Successful arithmetic only establishes consistency of supplied offline inputs.
It does not verify the measurement artifact, live server max_connections,
reserved-slot settings, operator privileges, cgroup limits, pressure thresholds,
maintenance window, disk/WAL growth, or the number of actual running instances.
PostgreSQL superuser connections may bypass connection limits; the reserves
require operational enforcement. Parent composition must keep its per-instance
driver pools and aggregate role budgets consistent; do not pass a multi-instance
aggregate budget as the driver's per-instance maximum.

## Credentials and completion evidence

Passwords and connection strings are not accepted by the planner, are never
included in SQL or receipts, and must not be printed. All roles remain NOLOGIN
until an external private credential process configures the intended authentication
and activates them. Use a protected secret manager or a private out-of-band
administrative channel; keep secrets out of command arguments, terminal output,
logs, plan artifacts and this document.

Before formal migration, parent integration must complete all six CLI paths,
retain all 141 source tables with row/type/digest/retrieval accounting, prove the
writer fence and final boundary, and rehearse rollback after PG writes. This
role plan changes no scoring, qualification, identity merge, delivery, FOMO,
historical activation, retention or provider-budget business rule.

Required isolated permission proof includes fresh-name collision refusal,
PUBLIC CREATE/TEMP denial, column-level grants, inherited and SET ROLE reachable
permissions, ledger/DDL denial, console write denial, default/future-object
privileges, archive deny/explicit SELECT behavior, and the actual async repository
calls under each identity. Credential activation must be included in that proof.
No SQL plan is equivalent to readiness or production authorization.

## Local tests

```sh
node node_modules/vitest/vitest.mjs run packages/database/test/postgres-business-provisioning.test.ts --no-cache --configLoader native
```

These tests exercise only offline planning and refusal behavior. They do not
constitute real PostgreSQL permission or production capacity acceptance.


## Reviewed extension ACL boundary

Provisioning imports/re-exports the six service identities from postgres-service-dispatch.ts. Reviewed trustedModules definitions must be provided separately from schemaPlan; the existing version-one fingerprint remains unchanged. A trusted DDL definition is not automatic permission to write its tables. Unclassified extension tables receive SELECT only.

Runtime write denial covers business_schema_identity, business_schema_ledger, migration_cutover_transitions, wallet_service_import_ledger, wallet_service_profile_cohort, wallet_service_profile_versions, wallet_service_fact_inputs, wallet_service_fact_validators and wallet_service_fact_attestations. Provenance, validator authority, attestations and cohort seeds require separately authorized migration/producer credentials, never the six business runtime roles.

The fixed runtime column policy follows the reviewed wallet-channel and service-fact module SQL. Provider budgets permit only UPDATE(window_started_at, requests_used, cooldown_until), preserving the existing window-rotation algorithm; generation/provider identity, origin, import_id, window_ms and maxima cannot be modified. Price lease updates, append-only price consumption, provider lease creation/release, wallet capture/checkpoint state and source-request creation receive only the columns used by their current implementations. No extension table receives runtime DELETE. Counter column ACLs alone do not prove monotonic accounting or protect against arbitrary counter resets by an authorized writer; such invariants require separately reviewed database enforcement.

The driver must independently reject table/column write ACLs to authority tables through every SET-reachable role and reject forbidden budget/lease column grants. The provisioning policy is not a substitute for that runtime check. Live permission proof remains unknown until an isolated rehearsal passes.

## Synthetic runtime rehearsal limitation

The opt-in scripts/test/postgres-business-runtime-rehearsal.test.ts resolves pg through packages/database/package.json, not an undeclared root dependency. It uses only randomized radar_rehearsal_* identities and private generated credentials.

Existing PostgreSQL 5433 HBA denies new rehearsal identities. It is not modified or bypassed, and the test never connects to that cluster or its acceptance/business databases. The separately authorized alternative is a fresh private PG16 cluster using existing /usr/lib/postgresql/16 binaries in a marked /tmp/radar_rehearsal_<nonce> directory. It fails closed unless remote MemAvailable is at least 1 GiB, filesystem free space at least 5 GiB, and local/remote loopback port 5434 is unused. Authentication is SCRAM over TCP. Shared buffers are 16 MiB, work_mem 1 MiB, max_connections 6 and process nice priority 19. These are ephemeral rehearsal limits, not production defaults or capacity proof.

The local tunnel must use 5434 to match the actual server port. Administrative connections use only the private cluster socket and verify its data directory and port. At most two test connections are used. Cleanup stops only the marked cluster after checking owner identity and postmaster command-line data path, then removes only its private artifact directory. No existing HBA, cluster, service, database or role is changed. Permission/resource failures are reported rather than weakening guards.

A synthetic fixture, even after isolated driver/schema/ACL checks pass, is not real-wallet or natural-case qualification evidence, does not establish production ACL/capacity proof and never authorizes formal migration or business service activation.

The mandatory provider cooldown_until is preserved from separately reviewed continuity evidence with no zero/default seed for unknown values. Runtime UPDATE may change only window_started_at, requests_used and cooldown_until; identity, provenance and contractual limits remain protected. Only EXECUTE ON FUNCTION pg_catalog.pg_control_system() is granted for instance identity, including console, never pg_monitor or authority-ledger writes.

### Authorized isolated execution result, 2026-10-04

Provisioning offline tests passed 34/34. The opt-in ephemeral PG16 rehearsal passed 1/1 (43.50 seconds of test execution). The fresh private 5434 cluster passed its RAM/disk/port guards and configured resource-envelope/identity checks. Actual v1 and synthetic trusted v2 installation/retries, restricted writer probe, committed write, rollback, read-only denial, schema-ledger and one import-authority column ACL refusal, ordinary NOINHERIT SET-role ledger ACL refusal, and fake ledger view refusal by both driver and installer passed. Guarded private-cluster stop/removal completed before the test passed. Existing 5433 was not accessed or changed by this run.

This run used a synthetic two-table extension, not the full seventeen-table application-support registry. It does not prove every protected authority table, the full provider budget/cooldown ACL matrix, real imported continuity, post-business-write rollback, or real-wallet/natural-case behavior. Production permissions/capacity and migration readiness remain unknown; no formal import or service activation was authorized.

## Actual v2 mutation grant coverage (2026-10-04)

The canonical runtime column policy now includes the three production-composition tables, in addition to the seven wallet/fact-adapter tables. `wallet_forward_signal_jobs` permits only its reviewed INSERT columns and status/scheduling/lease/reason/wake UPDATE columns; `wallet_forward_signal_wake_receipts` permits INSERT only; `wallet_forward_signal_wake_intents` permits its reviewed INSERT columns and UPDATE(status) only. These are column grants for the existing five writer roles, not table-wide CRUD, not DELETE, and not console privileges. The nine fixed authority tables remain runtime SELECT-only.

The production provisioning test uses `createPostgresServiceSchema()` and its actual trusted v2 module registry, verifies all 17 support table declarations, and preserves the original v1 migration fingerprint. Local targeted validation on this revision reported seven passing files, 307 passing tests and two skipped opt-in tests. Skips are not database proof. Parent-provided full-suite counts are separate evidence, not a run performed by this task.

The real rehearsal is explicitly opt-in:

```sh
ADDRESS_RADAR_RUN_BUSINESS_RUNTIME_REHEARSAL=1 node node_modules/vitest/vitest.mjs run scripts/test/postgres-business-runtime-rehearsal.test.ts --reporter=dot
```

The fixture uses a newly initialized private PG16 cluster and fresh nonce database/roles. It never connects to the existing 5433 cluster or changes its HBA/services. RAM/disk and both 5434 ports must pass the fixed preflight before initialization. Actual cluster limits remain six server connections, 16MB shared buffers, 1MB work_mem and nice 19; fixture role pools run sequentially, at most two client connections. Its offline provisioning-capacity input is a labeled synthetic policy fixture, not a measured production sizing recommendation. Sequential six-role checks do not prove concurrent six-service deployment capacity.

A first actual-v2 run timed out at 300 seconds and was not accepted. Recovery verified the nonce owner marker, postgres UID, exact postmaster binary/data path and server port before stopping/removing only the owned cluster. The fixture now batches each role's SQL permission-planning queries, emits credential-free stage progress and adds an exit cleanup fallback. Failed cleanup is never reported as success.

### Native migration/cohort integration boundaries

`apps/automation/src/postgres-cohort-import.ts` exists; the earlier lookup under `packages/database/src` was incorrect. Its isolated apply capability and the dedicated migration runtime currently require database/schema identifiers containing `test` or `acceptance`; the authorized business-runtime fixture uses `radar_rehearsal_*` and the business driver refuses those other identity classes. Do not manufacture `approved_cutover`, bypass the migration adapter with a service runtime, or treat handwritten fixture seeds as a native cohort import proof. The parent owns resolution of these explicit capability contracts.

The safe migration runtime also requires a pre-owned exact namespace and no database CREATE/TEMP. The legacy new-business installer refuses adoption of an existing empty namespace. A separately authenticated provisioning-namespace receipt is a parent-owned integration requirement; isolated schema mechanics must not be advertised as proof that production bootstrap is wired. Real-wallet/natural-case evidence, all-141-table source preservation, million-row import capacity, first-write cutover marker/receipt atomicity and post-write rollback remain separate gates.

### Completed actual PG16 runtime rehearsal

The second actual-v2 isolated run passed 1/1 in 328 seconds; its owned cluster was removed successfully. Fresh preflight reported MemAvailable 1,381,052 KiB and filesystem free 29,813,896 KiB. These are fixture-start observations, not production workload measurements or authorization to activate services.

Observed evidence:

- Six distinct service roles passed their restricted identity/ACL probes sequentially; console's attempted write was denied.
- The actual v1 then actual v2 installer applied the 17 reviewed support tables and idempotent retry succeeded. The v2 fingerprint was `cecbd7d9218d0a91022c221d1086244fcb5e91cb5de8ac2639e7378c19070ea6`; the original v1 migration remained unchanged.
- Each of the five writers passed PostgreSQL EXPLAIN (without ANALYZE) for all 21 literal support mutation statements captured from the actual wallet/composition/fact-adapter source: 105 permission/schema checks. This is permission planning, not execution of every business branch.
- Actual restricted-role execution committed a wallet poll's capture binding/checkpoint, composition wake intent/receipt/job insert and conflict-upsert/dispatch, fact-adapter source request/provider debit/lease/release and HTTP429 cooldown persistence, plus a price consumption receipt. The provider HTTP response was a local synthetic fixture, not external provider evidence. Unknown/unattested price facts correctly remained deferred.
- An intentionally failed wake UOW left no durable wake row. The existing provider origin/import/window size/maxima remained unchanged; imported known synthetic cooldown was not defaulted, and the resulting future cooldown denied another request.
- All nine fixed authority tables rejected both injected table UPDATE and column UPDATE privileges: 18 direct-role refusals and 18 refusals via an ordinary SET-reachable role inheriting another role that was not itself SET-reachable.
- Immutable provider-budget columns and additional table/column INSERT, UPDATE, DELETE or REFERENCES authority produced 24 ACL refusals. Only window_started_at, requests_used and cooldown_until were mutable; cooldown_until had no default.
- A fake view substituted for the schema ledger was rejected by both runtime and installer.

The real test used ordinary non-superuser service roles and a separate restricted migration role for installation/known fixture seeds; the schema owner was not represented by BusinessRuntime. The private bootstrap administrator was used only for isolated role/database setup, deliberate negative ACL fixtures and an independent observer. It was never a replacement production import executor. No existing acceptance/business database, 5433 cluster, production role, HBA or service was touched.

Native full preservation/cohort imports were not run through the new dedicated migration adapter because the isolated identity capability contract remains incompatible with this business-runtime nonce fixture. Handwritten known fixture seeds are not proof of the Mendel native import/cohort API. The requested custom pg_dump/pg_restore rehearsal was not performed: the bounded role test had already completed its guarded source-cluster cleanup before that phase could safely obtain its connection budget. Backup/restore, exact typed-payload import preservation and physical commit/failure replay through the dedicated native migration adapter remain pending actual-PG acceptance, not passed or implicitly covered by the offline tests.

## Consolidated same-nonce rehearsal: observed outcome, 2026-10-04

This section supersedes earlier pending naming/bootstrap descriptions, but does not upgrade the failed consolidated test to a pass. All commands used the actual repository `/Users/a77/Documents/ChatGPT/address-radar`. No existing PG5433 database, production import, cutover, HBA change, or service restart was performed.

### Code and offline evidence

The canonical provisioning policy now covers the three composition tables with exact INSERT/UPDATE column grants: `wallet_forward_signal_jobs`, `wallet_forward_signal_wake_receipts`, and `wallet_forward_signal_wake_intents`. Provider UPDATE remains exactly `window_started_at`, `requests_used`, and `cooldown_until`; origin, maximum limits, import lineage and seed columns remain protected. The fixed nine-table authority classification is not broadened. Reviewed trusted v2 module extensions are accepted through the existing explicit registry, without changing the versioned SQL fingerprints.

At 14:00 local time, the provisioning, migration-runtime and native cohort-import test files returned **3 files passed, 82 tests passed, 1 skipped**, in 9.12 seconds. The skipped case was a separate opt-in PostgreSQL test, not a successful real rehearsal. After the fixture-only lifecycle adjustment, provisioning plus the default opt-out rehearsal load returned **1 file passed, 1 skipped; 35 tests passed, 1 skipped**, in 13.81 seconds. These counts overlap and must not be summed. This was not a full repository suite or typecheck.

The owned fixture now creates a fresh dedicated pool for each migration phase, closes the preservation runtime before creating the cohort runtime, and forwards actual checked-out client error events through its real-query COMMIT fault wrapper. That last adjustment was only loaded offline; a subsequent real run against the newly hardened migration-runtime implementation remains unproven.

### Actual private PostgreSQL evidence

The latest consolidated opt-in run started at 13:58:38 local time and ended **1 file failed, 1 test failed**, in **460.16 seconds**. Its private database was `radar_rehearsal_7cfb18e16530cd54`, with schema `radar_rehearsal_7cfb18e16530cd54_schema`. The preceding expanded run also failed (418.47 seconds); it is not counted as a pass.

The latest run observed MemAvailable **1,348,356 KiB** and filesystem free **29,798,240 KiB** at its guard. It used a fresh private PG16 cluster on loopback5434, max_connections6, shared_buffers16MB, work_mem1MB, nice19, and at most two client connections. Its >=1GiB RAM / >=5GiB disk guard was not lowered. No overlapping full-preservation workload ran.

The following assertions actually completed before the failure:

- Same-nonce, preowned empty namespace installation through the dedicated migration-role runtime, actual system identifier and narrow `pg_control_system` EXECUTE grant; actual v1 and v2 installation and idempotent retry. Namespace authentication used an in-memory synthetic fixture signer, not a production approval key.
- Actual v2 support schema: all **17 support tables** present; fingerprint `cecbd7d9218d0a91022c221d1086244fcb5e91cb5de8ac2639e7378c19070ea6`. The existing v1 fingerprint remains `9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22`.
- All **six distinct restricted roles** passed the real runtime probe. Five writer roles planned all 21 captured actual application mutation statements using EXPLAIN without ANALYZE: **105 SQL schema/permission checks**, not 105 committed writes.
- **Three actual application transaction paths committed**: wallet capture binding/checkpoint; composition wake intent, receipt, conflict-upsert and dispatch; fact adapter request/debit/lease/release and HTTP429 cooldown. Console write denial and an independent-observer physical rollback assertion passed. Provider HTTP responses and chain/collector inputs were synthetic.
- Protected-table runtime refusals: **18 direct ACL injections**, **18 SET-reachable inherited ACL injections**; immutable provider budget ACL refusals: **24**. The three mutable budget columns were accepted and immutable configuration remained denied. A fake schema-ledger view was rejected by both runtime and installer.
- Real dedicated migration-runtime full-preservation importer: **4 synthetic source tables, 7 rows, 4 chunks**. A failure after physical row INSERT rolled back rows and chunk receipt. A lost response injected only after real COMMIT left the durable chunk visible; retry resumed it, and a completed retry resumed all four chunks without duplicate writes. Canonical typed row bytes and manifest bytes matched, including maximum signed bigint, negative-zero real representation, invalid-UTF8 text bytes, bytea and NULL. This is not the real141-table/6,023,033-row source.

### Remaining real integration blocker

The native cohort/provider importer failed before the intended marker CHECK failure with **`postgres_cohort_import_target_connection_mismatch`**. Its `cohort-import-target` SQL uses `inet_server_addr()::text`, whose inet text representation includes `/32`, while the verified runtime/store target uses canonical `host(inet_server_addr())` (`127.0.0.1`). The identity pin was not weakened, changed to a CIDR, or mocked. The exact owner-level recommendation was handed to Mendel: use `host(inet_server_addr())` consistently and retain the existing exact target comparisons and isolated authorization.

Consequently, native cohort/provider schema-contract acceptance, same-transaction import/marker rollback, physical marker COMMIT-before-acknowledgement, and marker uncertainty reconciliation **are not verified by this run**. The bounded pg_dump(custom)/pg_restore and all-fixture-table parity stage **was not reached**. Neither is a skip/pass disguised as readiness. The fixture includes these stages, but their execution requires the actual importer correction and a fresh guarded run. Do not use a BusinessRuntime owner workaround, approved_cutover self-authorization, or direct superuser import instead.

### Cleanup and handoff

Both failed expanded runs reported `cleaned:true` after guarded private-cluster stop/removal and tunnel termination. A separate authorized read-only check confirmed both known nonce artifact roots absent, **zero local5434 SSH tunnels**, and local and remote5434 available. All owned test processes had exited. There is no surviving source fixture to dump. Mendel was given the runner/API/lifecycle details and the no-overlap requirement; no credentials were handed off or printed. His independently bounded real141-table rehearsal is a separate scope and must recheck capacity, immutable source pins and chunk/resident-memory limits before any run.

Mechanical fixture success does not establish natural-wallet qualification, actual provider behavior, production signed namespace approval, concurrent six-service resource capacity, production target activation or post-write production rollback readiness. No readiness claim follows from the SQL plan or SQL fingerprint alone.

## Final consolidated real fixture: PASS, 2026-10-04 14:14 local run

This final result supersedes the preceding native connection-mismatch blocker and unexecuted backup stage. Mendel corrected the actual native probe to `host(inet_server_addr())` without weakening the target identity. The final fresh guarded run loaded the hardened migration runtime and the fixture's independent per-phase pools/event forwarding; no probe was mocked.

**Actual opt-in Vitest: 1 file passed, 1 test passed, 474.35 seconds** (started 14:14:09 local). There were no skips in this opt-in run. Earlier failed attempts remain failed historical results, not additional passes. The offline counts above overlap and are separate from this real test.

Observed preflight: MemAvailable **1,342,384 KiB**, filesystem free **29,795,880 KiB**. The original RAM/disk floors, PG6-connections/16MB-shared-buffers/1MB-work_mem/nice19 and at-most-two-client limits were preserved. Every earlier six-role/schema/application/authority assertion passed again: 17 actual support tables, 105 EXPLAIN permission checks, three application transaction paths, 18 direct plus 18 SET-reachable protected-table refusals, 24 budget ACL refusals, console denial, physical rollback and fake-ledger refusal.

Additional assertions actually passed in this final run:

- Dedicated migration role, real system identifier and narrow control-system grant, exact same-nonce database/schema and actual permanent ledger checks through the current migration runtime.
- Preservation of 4 synthetic source tables / 7 rows / 4 chunks: row-insert failure rollback, lost physical COMMIT response and durable receipt reconciliation, idempotent completed retry and exact typed/manifest bytes.
- Actual Mendel native cohort and provider schema contracts accepted. Two historical fixture profiles retained their exact payloads and flags. Imported provider counters/limits/lineage were retained and cooldown `9223372036854775807` survived without precision loss or an unknown/default reset.
- Native cohort + provider + first marker shared one real top-level UOW: an intentionally invalid marker CHECK rolled back both imports and marker. An independent connection saw committed import/marker rows while the COMMIT response was held and the caller had no acknowledgement. A second physical COMMIT followed by an injected lost response produced commit uncertainty; reconciliation loaded the durable marker and checked the existing profile without reimporting it. The traced fixture observed 28 physical COMMITs across these preparation stages; this is not a count of production business transactions.
- Bounded **pg_dump custom / pg_restore**, archive **425,069 bytes**, to a separate unique same-nonce fixture database: **81 tables matched** on row counts/full-row digests, column/default/constraint metadata, explicit bigint/bytea/NULL preservation and state/schema ledgers. The source was checked again before removal. Restored identity records intentionally retain the original fixture identity; restore parity is not activation/retargeting authorization.

The real test reported **`cleaned:true`** after guarded cleanup. A subsequent explicit read-only check confirmed **zero local5434 SSH tunnels**, local5434 available and remote5434 available; the test process exited successfully. No fixture remains active or reusable with its former credentials.

A reusable credential-free lifecycle module was handed directly to Mendel at the private artifact path `/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar_rehearsal_lifecycle-qz6YDc/private-pg16-lifecycle.mjs`, SHA256 `f64463042e64f2d11ccfdd078ca00c47e0610d672b02cd51379d94bc1b7a49bb`. Its API `withPrivatePreservationFixture(operation)` creates fresh guarded identities and 0600 private connection files only when invoked, with a dedicated migration-only role and narrow system-ID permission; callback completion is followed by owned cluster/tunnel/config cleanup. Syntax and offline module load passed. This extracted lifecycle has **not itself been executed against PG**, and its callback must still provision the reviewed four preservation ledgers, construct Mendel's pinned external authority record, close its dedicated pools and respect his stronger chunk/RSS/disk-growth guards. Do not treat the artifact or the synthetic fixture as the actual141-table rehearsal result.

The extra dedicated execution-publication actor/UOW was not available after cleanup. No consumer authority privileges were broadened to fabricate that test; source publication SQL and independent source-provenance acceptance remain separate unverified integration scopes. Real141-table preservation, natural-wallet/provider evidence, full six-service concurrency, production approval and formal post-write rollback readiness are not established by this PASS.

The follow-up read-only real-source size inventory encountered an external access blocker: the approved `sudo -n -u postgres` account returned PermissionError13 opening the pinned backup manifest. One initial SSH banner timeout was retried once; the retry reached the source permission check. No manifest/chunk contents were read by that inventory, no PostgreSQL connection was made, and no source permissions were changed. Therefore real maximum chunk size/total export size remain unobserved by this agent. Mendel and the parent received the exact blocker and the reusable private lifecycle module; the next bounded full run must first obtain inventory from an explicitly authorized read-only source account, honor the stricter resident-chunk/RSS/disk-growth checks, and execute only serially after this completed fixture's cleanup.
