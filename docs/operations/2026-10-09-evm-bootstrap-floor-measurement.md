# EVM bootstrap floor measurement evidence

Date: 2026-10-09. Measurement phase is frozen. No commit was requested or created.

## Scope and outcome

The reviewed maintenance runner measured the first block whose timestamp is at or after the original generation activation. It used the existing production `createPostgresServiceFactAdapters(...).fetch` transport, including durable provider budget debit, leases, response limits and cooldown. No budget implementation was duplicated.

Only provider budget/lease/cooldown operational writes were authorized. No business checkpoint, anchor, facts, eligibility, signal permission, DDL, service activation or restart was applied by the measurement. A successful floor receipt is not a committed collector checkpoint or evidence of radar closed-loop completion.

| Evidence | Value |
| --- | --- |
| Generation | `production-20261006-v1` |
| Original activation, Unix milliseconds | `1791442257867` |
| BSC floor | `126398984` |
| Base floor | `52326456` |
| BSC provider requests | `rpc-bsc-source`: `33` |
| Base provider requests | `rpc-base-source`: `32` |
| Total runner elapsed milliseconds | `11046.147447` |
| Receipt | `/var/lib/address-radar-maintenance-tools/evm-bootstrap-floors-20261009c-r2/floor-receipt.json` |
| Receipt SHA256 | `92fae8b674091d3a789f9f29d4d2c0cceb1a355f0372103c4be74318107615c8` |
| Reviewed r2 bundle SHA256 | `707de76736cafd7625ba5589895f46bbd244412d9f47552df32393a09c16f188` |
| Local r2 bundle | `/private/tmp/address-only-evm-floor-runner-20261009c-r2.mjs` |
| Production r2 toolroot | `/var/lib/address-radar-maintenance-tools/evm-bootstrap-floors-20261009c-r2` |

The root-private receipt contains the predecessor and selected headers, hashes and timestamps, chain/genesis identity, fixed search head, generation/activation/release bindings, input pins and request counts. It contains no RPC URL or credential. Publication is exclusive, atomic and fsynced.

The consuming environment value is plain JSON:

```json
{"bsc":126398984,"base":52326456}
```

Huygens received the result for c metadata preparation. This document does not assert that metadata publication or activation has completed.

## Bounds and correctness gates

- At most 40 requests per provider; 180-second runner deadline; 10-second maximum request timeout; 256 KiB maximum response.
- Fixed chainId/block-header RPC allowlist; no new provider, raw curl path or cooldown override.
- Approved source provider endpoints and chain/genesis pins come from current root-private authority/deployment inputs.
- Original millisecond activation is compared without downward rounding: `timestamp * 1000 >= activatedAt`.
- Binary search uses a fixed head and validates observed timestamp ordering, the predecessor boundary, parent linkage and final header stability.
- Zero floors are rejected before receipt publication.
- Operational DB access accepts only exact existing adapter SQL templates, complete parameter counts and generation/provider parameter positions. Template changes fail closed.
- Runtime closes and private input/release pins are rechecked before publication. No partial result is published as successful floors.

## Measurement-related source changes

- `scripts/measure-address-only-evm-bootstrap-floors.ts`: maintenance runner, binding checks, exact operational SQL gate, bounded search and private receipt publication.
- `scripts/test/measure-address-only-evm-bootstrap-floors.test.ts`: search boundaries, response/request/deadline limits, negative SQL cases and complete job fixtures using the actual adapter with fake DB/network.
- `scripts/tsconfig.evm-bootstrap-floors.json`: dedicated typecheck entry.
- `scripts/postgres-address-only-configured-preflight.ts`: export the existing root-compatible `sealedRelease`; equivalent explicit numeric guard for operator allocation typing. Inventory logic is unchanged.
- `scripts/build-address-only-compiled-release.mjs`: exact imported maintenance CLI guard isolation while preserving the selected entry CLI. This handles esbuild collapsing imported `import.meta.url` values.
- `scripts/test/build-address-only-compiled-release.test.ts`: root-library import side-effect guards and standalone runner/native-preflight CLI regressions.

The initial production attempt was refused before DB/RPC because the service-only release verifier rejects root identities. Its job/artifacts remain under `/var/lib/address-radar-maintenance-tools/evm-bootstrap-floors-20261009c`. r2 uses the existing root-compatible inventory implementation; it does not weaken or duplicate inventory verification.

