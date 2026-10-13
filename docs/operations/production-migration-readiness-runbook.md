# Production migration readiness: saved-manifest evaluation

This implements the readiness/writer/rollback safety slice of
`docs/specs/2026-10-04-complete-database-migration-readiness-spac.md`.
It does not perform import, fencing, deployment, delivery, or rollback.
A passing report is validation of independently checked saved evidence. Every
result explicitly contains `validationOnly: true` and `productionAuthorized: false`.
It never grants execution authority for a production operation. SQLite remains authoritative until separately
approved production work has actually completed.

## Interface and acceptance boundaries

Import directly from `packages/database/src/production-migration-readiness.ts`.
No package index or runtime entrypoint is modified.

```typescript
import {
  evaluateProductionMigrationReadiness,
  productionMigrationManifestDigest,
  productionMigrationApprovalPayload,
  productionMigrationArtifactClaimsDigest,
  PRODUCTION_MIGRATION_REQUIREMENTS,
  type ProductionMigrationReadinessManifest,
  type ReadinessEvaluationOptions,
} from "../../packages/database/src/production-migration-readiness.js";

const result = evaluateProductionMigrationReadiness(savedManifest, {
  now: evaluationTime,
  maxEvidenceAgeMs: approvedEvidenceAgeLimit,
  trustedReviewers: [{ keyId, reviewer, publicKeyBase64 }],
  externalTrust: {
    expected: independentlyPinnedMigrationContext,
    trustedArtifactVerifierIds: reviewedVerifierIds,
    verifyArtifact: independentlyVerifyArtifact,
  },
} satisfies ReadinessEvaluationOptions);
```

The evaluator accepts `unknown` and returns `ProductionMigrationReadinessResult`:
`version`, `validationOnly`, `productionAuthorized`, aggregate `ready`, `gates.preservation`, `gates.operationalCutover`,
`gates.businessActivation`, independent `purge`, and per-requirement `checks`.
Each gate has `ready` and fixed-code `blockers` with a gate ID. The result contains
no input paths, connection strings, table names, event IDs, or raw evidence.

- Preservation requires coherent lossless history, immutable verified snapshots,
  all-table receipts, references/quarantine, protected ledgers and restore/fault
  tests. Missing old market proof never blocks this gate.
- Operational cutover also requires preservation, dedicated roles, measured
  capacity, real entrypoints, complete fencing, final reconciliation, handoff,
  rollback before and after new writes, console traces, and isolated PG evidence.
- Business activation also requires operational cutover and the explicitly
  selected cohort, real market proof, truthful interval coverage, committed
  consumers, confirmed-policy evidence, and natural two-trader acceptance.
- Purge requires a separate signed purge approval, a purge request, passing
  operational write safety, and an exact externally pinned deletion scope with
  independently checked protection/dry-run evidence. Its failure does not block non-destructive
  preservation, cutover, or scoped activation. It is never permission to delete
  protected proof. No deletion implementation is included here.

All four safety flags must explicitly be false: `deliveryEnabled`,
`fomoCaptureEnabled`, `historicalMiningEnabled`, and `automaticOwnerMergeEnabled`.
Business activation in this report still means delivery-disabled acceptance.
No eligibility thresholds or core scoring implementation are changed.

The typed interface describes a complete approval package. At the runtime
`unknown` input boundary, a preservation-only package may omit operational
budgets, final cutover/rollback scope and activation cohort. Those omissions
block their respective gates, not preservation; snapshot identity/watermark,
preservation receipts and a preservation approval remain mandatory.

## Manifest and trusted approvals

