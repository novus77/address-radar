# Migration writer fence and rollback protocol

This module implements preparation validation and a durable coordination protocol. It does not stop production, replace symlinks, collect live evidence, provision schemas, switch deployment configuration, purge data, or activate business delivery. The parent composition owns those integrations and their separately signed scoped authorization. Old prices and purge approval are not inputs to this protocol and do not veto lossless preservation.

## Trust boundary

`WriterFencePolicy` is an externally reviewed expectation, not a field embedded in a candidate manifest. Pin its versioned canonical digest outside the candidate artifact workflow. It specifies the canonical source path, device/inode/schema, old and new generations, exact decimal snapshot watermark and cohort, final snapshot hash, complete source catalog, expected writer census, PostgreSQL endpoint/system identifier/schema/release, compatible rollback target, provider/delivery guard baseline, collector identities and binaries, authorized reviewer actions, deadlines, and budgets.

Collectors sign observations; reviewers separately sign transition commands. Neither signature proves business scoring. A compromised trusted collector can lie: the parent must supply audited collectors that actually enumerate the operating system and verify artifacts. A boolean such as `complete: true` or `passed: true` is not an observation. The core checks signatures, pinned collector binary/run/host/boot/challenge provenance, exact expected contents, chronology, row accounting, budgets and guard parity. It never treats a fabricated test fixture as real production proof.

Collector keys and reviewer keys may have separate capabilities. Candidate observations cannot select a new trusted key, issuer, binary or expected target. Bind source/target identity in every signed observation. PostgreSQL identity includes database, schema, schema fingerprint, release digest, generation, network endpoint and cluster system identifier; database names alone are insufficient.

Use `migrationCutoverCanonicalJson`, `migrationCutoverDigest`, `migrationCutoverObservationPayload`, and `migrationCutoverAuthorizationPayload` as the version 1 protocol. Only plain, dense JSON with safe integer numbers is accepted; counts/watermarks/bytes are decimal strings. Undefined, accessors, custom prototypes, `toJSON`, sparse arrays, non-finite numbers and negative zero are rejected. Signing and validation consume the same normalized JSON, with domain separation for digests, observations and command authorizations. This is a project encoding, not a claim of RFC 8785 conformance.

## Comprehensive writer and file census

External expectations must include the six production runtime services and the FOMO sync and backup input services, both input timers, and explicit lists for operators, deployment jobs, every user's cron jobs, and external inputs/bridges. Declare a connection allocation for every expected writer, including zero allocations. An empty non-service category is permissible only when the externally reviewed expectation and the authenticated exhaustive census both show it empty.

A production collector must enumerate all users, namespaces/containers, processes, executable identities, PID start identities, inherited file descriptors, systemd service/timer units, cron jobs, active operator sessions, deployment jobs, and external bridges. Check database, WAL and SHM real paths and device/inode identities. Sign the complete scan with pinned binary identity, host, boot ID, run ID, positive sequence and the current fence challenge. Absent WAL/SHM files are represented explicitly by null device and inode. A missing scan category, unknown writer, omitted expected writer, substituted executable, stale boot, replaced source inode or unknown file holder blocks preparation.

The final census must follow the final snapshot and show no live writer process and no open source database/WAL/SHM holder, including read holders. This conservative protocol requires quiescence plus persistent admission barriers; a PID census alone is insufficient. Validate each expected writer's denied admission, blocked inputs and distinct stale-generation rejection attempt. Admission barriers must cover future processes, operators, cron and deployments, not just current service PIDs. The parent maintains those barriers across every transition and recovery.

## Final boundary and preparation

Only `full-fenced-snapshot` is accepted. There is no inferred timestamp delta mode. Fence enforcement precedes snapshot start; snapshot completion precedes the current exhaustive census. Every observation binds the same source, generation, watermark, snapshot and target. Snapshot catalog and table contents must match the external catalog, and preserved plus quarantined row counts must account for the original snapshot exactly, including integers beyond JavaScript's safe integer range. Hash parity is over losslessly retrievable retained content, including quarantine.

Preparation requires authenticated current target/compatible-release probes, unchanged provider/delivery guard baselines, measured resource traces, and both rollback rehearsals. A rehearsal collector must execute the before-first-write and after-first-write cases on isolated PostgreSQL using the exact release/schema/generation contracts; the after-write case must recover retained mutations and guards. A rehearsal receipt is not an authorization to perform a production write.

Deadlines are explicit: preparation window is at most one hour, evidence age at most five minutes, one operation at most sixty seconds, lock budget at most five seconds. Authorization must expire before every required observation and fence expires. RAM/disk budgets include measured peaks, WAL/temp usage and reserves. Connection budgets include all writer instances plus migration, operator, backup and PostgreSQL reserves. Ledger transitions and SQL statement counts are bounded.

Delivery, FOMO capture, historical mining and automatic owner merge remain false. The coordination receipt also states `activationEnabled: false` and `writeAuthorized: false`; it is historical state, not a transferable capability. Business activation requires a separate protocol owned by the parent.

## Durable transitions

Constructing either adapter starts no transaction. Production composition explicitly supplies an authenticated, bounded PostgreSQL pool plus explicit statement/lock timeouts to `createPostgresCutoverTransitionStore` and an externally pinned policy to `createMigrationCutoverCoordinator`. The store probes the database, endpoint/system identifier, permanent schema ledger, fingerprint and generation inside each transaction. It refuses an unlogged or temporary transition ledger. The migration role needs explicit permission for `pg_catalog.pg_control_system()`; do not broaden runtime role privileges to satisfy this probe.

Popper/the parent schema owner must include the exported trusted `MIGRATION_CUTOVER_TRANSITIONS_DDL` in the actual v2 schema extension and its fingerprint, using `migrationCutoverTransitionsDdl(schema)` for an explicitly qualified schema. This batch does not alter the schema builder or execute DDL. Missing transition tables fail closed; registering a generation or selecting PostgreSQL in configuration cannot substitute for this table and a committed signed transition. Do not use `IF NOT EXISTS` to hide an incompatible preexisting ledger. Provision it only through the separately authorized schema workflow. The minimal shape below is illustrative; use the exported DDL for the full checks:

```sql
CREATE TABLE business.migration_cutover_transitions (
  source_key text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  state jsonb NOT NULL
);
```

There is one source-keyed state row with original signed preparation observations and a bounded journal retaining each signed command and its recorded transition receipt. A transaction-scoped advisory lock uses the host and canonical source path, excluding generation, inode and schema: replacing a file or changing a generation must not produce an independent lock for the same source. All parent participants must use this lock namespace. External tools cannot be constrained by advisory locks alone; the writer fence remains mandatory.

The adapter sets statement/lock/idle transaction limits and synchronous commit, acquires the source lock, probes identity, reads the row under `FOR UPDATE`, applies a typed transition and saves through revision comparison. A fresh private unit of work handles the physical COMMIT/ROLLBACK for each call and never joins an ambient caller transaction, so a nested callback cannot acknowledge a transition before its durable commit. Pool connection timeout, actual statement cancellation, authenticated PostgreSQL access and bounded shutdown remain requirements of the injected production runtime. Do not use a promise timeout race to pretend an in-flight transaction has rolled back.

