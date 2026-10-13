# Initial prepare phase / authority profile handoff

No host operations, key generation, schema modifications, deployment or activation
were performed. Frozen bootstrap, maintenance and expiry helpers are unchanged.
The new coordinator method and native transport require independent review.

## Exact first-prepare API

```ts
const phaseReader = createMigrationCutoverCoordinator({ expected: policy, store, clock });
const phase = await phaseReader.inspectPersistedPhase(inspectionDeadline, signal);
```

Use ONLY createReadOnlyCutoverStartupStore with the existing actual native runtime
in the signing entry. An injected test store is not native proof. This store verifies
actual backend DB/address/port/system_identifier/schema/generation/fingerprint,
requires ordinary persistent ledger and marker tables and performs real SELECTs.
The phase method reads both ledger and marker for the SAME generation-independent
sourceKey. Only measured absence of BOTH admits initial before-first-pg-write.
Absent tables, query failure, unavailable marker adapter, orphan/mismatched marker,
unvalidated durable state/closure and deadline failure refuse, never default.

Return: version1, sourceKey, policySha256, phase, ledgerPresent, revision,
stateSha256, nativeMarkerSha256, writeAuthorized:false, activationEnabled:false.
Existing durable state uses unchanged native marker and signed closure validators.
It does not install tables or authorize a write. Native signing measures phase twice
and requires identical returned state/marker hashes before publishing. Parent must
keep all first-write admissions closed throughout the managed operation; two reads
alone are NOT a lock preventing a trusted concurrent root writer.

The initial signing entry now invokes this API rather than requiring an already
committed selection. It continues through the unchanged full authorization/census/
snapshot/rollback signature closure verifier. Actual protected keys and genuine
native evidence remain mandatory. A bare phase string or unsigned outline cannot
replace them.

## Actual inventory seed, not scope closure

scripts/migration-authority-profile-plan.mjs supports seed and plan; neither creates
keys or signed evidence. Seed consumes the actual captured discovery report and
its exact SHA, preserves every unresolved blocker, known PID metadata and protected
FOMO identity requirements. Timer-associated services are conservative review
candidates, NOT declared writers. The existing actual report produces 43 candidates
and STILL has scopeApproved:false. It is old capture data, not fresh fence evidence.

Minimum approved inventory record:

```json
{
  "version": 1,
  "provenance": "new-local-operator-approved-scope-inventory",
  "approvalId": "actual-operator-review-id",
  "hostId": "actual-host",
  "bootId": "actual-boot",
  "discoverySha256": "actual-raw-discovery-sha256",
  "scopes": [],
  "unresolvedScopeIds": [],
  "coverage": []
}
```

Fill scopes only with reviewed actual contract-shaped id/kind/paths/directions.
The full unchanged closure minimum (all seven kinds, >=12 services, >=5 timers)
is enforced; entries cannot be invented to satisfy counts. Required coverage:
units, timers, user-managers, cron-at, operators, deploy, external-input, bridges,
fd-mmap. Each coverage entry has surface, approved:true, evidencePath and the actual
evidenceSha256. Native plan reads and pins those protected evidence files; operator
approval is still NOT signed measured fence proof. Unresolved scopes always refuse.
Unknown input must be measured/classified or denied by actual admission controls,
not erased from this list or attributed to an imaginary external authority.

Collector entry list: exactly observer-collector, snapshot-collector,
compatibility-verifier; each {role,path,sha256}. Plan reads each actual executable
entry, verifies its supplied SHA and emits these pins. Executable extension is only
a format guard, not semantic proof that a library is a collector. Independent review
must approve each actual native entry and its complete loaded byte closure. The
observer signing path/full actual scope closure are NOT established by this tool.

## New local operator authority, not historical independence

Generated profile provenance is exactly new-local-operator-bootstrap. Issuer/key
IDs explicitly include new-local-operator/local and the new bootstrap nonce. The
profile gives authorization all five actions, observer census+fence, snapshot
snapshot, compatibility rehearsal, and exact reviewed scope coverage.