The exported interface is the exact version-1 manifest contract. Inputs must be
plain JSON objects with finite JSON values. Getters, `toJSON`, custom prototypes,
functions, symbols, undefined values, cycles, sparse/extended arrays, non-finite
numbers and negative zero are rejected before digest or evaluation. Both use
the same inert plain JSON copy. Mode and rollback strategy must be exact strings;
arrays and boxed/coercible values never select a valid branch. There are no
resource or evidence-age defaults. IDs are nonempty strings. SHA-256 values are
64 lowercase hex characters. Timestamps are valid UTC ISO timestamps with seconds
or exactly three fractional digits. Row counts and byte quantities are canonical
nonnegative decimal strings; budgets require positive quantities. Integer row
accounting uses `bigint`, including values beyond JavaScript's safe integer range.

The identity tuple is exact: `snapshotId`, `snapshotSha256`, `sourceId`,
`sourceSchemaSha256`, `targetId`, `targetSchemaSha256`, `generation`, and
`releaseSha256`. Every receipt carries the same tuple. The signed
`scope.snapshotWatermark` binds the delta start to the reviewed snapshot.
Schema/snapshot/catalog changes require regenerated evidence and approval,
not a blanket waiver.
`createdAt`, `expiresAt`, evidence/test timestamps, fence lifetime, maintenance
window and rehearsal timestamps are validated against the caller's time and
explicit maximum age. Future observations, missing values, unknown statuses,
skipped tests, stale evidence and expired approvals fail closed.

Each requirement in `PRODUCTION_MIGRATION_REQUIREMENTS` requires an evidence
receipt with `status: "passed"`, owner, artifact SHA-256, exact identity,
observation time, and an executed, non-skipped passing test with a name and time.
The artifact must be an immutable report containing the actual assertions,
commands, counts, failures and exact test input scope. A status label alone is
not a verified receipt.

`ReadinessEvaluationOptions.externalTrust` is mandatory for passing readiness.
Its `expected` context is maintained independently of the candidate manifest:
fresh observation time, the complete exact identity tuple, all reviewed source
table names, and the full writer inventory by category. All table names must
match the trusted catalog, not merely a self-declared count of 141. All writer
members must match the trusted inventory exactly, including manual/deployment/
cron/external bridges. The built-in service/timer list remains a minimum safety
constraint. Empty categories require independently checked evidence of absence;
manifest booleans cannot establish that absence. Missing writer expectations
block operational cutover; missing identity/catalog/verifier trust blocks all gates.

The separately configured `verifyArtifact` callback receives the check name,
artifact digest, acceptance-specific claims digest and pinned identity. It must
independently verify real assertions/test execution against the pinned context,
including permissions, resources, table retrieval, writer rejection, journal
recovery and business policy. It must never echo manifest booleans. Return null
on unknown, missing, unsupported or failed checks. A successful result supplies
actual immutable `bytes`, a trusted `verifierId`, a fresh `verifiedAt`, and
`assertionsPassed: true`; exceptions and asynchronous/unusable results fail closed.

The evaluator hashes those bytes itself and parses their JSON envelope. The
envelope must contain `check`, `claimsSha256`, `identity`, `observedAt` and `test`,
matching the current requirement, pinned identity and manifest receipt exactly.
Use `productionMigrationArtifactClaimsDigest(manifest, check)` when producing
that envelope. Independently checked assertion reports may add their details.
Claims bind the structured values for the applicable acceptance gate; preservation
claims exclude activation/cutover fields so legacy market gaps stay independent.
Artifact-reference digest fields are excluded from their own claims to prevent
circular hashing; approval signatures and explicit receipt comparisons bind them.
Replacing bytes, test metadata, identity or claimed resource/behavior values
invalidates verification even after the manifest is re-signed.

The embedding owns the independent verifier and trusted expected context. These
are privileged dependencies, not serializable assertions accepted from the
manifest. Unit tests use synthetic independent verifier fixtures and do not
certify production behavior. A deliberately dishonest trusted verifier remains
outside this checker trust boundary; cryptography cannot establish real-world
truth without a trustworthy measurement/verification source.