Transitions are:

| Action | Required state | Result |
| --- | --- | --- |
| prepare | no prior row | prepared |
| select-postgres | prepared | postgres-selected |
| first-postgres-write | postgres-selected | postgres-written |
| rollback before first write | prepared or postgres-selected | source-rollback-selected |
| rollback after first write | postgres-written | postgres-rollback-selected |
| abort | prepared or postgres-selected | aborted, fences retained |

Every action requires current explicit reviewer authorization for the exact operation ID, action, expected revision, plan digest, deadline, write ID and recovery observation. Reused operation IDs return only the original durable receipt when the request digest matches. Changed requests fail; stale generation/revision, terminal states and exhausted budgets fail. Abort never restarts SQLite and is forbidden after a PG write.

The first business write callback receives the same PostgreSQL transaction used to record its marker and command receipt. It must write the idempotent business receipt and preserve provider/delivery guard stores in that transaction. It returns the exact write ID, receipt digest and provider/delivery guard digests. Callback failure, cancellation before commit and deadline failure roll back both business effects and marker. The parent must route **every** potential first PG business writer through this transaction and keep other writer admission blocked until the durable marker is known. Subsequent writes require the parent's continuous mutation/input journal and guarded business runtime; this module does not implement those business rules.

## Commit-unknown and rollback

A lost COMMIT acknowledgement or a late/cancelled acknowledgement throws `CutoverCommitUnknownError`. Never blindly replay the callback, reopen the source, or assume rollback succeeded. Call `reconcile` with the original exact command and a fresh bounded recovery deadline. It acquires the same source lock and checks the durable journal. A held lock, unavailable database or failed read leaves the outcome unresolved and all fences retained. A committed receipt is returned without callback execution. Authoritative absence under the lock permits a retry with the same operation ID only while an explicit scoped authorization is valid; an expired authorization needs a new signed request and reconciliation of the original request first.

Before the first PG business write, source-only rollback requires a fresh signed operation/revision/plan-bound recovery observation with original snapshot table parity and unchanged provider/delivery guards. This selects a source recovery path; the parent must still verify and perform an authorized restore/restart. Merely repointing a SQLite symlink is not proof of parity or admission safety.

After the first PG business write, source-only rollback is categorically refused. A fresh signed recovery must identify the exact compatible PostgreSQL release, schema, endpoint, system identifier and generation; bind the durable first-write receipt; preserve baseline guards and the provider/delivery guard digests returned by the first write; and demonstrate equal retained/recovered mutation digests through the current recovery watermark. The collector must verify the full current journal and latest guards, not just the first write. PostgreSQL remains authoritative. Plain SQLite symlink rollback is not an accepted transition.

Recovery observations and authorizations may be refreshed after the original preparation window expires, but must bind the original plan, snapshot and current durable revision. Production composition must keep trusted keys/current clock under external control and require a live fenced journal boundary through the recovery watermark. This is the parent's continuous-journal and execution integration, not a claim supplied by a fixture.

## Read-only CLI and protocol tests

The checker reads two bounded regular files, rejects symlinks, checks the external policy digest pin, verifies saved observations against the current clock and emits sanitized JSON. It never opens PostgreSQL, constructs a transition store, stops a process, modifies a source, or authorizes a write. Fixture policies are refused.

```sh
node --import tsx scripts/check-migration-writer-fence.ts \
  --bundle /reviewed/writer-fence-observations.json \
  --expected-policy /trusted/writer-fence-policy.json \
  --expected-policy-sha256 "$TRUSTED_WRITER_FENCE_POLICY_SHA256"
```

Exit 0 means preparation evidence matches expectations at evaluation time; exit 1 means blocked; exit 2 means invalid input or fixture policy. A caller that chooses its own policy pin has not established trusted authority. Pin policy/issuer capabilities in the parent, and revalidate inside the separately authorized execution workflow. Neither CLI exit 0 nor a stored selection permits business activation or production writes.

```sh
node node_modules/vitest/vitest.mjs run packages/database/test/migration-cutover-coordinator.test.ts
```

Tests use explicitly labeled injected collector signatures, in-memory atomic transactions and simulated PostgreSQL query responses. They verify protocol invariants, corruption/staleness, rollback boundaries, idempotency, cancellation, commit-unknown and sanitized CLI behavior. They are not production OS census, real PostgreSQL durability, real rollback rehearsals, or evidence of operational readiness. Production collector adapters, schema provisioning, signed authorization issuance, universal writer integration, continuous journaling and physical cutover/rollback remain parent-owned composition work.

## Runtime backend selection API

Pinned private configuration and a registered activated generation do not establish durable cutover authorization. Before choosing PostgreSQL, the parent startup path must call the read-only exported API with its already validated deployment identity:

```typescript
const selection = await verifyCommittedPostgresCutover({
  expected: pinnedWriterFencePolicy,
  runtime: { target: verifiedRuntimeTarget, cohortId: verifiedCohortId },
  store: verifiedCutoverTransitionStore,
  clock: () => new Date().toISOString(),
  deadline: startupVerificationDeadline,
  signal: startupSignal,
});
```

The call takes the same source-level lock under UOW, probes the actual PostgreSQL target through the production store, and reads without saving. It revalidates the original signed preparation at its historical committed execution time, all retained reviewer authorizations, operation/request digests, transition order, exact generation/schema/release/endpoint/system identifier/cohort and first-write marker. Only durable `postgres-selected` or `postgres-written` states qualify. Missing/prepared/aborted/rollback-selected states, corrupt or fabricated signatures, and mismatched configuration fail closed. Historical execution authorization need not still be unexpired at startup; it must have been valid when the recorded transition ran.

The returned opaque `CommittedPostgresCutoverCapability` contains backend, phase, revision, plan digest, exact target/cohort, evidence mode and a bounded verification lifetime. It cannot be constructed through an exported factory. It remains `writeAuthorized: false` and `activationEnabled: false`. Production startup must require an externally trusted `production-observation` policy; the explicitly labeled fixture mode exists only for protocol tests. No capability should be reconstructed from JSON, booleans or configuration.

Parent composition still owns calling this gate from production startup, failing closed on rejection, enforcing a current source admission fence and provider/delivery guard runtime, rechecking revision/generation under the same UOW before writes, and separately authorizing business activation. A startup capability is a bounded backend selection result, not a lease that overrides later rollback or generation revocation. The production entry is not modified by this batch.

The bounded handoff to Popper is: import `MIGRATION_CUTOVER_TRANSITIONS_DDL`/`migrationCutoverTransitionsDdl` from the new core, include the table in the real v2 extension/schema fingerprint, and make `verifyCommittedPostgresCutover({ expected, runtime: { target, cohortId }, store, clock, deadline, signal })` a mandatory gate in the parent backend selection path. A configuration-selected PG path must fail closed until that call succeeds. Neither the v2 builder nor the production selector is modified by this coordinator-owned batch.

## Existing read-only runtime startup adapter

The production entry can retain its existing `run/probe/close` runtime without exposing a raw pool. Construct `createReadOnlyCutoverStartupStore({ runtime: verifiedRuntime, target: verifiedRuntimeTarget, clock })`, then pass that store to `verifyCommittedPostgresCutover` **at top-level startup before composition**, outside any writer transaction. The write coordinator remains on its independent physical-pool adapter.

