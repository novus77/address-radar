# PostgreSQL-compatible rollback release contract

## Status and boundary

This is a packaging and evidence contract, not production authorization. It does
not approve a source, target, signer, deployment, rollback, or first write. No
remote access, PostgreSQL access, production changes, or artifact generation was
performed to write this document.

A local PostgreSQL-compatible rollback candidate can be assembled from an
identified release and its dependency closure. The known entrypoints can inspect
or execute such a release under their existing gates. There is no demonstrated
end-to-end entrypoint that turns a locally assembled candidate into an
independently approved production rollback artifact. In particular, a configured
generation, release hash, signed manifest, or successful synthetic rehearsal is
not that authorization.

## Existing entrypoints and their limits

| Entry point | Applicable responsibility | Not a substitute for |
| --- | --- | --- |
| `scripts/postgres-service-entry.ts`: `runPostgresServiceEntrypoint` | Real service startup, committed startup verification, bounded execution and shutdown | An artifact builder or independent production approval |
| `packages/database/src/postgres-service-dispatch.ts`: `dispatchPostgresBusinessService` | Protected release verification and child supervision | Compatibility testing against retained PostgreSQL facts |
| `verifyCommittedPostgresCutover` | Verify committed cutover state; selected PostgreSQL may support read-only console startup | Writer permission in the selected phase |
| `verifyCommittedPostgresWriterStartup` | Verify writer startup against committed identity, written phase, durable first-write marker and independently trusted PostgreSQL-compatible rollback proof | Minting that proof from configuration |
| `createMigrationRuntimeCutoverTransitionStore` | Use an existing top-level `runtime.run` for the committed transition store | A new pool, nested UOW, or authority generator |
| `createProductionMigrationArtifactVerifier` | Measure supported protected artifact bytes and independently scoped evidence | Online source integrity, fencing, or production authorization |
| `measureProductionMigrationLiveCatalog` | Read supported physical identity, generation/ledger and table-name observations through an existing read-only runtime | A complete catalog digest or cohort proof; unsupported measurements remain unknown |
| `scripts/check-production-migration-readiness.ts` | Validate saved manifest and evidence inputs, with safe machine output and failure when not ready | Production writes, signals, deployment approval, or signing missing facts |

The dispatcher now uses verified Node with `--import` pointing directly to the
sealed absolute `tsx/dist/loader.mjs`, rather than a tsx CLI intermediary. This
change was reported by the parent; it was not independently rerun for this
document. The protected inventory must include `loader.mjs` and its actual
transitive dependency closure. Old CLI-only packaging is not sufficient evidence
for this launch path.

## Meaning of compatible rollback

After the first PostgreSQL write, rollback means switching to an independently
verified release that continues against the same retained PostgreSQL data. It
must preserve facts, attestations, work/wake state, native journal and subsequent
writes, or provide independently demonstrated lossless reconciliation for an
explicit boundary. It must not silently restore an earlier database image.

Restarting legacy SQLite writers, restoring a source-only snapshot, resetting
source cursors, or changing a configuration backend is not a compatible rollback
after the durable first-write marker exists. A fenced source snapshot establishes
a preservation boundary; it does not establish preservation of later PostgreSQL
writes.

Writers require committed `postgres-written` state and its durable non-null
first-write marker. A read-only console may use verified `postgres-selected`
state. Neither a selected phase nor `writeAuthorized: false` grants permission to
write. Generation/cohort bootstrap must precede workers through the approved
atomic first-write path, not an unjournaled worker initialization.

## Required immutable evidence

Use the existing verifier payloads and signing domains; this document introduces
no new proof format. The following items are mandatory semantic bindings, not a
proposed replacement TypeScript interface.

1. **Operation and freshness.** Exact operation identity, observed/effective
   times, validity interval and maximum allowed evidence age. Independently
   measured observations must belong to one coherent boundary. Old observations
   must not be combined into a fresh fence or refreshed by copying timestamps.
2. **Source identity.** Exact canonical source/snapshot identity, protected
   artifact digest and byte size, source schema and generation/watermark scope.
   Bind live source identity observations separately from copied file contents.
3. **Target identity.** Exact physical endpoint, database, cluster/system identity
   and schema. A display hostname, private config pin, or successful connection
   alone does not prove the intended target.
4. **Generation and cohort.** Exact activated generation, activation boundary,
   cohort and approved source derivation. Preserve Solana case-sensitive
   identities and other chain-specific identity semantics. Do not derive cohort
   authority from generation configuration.
5. **Release and executable closure.** Digests and sizes for the candidate,
   currently deployed release, verified Node executable, loader, dependency
   closure and relevant build/configuration inputs. Pin the complete inventory
   and launch contract, not just the entry file. Production execution requires
   the actual protected root-owned tree/executable/ancestors and nonroot actor;
   mutable user-owned files or a hash check alone cannot satisfy this gate.
6. **Actual schema compatibility.** Independently measured live catalog/schema
   identity and approved release/schema compatibility, including installed
   migration ledger identity. A table-name digest is not a full catalog digest.
   No missing catalog measurement may be replaced with a manifest boolean.
7. **Complete accounting.** Every source table and its disposition, exact counts,
   lossless content/derivation evidence, target reconciliation and named
   exclusions. Prove preservation and later native-write retention independently
   of legacy market-proof gaps or retention/purge approvals.
8. **Writer and input boundary.** Independently reviewed expected inventory of
   all six services, sync/backup timers, operators, deployment admission,
   user/system cron, external inputs and all source holders. Include proved
   fencing and final delta or full fenced snapshot scope. A PID/FD census or a
   proposed inventory is observation, not fencing or completeness.
