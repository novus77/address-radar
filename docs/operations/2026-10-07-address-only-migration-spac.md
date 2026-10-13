# Address-only Migration SPAC

## Scope and authority

The user confirmed on 2026-10-07 that the migration retains confirmed addresses and necessary identity and monitoring settings only. This supersedes full historical preservation/import as an activation prerequisite. Existing backups remain retained; no deletion is authorized by this document.

## Source checkpoint

Native production observation: six services active, NRestarts=0; actual process delivery flags false; release 4b48fc2-forward-token-code; approximately 24 GiB disk available.

A read-only SQLite transaction produced a server-local root-private seed:

- Path: /var/backups/address-radar/address-only-seed-20261007.json
- SHA256: ff639371c3417c8431bbc455f7d1393e5a794b1b28119c2a1081b1abc8647817
- 122 FOMO accounts, 216 wallet identities, 122 entity-account links.
- 122 trader entities, profiles and monitoring policies.
- Selection: confidence=confirmed/source=manual OR confidence=high/source=fomolens_manual.
- No cross-account address conflicts found using case-insensitive EVM and case-sensitive Solana keys.
- Sensitive seed data remains on the production host. No historical tables or tasks were exported.

## Plan

1. Complete current PostgreSQL schema and runtime compatibility checks without the old full-import requirement.
2. Implement an address-only importer with a strict table/field allowlist, source digest, transaction, idempotent import receipt, foreign-key validation and independent destination count/body comparison.
3. Preserve identity relations without automatically merging identities. Retained lifecycle values are archival settings, not newly calculated capability evidence. Record historical confirmation separately from future measured capability. Suspensions, disabled channels and explicit manual permissions must not be silently promoted.
4. Establish a cutover timestamp. Initialize new monitoring cursors at the cutover boundary; do not enqueue historical wallet or token backfills. Prevent legacy bridge files, scan cursors and collectors from replaying pre-cutover observations into the new pipeline.
5. Discover and observe tokens first seen after cutover. Do not require launch-time proof or import the old token universe. Continue confirmed 100K activation, at-least-50U buys, 3x/5x opportunity tracking and independent-trader signal conditions. Real execution bases and data-quality checks remain mandatory.
6. Perform a short write fence for final address/settings delta capture, target import and backend switch. Keep the old database read-only after cutover. Do not discard post-cutover PostgreSQL writes when rolling back application code.
7. Accept address/channel selection, new-token ingestion, trade deduplication, opportunity evidence, aggregation and signal projection with delivery disabled. No synthetic success receipts or invented capability proof.

## Explicit exclusions

Old tokens, historical prices, trades, score details, candidate evidence, historical jobs, old recovery queues, outbox deliveries, leases and old coverage claims are excluded. A namespace/table existing in the new schema is not permission to populate it with legacy data.

## Completion gates

Seed generation is complete; import and backend switch are not. Require independently matching imported identities/settings, zero identity conflicts, no historical job resurrection, real new observations progressing, stable services and delivery=false before declaring migration complete. Retain the original database and server-local seed until explicit backup-retention approval.

## Independently observed production checkpoint — 2026-10-07 14:56 UTC

- The dedicated two-hour migrator credential rotation completed under a separate operation. Credentials remain server-local; previous authorization records and HBA were not changed.
- Independent PostgreSQL peer inspection confirmed business schema ledger versions 1, 2 and 3, including the complete fingerprint chain and module vectors. The schema maintenance unit reported `Result=success` and `ExecMainStatus=0`.
- `wallet_service_profile_cohort` contains **0** rows. This is schema preparation, not a completed address import.
- All six business service roles remain `NOLOGIN`. The production release remains `/opt/address-radar/releases/4b48fc2-forward-token-code`; no backend switch was performed.
- The existing cohort importer requires historical crosswalk provenance. The reduced-scope importer must validate the address-only seed directly and retain its actual provenance, rather than fabricate historical crosswalk evidence or bypass writer-startup fencing.
- Remaining gates: implement the reduced-scope import adapter; test its identity/settings preservation and atomic replay behavior; capture the final source delta under a short writer fence; import and independently compare destination bodies; establish cutover/startup authority; activate services and validate fresh address-channel events. Historical scores and lifecycle labels must not become new capability proof.
- Migration completion remains **not achieved**. A successful schema upgrade or an import receipt alone does not authorize claiming a completed cutover.

## Reduced-scope import adapter — implementation checkpoint