This adapter uses ordinary SELECT without advisory or row locks. It never uses FOR UPDATE, creates an additional pool, changes the verified runtime's connection/statement limits, saves a state, or permits caller business SQL. It reads the live PostgreSQL system identifier using pg_catalog.pg_control_system() in the same verified runtime transaction. It additionally refuses a transaction that already has an assigned transaction ID, preventing an ambient writer from presenting its uncommitted selection. Top-level placement remains mandatory; the generic runtime API cannot reveal every ambient read-only scope. Missing ledger, unavailable live cluster probe, wrong live endpoint/cluster/schema/generation/fingerprint, malformed state and invalid signed authorization all fail closed.

Console/read roles need SELECT on the actual v2 migration_cutover_transitions table and existing schema-identity/ledger reads, plus a narrow EXECUTE ON FUNCTION pg_catalog.pg_control_system() grant for the independent live cluster probe. Do not grant pg_monitor or broad roles. If this function privilege is unavailable, startup fails closed; configuration or historical metadata cannot replace the live probe. Release identity is supplied by the parent's verified loaded-release artifact and compared exactly with the signed state; PostgreSQL cannot report a JavaScript bundle release hash. A configuration-selected backend must never skip this gate. The returned capability still grants neither business writes nor activation.

The capability now exposes the validated durable firstPostgresWrite receipt. Root entry must accept postgres-selected only for console/read, and require postgres-written plus that marker for writer services. mutableJournalVerified is explicitly false and writerStartupBlockers contains FULL_MUTABLE_FAMILY_JOURNAL_NOT_VERIFIED: the real continuous journal covering every post-cutover mutable family is not implemented or proven in this batch. It remains a writer-startup/operational blocker, not a property inferred from the first-write marker or matching rollback artifact digests.

## Long operations and unapproved production windows

A snapshot/export/restore over 141 tables can take 25 minutes. Historical fence enforcement, snapshot start/completion, capacity measurement boundaries and rollback rehearsal boundaries must be inside the explicitly approved maintenance window and ordered consistently; they need not be within the latest five minutes. Observations/signatures and the final live census must still be current, and authorization expires before their freshness/expiry, the fence expiry and the window end. Window duration remains bounded to one hour and operation acknowledgement to sixty seconds. No window extension or invented current clock is permitted.

The 25-minute example in the tests uses an explicitly injected fixture window, 141 fixture tables, a fence before snapshot start, ordered completed parity/rehearsals, and fresh observation/final census times. An out-of-window boundary or stale observation/census rejects the example. This is not approval of a real maintenance window, proof of real production artifacts, or selection of an actual target. The user has not approved a formal production maintenance window; the actual target remains unknown and production transitions remain blocked until externally trusted exact inputs and scoped approval exist.


## Compatible PostgreSQL release route, not an invented reverse journal

A first-write marker and migration transition journal are not a full mutable business
reverse journal. The previous unconditional FULL_MUTABLE_FAMILY_JOURNAL_NOT_VERIFIED
startup blocker made every PostgreSQL writer technically unable to start. The core
now supports the approved alternative: restart an independently tested compatible
PostgreSQL release against the SAME PostgreSQL data, endpoint, cluster, database,
schema fingerprint and generation. No SQLite symlink, snapshot rewind, schema
downgrade, provider counter/cooldown reset, global head reset or ownership merge is
part of this route. mutableJournalVerified remains false, truthfully.

The externally pinned policy must include postgresRollbackCatalog (all live tables
in the target schema, with explicitly reviewed insert/update/delete coverage or an
explicit immutable empty operation list) and postgresRollbackVerifier. The persisted
signed rehearsal may include CompatiblePostgresReleaseProof in compatibleRelease.
It binds both exact target release artifacts, table-by-table post-commit mutation
retention and compatible-release read/write receipts, immutable provenance and
provider/delivery behavior checks, parent-transaction marker+projection rollback,
and commit-unknown reconciliation. A separately pinned verifier key and collector
binary must attest this proof; the ordinary preparation collector cannot self-sign
independent compatibility. Booleans or a release hash alone are never proof.

Production release 4b48 still runs SQLite. It is NOT a compatible PostgreSQL release
and cannot satisfy this evidence contract. Independent actual compatibility tests
must exercise retained candidate PG schema/generation with the candidate and
rollback artifacts; synthetic tests below establish protocol rejection behavior,
not successful real-release rehearsal. A trusted verifier is responsible for real
collection and immutable receipts, not signing invented hashes.

Root startup calls verifyCommittedPostgresWriterStartup with the same options as
verifyCommittedPostgresCutover and the existing SELECT-only startup adapter. It
requires postgres-written and a persisted first-write marker, or a separately signed
postgres-rollback-selected state with the exact tested rollback runtime target.
The full live table catalog is checked in the same read-only UOW. Missing or invalid
proof fails closed; console-only selection can still use the selection verifier.
The returned branded rollbackReadiness.strategy is compatible-postgres-release,
writerStartupBlockers is empty only for that proven route, and writeAuthorized and
activationEnabled remain false. Root must reject injected-protocol-fixture mode in
production. This capability is not a SQL grant or business activation permission.

Mendel's applyReviewedPostgresCohortImportPlanInTransaction and
applyReviewedPostgresProviderBudgetSeedPlanInTransaction must receive the exact
coordinator first-write PostgresTransaction, with explicit reviewed plan/capability
and statement/record/deadline budgets. Their pending_parent_commit results do not
acknowledge durability. The coordinator saves the first marker in that same physical
UOW and awaits commit; callback failure rolls back both. Standalone approved-cutover
batch APIs are prohibited. Full six-service family coverage is larger than these
nine import/provider tables and must be supplied by the reviewed PG catalog.

## Outstanding production writers and formal boundary

User-reported read-only inventory at 2026-10-04T04:53:48Z: all six business services
were active/running; address-radar-backup.timer was active; the FOMO verification
sync timer was active on a two-second schedule, while its oneshot service was
inactive just after a trigger; address-radar-migrate.service was active/exited.
These observations are not current signed fence proof. Pausing a FOMO collector
DOES NOT stop the bridge sync timer. The required unit census includes both timers,
the possible sync/backup oneshots and the migration unit, not just six services.
An exited migration unit is still a deployment admission surface to fence.

Root/ubuntu/postgres were reported to have no crontabs. The address-radar service
user's crontab remains UNKNOWN and must be inspected, along with operators,
deployment jobs, external inputs and all live process/file holders. No production
unit has been stopped by this work. No formal maintenance window or actual target
has been approved. These are final approval/evidence blockers, not requests for
immediate production execution. During the formal approved fenced window, no old
SQLite write may occur through any service, timer, oneshot, migration unit, cron,
operator or bridge; a complete fresh census and signed admission-denial evidence
must establish that boundary before the final fully fenced snapshot.

## Dedicated operator runtime store: the only write adapter