The existing reviewed bootstrap, AFTER a new explicit profile/plan review, can
create four real distinct Ed25519 keys atomically. Those are independent role keys
under newly established local operator trust, NOT pre-existing independent external
reviewers/operators. No public/private key is invented by this planner. Existing
independent keys need their own explicitly approved protected registry; this planner
neither imports nor claims them. No private key bytes appear in commands or output.

## Contract pin change must be reviewed, never hidden

Adding the phase method changes the actual coordinator source SHA. Plan receives
actual source pins, preserves them, and reports BOOTSTRAP_CONTRACT_PIN_REVIEW_REQUIRED
if they differ from the unchanged frozen bootstrap CONTRACT. Its bootstrapApplyAllowed
is always false: parent approval/release is required even without drift. Do NOT pass
old contract SHA aliases. Bootstrap owner must publish a newly reviewed contract-pin
version before native apply can consume the new profile. No frozen bootstrap was
modified and no apply was executed here.

## Parent-only acceptance and provisioning commands

Read-only plan against protected actual inventory/entries, only after parent release:

```sh
"$PINNED_NODE" "$PINNED_PROFILE_PLANNER" plan \
  --inventory "$ROOT_APPROVED_INVENTORY" --inventory-sha256 "$INVENTORY_SHA256" \
  --entries "$ROOT_MEASURED_COLLECTOR_ENTRIES" --entries-sha256 "$ENTRIES_SHA256" \
  --bootstrap-id "$NEW_BOOTSTRAP_NONCE" \
  --coordinator "$ROOT_REVIEWED_COORDINATOR_SOURCE" --coordinator-sha256 "$COORDINATOR_SHA256" \
  --closure "$ROOT_REVIEWED_CLOSURE_SOURCE" --closure-sha256 "$CLOSURE_SHA256" \
  --native-readonly true
```

Publish the generated canonical profile through the reviewed exclusive root adapter
(root0700 namespace/profile0600), not an arbitrary overwrite/redirection. After
contract-pin code review and exact profile approval, existing bootstrap commands:

```sh
"$PINNED_NODE" "$REVIEWED_BOOTSTRAP" plan \
  --profile "$PROTECTED_PROFILE" --profile-sha256 "$PROFILE_SHA256"

"$PINNED_NODE" "$REVIEWED_BOOTSTRAP" apply \
  --profile "$PROTECTED_PROFILE" --profile-sha256 "$PROFILE_SHA256" \
  --approved-plan-sha256 "$APPROVED_PLAN_SHA256" \
  --approval-kind new-local-operator-bootstrap \
  --expected-node-sha256 "$ACTUAL_NODE_SHA256" \
  --expected-bootstrap-sha256 "$REVIEWED_BOOTSTRAP_SHA256"
```

Do not execute apply until parent releases it. The resulting actual registry SHA,
profile SHA, SPKI fingerprints and role public keys must be pinned into the root
policy closureTrust/reviewer/collector records. Registry publication explicitly
claims no readiness; source admission/drain/fresh snapshot/compatibility evidence
must still be obtained independently. Preserve FOMO collector/login/noVNC PIDs.

The signing command remains inside its separately approved managed verifier lane:

```sh
"$PINNED_NODE" "$PINNED_SIGNING_ENTRY" --job "$PROTECTED_SIGNING_JOB" --job-sha256 "$SIGNING_JOB_SHA256"
```

Original deadlines, exact request-only ReadWritePaths, verified INVOCATION_ID,
permanent shared lock, original cgroup/terminal-empty/job proof and closed writer
admission remain mandatory. Missing durable tables require schema-owner-approved
provisioning, not implicit creation by phase inspection. Local protocol fixtures
and ephemeral crypto tests do not establish native acceptance.