- Added `postgres-address-only-plan.ts` and the branded `createReviewedPostgresAddressOnlyImportPlan` entry in the existing cohort importer. The entry validates the raw seed digest, review digest, exact six-table scope, source clock, trust basis, unique account ownership, normalized wallet uniqueness and complete monitoring settings.
- Identity references point to actual rows in the pinned seed. No historical crosswalk, price evidence or capability qualification is synthesized. Non-suspended legacy lifecycle values become `candidate` in the new projection; original lifecycle, account metadata, profile settings and monitoring policy remain in provenance.
- Existing transaction authorization, native target/schema checks, collision detection, replay checks and parent-commit requirements remain mandatory. Address-only imports have a distinct ledger proof scope.
- Targeted regression: 43 passed, 1 skipped. Automation TypeScript build passed.
- Parallel full regression: 2697 passed, 107 skipped, 1 failed. The failure was an architecture scan opening a temporary migration-test `manifest.json` after concurrent cleanup (`ENOENT`); serial full regression was started to distinguish fixture concurrency from a persistent boundary violation.
- Additional cutover blocker: the PostgreSQL wallet selector currently checks profile/channel enablement and suspension, but not the legacy realtime/periodic/lightweight/off policy. Storing policy in provenance does not prove runtime enforcement. Complete this compatibility path and regression coverage before enabling migrated profiles; do not silently upgrade periodic/off settings to realtime.
- Production address rows have not been imported and the backend has not been switched in this implementation checkpoint.

## Native plan and runtime continuity checkpoint — 2026-10-07 15:20 UTC

- Address-only proof scope is now recognized by service fact loading. New address-only profiles require an explicit valid monitoring policy; the realtime wallet selector excludes periodic/lightweight/off policies instead of silently upgrading them. Capture payloads retain the policy. Legacy profiles keep their existing contract.
- Relevant runtime regression: 62 passed. Subsequent transaction regression: 49 passed, 1 skipped, including address-only ledger scope, exact idempotent replay and rollback of all staged identity/profile writes after an injected failure. Automation build and PostgreSQL service entry type checks passed.
- Full serial regression before the last two transaction tests: 333 files passed, 25 skipped; 2707 tests passed, 107 skipped.
- A protected code-only bundle was installed at `/var/lib/address-radar-maintenance-tools/address-only-import-663b3612f818d519b8e25b52390136285b0e8c462a5d1c6d004f151c9a933bf3`. Native root preparation successfully validated 216 wallets, 122 entities and realtime policies, producing plan digest `93b6242028b1095c13b38c8f74e671c72a249400bdcf27001a963b4b40d917b2`. Sensitive source and plan bodies remain server-local.
- An empty isolated database `radar_rehearsal_663b3612f818d519` was created for native import verification. The rehearsal was refused before its intent, schema installation or address writes. Read-only HBA inspection identified the blocker: the migration role is allowed only for database `address_radar` on IPv4 loopback; all other loopback database connections are rejected. Function permission and credential lifetime were checked and were not the blocker.
- No HBA edits or production backend changes were performed. Do not treat the protected prepared plan or the empty rehearsal database as a completed migration.
- Native verification needs a separately scoped temporary loopback-only HBA rule for this exact isolated database and migration role, with original-file preservation and verified restoration. Production cutover additionally still requires final-source fencing, independently checked parity, protocol-v2 startup/rollback authority and service acceptance; passing rehearsal alone is insufficient.

## Temporary authentication window and native rehearsal closure — 2026-10-07

- User explicitly approved a temporary rule restricted to the isolated rehearsal database, migration role and IPv4 loopback.
- The actual active HBA path is `/etc/postgresql/16/radarproduction/pg_hba.conf`. Its original SHA-256 is `f4871503662bf298c9b730c3017eb19339771328a5928b614197fe10e21d6821`.
- `run-address-only-hba-rehearsal.py` preserves the exact original bytes and permissions, holds the existing authentication-state lock, arms a separate 240-second restore timer before applying the rule, reloads PostgreSQL without restarting business services, and restores in a `finally` block. The timer is disarmed only after restoration is verified. Unrelated HBA changes are treated as collisions, not overwritten.
- Native isolated import succeeded for **216 wallets / 122 entities**. The existing parent-transaction importer committed actual PostgreSQL rows; replay staged zero new profiles and verified all 216 existing profiles. Plan digest: `4a3354a7c556636375cbca6b662ed011be5502b4e4a98a45fa55484478824cf9`.
- Independent PostgreSQL peer inspection compared the cohort payloads, profile versions, identity channel versions, heads, bindings and import ledger against the protected native plan. All six table checks passed.
- Original HBA byte parity and absence of the temporary rule were independently confirmed. The fallback timer is inactive. A fresh migration-role connection to the isolated database is rejected again; the existing production-database connection still works.
- Native artifacts, including `rehearsal-receipt.json`, `rehearsal-peer-receipt.json` and `hba-window/restore-receipt.json`, remain server-local in the protected address-only import directory. The isolated database is retained for audit, not used by business services.
- **This closes native rehearsal and its temporary authentication window, not production cutover.** Production address projection and formal cutover records remain empty; the next production gates are final source fencing/delta, authenticated cutover/startup/rollback evidence, atomic import, independent parity and service activation acceptance.