createMigrationRuntimeCutoverTransitionStore accepts runtime.run from the verified
createPostgresMigrationRuntime result, explicit statementTimeoutMs/lockTimeoutMs,
exact CutoverPostgresTarget, and an ISO clock. It calls this run exactly once at the
top level. The dedicated runtime authenticates external approval, checks the actual
schema-owner migration role and exact schema/generation, bounds connections/query/
callback work and owns the sole physical BEGIN/COMMIT. The store uses that supplied
transaction for source advisory lock, live target/catalog probes, FOR UPDATE load,
CAS save, cohort/provider callback and first-write/policy journal marker. It never
opens an additional pool, creates another UOW, calls runtime.probe in the callback,
or invokes a nested run. Statement and lock settings cannot exceed store budgets
or the remaining command deadline; dedicated runtime limits must be consistent.

The old createPostgresCutoverTransitionStore raw-pool export is deprecated and now
always throws RAW_POOL_CUTOVER_STORE_DISABLED_USE_VERIFIED_MIGRATION_RUNTIME,
without connecting. Earlier descriptions of that raw-pool adapter are superseded
by this section. Construct the runtime only through the dedicated operator factory
with an authenticated external approval port; an arbitrary structural mock run is
permitted only in explicitly labeled injected protocol tests, never production.
The migration runtime is NOT the business startup driver. Startup still uses the
restricted SELECT-only business-runtime adapter, without owner authority.

Exact first-write call shape:

```typescript
await coordinator.execute(firstWriteCommand, bundle, {
  write: async (transaction, writeId) => {
    await applyReviewedPostgresCohortImportPlanInTransaction(plan, {
      transaction, capability, assertAuthorized, budget,
    });
    await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(seedPlan, {
      transaction, capability, assertAuthorized, budget,
    });
    return { writeId, receiptSha256, providerGuardSha256, deliveryGuardSha256 };
  },
});
```

The caller must supply reviewed receipt digests and authenticated native importer
capabilities, not fabricated values. pending_parent_commit is staged work only;
coordinator.execute acknowledges only the dedicated runtime's physical commit.
Unknown COMMIT acknowledgment requires reconcile with the same operation ID under
the same source lock, never a blind second independent import. Mendel owns the
cross-module integration tests; protocol mock passes are not real PG execution.

## Explicit full-cohort single-transaction SQL budget

The write policy and dedicated-runtime cutover store accept an explicitly reviewed
maximumSqlStatements between 8 and MAXIMUM_CUTOVER_WRITE_SQL_STATEMENTS (10000).
This is an upper bound on configuration, NOT a new default or an automatic grant.
A previously approved 1000-statement policy still permits exactly 1000. Changing
the budget changes the pinned policy and plan digest and requires corresponding
review/signatures and matching explicit dedicated-runtime/importer budgets.
maximumOperationMs remains at most 60000; no maintenance window or time limit is
expanded. A quota failure rolls back native rows, marker and policy journal together.
Never split the first marker from the cohort/provider commit to fit a budget.

Account separately for the coordinator wrapper (settings, lock, probes, ledger
load/save, native importer SQL) and the dedicated runtime (BEGIN/settings/owner and
schema probes/COMMIT or ROLLBACK). The runtime's explicit quota must cover its wider
count. A one-profile test does not establish capacity for 216 profiles plus four
provider budgets. Mendel owns the actual native-fixture count and full-cohort
integration coverage; modeled counts are not production-duration/resource proof.

Readonly startup remains capped at MAXIMUM_CUTOVER_STARTUP_SQL_STATEMENTS (1000),
with effective scope min(explicit policy maximumSqlStatements, 1000). Increasing
an approved write budget never expands reader queries or SQL capabilities. No
scoring, provider limits, delivery or activation semantics change.

Deadline regression coverage uses an explicitly labeled fixture clock: 59999ms
may commit within a signed 60000ms command, while 60000ms and 60001ms observed
inside the callback cause native rows, marker and policy journal to roll back.
If physical COMMIT succeeds but acknowledgment reaches the deadline, the result
is commit-unknown and is reconciled under the source lock without re-importing.
This proves protocol boundary behavior, NOT that a 216-profile native transaction
will complete within 60 seconds on the real server. That still needs isolated
measured native execution against the exact approved target and resource budgets.

### Measured 216-profile native-path SQL accounting (modeled client)

Mendel reported the full native integration fixture with 216 profiles (192 enabled,
24 suspended) and four separately reviewed provider-budget seeds. It directly uses
the dedicated migration runtime, coordinator write adapter, native importer ports,
first-write marker and policy journal on one connection and one BEGIN/COMMIT.

| Layer | Statements |
| --- | ---: |
| Native cohort importer | 8656 |
| Native provider-budget seed | 48 |
| Coordinator wrapper total, including its six overhead statements | 8710 |
| Physical runtime/client total, including six further UOW/runtime statements | 8716 |

An explicitly signed fixture policy budget of 10000 and explicit runtime budget of
10000 allow that single transaction, leaving 1284 physical runtime statements of
headroom. This is not a default, a production-approved increase, or a time guarantee.
The unchanged 1000-policy regression rejects at the wrapper quota (1000 forwarded
statements, 1006 physical statements at rejection) and rolls back all imports,
heads, budgets and marker, leaving the selected state and journal unchanged.

The reported model elapsed time was 758ms with native/runtime/coordinator fixture
deadlines of 4000/5000/10000ms. That is NOT real PostgreSQL or network duration and
cannot establish the production 60-second capacity. The separately tested core
60000ms boundary remains hard: callback expiry rolls back, and a late physical
COMMIT acknowledgment produces commit-unknown reconciliation, not a new import.
Mendel's dedicated-runtime deadline regression and Boyle's isolated actual PG
rehearsal are separate evidence. No actual target, maintenance window, compatible
PG rollback release, independent real compatibility proof or production approval
is inferred from these modeled-client counts. Unsigned or absent proof still fails.

### Dedicated-runtime expiry differs from a coordinator-only deadline simulation

Mendel's final scoped result was 57 passed and two optional real-PG cases skipped,
with scoped strict TypeScript success. Its deterministic dedicated-runtime expiry
case advances the runtime fixture clock to 60001ms during the first profile INSERT.
The actual runtime implementation rejects further SQL, INCLUDING an explicit
ROLLBACK attempt, and returns an AggregateError containing operation and rollback
PostgresMigrationDeadlineError causes. It discards the connection. The modeled
client aborts its pending transaction on discard; there is no COMMIT, marker or
success acknowledgment. The reported trace contains 56 physical statements before
discard. This is NOT an executed SQL ROLLBACK and NOT real PG cleanup evidence.

Earlier coordinator-only deadline regressions use an injected runtime that still
permits ROLLBACK; do not generalize that trace to the dedicated-runtime expiry
case. Real server transaction termination after connection discard and full-cohort
completion within 60 seconds remain separate isolated PG evidence requirements.
No production readiness, signed authorization or compatible-release proof follows
from the modeled abort. Normal quota failure does execute SQL ROLLBACK before the
deadline and remains distinct from expiry cleanup.

## Bounded nonmutating census extension

The checker now has a separate diagnostic mode; the existing saved signed evidence
mode remains unchanged. The diagnostic accepts an explicitly reviewed scopes file
and its migrationCutoverDigest pin, never arbitrary shell commands or a ready flag:

