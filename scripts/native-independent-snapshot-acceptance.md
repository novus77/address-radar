# Native snapshot acceptance handoff

No commands in this document have been executed against a host. Deployment and
maintenance/cleanup remain parent-owned. Neither this transport nor local tests
claim production activation or a complete native fence.

## Operator-established trust versus existing independent keys

The approved bootstrap may create four NEW local operator-authorized Ed25519
keys. This is not a pre-existing external reviewer. All four SPKI keys must be
cryptographically distinct. An existing independent key may instead be used only
under an explicitly approved protected registry/profile; no key is inferred from
issuer names, documents, fixture receipts or test fixtures.

Minimum real profile: reviewed actual seven-kind scope inventory; authorization
all five existing actions; observer census+fence; snapshot snapshot; compatibility
rehearsal. Register actual installed native entry SHA256, not a library/document
SHA. Registry/profile/approved-plan and immutable jobs must be root protected.
Private keys remain root0600 under root0700, never argv/stdout. Bootstrap remains
blocked until actual scopes and entries are reviewed; this change creates no keys.

## Snapshot work cleanup

The independent snapshot entry exclusively creates snapshot-work in its already
bound request receipt directory. Both snapshot artifact and CURRENT fenced-source
backup/export/restore work live there. It reserves ten seconds from the original
monotonic deadline for cleanup. Entire-tree ownership/type/mount/identity preflight
precedes unlink. Incremental bounds: 10000 entries, depth16, 512 live child FDs.
No symlinks, hardlinks, other owners, group/world-writable entries, mount changes
or recreated work roots are accepted. Unknown trees remain and the run refuses.
Failure paths attempt the same cleanup, never arbitrary recursive removal.

Only generated work is deleted. Source, producer snapshot and fixture are never
cleanup targets. The receipt carries non-content cleanup counts and a prepublish
retained audit; the audited directory admits only proof.json, not business work.
This is unlink/removal, NOT forensic secure erasure of underlying storage. A crash
or expired/unknown tree may leave private root-only work requiring independently
reviewed lifecycle recovery; do not assert cleanup from absence of a success receipt.

## Protected signing job

Native entry: scripts/native-independent-snapshot-signing.mjs. Install actual
reviewed bytes under a root-protected path and register its entry SHA for the
snapshot-collector. A fixed registered launcher must preserve the verified real
INVOCATION_ID and run the entry in the existing sealed verifier managed lease.
Only its request receipt directory may be writable under ProtectSystem=strict.
No direct console execution substitutes for managed admission.

Job version1 fields consumed by the entry:
- nonce, requestNonce, bindingPath, outputPath
- registry{path,sha256}, approvedProfileSha256
- policy{path,sha256} (existing coordinator v2 policy with closureTrust)
- measurement{path,sha256} (outside wrapper FINALIZED actual snapshot measurement)
- authorization/census/rollback each {path,sha256} (real signed evidence)
- credentials{path,sha256} (private connectionString, ssl:false)
- enginePath, coordinatorPath, pgModulePath (actual compiled installed modules)
- codePins[{path,sha256}] (ALL loaded non-builtin modules, including pg dependencies)

bindingPath is derived exact request verifier path. Its actual hash is measured
at startup and checked against protected admit.json; no preembedded binding hash
or mutable job rewrite is needed. All non-builtin module loads are checked against
approved codePins and execute the bytes already read/hashed. Missing dependency
pins fail closed. Use compiled JS, not an unreviewed TS transformation loader.

The registry pins the actual entry and the protected reviewed job pins its entire
loaded code closure. Runtime executable pin, managed resource/deadline/cgroup
terminal verification and outside-root child drainage are supplied by the existing
registered managed launcher/helper, not invented by this signing entry.

The connection is dedicated pool1, timeout2s/lock500ms, transaction SERIALIZABLE
READ ONLY, measured nonowner/nonmember/no SET/no table+column+sequence writes.
The existing createReadOnlyCutoverStartupStore and new coordinator
inspectPersistedPhase verify actual DB identity, durable state and native first-write
marker. Phase is measured twice, never supplied as a job boolean/string. Initial
prepare requires actual absence of BOTH records in existing durable tables; missing
tables/query failure/orphan marker refuse. The new method requires review and native
acceptance; see native-initial-prepare-phase-handoff.md. No schema/protocol install
or write authorization is performed by this entry.

## Native acceptance commands (parent only, no guessed runtime paths)

Within the admitted managed unit, the fixed registered launcher executes exactly:

```sh
"$PINNED_NODE" "$PINNED_SIGNING_ENTRY" --job "$PROTECTED_SIGNING_JOB" --job-sha256 "$SIGNING_JOB_SHA256"
```

For actual fresh snapshot measurement within its separately admitted verifier:

```sh
"$PINNED_PYTHON" -I -B "$PINNED_SNAPSHOT_ENTRY" --job "$PROTECTED_SNAPSHOT_JOB" --job-sha256 "$SNAPSHOT_JOB_SHA256"
```

The Python flags belong in the reviewed launcher: do not change frozen helper's
argv1 registration expectations. Parent must enter the existing managed lease and
call run_managed_collector with registered argv/limits; retain the lock until
strict terminal-empty, Job settled and original cgroup proof, then publish its
actual finalizedSnapshotMeasurement as protected canonical data for signing.
The same wrapper must drain the signing unit before accepting proof.json.

Negative native acceptance: wrong INVOCATION_ID; absent/replaced cgroup; unknown
module pin; different collector entry; mismatched profile/key/scopes; missing
committed marker/state; changed phase; column-only write grant; preexisting receipt;
symlink/mount/hardlink work tree. All must refuse without publishing success.
Local mocks/ephemeral crypto tests are not native acceptance evidence.