## Production activation work package

Native isolated parity is complete, but production activation remains blocked. Do not equate the prepared production plan with an imported cohort or an authorized service startup.

### Dependency order

1. Establish the actual writer inventory and authenticated protocol-v2 authority. Preserve the existing closure requirements; do not fabricate scopes, reuse fixture attestations, or silently reduce writer coverage. Include service, timer, bridge, operator and external-input admission paths. Preserve FOMO login and browser processes.
2. Complete production-compatible release and rollback evidence. The existing native compatibility collector is tied to its managed private fixture endpoint and is not a production collector merely because its policy uses the production-observation label. Any production lane must preserve independent evidence, exact artifact binding and retained PostgreSQL writes.
3. Prepare six least-privilege runtime roles, loopback authentication, private credentials and service-specific deployment configuration. Confirm console route compatibility, durable provider contracts and validation authorities, profile refresh, and monitoring cursor initialization before admitting writers. Do not grant eligibility from imported lifecycle labels.
4. Enter a bounded final SQLite write fence. Capture a fresh address/settings seed and explicitly compare its delta against the rehearsed seed. Use fresh operation identifiers and hashes; do not overwrite existing audit artifacts or treat the earlier snapshot as current.
5. Import the final address cohort through the authenticated native parent transaction and record the formal cutover transition and first-write evidence atomically. A commit with uncertain acknowledgement requires persisted-state inspection, not blind replay.
6. Independently compare identity and settings bodies, not only counts. Activate the sealed release only after parity and startup authority pass. Initialize future-only collection at the actual cutover boundary and reject legacy replay.
7. Accept all six services, console access and fresh address-channel observations. Verify no historical token/job resurrection and delivery=false. After PostgreSQL writes begin, rollback retains live PostgreSQL data and must not restart SQLite writers.

### Completion evidence

- Final fenced source digest and explicit delta report.
- Authenticated cutover, first-write and compatible rollback records.
- Independent destination body parity, zero conflicting identities, and preserved monitoring settings.
- Service-role and startup acceptance, console route acceptance, and real post-cutover observations.
- Delivery disabled and original SQLite database and backups retained.

This package is not yet implemented or accepted. No production backend switch is authorized by this status entry alone; execution remains subject to the existing user approval and protocol-v2 runtime checks.

## Production entry implementation status (2026-10-08)

- Added a read-only native preflight. Actual production inspection returned no cohort rows, no protocol-v2 transitions and no first-write markers; all six services were active with zero restarts, delivery was explicitly false in their process environments, and six business roles remained NOLOGIN. Unknown query results are not interpreted as zero.
- Added an existing-target grant planner composed from the existing business and protocol-v2 service grant definitions. It does not create roles/databases, install credentials, enable login or grant activation. Missing or expired capacity measurements refuse planning. The existing production provisioning artifact has capacity=null; test fixture capacity values must never replace a native measurement.
- Added an address-only first-write adapter that delegates signature validation, fencing, durable transition and marker ownership to the existing coordinator. Cohort import uses the exact parent transaction, checks target/cohort/generation binding, requires guard verification before and after import and rejects incomplete profile coverage. Guard measurement and authorization callbacks are trusted native ports and still need production implementation; mock-backed adapter tests are not native cutover evidence.
- Added a separately authenticated production compatibility path for IPv4 loopback port 5432. The existing private port-5434 path remains unchanged. Production probe approval binds the complete expected policy and program digests, reviewer identity, independent verifier and bounded validity window. Its operation deadline is capped at approval expiry; an expiry during probing refuses subsequent writes. A probe approval is not a cutover or startup authorization.
- Targeted regression: 11 tests passed. Automation build and PostgreSQL service entry type checks passed. The complete regression suite was started after the expiry fix; its result is recorded separately below when available.
- These library adapters have not been installed as a protected production collector, and no new authority registry, service credentials, capacity proof, final source fence or backend switch has been established. Production migration is still incomplete. Do not describe an unsigned report, mocked transaction, or local approval fixture as an independent native proof.

### Complete regression result after approval-expiry fix

The serial complete regression finished successfully: 337 test files passed, 25 skipped; 2725 tests passed, 107 skipped. Duration: 114.76 seconds. Log: `/private/tmp/address-radar-migration-final-20261008.log`. Skipped tests remain unexecuted; this result does not constitute native production compatibility, cutover or live-address acceptance.
