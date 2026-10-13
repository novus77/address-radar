# Isolated migration authority bootstrap

## Boundary

This is a NEW local operator bootstrap, not a pre-existing external reviewer,
review result, readiness token, writer fence, snapshot or compatibility proof.
It generates four distinct real Ed25519 keys but does not establish independent
actors merely by generating distinct keys. No existing trust policy is replaced.
No signing operation, service activation, database action or SSH exists here.
Native creation requires parent code/plan review before controlled root apply.
Frozen maintenance/expiry helpers remain unchanged.

The contracts require caller-reviewed out-of-band trust and genuinely acquired
native evidence. This bootstrap cannot satisfy that external review/measurement
gate. A later separately reviewed adapter may extract public keys; it must not
use this registry itself as proof of readiness or independent observations.

## Owned files

- `scripts/migration-authority-bootstrap.mjs`
- `scripts/test/migration-authority-bootstrap.test.mjs`
- This plan document.

## Existing contract pins and enums

The implementation is bound to the reviewed local coordinator and fence closure
source SHA-256 values in `CONTRACT`. Drift requires independent review and a new
version, not caller-selected widening of enums.

Actions: `prepare`, `select-postgres`, `first-postgres-write`, `rollback`, `abort`.
Observation kinds: `census`, `fence`, `snapshot`, `parity`, `target`, `guards`,
`capacity`, `rehearsal`, `rollback`.
Scope kinds: `service`, `timer`, `bridge`, `cron`, `operator`, `deploy`,
`external-input`. Scope fields follow the existing closure contract:
`id`, `kind`, `paths`, `directions`. Bridges require both `source-to-input` and
`output-to-source`; other kinds require no directions. This validates syntax,
NOT completeness of the real writer census. Bootstrap plans may therefore still
be incomplete for a production trust policy.

## Profile v1

The profile is canonical sorted-key compact JSON, regular single-link file0600.
Top-level exact fields: `version:1`, `bootstrapId` (16 lowercase hex),
`provenance:"new-local-operator-bootstrap"`, `contracts`, `scopes`, `roles`.
`contracts` has the exact `coordinatorSha256` and `closureSha256` in `CONTRACT`.

Exactly four role entries, with distinct issuer IDs and key IDs:

| Role | Actions | Kinds | Collector hash |
| --- | --- | --- | --- |
| operator-authorization | All five existing actions | Empty | null |
| observer-collector | Empty | census and fence required; other existing non-snapshot kinds only if explicitly approved | Reviewed code SHA-256 |
| snapshot-collector | Empty | snapshot only | Reviewed code SHA-256 |
| compatibility-verifier | Empty | rehearsal only | Reviewed code SHA-256 |

Each entry has exactly `role`, `issuerId`, `keyId`, `actions`, `kinds`, `scopeIds`,
`collectorSha256`. Scope IDs must reference explicit profile scopes. No keys,
proof booleans or caller-added permissions are accepted in the profile.
Collector hashes are review bindings, not claims that those programs executed.

Coordinator collector `kinds` and closure signing domains are distinct contracts.
The coordinator requires its pinned compatibility collector to have `rehearsal`;
its public key must differ from the outer report collector. The minimal observer
profile grants only `census` and `fence`. Coordinator observation validation at
`observation(report, "rollback", policy, now)` and complete-policy kind coverage
require an outer rollback collector for the complete rollback pipeline. Therefore
an explicitly reviewed profile MAY add observer `rollback` and other required
observation kinds; bootstrap never silently adds them. Compatibility remains
`rehearsal`-only in coordinator kinds. Closure verifies `census` with the
observer key and `rollback` with the independent compatibility key. Registry
entries expose the fixed `closureSigningKind` mapping: authorization, census,
snapshot and rollback respectively. No signing is implemented here. These
structural mappings do NOT establish real independent actors, complete scopes,
actual evidence or full-pipeline acceptance. Earlier partial-action/rollback-only
profiles are rejected and require a new exact reviewed profile and plan pin.

## Offline plan API

```sh
PINNED_NODE scripts/migration-authority-bootstrap.mjs plan \
  --profile /absolute/canonical-profile.json \
  --profile-sha256 PROFILE_SHA256
```

Plan does not generate keys, create namespaces or need root/Linux. It emits a
public plan and `planSha256`. Parent reviews both profile and exact plan hash.

## Controlled native apply API (NOT executed during implementation)

Parent must separately provide the permanent root-owned0700 base
`/var/lib/address-radar-migration-authority`, with protected root-only-write
ancestors. Apply never creates or changes ancestor permissions.
The actual pinned server Node path and bootstrap copy must be root-protected,
regular single-link and hash-pinned. No private key goes through argv/stdout.
The apply profile must also have protected root ancestors and root ownership.

```sh
PINNED_NODE /absolute/pinned-bootstrap.mjs apply \
  --profile /absolute/root-protected-profile.json \
  --profile-sha256 PROFILE_SHA256 \
  --approved-plan-sha256 APPROVED_PLAN_SHA256 \
  --approval-kind new-local-operator-bootstrap \
  --expected-node-sha256 SERVER_NODE_SHA256 \
  --expected-bootstrap-sha256 REVIEWED_BOOTSTRAP_SHA256
```

Apply is Linux/effective-root only and has a 30-second monotonic operation budget.
It opens protected ancestors and uses `/proc/self/fd` relative to held directory
FDs. The exact nonce namespace is exclusively created root0700. Every private
PKCS8 PEM is exclusively created root0600, single-link, checked before/after
writes and fsynced. Symlinks, path replacement and existing namespaces fail
closed. No retry or deletion of incomplete namespaces occurs.

Public `registry.json` is published last by atomic no-replace hard link, followed
by unlinking the private publication staging name and directory fsync. Readers
must require nlink1; a crash leaving nlink2 is NOT usable. Registry includes only
public SPKI PEM/base64, public SHA-256 fingerprints, issuer/key IDs, approved
scope/action/kind bindings and explicit false trust/readiness/proof claims.
Apply stdout contains only fingerprints, hashes and status, not PEM material.
All public registry files are root0600 inside root0700 as a conservative default.

## Remaining gates

- Independent parent review of code, exact profile and plan hash.
- Controlled native filesystem/runtime acceptance (local mocks are not proof).
- Separate ownership/custody and out-of-band pinning of the reviewed public trust
  policy; local distinct keys do not prove independent actors or external review.
- Actual independently acquired observer/snapshot/compatibility evidence and
  separately approved signing, including all native artifact/ACL/content checks.
- Full existing writer census, scope completeness and production readiness gates.

Test invocation: `node --test scripts/test/migration-authority-bootstrap.test.mjs`.