Trusted Ed25519 public keys come from the caller's reviewed trust configuration,
not from the manifest. `publicKeyBase64` is base64-encoded DER SPKI. For each
acceptance scope, include exactly one `MigrationApproval` with an authorized
reviewer/key ID, `decision: "approved"`, manifest digest, issuance/expiry and
signature. A reviewer may sign multiple distinct scopes only if authorized to do
so outside this tool. Purge is an additional distinct scope.

1. Assemble the manifest and all immutable evidence. Leave `approvals` empty.
2. Compute `productionMigrationManifestDigest(manifest)`. It hashes strict plain
   canonical sorted-key JSON, excluding the entire approvals field.
   Array order remains significant. Extra manifest fields are also digest-bound.
3. Build the approval metadata with the digest, exact scope, reviewer/key ID and
   current issuance/expiry. Sign the UTF-8 string returned by
   `productionMigrationApprovalPayload(approval)` using Ed25519. Encode the
   64-byte signature as canonical base64 in `signatureBase64`.
4. Attach the approvals and evaluate. Any content edit requires new approvals.
   Duplicate/conflicting approvals for a scope fail closed.

Do not put private keys or database credentials in the manifest. The evaluator
verifies approval integrity separately from evidence. Ed25519 proves authorization
of a particular package, never that its assertions are true. A valid signature
cannot replace independently pinned context and verified artifact bytes. This
checker does not fetch artifacts or contact production; the embedding supplies
an independent verifier with verified immutable bytes. Reviewers and verifiers
must assess real execution receipts before the package can pass validation.

## G01-G23 evidence contract

The following check names are required verbatim. Each check maps to a distinct
receipt in `evidence`; the exported constant is the machine-readable inventory.

| Gate | Acceptance | Required checks and review scope |
| --- | --- | --- |
| G01 | Preservation | `exact-ddl`: all DDL, compound FKs, collations, predicates, defaults, triggers/views, schema version and approved deltas |
| G02 | Preservation | `immutable-snapshot`, `safe-online-backup`, `readonly-restore`: checksum, restore, WAL-inclusive coherent backup and side-effect-free readers |
| G03 | Preservation | `lossless-all-tables`: all 141 reviewed source tables, lossless types, exact counts and retrieval |
| G04 | Preservation | `reference-crosswalk`, `protected-ledgers`: FK/JSON lineage, quarantine of unresolved references, compatible protected ledgers |
| G05 | Cutover | `production-roles`: dedicated business target and migration/runtime/read privileges and secret delivery |
| G06 | Cutover | `measured-capacity`: global connections, measured RAM/disk/WAL/temp pressure, approved window and thresholds |
| G07 | Preservation | `typed-schema`: versioned schema, indexes, sequences and exact adapters; retain original uncertain values |
| G08 | Preservation | `atomic-import-resume`: chunk/row-map receipts, digests, atomic commits, retry and collision quarantine |
| G09 | Both | Preservation: `preserve-identities`; activation: `active-cohort`, enabled/suspended flags, conflicts/manual grants, no inherited capability |
| G10 | Both | Preservation: `preserve-market-history`; activation: `active-market-proof`, chain/contract/pool and temporal real-price provenance |
| G11 | Cutover | `production-entrypoints`: all six real PG entrypoints with backend/generation checks and no silent SQLite fallback |
| G12 | Both | Cutover: `atomic-consumers`, `generation-leases`, `fair-work`; activation: `committed-consumers`, no false missing-data receipt |
| G13 | Activation | `external-coverage`: BSC 404 scope, real interval boundaries, routing, stable events, budgets, reorgs/late revisions and truthful degradation |
| G14 | Cutover | `final-boundary`: complete delta or final fenced coherent snapshot, all mutation categories and no unjournaled gap |
| G15 | Cutover | `complete-writer-fence`: all services/timers/operators/deploy/usercron/external inputs, future admission and stale-write rejection |
| G16 | Cutover | `queue-cursor-handoff`: frozen old work, selected new work, fresh leases and accepted input scope without wholesale replay |
| G17 | All | Preservation: `preserved-consumption-guards`; cutover: `delivery-idempotency`; activation: `readiness-risk`, frozen decisions and authorization revalidation |
| G18 | Cutover | `rollback-before-writes`, `rollback-after-writes`: durable mutation/input journal, parity, recovered new writes and commit-unknown reconciliation |
| G19 | Both | Preservation: `preservation-retention`; cutover: `excluded-purge-jobs`, protected 30-day proof versus 15-day raw hot storage |
| G20 | Cutover | `pg-console-trace`: bounded PG trace/metrics and truthful history/generation/gap/progress distinctions |
| G21 | All | Preservation: `all-table-fault-tests`; cutover: `full-suite-and-types`, `real-isolated-pg-tests`; activation: `business-tests`; skipped PG tests never pass |
| G22 | Activation | `real-wallet-e2e`, `natural-two-trader`: real selected events through confirmed rules without fabricated signals |
| G23 | All | `manifest-preservation-approval`, `manifest-cutover-approval`, `manifest-activation-approval` plus independently verified signatures and exact approval package |