```sh
node --import tsx scripts/check-migration-writer-fence.ts --census \
  --census-scopes /absolute/reviewed-writer-census-scopes.json \
  --census-scopes-sha256 REVIEWED_64_HEX_PIN
```

WriterCensusPolicy requires a host identity, the exact SQLite/WAL/SHM file paths,
explicit users (including address-radar), reviewed system/user service and timer
units, cron-line hashes, operator session identities, process command candidates,
and named deployment/external-input scopes. There are no invented production
paths, ownership conclusions or default budgets. All six business services, both
timers, sync/backup oneshots and address-radar-migrate.service must be in the
system-unit scope. Reviewed non-writer OS units may have writerId:null, which is
an inventory classification, NOT a proof that their execution is safe or fenced.

Queries are fixed read-only hostname, systemctl list-units/list-unit-files/list-timers,
per-approved-user sudo -n systemctl --user and crontab -l, loginctl list-sessions,
and lsof field output for ONLY the three named source files. There is no broad
/proc walk, process argv/environment dump, shell, database connection or SSH
connection built into this mode. Native executor limits each read command to at
most 3000ms and 32768 combined output bytes, and the entire diagnostic to at most
30000ms and 64 commands. At most eight reviewed users are accepted. Exceeding any
limit means unavailable/incomplete, never an empty successful census. The scanner
may terminate only its own bounded reader process group on timeout/output overflow;
it never signals a production unit or writer. No production SSH census was run by
this batch. Operator use must remain within existing approved read permissions;
sudo -n denial is recorded, never followed by a password or permission escalation.

Every observation distinguishes present, absent, denied, unavailable and unknown.
An empty successful crontab or exact no-crontab diagnostic can establish scoped
absence. missing commands, unavailable user buses, denied sudo/read access,
not_available output and unrecognized failures cannot. The latest user crontab
checks returning not_available remain unavailable, NOT proof of no crontab.
System and user timers are enumerated directly; an inactive sync oneshot does not
cancel the active two-second sync timer. Extra/unreviewed timers, service units,
cron lines, operator sessions and writable SQLite handles are reported explicitly.
Process command matching is only a candidate attribution, not executable identity
or trusted provenance. Unverifiable handle access/file identity remains unknown.

Raw command exit/error metadata and stdout/stderr SHA-256 fingerprints are retained.
Unit listings retain metadata, not descriptions; cron schedules and line hashes
are retained while commands/environment values/comments are redacted. All stderr
text is represented by a fingerprint to prevent rejected command payloads leaking
credentials. Raw here means bounded original-observation fingerprints plus safe
metadata, not a promise to publish secret command bytes. No file/credential contents
or production connection strings are logged. Output truncation cannot become proof.

This initial extension deliberately leaves external deployment/input admission,
/etc/crontab and cron.d/periodic directories, anacron and at jobs unverified rather
than inventing absence. Those named scope observations remain unknown/incomplete
until additional specifically approved bounded readers and real provenance exist.
Configured input units are visible but do not enumerate remote deployment actors
or future external admissions. censusComplete therefore stays false with these
remaining scopes, and fenceEstablished/preparationReady/writeAuthorized/
activationEnabled remain false. Diagnostic mode exits 1 for this unproved fence;
invalid pins/scopes exit 2. A complete future diagnostic still must not claim that
readonly reads establish a future fence. Only the separately trusted signed fence
protocol and formal approved maintenance boundary can establish admission denial
and the final fully fenced snapshot. No stop, disable, restart, cutover or write
operation is performed. The 2026-10-04T04:53:48Z inventory remains historical,
not fresh production fence evidence.

The exported native read executor independently validates the exact fixed argv
forms before spawning, not merely TypeScript executable types. Mutating systemctl,
crontab removal, loginctl termination, hostname changes, unscoped lsof and arbitrary
executables are rejected. The caller cannot turn this diagnostic port into a write
command by supplying different args. Tests for those rejections spawn no child.

## Corrected bounded child-holder observation (2026-10-04)

The initial SSH adapter failed to discover a source from MainPID handles and lost
structured listings when its collector was null. That adapter result is incomplete;
it must not be used as evidence of absence. The corrected collector always retains
structured system/user units and unit files, timer boundary fields and activated
units, operator session/UID/owner metadata, and explicit scoped kernel observations.
It no longer requires the parent to hold SQLite before observing the supplied path.

The native executor accepts only fixed read-only systemctl show properties for the
nine known service units and the exact WRITER_PROCESS_CENSUS_PYTHON export, with
validated source-file and root PID/cgroup arguments. An arbitrary Python script,
PID reader or shell is not accepted. The fixed reader stats the three supplied files
and reads only approved-unit cgroup members and their bounded task descendants.
It does not sweep /proc, inspect cmdline/environ, read database contents, or publish
cron commands. Process start ticks are checked again for PID reuse. Per-FD kernel
fdinfo octal flags and stat device/inode are retained; writable is derived from the
actual O_ACCMODE bits, never supplied as an approval boolean. Parent no-handles,
permission errors, disappeared processes/FDs and truncated scans remain distinct.

Hard reader bounds: 128 processes, 32 tasks per process, 64 cgroup directories,
256 FDs per process, 4096 total FDs and 2000ms internal elapsed time. These bounds
are additional to the existing 3000ms command, 32768-byte output and 30000ms/64-command
collector caps. Any limit, unsupported metadata, inode alias/replacement, changed
source identity or read error leaves the census incomplete. A separate sudo-n lsof
query for only DB/WAL/SHM detects holders outside known cgroups; mapped mem entries
without access flags remain explicitly unverifiable, not silently read-only.

One corrected read-only remote retry ran at 2026-10-04T06:42:51.312Z through
06:42:52.793Z, with 31 readers and 1480ms remote elapsed time. Its sanitized
observational receipt is migration-writer-census-observation-2026-10-04T06-42-53-105Z.json.
The initial no-live-census statements above describe the initial extension only;
this corrected receipt supersedes the incomplete 06:24 receipt, not external policy.

Observed source path: /var/lib/address-radar/address-radar.db, device 64769, inode
1137388; WAL inode 1053936; SHM inode 1054014. These are observed metadata, NOT an
approved canonical source, generation, watermark, schema or signed target binding.
Stable identity before/after the reader does NOT imply stable database contents.
The reader inspected 18 processes and 409 FDs, retaining 38 writable source FDs.
Six MainPIDs held none, while child PIDs 4146739, 4146780, 4146765, 4146757, 4146759
and 4146726 held DB/WAL/SHM with actual flags 02500002. Kernel-reader elapsed time
was 17ms, with no recorded kernel error, truncation or source identity change.
These facts prove ongoing possible writes, NOT a writer fence.

Both address-radar-backup.timer and address-radar-fomo-verification-sync.timer were
active/waiting. The sync last/next boundaries were 14:42:50/14:42:52 HKT, consistent
with the two-second schedule; its service was inactive/dead at the later unit read.
The backup timer next boundary was 2026-10-05 04:16:57 HKT. The migration service
remained active/exited. Inactive oneshots do not cancel their timers or admission.