## Validation and review provenance

PASS, executed by the measurement owner: 45 tests across these three files, followed by the dedicated typecheck:

```sh
NODE=/Users/a77/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
"$NODE" node_modules/vitest/vitest.mjs run \
  scripts/test/measure-address-only-evm-bootstrap-floors.test.ts \
  scripts/test/build-address-only-compiled-release.test.ts \
  scripts/test/postgres-address-only-configured-preflight.test.ts
"$NODE" node_modules/typescript/bin/tsc -p scripts/tsconfig.evm-bootstrap-floors.json --pretty false
```

PASS, reported by the parent/user, not independently rerun by this owner: full gate with **3376 passing tests**. File count, skipped count and additional typecheck totals are not inferred for that report.

PASS, reported by the parent/user: Turing final no-P1 review explicitly bound to r2 bundle SHA256 `707de76736cafd7625ba5589895f46bbd244412d9f47552df32393a09c16f188`. Real production measurement ran only after that approval.

## Separate c code-stage evidence

The parent/user reported successful code-only staging; this owner did not recreate that release or independently remeasure these c stage pins:

- Release: `/opt/address-radar/releases/address-only-stability-20261009c`.
- Seal SHA256: `51383e1553a28d0044958a53e6c59379597066dcc43ccb34aab9cd45c72f7ca1`.
- Entry SHA256: `02e0c280650b7f8ea240a916bd0739efedaa04f4e25394565b6d7f8129027479`.
- Stage receipt: `/var/lib/address-radar-maintenance-tools/code-stage-stability-20261009c.json`.
- Stage receipt SHA256: `86bfe09a2b6c9ce690432d21a2bf3f5b6d2f345fc55f3c5b646a9ea591a7d4d1`.

Activation belongs to the parent. The original b COMPLETE origin remains the configuration transition basis until an actual later transition is verified.

## Minimal source-fact authority gap plan, not executed

This section records a local source-contract inspection, not a production capability grant. The literal identifier `requiredSourceFactAuthority` was not found in the inspected local source. No new configuration field is assumed to exist.

Current inspected CLI contract:

- `scripts/postgres-service-cli-authority.ts` exports `PostgresCliExecutionAuthorityConfiguration` and `createPostgresCliExecutionAuthority`, returning execution validator/publisher ports only.
- `PostgresSourceFactRetryAuthority` requires preconstructed `reader.load` and `receiver.receive`; it does not create keys, pools or authorities. Missing authority defers with `source_retry_authority_unavailable`.
- `createPostgresSourceFactReceiver` requires a candidate verifier and independently supplied validator/publisher; missing validator/publisher defers with `source_validator_or_publisher_unavailable`.
- Existing factories are `createPostgresExecutionEnvelopeReader`, `createPostgresIndependentSourceValidator` and `createPostgresSourceFactPublisher`.

Minimal next steps, all PENDING:

1. Read-only inventory of the exact deployed source contract, source-kind schema constraints, validator/import ledger coverage and publisher ACLs. Establish whether the frozen release actually wires the source retry authority. Module presence or execution authority approval is not wiring proof.
2. Obtain explicit reviewed policy for source validator/key/actor identity, validity window, generation/original activation, release binding, allowed replay provider bindings and budgets. Do not generate or approve a key, infer organizational independence, reuse execution signing authority by default, or expand provider approvals automatically.
3. Plan a narrow root-private CLI source authority factory using those existing factories: read-only envelope reader and validator UOW, separately least-privileged publisher UOW, exact current target-version/original execution-envelope binding, explicit limits and cleanup. Preserve the distinction between replay execution validation and source attestation.
4. Only after separate authorization, provision the exact source-kind validator/import-ledger entries and least-privilege role grants demanded by the approved contract. First confirm existing schema supports them; do not silently run DDL or broaden an execution authority record. Publisher privilege checks protect original samples, revisions, generations, identity/channel history and provenance tables against writes.
5. Integrate the reviewed authority into the actual CLI/retry path in a separately reviewed change. Test absent/revoked/mismatched keys, same-identity authority, stale/current-version drift, altered envelopes, privilege excess, duplicate replay and failure rollback. Missing approval continues to defer; no default independence or eligibility grant.

No policy/key approval, provisioning, DB changes, new signing authority or service action was performed for this plan. Source authority provisioning is separate from successful bootstrap-floor measurement and c activation.