## Accounting, fence and rollback details

`tables.reviewedSourceTables` must contain all 141 unique catalog names.
`tables.entries` must match it exactly. Each entry names a queryable destination,
source count, preserved count, losslessly quarantined count, and a canonical
retained digest equal to the source digest. `preservedRows + quarantinedRows`
must equal `sourceRows`. The retained digest covers the union of ordinary and
quarantined rows in the same lossless deterministic representation; it is not
necessarily a digest of the typed target encoding. Every entry requires a
retrieval test. A newly discovered table blocks acceptance until the reviewed
catalog and approved plan are updated; do not omit it to keep the count at 141.

Roles match provisioning's seven dedicated business identities: one migration
role with `service: null` and `access: "migration"`, plus one role for each short
service ID in `PRODUCTION_MIGRATION_SERVICE_IDS`. Console alone has `access: "read"`;
the other five have `access: "runtime"`. All seven names are distinct, valid,
non-acceptance least-privilege role names with verified privilege evidence. The
old three shared-role representation is rejected.

Each pool uses a short service ID and its dedicated role limit must equal
`instances * maxPerInstance`, including console and all replicas. Spare capacity
from another service cannot satisfy that role's allocation. The migration role
limit must equal `migrationConnections`. Operator and backup reserves are separate
global slots, never charged to the console role. `databaseConnectionLimit` must
equal the six service allocations plus migration/operator/backup. That database
budget plus `postgresReservedConnections` and explicitly measured
`otherHostConnections` must fit `postgresMaxConnections`. Only other-host occupancy
may explicitly be zero; absent values have no defaults. A provisioning plan's
`roles` can be mapped directly by adding independently verified `superuser` and
`leastPrivilegeProved` evidence, and its pool `maximumConnections` maps to
`maxPerInstance`. Offline planning alone does not prove these privileges or capacity.
The new role/capacity contract changes artifact claims and requires fresh verified
artifacts and manifest approvals. RAM acceptance includes
peak plus reserve. Disk acceptance includes measured data/index peak, WAL, temp
and reserve without double-counting these in the data/index peak. These are
operator measurements, not recommended resource defaults.

The fence inventory has exactly one complete, fenced group for each category:
`services`, `timers`, `operators`, `deploy`, `usercron`, `externalInputs`.
The services group must include the six exported expected names and must exactly
match the independently pinned inventory; the timer group
must include FOMO verification sync and backup timers. The services group also
includes the separately exported `EXPECTED_PRODUCTION_INPUT_SERVICES`
for both timers' service units, preventing manual service invocation from escaping
the timer fence. Inventory all extra
services, timer-triggered jobs, manual tools, deployment agents, user crontabs and
external collectors/file bridges as well. Empty operator/cron/external groups
are permitted only when independently pinned expectations and verified artifacts
prove the inventory is complete and
future admission is blocked. Capture pause is not proof of file-bridge fencing.