9. **Committed journal and first write.** Actual committed transition/signature
   chain, durable first-write marker and matching operation/target/schema/
   generation/cohort/release bindings. Preserve journal evidence both before
   and after new writes, including an explicit retained-write boundary and
   reconciliation after uncertain commit acknowledgements.
10. **Permissions and capacity.** Actual actor/ACL evidence, six dedicated
    service roles plus the migration role, per-role/per-service pool allocations
    and the global connection budget. Independently provisioned publisher actors
    and any other clients must also fit that budget. Do not allocate a hidden
    extra pool, invent resource defaults, or widen authority-table privileges
    just to make a rehearsal pass.
11. **Compatibility rehearsal.** Identified immutable candidate, test inputs,
    exact schema/role/target identity and actual results for startup, reads,
    allowed native writes, commit-before-ack, uncertain-commit recovery, journal
    preservation, rejection boundaries and bounded shutdown. Distinguish a
    function-entrypoint rehearsal from the actual dispatcher/loader/IPC launch
    path, and sequential operation from simultaneous capacity. Synthetic keys
    and empty inputs prove only their recorded fixture scope.
12. **Independent trust and review.** Out-of-band pinned approval, external review
    and collector keys with the exact existing scopes. Bind measured artifact
    content and independently derived claims to the reviewed policy and exact
    identities above. Ed25519 authenticates authorization statements, not the
    underlying facts. Reject self-reported `success`, unmeasured watermarks,
    absent claims and signer-only readiness.

Artifact loading must retain the existing bounded size/time/depth limits,
regular-file/no-follow requirements, protected ancestor ownership/permissions,
hard-link rejection and pre/post file-identity checks. Hash the actual bytes.
Canonical JSON evaluation must reject nonplain objects, getters, `toJSON`
surprises, duplicate keys, lossy numbers and serialization/evaluation mismatch.
An unimplemented derivation or live measurement remains unknown.

## Snapshot versus backup rehearsal

`snapshot-bytes-v1` verifies supported protected byte identity. It does not prove
SQLite integrity, an online backup, writer fencing, or complete table derivation.
`lossless-table-records-v1` can measure supported typed-record counts and digest
parity; absent independent source-to-export replay remains unknown.
`backup-roundtrip-v1` can measure supported byte parity and its recorded completed
boundary. It does not by itself prove a live database backup/restore rehearsal.

A backup/restore rehearsal needs its own exact method, input/output identities,
completion boundary, actual restore/open/integrity/reconciliation results and
independent measurements. A copied fenced snapshot must not be labeled a
completed backup rehearsal. Conversely, a completed backup rehearsal without
proved fencing does not authorize cutover.

Archive purge is separate: it requires operational write safety plus independently
approved exact scope/selectors. Its approval is not required for non-destructive
import, and it is not implied by preservation or a signed manifest.

## Concrete bounded batch plan

1. **Local candidate packaging.** Select an explicitly identified PostgreSQL-
   compatible release. Assemble its executable/loader/dependency closure and
   digest/size inventory locally without signing approvals or touching
   production. Record unsupported platform dependencies and build inputs as
   blockers. This produces a candidate, not an authorized rollback artifact.
2. **Offline contract verification.** Check exact identity/configuration and
   launch inventory against existing root gates. Record platform-specific
   executable hashes and the direct loader contract. Do not pretend a locally
   mutable tree passed the protected production-release gate.
3. **Isolated mechanism evidence.** Separately authorized isolated work may
   exercise the existing entrypoints with exact fixture identity and native
   committed journal, using the existing runtime and approved pool budget.
   Record actual results and cleanup; do not upgrade fixture signatures to
   independent production approval. This document's sidecar performs no such
   run.
4. **External measurement and review.** Supply the trusted expected target,
   catalog, writer/input inventory and independently measured artifact
   derivation, retained-write compatibility and backup/fence evidence. Produce
   existing-format review/authorization records only through their legitimate
   external authority. Missing facts stay unknown, even if a signer is present.
5. **Saved-input readiness evaluation.** Run the validation-only readiness CLI
   against the immutable manifest, pinned review policy/keys and supported
   protected artifacts. Inspect preservation, operational cutover and business
   activation separately. Any unknown required evidence remains blocked; this
   command cannot authorize production execution.
6. **Operational handoff.** Hand over the exact candidate inventory, external
   proof records, journal/retained-write boundary and approved launch identity.
   Actual production rollback requires its independent approval and current
   committed startup verification. Keep delivery, FOMO and historical resume
   disabled; do not change core scoring thresholds.

## Current gaps

- No demonstrated one-command rollback artifact builder or production-proof
  generator exists in the known entrypoint contract; release packaging remains
  an explicit step.
- Real independent source derivation, live catalog/cohort measurements,
  complete proved fencing and production retained-write compatibility are not
  supplied by this document or by signed manifest booleans.
- The artifact verifier does not implement all source integrity, online backup,
  catalog or derivation measurements; its unsupported claims remain unknown.
- Parent's current direct-loader G11 result must be recorded by the parent when
  complete. Earlier function-entrypoint evidence cannot stand in for it.
- A final target-bound independent compatibility approval and current committed
  journal are external inputs, not something this local sidecar may self-mint.

These gaps block production authorization, not local preparation of a clearly
labeled candidate. They do not justify restoring SQLite after PostgreSQL writes
or marking any of the three readiness gates ready without their actual evidence.