Additional unreviewed active/waiting timers were fomo-address-radar-input-sync.timer,
fomo-address-radar-backup.timer and fomo-radar-protocol-audit.timer. The FOMO collector,
login and novnc services were active/running; the protocol-audit service was failed.
Their behavior/approval classification is unknown, not an automatic non-writer
exemption. Ubuntu sessions 1944 and 410 were observed; executable/admission identity
and future deployment actors remain unknown. All four scoped user crontabs returned
explicit no-crontab exit 1. Eight system-cron entries retain classifications,
schedules and original line hashes with commands redacted. All three regular cron.d
files were read, but periodic-script and scheduled-command write behavior was NOT
reviewed. /etc/anacrontab was missing; atq was unavailable (exit 127); user systemd
buses were unavailable (exit 1), not absent.

Exact local retry invocation (temporary read-only SSH adapter, not a migration CLI):

```sh
cd /Users/a77/Documents/ChatGPT/address-radar
node --import tsx /private/tmp/volta-live-writer-census-corrected.mts
```

The adapter sends its bounded reader over stdin to this exact transport, without
uploading or modifying a production script, config, gateway or release:

```sh
ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=5 -o ServerAliveCountMax=1 \
  -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
  -o ControlMaster=no -o ControlPath=none \
  ubuntu@152.32.185.240 'python3 -u -' \
  < /private/tmp/volta-live-writer-census-corrected.py
```

SSH uses the existing key/agent and known-host trust, has a 40s local transport cap,
and the remote batch has a 27s/64-reader/32KiB-per-reader cap. sudo is always -n.
Timeout termination applies only to the owned reader child, never a production unit.
Raw observations mean original-byte fingerprints plus sanitized structured metadata;
credential-bearing command bytes and stderr payloads are never printed. Actual
exit/error classes and native errno, when exposed, remain separately recorded.

Operator runner API remains collectWriterCensus(reviewedPolicy, {execute, clock}).
Native host use supplies executeWriterCensusCommand; remote adapters must preserve
exact requested argv, timestamps, exit/error and bounded stdout/stderr without
converting permission or command failures to empty successes. Public parsing APIs
are parseWriterCensusListing and parseWriterProcessCensus; the latter validates exact
source paths, types, hard bounds and flag syntax. This batch's observed-host/path
policy is explicitly NOT a signed authority policy. The formal runner must load an
external reviewed scope and migrationCutoverDigest pin using the existing --census,
--census-scopes and --census-scopes-sha256 flags; it cannot self-approve discovered
units, inode/generation, operators or a maintenance window.

censusComplete, fenceEstablished, preparationReady, writeAuthorized and activationEnabled
remain false. OS/FOMO candidate units, mmap access identity, external deploy/input
admission, unavailable user buses/at, unreviewed scheduled scripts and the actual
formal window remain explicit blockers. No stop, disable, signal to a production
unit, database write, cutover or Git operation occurred. During a formally approved
fenced window, ALL old SQLite writing through services, descendants, timers,
oneshots, migration/deploy, operators, cron or bridges must be denied before the
final fully fenced coherent snapshot. Current read-only observations cannot prove
that future admission boundary or authorize startup/cutover.


## Proposed additional fence inputs: observed semantics, not approval

The three new timer/service pairs were inspected read-only at 2026-10-04T06:59Z;
new maintenance helper and user-unit file dependencies were inspected at 07:03Z
and 07:06Z. These are separate bounded observations, NOT one fresh coherent fence
snapshot or a maintenance authorization. All authority/fence/write/activation
flags remain false. Code is frozen; this batch changes only observational JSON
and this runbook. The last executed owned regression result remains 193/193 with
strict collector/test TypeScript success, not a newly executed full-suite result.

The classified receipt is migration-writer-inputs-proposed-inventory-2026-10-04T07-14-56-573Z.json. It references the three
underlying receipts with original hashes, size/identity metadata, redacted command
semantics and package ownership. No production script was executed or changed.
Each actual script/helper was read at most once. The sysstat cron file alone was
recovered to resolve omitted bare executable/PATH metadata; its byte hash stayed
identical across observations. The observer's default PATH is NOT cron's PATH.
One bounded Node interpreter prefix was initially captured as an executable
artifact candidate; it is explicitly a partial binary fingerprint, not a complete
script or trusted release hash, and is not used to prove writer behavior.

| Additional pair | Observed identity | Observed effects | Proposed boundary |
| --- | --- | --- | --- |
| fomo-address-radar-input-sync | root; empty WorkingDirectory; sync-address-radar-input.sh, 2985 bytes, SHA-256 d255ace12c64043bda794f0ab9e4b7e73073e882ea7560d1beb5fed1ef646c6b | Bidirectional JSON/JSONL replacement/append, directory/file ownership/modes and three cursor writes | Fence timer and manual admission; drain service and preserve streams/cursors |
| fomo-address-radar-backup | fomo-radar; /opt/fomo-radar/address-current; backup-cli.ts, 1154 bytes, SHA-256 71599e31fac73d84caf09769e3883f0b29b08975cf1c38e647af316978de0c9f | SQLite opened without readOnly; VACUUM INTO backup destination; retention unlink of .sqlite files | Fence timer and manual admission; no prune during preservation; no SQLite CLI restart after PG first write |
| fomo-radar-protocol-audit | root; /opt/fomo-radar/current; declared refresh-radar-protocol-audit.sh absent, errno 2 | Script behavior unknown; failed service does not cancel active timer or future artifact restoration | Fence timer/manual admission; remain off until actual artifact and effects are pinned |

The two present scripts resolve inside
/opt/fomo-radar/releases/address-identity-wallet-analysis-c1d8578. The audit target
also resolves to that release, but does not exist. No alternative script or release
was guessed, created or executed. The new proposed census is twelve service units
(the prior nine plus these three) and five timers (the prior two plus these three),
plus operators/deploy/usercron/input admission and all process/FD/mmap holders.
This is a proposal only; external expected inventory and trusted collector
provenance still govern the signed protocol.

### Bridge paths and backup targets

Input-sync reads /var/lib/fomo-radar/data and mutates
/var/lib/fomo-address-radar/input and /var/lib/fomo-address-radar/output. It replaces
collector status/leaderboards, appends radar/result/history JSONL, and sends
output/fomo-token-lookups.jsonl back into the FOMO data directory. Cursor paths are
input/.lookup-result-sync.cursor, input/.lookup-history-sync.cursor and
output/.lookup-request-sync.cursor under the FOMO address-radar root. They are
part of the preserved boundary; do not reset offsets, truncate streams, silently
replay history or re-enable delivery/provider requests while changing backends.
There is no explicit /var/lib/address-radar/address-radar.db reference or SQLite
command in this fully read shell script. That is NOT evidence that its consumers
or externally configured inputs are unrelated to the primary source.

Backup creates files below /var/backups/fomo-address-radar and prunes old .sqlite
files with configurable retention (literal default 14 days). Its two DB arguments
are unresolved ADDRESS_RADAR_DATABASE_PATH and RADAR_CUSTOMER_DATABASE_PATH
references; environment values were deliberately not read or printed. Exact DB
binding must come from externally approved private configuration/provenance.
No explicit WAL checkpoint appears in the script; implicit WAL/close effects were
not executed or proven. Unapproved pruning is not lossless preservation and must
remain disabled without blocking an independently approved lossless snapshot.