`mechanism` must be `generation-rejection-and-input-barrier`; generation/source,
active fence lifetime, tested stale-write rejection and blocked new writer
admission are mandatory. A PID/handle census alone is rejected. Fencing evidence
must include attempts by stale workers and future scheduled/operator writers,
not merely the absence of open handles at one instant.

The final boundary covers exactly all reviewed tables and the approved watermark,
with coherent snapshot identity and completion after fence enforcement. Delta
mode also requires its explicit starting/ending watermarks, continuous journal
and complete facts/identity/config/grants/budgets/cursors/work capture. If this
cannot be proved, use the final full snapshot behind the complete fence.

Rollback requires a retained, durable, continuous input/mutation journal that
starts before the before-write rehearsal. The before-write test precedes the
first rehearsal write; the after-write test follows it. Both prove parity and
commit-unknown reconciliation; the after-write test proves recovery of new writes.
Rehearsal artifact hashes must match their G18 receipts. Reverse-delta replay or
an explicitly hashed compatible PG release is required. An old SQLite symlink
alone cannot satisfy this contract. These timestamps describe an isolated
rehearsal, not permission to generate production test writes.

Purge additionally requires `purgeScope` matching the external context's
`purgeScope` exactly: operation ID, target, generation, snapshot checksum,
protected-exclusion digest, dry-run artifact digest and a nonempty list of exact
selectors. Each selector identifies a reviewed table, explicit partition ID,
exclusive UTC cutoff at least 15 days old, exact decimal expected row count and
selection digest. Wildcards, missing selectors, changed counts/targets/cutoffs,
duplicate selectors and unknown tables fail closed. The `purge-dry-run` evidence
receipt must independently prove these selections exclude protected 30-day proof,
unresolved raw, normalized facts, lineage and consumption/deduplication guards.
Its artifact hash must match the scope, and the scope must be separately approved.
Missing capacity/fence/final boundary/rollback/window blocks purge even if
preservation passes. Purge remains an independent validation result, never a
deletion authorization or implemented delete path.

## Read-only CLI and tests

Run from the repository root with the bundled Node executable. Pass the reviewed
age limit and independently obtained public key; placeholders below are not
production values.

```bash
/Users/a77/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --import tsx scripts/check-production-migration-readiness.ts \
  --manifest /path/to/reviewed-manifest.json \
  --trusted-reviewer REVIEWER \
  --trusted-key-id KEY_ID \
  --trusted-public-key-base64 DER_SPKI_BASE64 \
  --max-age-ms APPROVED_AGE_LIMIT_MS

/Users/a77/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/vitest/vitest.mjs run \
  packages/database/test/production-migration-readiness.test.ts
```

The CLI reads only the saved manifest, uses the current clock and outputs one
sanitized validation-only JSON result. It has no independent artifact verifier
or pinned production context, and never obtains either from the manifest or
from caller-supplied approval keys. Therefore standalone CLI validation cannot
report readiness: parsed input yields exit 1 with explicit trust/evidence blockers.
Exit 2 means invalid arguments, unreadable input or invalid JSON. Fully composed
library validation requires the independently configured external trust boundary.
Purge status never changes the three-gate exit decision. It never opens a
production database, uses SSH, sends signals, starts jobs or writes production.

Targeted tests exercise signed fixture readiness, every absent requirement,
forged/stale/mismatched approval or evidence, all-table accounting, exact large
counts, missing writer groups, census-only fences, capacity, final delta/snapshot,
rollback phases, disabled safety flags, legacy market gaps and independent purge.
Reviewer regressions cover coherent but unexpected target/catalog/writer claims,
missing or false independent verification, artifact substitution, exact string
discriminants, nonplain JSON/toJSON/getter attacks, and operationally unsafe or
inexact purge scopes. Successful validation always retains the explicit
`productionAuthorized: false` marker.
They are checker unit tests, not evidence that production G01-G23 now pass.