### Eight system-cron entries: proposed classifications

| Entry | Observed semantics and evidence | Proposed disposition |
| --- | --- | --- |
| /etc/crontab:19, hourly | run-parts directory contains only non-executable .placeholder | Candidate current non-writer exclusion; future file admission not fenced |
| /etc/crontab:20, daily | six fully read package-owned scripts; man-db/apt/sysstat/dpkg/logrotate exit on observed /run/systemd/system; apport prunes only literal /var/crash, whose real path was observed | Candidate current non-radar cron route; corresponding systemd jobs NOT excluded |
| /etc/crontab:21, weekly | package-owned man-db exits on observed systemd directory | Candidate current non-writer exclusion |
| /etc/crontab:22, monthly | run-parts directory contains only non-executable .placeholder | Candidate current non-writer exclusion |
| /etc/cron.d/sysstat:6 | actual cron PATH resolves /usr/lib/sysstat/debian-sa1; line 9 exits before config on systemd | Candidate current non-writer exclusion |
| /etc/cron.d/sysstat:9 | same fully read helper; downstream sa1 defaults to /var/log/sysstat but has config-dependent output | Candidate current cron route exclusion ONLY; sysstat timers/config NOT excluded |
| /etc/cron.d/e2scrub_all:1 | fully read e2scrub_all_cron exits on observed systemd directory | Candidate current cron route exclusion ONLY |
| /etc/cron.d/e2scrub_all:2 | /sbin/e2scrub_all sources config, selects LVM filesystems and can create/fsck/reap snapshots or start e2scrub instances | Unknown storage/admission effects; do NOT exclude wholesale |

All eight retain original line and command hashes with command bytes redacted.
Candidate exclusions require separately reviewed exact paths, hashes and
conditions, never a generic system-maintenance exemption. No sourced config or
maintenance command was executed. In particular, cron skip guards do NOT imply
that corresponding active systemd timers are harmless or fenced. The e2scrub
configuration/storage targets and maintenance overlap remain an explicit
approval/evidence issue; do not assume no filesystem/checkpoint/resource effects.

### User-unit filesystem fallback and limits

Because live user-bus queries were unavailable, bounded listings covered
/etc/systemd/user, /usr/lib/systemd/user and per-user .config/.local/share plus
/run/user/<uid>/systemd/user roots for root/ubuntu/address-radar/postgres. All
twelve per-user roots returned actual ENOENT (2), not denied/not_available.
Global installed maintenance units and a launchpad cache-clean timer link exist.
Four package-owned user maintenance unit files were read once (at most 16KiB
each), retaining timer/condition/path properties without environment or argv
secrets. No custom application unit was observed in those bounded roots. This
does NOT establish live user manager absence, exhaust all unit search paths or
resolve every %h/config effect, and does not deny future unit installation.

Initial readers were capped at 22s, 40 files, 32KiB/file and 512KiB aggregate;
focused new dependency reads at 12s/8 files/16KiB each, with local SSH watchdogs.
The primary script inspection used 354ms, the dependency observation 243ms and
the final cron/user-unit file observation 206ms. Missing scripts, partial binary
hashes, unresolved target parameters and unavailable live buses are explicitly
not converted into complete observations or successful fence proof.

### Stop/restart proposal, NOT executed or authorized

Only in a separately signed bounded maintenance window: first inhibit all five
timers and manual/deploy/user admission, then drain all twelve services and
descendant writers. Collect a fresh complete signed inode/generation/FD/mmap and
bridge-input/cursor census, preserving relevant files before the final fully
fenced coherent snapshot. Do not infer drain from inactive/exited/failed alone.
The additional names to stop/drain are exactly the three pairs listed above;
no production stop/disable/reset-failed/restart action occurred in this batch.

Before the first PG write, source-only recovery requires parity, preserved guards
and scoped authorization. After the first PG write, retain the same PG data and
use only the exact independently proven PG-compatible release/schema/generation;
no plain SQLite symlink rollback, legacy SQLite writer restart or cursor reset.
Keep these new jobs off until target-specific replacement/compatibility and
provider/delivery/history guards are proven and separately authorized. A missing
audit script must not be silently recreated or blindly restarted.

Remaining external issues: approved inventory/window/target/cohort/generation
and future admission denial; exact private backup DB binding; actual audit
artifact if restored; unapproved storage/config maintenance effects; live user
manager/operator/deploy identity; current coherent full fence and all existing
trusted snapshot/schema/release/rollback proofs. No new scoring or business
behavior was introduced, and no production readiness or cutover completion is
claimed.

## Final backup configuration binding observation (2026-10-04T07:20:45Z)

This section supersedes only the two unresolved backup DB configuration references in the preceding proposed inventory. It does not approve that inventory, a maintenance window, a fence, or a cutover. Frozen classification addendum: `docs/operations/migration-writer-inventory-final-addendum-2026-10-04T07-25-36-401Z.json`. Raw sanitized observational receipt: `docs/operations/migration-writer-backup-bindings-2026-10-04T07-20-45-498Z.json`. The prior 12-service / 5-timer proposal and eight cron classifications remain unchanged and incomplete as an externally expected census.

The actual backup service declares `EnvironmentFile=/etc/fomo-radar/address-radar.env` with ignore-errors disabled. The file was read once, bounded to 64 KiB, and only the two requested literal DB paths were emitted. Observed config: root:root, mode 0600, 3003 bytes, device 64769, inode 287880; full-file SHA-256 `580bde3f660c15e9a350a07f19e2c2e0d4d24a8b7a2155039da6b9367137f659`. No other environment values or config plaintext were retained.

| Config key | Validated and resolved absolute path | Device | Inode | Owner |
| --- | --- | --- | --- | --- |
| ADDRESS_RADAR_DATABASE_PATH | /var/lib/fomo-address-radar/address.sqlite | 64769 | 1109226 | fomo-radar:fomo-radar |
| RADAR_CUSTOMER_DATABASE_PATH | /var/lib/fomo-address-radar/customer.sqlite | 64769 | 1106432 | fomo-radar:fomo-radar |

Both files are regular files, mode 0644. The current main radar source `/var/lib/address-radar/address-radar.db` resolves to the same path with device 64769 / inode 1137388: neither backup argument aliases that file at this observation. Neither argument is within the observed input/output directories. These are configured FOMO application DB paths, not a claim about their business contents or downstream dependency independence.

The previously fully read backup script opens both configured files with `DatabaseSync` without a read-only option and issues `VACUUM INTO` to create copies under `/var/backups/fomo-address-radar`; its retention loop unlinks old `.sqlite` copies in that directory. It has no explicit checkpoint statement. No script was executed and implicit SQLite/WAL effects were not proven. Keep both timer and manual service admission within the proposed fence. The default retention period is not purge authorization; unapproved pruning must remain disabled independently of lossless preservation. Do not automatically restart this legacy SQLite backup after the first PostgreSQL write.

The missing protocol-audit script remains an explicit blocker for excluding or safely restarting its scope. Formal go/no-go still needs externally trusted scope/authorization, an approved bounded window and exact target/generation/schema/release/cohort, full current admission/holder evidence, a final fully fenced coherent snapshot, and proven before/after-first-write rollback guards. In particular, post-write rollback must retain PostgreSQL data using a separately proven exact compatible PostgreSQL release, not the current SQLite release or a SQLite symlink. External future deployment/admission is not fenced by a read-only observation.

### Exact nonmutating observation invocation

The local transient observer streams its fixed bounded Python program to standard input; the remote host receives no script file and no service/config change:

```sh
node --import tsx /private/tmp/volta-backup-db-binding-readonly.mts
# Remote transport used by that observer:
ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=5 -o ServerAliveCountMax=1 \
  -o StrictHostKeyChecking=yes -o UpdateHostKeys=no \
  -o ControlMaster=no -o ControlPath=none \
  ubuntu@152.32.185.240 'sudo -n python3 -u -'
# Exact unit query inside the observer:
systemctl show --no-pager --property=Id --property=User \
  --property=WorkingDirectory --property=EnvironmentFiles --property=FragmentPath \
  fomo-address-radar-backup.service
```

Bounds: 10-second remote observation deadline, 2-second unit-query timeout, at most four declared config files, 64 KiB/file and 128 KiB total config bytes, 16 KiB unit output; 18-second local transport deadline and 64 KiB sanitized stdout. Actual remote observation took 17 ms. The general operator diagnostic remains `collectWriterCensus(policy, { execute, clock })`; CLI `--census --census-scopes /absolute/reviewed.json --census-scopes-sha256 REVIEWED_PIN` is fail-closed diagnostic output, not an authorization or a future fence. Reviewed/pinned scopes must come from outside the observation; do not self-mint them from discoveries.

Code and tests remain frozen. No tests were rerun for this observation-only addendum; the earlier owned baseline was 193 passing protocol tests and a successful strict collector/test typecheck. No production stop, restart, signal, script execution, DB-content read, permission change, or config mutation occurred.

## Preparation closure evidence API (2026-10-04, synthetic protocol tests only)

The coordinator now exports `verifyWriterFenceSnapshotRollbackClosure(input, trust, now)` from `migration-writer-fence-closure.ts`. This additional pure verifier does not call SSH, open a database, stop services, establish a fence, or grant a write/activation capability. Its successful result always retains `writeAuthorized: false` and `activationEnabled: false`.

`trust` must come from an independently pinned operator trust policy, not from the submitted evidence envelope. It contains fixed Ed25519 public keys for authorization, observation, snapshot and independently verified compatibility evidence; exact source device/inode/path, generation, watermark, cluster, schema, release/artifact, cohort and provider/delivery guard bindings; the expected complete scope SHA-256; complete expected table names; and the exact retained compatible rollback release/artifact. The compatibility key cannot be the authorization or observer key. The API neither generates an approval nor treats an evidence boolean as proof. Signatures authenticate the supplied evidence and issuer, not business scoring or the truth of an unexecuted experiment.

Scope entries must explicitly enumerate service, timer, bridge, cron, operator, deploy and external-input families, literal paths and both bridge directions. The already observed minimum of 12 service scopes / 5 timer scopes is a lower bound, not the complete externally expected census. Unknown/opaque scope kinds, unknown discovered IDs and missing observed IDs fail. Approval must include the actual known names in the preceding observational inventory, not substitute arbitrary scopes that merely satisfy these counts.

The signed census must preserve parent/child lineage and enumerate every referenced descendant. Missing descendants, unscoped processes, denied/unavailable/unknown/truncated FD or mmap scans, writable DB/WAL/SHM handles, source mappings, active/pending timers, incomplete bridge directions, missing cursor preservation receipts and admission controls that expire before the approved window ends fail closed. An empty parent handle list cannot hide a writable child. The verifier validates an externally attested normalized census; it does not turn the existing raw observation into a signed effective admission barrier or independently discover omitted writers.

The snapshot must be final/full/fenced, not a guessed timestamp delta. Every expected table has an explicit name, row count and digest; missing/unknown tables, numeric coercion and mismatched table-set digests fail. Exact schema/table names must be taken from the approved real schema, not guessed from fixture counts. The historical signed `fencedAt` precedes snapshot start. Snapshot start/completion and rollback completion are ordered inside the explicitly approved bounded window; the final census observation remains current (at most five minutes old, never future). A 25-minute export/restore is covered by a regression test without faking time or extending the window. No real maintenance window has been approved by these fixtures.

Before the first committed PostgreSQL write, a source-only route still requires exact bindings and parity evidence. After that write, source/SQLite rollback is rejected: only the exact separately pinned compatible PostgreSQL release/artifact with an independent compatibility test receipt and unchanged provider/delivery guards is accepted. The current SQLite release cannot be substituted. Neither route grants permission to restart a SQLite writer or alter a symlink.

### Integration and externally executable prerequisites

This additive verifier is exported, but has not been made a mandatory call inside existing transition or root composition code in this batch. Parent owns that composition integration. A successful verification summary is not a durable transition token and must not be accepted as one. In particular, `input.phase` must be derived from the existing committed-state reader/native marker under the owning UOW; it is not an authority-bearing config/manifest flag. Service startup continues to require durable `postgres-written`; read-only console selection is separate. The closure summary does not bypass existing approvals, locks, owner checks, transaction budgets or commit-unknown recovery.

1. Obtain a complete externally reviewed and pinned scope document including all known service/timer pairs, both bridge directions and cursor paths, actual user/system scheduling, operators, deployment and external-input admission controls. Record verifiable control receipts; unavailable/unknown observations remain blockers.
2. Retain an actual PostgreSQL-compatible rollback release and artifact, pin their exact hashes and target/schema/generation/guard compatibility, and obtain independent executed compatibility-test evidence. Do not substitute a fixture key, a claimed boolean, or the current SQLite release.
3. Obtain an explicitly signed bounded maintenance window, exact real target/bindings and approved SQL/time budgets. Existing approval of 1000 SQL statements is not raised by the hard upper limit of 10000; the transaction limit remains 60 seconds.
4. In that separately authorized window only, the operator closes all admissions/timers, drains service descendants/holders, preserves bridge streams/cursors, and obtains verifiable effective fence evidence. These steps are instructions, not actions performed by this patch.
5. Produce the final fully fenced full snapshot, exact full-table parity and restore evidence, rollback rehearsal evidence and fresh final census; invoke the verifier with the pinned trust policy before any existing durable transition is allowed to advance. Recheck under existing UOW/advisory-lock/marker guards; no standalone boolean may authorize cutover or startup.

Executed local validation for this preparation batch:

```sh
node node_modules/typescript/bin/tsc --noEmit -p packages/database/tsconfig.test.json
node node_modules/vitest/vitest.mjs run packages/database/test/migration-writer-fence-closure.test.ts packages/database/test/migration-cutover-coordinator.test.ts
```

The complete database test typecheck passed. The two suites passed 241 tests (193 existing coordinator + 48 closure tests). Keys, scopes, receipts, timestamps, table records and compatibility artifacts in the added suite are injected synthetic protocol fixtures, not production evidence. This batch made no production scans, service operations, PostgreSQL startup, approval signing or production configuration changes. The parent-owned consolidated blocker-resolution report is untouched.
