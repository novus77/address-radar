# Stability release e: recovery and deployment record

Date: 2026-10-09. This record distinguishes verified metadata, locally executed tests, and parent-reported production outcomes. No Git commit was performed by this owner.

## Source and test evidence

- Connection retirement review passed for `packages/database/src/postgres-business-driver.ts`, `packages/database/src/postgres-connection-retirement.ts`, and their driver/retirement tests. Reviewed physical connection fencing, bounded acquisition, shutdown, and absence of uncertain-commit replay. Owner reported 126 tests and database test types passing.
- Entry/source retry review passed for `scripts/postgres-service-entry.ts` and its test. Reviewed shared runtime use, bounded scheduling, missing-authority refusal, immutable envelope consumption, and closed diagnostic reasons. Owner reported 254 tests and entry types passing.
- Rate-limit review passed for `apps/wallet-monitor/src/postgres-wallet-channel.ts`, `apps/automation/src/postgres-service-fact-adapters.ts`, and their tests. Reviewed the 40 fixed EVM reasons, 60-second invalid/missing Retry-After fallback, 24-hour maximum, durable cooldown, unchanged allocations, and no immediate retry.
- The parent reported a stability gate of 3,422 tests and 18 type checks passing. This owner did not rerun that full gate.
- This owner changed only `scripts/activate-address-only-configured.py` and `scripts/test/activate-address-only-configured.test.py` for the restored-origin entry point. Locally executed: 102 configured-controller tests, 14 native-activation tests, and 14 native-controller tests; all 130 passed. Huygens independently reviewed the change with no new P1.

## Production timeline

1. Release c had a COMPLETE journal and receipt. Release d metadata and code were staged; staging did not establish activation success.
2. Activation d failed in native preflight, before prepare/publish. The launcher surfaced `launcher_refused_or_uncertain`; the underlying failure was `actual_provisioned_contracts`, associated with treating an operationally paused provider as an invalid provisioned contract. The inherited c preflight input hash was not evidence that d passed preflight. All six services were reblocked, and their owned PostgreSQL drop-ins were removed. **Release d did not activate successfully.**
3. The parent restored c using six rendered drop-ins that exactly matched c journal desired hashes, verified guard body/hard-link identity, and retained matching c runtime artifacts. The parent reported six active/running services with zero restarts. Restore audit: `/var/lib/address-radar-maintenance-tools/restore-c-after-d-refusal-1791514514847/receipt.json`; SHA-256 `b607b8541f0b97732176cdba335d2dd0ed56b5072cc53d610e1af7c6bffc8860`. Database data was not rolled back, and delivery remained disabled. This owner's draft restore script was not used.
4. Restored c processes had new PIDs; the historical c COMPLETE receipt was not rewritten or presented as current readiness. The new explicit `restoredRecovery` authorization binds c journal/receipt and the root-private restore audit, checks all six current process/lifecycle identities and retained artifacts, and records that old six-service readiness was not verified. It does not bypass the subsequent native preflight or new six-service readiness.
5. The reviewed controller was uploaded exclusively to `/var/lib/address-radar-maintenance-tools/configured-controller-20261009e/activate-configured.py`: root-owned file mode 0400, directory mode 0700; SHA-256 `4e87e5849191f135d4f0b7636f962d58fd89e5b2407bd94879c1fd2e74207e9c`.
6. Read-only e verification passed for metadata pins, c COMPLETE origin, restored-origin authorization/audit, preserved credentials and business settings, release inventory, and entry hash. A mistaken review comparison between the verifier program and settings JSON was corrected: these are separate pins; the settings JSON correctly retained c's pin.
7. The parent reported **e activation SUCCESS, exit 0**, with new six-service readiness at epoch milliseconds `1791515580405`. The actual controller verified all six restored identities, and the new native preflight program passed. Gateway delivery remained false. Activation was performed by the parent, not this owner.

## Release e pins

- Release root: `/opt/address-radar/releases/address-only-stability-20261009e`.
- Seal: `dbc72ef30a296f979a68aba5fc943e318d85471dd8f0587ea9fbbf72ee211c0f`; inventory: 5 entries, 1,213,299 bytes.
- Entry SHA-256: `ced4db2188522e14e89fd23f3f822acea0fc1d7761cdd0f5d46193c80a53c71d`.
- Native verifier: `/var/lib/address-radar-maintenance-tools/native-preflight-20261009e/preflight.mjs`; SHA-256 `30701647f918be25c6a80af106327d9226e6651655ab98dcbe6c6233cd47549a`.
- Retained settings JSON: `/var/lib/address-radar-maintenance-tools/configured-execution-20261008a/preflight-settings.json`; SHA-256 `7cfc19fa79b381e8b896fb6222a9ac22a029b20f87fdae594b92b24c322f0ede`.
- Original import anchors, historical c/d records, restore audit, SQLite source epoch, and global current were preserved. No new source authority or business eligibility was inferred from deployment success.

## Remaining acceptance

PENDING: Ohm's two-snapshot acceptance, including measured net business growth and relevant deferral/failure evidence. Six-service readiness and native preflight success do not establish a complete radar business loop or native migration completion.

## f stability release: deployed successfully

The parent reported f activation SUCCESS with exit code 0 and fresh six-service readiness at epoch milliseconds `1791517908568`. Native preflight accepted the two new source budget fields using the rebuilt f verifier. This deployment follows, and does not supersede or rewrite, the recorded d failure (`actual_provisioned_contracts`), audited c restoration, and successful e activation.

### Release and validation evidence

- Release: `/opt/address-radar/releases/address-only-stability-20261009f`.
- Release seal: `b50729390dc7c1007de0e47fec4458b5c2be005f40e8bacfbb1db0ef9f2fb927`.
- Entry SHA-256: `af10af51e84e4a42f0ef56f9cacd0996b92b5698757066679c40844bc90fd85f`.
- Inventory: 5 files, 1,220,511 bytes.
- Parent-reported full gate: 3,550 tests passed, 107 skipped; all 18 type-check gates passed. These full-gate results were not independently rerun for this documentation update.
- The compiled configuration smoke test accepted valid new source keys and rejected over-limit values without PostgreSQL or RPC access; the root module smoke test also passed, as reported by the build owner.
- Explicit source execution-item and result-page budgets are both 2,097,152 bytes. The existing composition payload budget remains 2,097,152 bytes; other fact payload limits remain 262,144 bytes.

### Final verifier and request binding

The original f request was not activated: the reused e verifier contained the older entry validation schema and could not accept the two new source keys. The final request replaced only the native verifier program pin; authority, deployment, environment, original pins, and healthy e COMPLETE origin remained unchanged. No restored or degraded recovery authorization was retained in the f origin.

- Native verifier: `/var/lib/address-radar-maintenance-tools/native-preflight-20261009f/preflight.mjs`.
- Verifier SHA-256: `7a9ae16b2c946a5d4d8a129ea256968b132015b98a3aad75ffdb502c4a12972f`; size: 639,557 bytes.
- Final request: `/var/lib/address-radar-maintenance-tools/configured-stability-20261009f/request-template-native-f.json`.
- Final request SHA-256: `1399eade529943dcf563fd4494af7e6b4c33494b72464f00742a6289d2aa6c08`.
- Preparation audit: `/var/lib/address-radar-maintenance-tools/configured-stability-20261009f/preparation-native-f.json`.
- Preparation audit SHA-256: `3183d5c3695830cea910b224ba3a035e0b20e8c18cca3ca76e0cbf4f181aa5a1`.

Independent production read-only verification confirmed the actual file hashes, verifier size, private metadata permissions, unchanged metadata pins, exact two-field template difference (`nativeVerifier.path` and `nativeVerifier.sha256`), `deadlineAtMs=0`, and audit bindings. The settings JSON remains a separate configuration pin, not the native verifier program. The preparation audit records no activation at preparation time; the subsequent activation success is the parent-reported event above.

### Acceptance boundary

- Operational activation: PASS, based on the parent's exit-zero activation and fresh six-service readiness report.
- Business acceptance: PENDING. Ohm is performing the two-snapshot, 90-second acceptance check; no purchase success or net business progress is asserted here.
- `gateway=false` and `nativeFullRadar=false` remain the stated operating boundaries. Successful f deployment is not evidence of a completed native full-radar closed loop.
- This documentation update performed no production PostgreSQL queries, service actions, or activation, and did not modify the retained d failure, c restore audit, or e transition artifacts.

## f observed business acceptance: incomplete closed loop

The parent supplied the following production acceptance observations for `2026-10-09 11:53:39` through `11:57:09` (reporting timezone not supplied). This replaces the pending snapshot evidence above with observed results, not a full closed-loop PASS.

| Metric | Start | End | Observed change |
| --- | ---: | ---: | ---: |
| Captures | 183 | 206 | +23 |
| Normalized records | 180 | 188 | +8 |

The reported snapshot also contained 72 tokens, 114 facts, zero purchases, and one matched buy overall. The reported post-f matched count was zero. No purchase or post-f matching success is established by these observations.

### Remaining blockers

- `canonical_execution_proof_unavailable`: 67 reported occurrences.
- `execution_acquisition_unavailable`: 16 reported occurrences.
- `source_retry_not_configured`: 14 reported occurrences.
- Base checkpoint remained `52335825`; BSC checkpoint remained `126445315`, with `provider_backoff` reported. The observations do not establish resumed chain catch-up.

### Operational boundary and follow-up

All six services were reported active with zero restarts; lock count was zero and available disk was 5,532,278,784 bytes. `gateway=false` and global current remained unchanged. These are operational stability observations, not proof of end-to-end business completion; the existing `nativeFullRadar=false` boundary remains in force.

Turing is continuing execution acquisition and retry fixes. Ohm is investigating RPC behavior and safe classification diagnostics. Independent review will follow their frozen changes. Until those fixes and subsequent acceptance evidence are available, execution-proof availability, post-f matching, purchases, and the complete radar closed loop remain unaccepted.

These observations were supplied by the parent; this documentation update did not query production PostgreSQL or perform service or database actions.

## g diagnostics release: deployed successfully

The parent reported g activation SUCCESS at `2026-10-09 12:16:54 UTC+08:00`, with the transition journal COMPLETE and all six services active with zero restarts. This release deploys the reviewed closed-set RPC and execution-acquisition diagnostics; it does not establish successful execution retry or a completed business loop.

### Release and transition evidence

- Release: `/opt/address-radar/releases/address-only-stability-20261009g`.
- Release seal: `a6d1988feb6be935b329a1561073198aec1dd71dd52956f4477538477201d418`.
- Entry SHA-256: `f632a3b32534865d5d0b16f5a35731a85357fb5c0a67a1df649b4dcd8605bcf8`.
- Inventory: 5 entries, 1,225,448 bytes.
- Native verifier: `/var/lib/address-radar-maintenance-tools/native-preflight-20261009g/preflight.mjs`.
- Native verifier SHA-256: `b7900dd6b2ed676dd9e1cef19102dce50cbaa12b16cd05840c8bde2700246d23`.
- COMPLETE journal: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009g-state.json`.
- Journal SHA-256: `e6d77ed61c55ba6f29be6d09ab704996814d33b8df1de2a1df027837a05a4061`.
- Receipt: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009g-receipt.json`.
- Receipt SHA-256: `6c1778ed88117c04da252ec089f80fc0d68169caad4fdd87b03842b610011d2a`.
- Activation audit: `/var/lib/address-radar-maintenance-tools/configured-stability-20261009g/activation-complete-1791519402988.json`.
- Activation audit SHA-256: `1747f681c131e0eb1db1db3a41855fcf605d62e4e084133dbbf3dee8527285bc`.

Independent pre-activation read-only verification matched the actual metadata, entry and g verifier pins, recomputed the seal using the controller's encoding contract, and verified the healthy f COMPLETE origin without recovery authorization. Configuration remained equivalent to f apart from approved release, inventory and deployment bindings; the settings JSON remained separate from the verifier program. The activation outcome and new journal, receipt and audit hashes above were subsequently supplied by the parent, not independently queried for this documentation update.

### Reviewed diagnostic scope and gates

- Wallet RPC diagnostics expose only allowlisted origins, methods, categories and safe-integer codes, with a second projection at the channel log boundary. Local cooldown reports only `rpcOrigin: "local_cooldown"`; regression coverage verifies no network call during that early return.
- Execution acquisition exposes six fixed transport refusal reasons reused by the entry whitelist. Unknown reasons and valid-code prefixes carrying provider text or secret suffixes fall back to a fixed generic code; logs do not include provider messages, URLs or payloads.
- Independent reviews found no remaining P1/P2 in these diagnostic changes. No budget, cursor, fact-admission or business eligibility relaxation was identified.
- Parent-reported full gate: 3,585 tests passed, 107 skipped; all 18 type-check gates passed. Compiled/schema smoke tests passed, and the reported 272-module dependency graph excluded the unfinished, unconnected retry module. These gates were not rerun for this documentation update.

### Acceptance boundary

Available disk was reported as 5,518,614,528 bytes. No import was performed; global current remained unchanged. Gateway and FOMO remain false, and the existing `nativeFullRadar=false` boundary is not changed by this diagnostics release.

Ohm's post-g business acceptance is PENDING. Neither purchase success nor completion of the radar closed loop is asserted. Turing is developing the h execution retry path; independent review is pending a frozen implementation. The historical d failure, c restoration, e success and f incomplete business acceptance remain part of the audit timeline.

This documentation update performed no production queries, activation, service operations or database writes.

## g observed business acceptance: interrupted extended snapshot window

The parent supplied two snapshots for `2026-10-09 12:18:38` through `16:35:27`. The observation window was interrupted by the user and is explicitly not the planned 90-second acceptance interval. Counts below must not be interpreted as a controlled 90-second throughput measurement.

| Metric | Start | End | Observed change |
| --- | ---: | ---: | ---: |
| Captures | 260 | 653 | +393 |
| Normalized records | 254 | 653 | +399 |
| Tokens | 85 | 166 | +81 |
| Pending execution proofs | 83 | 347 | +264 |

The reported fact count remained 114 and purchases remained zero. Base diagnostics identified an actual HTTP `rate_limit`. BSC diagnostics identified JSON-RPC code `-32005` with `ambiguous_limit`; this is not evidence of a range limit and must not be reclassified as one. Base/BSC cursors did not advance. The Solana fingerprint changed; that observation alone does not establish successful execution-proof publication or a purchase.

All six g services were reported active with zero restarts, lock count zero, and available disk 5,497,745,408 bytes. `gateway=false` and global current remained unchanged; the prior FOMO and native full-radar restrictions remain in force.

The snapshots establish capture, normalization and token-count growth, but not a completed business loop: pending execution proofs increased and purchases remained zero. The planned bounded business acceptance is not marked PASS. Turing's h retry work remains in progress; frozen changes will receive independent specification and quality review before any release conclusion.

The h review will check explicit retry authorization and entry wiring; generation, activation and exact-target binding; reuse of immutable execution envelopes without signature renewal or fabricated authority; bounded shared request/time budgets and cancellation; safe lease ownership, queue fairness and uncertain-commit behavior; and closed diagnostics without provider text or secret leakage. Review evidence must distinguish actual retry acquisition/publication from merely recording demand or advancing counters.

These are parent-supplied observations. This documentation update performed no production PostgreSQL queries or other production actions.

## h execution retry release: deployed successfully

The parent reported h activation SUCCESS and journal COMPLETE at `2026-10-09 17:09:06 UTC+08:00`, with all six services active and zero restarts. Available disk was reported as 5,491,884,032 bytes. Business acceptance remains PENDING; operational activation is not evidence of a completed radar closed loop.

### Release and transition evidence

- Release: `/opt/address-radar/releases/address-only-stability-20261009h`.
- Release seal: `85952ceddf56a663f1f2c61b9aa8125c9c9819e9919fec16cca8a2450670b0d9`.
- Entry SHA-256: `99740e25f26a4052722bc023f79709d65c632027e4d6b9a642c61796c273f761`.
- Inventory: 5 entries, 1,248,948 bytes.
- Native verifier: `/var/lib/address-radar-maintenance-tools/native-preflight-20261009h/preflight.mjs`.
- Native verifier SHA-256: `6f580c327f88f2f8bea2269d69b9746ffb66474a5d4dbde2a652ce41ee6536b0`.
- COMPLETE journal: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009h-state.json`.
- Journal SHA-256: `218fabece2020bb3b4e7d4b3913a7f793ce53ab6712b576fa9b59742740d743d`.
- Receipt: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009h-receipt.json`.
- Receipt SHA-256: `70f545d72859b0ad1c9d44f7bae826e28c097753d6d39098b7b968691f2946e9`.
- Postcheck audit: `/var/lib/address-radar-maintenance-tools/configured-stability-20261009h/activation-complete-postcheck-1791537012212194213.json`.
- Postcheck audit SHA-256: `dc2932288c21e20eea5c8a577ea54a1cadc1fd903a2ac3781f846fa2c8e84f92`.

Independent pre-activation root verification matched the five metadata hashes, actual release seal, entry and new h verifier, healthy g COMPLETE origin, permanent original pins, and separately pinned settings JSON. The activation outcome and new transition hashes above were subsequently supplied by the parent; they were not independently re-queried for this documentation update.

### Runtime isolation and retry scope

The existing controller ABI uses one shared deployment pin. The shared deployment adds `executionRetry` with `maximumCaptures=1`, `maximumPayloadBytes=2097152`, and `maximumRunMs=5000`; it is not physically split into a wallet-only JSON file. Only the wallet-monitor branch constructs and executes retry. The other five services accept the shared schema but do not execute this path.

The existing wallet allocation is 24,000ms and the poll allocation is 30,000ms: wallet plus retry is 29,000ms, within the poll budget. Retry remains within the existing receiver allocation of 32 candidates, 2MiB and 5,000ms. Neither pacing nor sourceRetry is newly enabled. Existing floors and provider quota configuration remain unchanged.

Independent review closed the oversized-head/cumulative-prefix, continuous-append fairness, SQL deadline/drain, and two-byte page-container boundary findings. Retry uses committed captures and the existing execution receiver, producer, independent validator and publisher; publication requires a matching native acknowledgement. Old signatures are not extended, and cursor advancement is scheduling progress rather than a business-success receipt.

### Gate evidence and postcheck correction

- Parent-reported full gate: 3,634 tests passed, 110 skipped; all 18 type-check gates passed, with reference build and compiled retry schema positive/negative smoke tests passing.
- The targeted review report included 233 tests and three actual isolated PG16 boundary cases. The disposable fixtures exercised the production SQL, parameter inference, oversized metadata, legal byte prefixes and subsequent-page progress, within transactions ending in ROLLBACK; this was not production write testing.
- Huygens reported a production read-only EXPLAIN passing in approximately 45ms, including 13-parameter inference and runtime permissions, with a 3-second SQL timeout, 1-second lock timeout and ROLLBACK. No ANALYZE, RPC or business writes were performed.
- The first postcheck incorrectly required a service-owned deployment artifact to be root-owned and raised an assertion. Huygens subsequently confirmed the successful activation through read-only checks. Activation was not retried, and the original error audit remains retained; the postcheck assertion must not be described as an activation failure or silently erased.

These test and execution results are attributed to the parent and implementation owners; this documentation update did not rerun them.

### Acceptance boundary

No import or global-current change was reported. Gateway and FOMO remain false; the existing `nativeFullRadar=false` boundary remains in force. Post-h business acceptance, execution-proof recovery and purchase outcomes remain PENDING. No full-radar completion or successful purchase is claimed.

This documentation update performed no production queries, activation, service actions or database writes. Earlier d failure, c restoration, e success, and f/g business observations remain retained in this timeline.

## h observed business acceptance: retry executed, RPC acquisition unsuccessful

The parent supplied snapshots for `2026-10-09 17:13:10` through `17:15:38` (reporting timezone consistent with the preceding h deployment report: UTC+08:00). The observations confirm that retry executed, not that execution acquisition or the business loop succeeded.

| Metric | Start | End | Observed change |
| --- | ---: | ---: | ---: |
| Captures | 723 | 724 | +1 |
| Normalized records | 720 | 724 | +4 |
| Tokens | 178 | 179 | +1 |
| Pending queue jobs | 496 | 499 | +3 |
| Due queue jobs | 493 | 495 | +2 |
| Proof-unavailable count | 364 | 367 | +3 |

The fact count remained 114; all were reported expired, with zero currently valid facts and zero new h facts. Purchases remained zero.

The two reported retry samples contained 19 and 14 attempts respectively. All attempts were deferred, with zero publications. The reported diagnostic counts were `execution_rpc_response_error` 16 and 14 respectively, plus three budget refusals. No ACK failures were reported. These observations establish an active retry path but unsuccessful RPC acquisition; they do not establish a precise provider root cause, successful proof recovery, publication, or purchase.

All six h services were reported active with zero restarts, lock count zero, and available disk 5,491,666,944 bytes. `gateway=false` and global current remained unchanged. The existing FOMO and native full-radar restrictions remain in force.

Operational stability remains distinct from business acceptance. The closed loop is not accepted: valid execution facts and purchases remain absent while pending/due work and proof-unavailable counts increased. Turing is continuing precise RPC diagnostics and root-cause investigation without expanding retry allocations or scope. Further business acceptance requires actual acquisition, validated publication and downstream evidence; no such success is pre-recorded here.

These are parent-supplied observations. This documentation update performed no production queries, service actions, database writes or retry configuration changes.

## i safe RPC diagnostics release: deployed successfully

The parent reported i activation SUCCESS and journal COMPLETE at `2026-10-09 17:34:19-17:34:20 UTC+08:00`. All six services were reported active with zero restarts; available disk was 5,486,776,320 bytes. This is a code-only safe RPC diagnostics deployment, not evidence of new execution facts or business-loop completion.

### Release and transition evidence

- Release: `/opt/address-radar/releases/address-only-stability-20261009i`.
- Release seal: `df12c4804a4bfb8ca71b74bc585399b492fe6546c92654751f25c4e66f3b2ac6`.
- Entry SHA-256: `9e18df4795d79ad74b0648762bbf8c0a5995fe99e0883704ce04416d2228a55b`.
- Inventory: 5 entries, 1,253,794 bytes.
- Native verifier: `/var/lib/address-radar-maintenance-tools/native-preflight-20261009i/preflight.mjs`.
- Native verifier SHA-256: `10f940e9c6f53fbbc8bbb5999625221d7abe38598860ce696256e34b98926585`.
- COMPLETE journal: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009i-state.json`.
- Journal SHA-256: `7f37ddffa94c7d4a6d298a097c08bc0791813d3750ca777d13642199f0046bb7`.
- Receipt: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009i-receipt.json`.
- Receipt SHA-256: `7fabd4739983f082f54c770c6b270466d1944922b71e165ec2c42c1c558df63a`.
- Activation audit: `/var/lib/address-radar-maintenance-tools/configured-stability-20261009i/activation-complete-1791538446994.json`.
- Activation audit SHA-256: `0b6cdd76767c97d9d74ac4d5c774e7ead4d6f7c5c674ba7f4812c34e84a7557e`.

Independent pre-activation production read-only verification matched actual metadata, release seal, entry, new i verifier and environment bindings, and the healthy h COMPLETE origin. Configuration remained the same as h except release/inventory bindings. Permanent original pins and the separately pinned settings JSON remained unchanged; the template had a zero deadline and no recovery authorization. The subsequent activation result and new transition hashes above were supplied by the parent, not independently queried for this documentation update.

### Diagnostic scope and validation

The new `postgres_wallet_execution_rpc_failure` event projects only `event`, `chain`, `method`, `code`, `subcategory` and `reasonCode`. Methods are restricted to the four existing Solana acquisition methods; codes are safe integers or null, and categories/reasons are closed vocabularies. At most 512 characters of provider message are inspected in memory for classification; raw provider messages, endpoints, parameters and payloads are not persisted in these diagnostics.

Independent review closed the getter/serialization P1: producer and entry use own-data-property snapshots, reject accessors and proxies, ignore inherited fields, and serialize only validated primitives. Regression coverage includes changing getters, inherited values, unknown subclasses and malicious serialization hooks. No additional requests, connections, acquisition parameters, budgets, cursor, TTL or proof-policy changes were identified in this diagnostic patch. Capture and retry retain the same approved execution receiver/runtime wiring.

- Parent-reported full gate: 3,673 tests passed, 110 skipped; all 18 type-check gates passed, with reference build and compiled schema smoke passing.
- The final diagnostic targeted report was 287 tests and two type checks passing. The earlier h isolated PG16 evidence remains separate; it is not represented as rerun by the diagnostic-only command.

### Acceptance boundary

No new import was reported. Gateway and FOMO remain false, global current is unchanged, and pacing remains off. Shared retry configuration remains one candidate, 2MiB and 5,000ms, constructed and executed only by the wallet-monitor branch; sourceRetry is not newly enabled. The existing `nativeFullRadar=false` boundary remains in force.

Ohm's short-log acceptance and RPC root-cause determination remain PENDING. Successful deployment proves neither new facts nor successful acquisition, validated publication, purchases or a complete radar closed loop. Earlier observed acquisition failures are not marked resolved by shipping diagnostics.

This documentation update performed no production queries, activation, service actions or database writes. All preceding failure, recovery and business-acceptance evidence remains retained in this timeline.

## i diagnostic acceptance: Solana transaction-version acquisition blocker identified

The parent reported that 12 naturally occurring retry attempts were all deferred. The diagnostic log sample contained 14 occurrences of Solana `getTransaction` failure with numeric JSON-RPC code `-32015` and the closed subcategory `unsupported_transaction_version`. The retry-attempt count and log-occurrence count are distinct reported measurements; no one-to-one correspondence is assumed.

- Diagnostic receipt reference: `/private/tmp/address-only-i-execution-diagnostic-20261009T093702Z.json`.
- Identified acquisition blocker: the Solana transaction-version support path, not rate limiting, timeout or publication ACK failure in this diagnostic sample.
- Remediation status: NOT FIXED. Turing is preparing a minimal change aligning the advertised version support with actual decoder support and independent replay.

The forthcoming j review must verify the exact supported transaction versions, the actual decoder's handling of their transaction/account representations, and consistent version declaration and validation in independent replay. Raising the advertised upper bound without demonstrated decoder and replay compatibility is not an acceptable fix. Unsupported versions must continue to fail closed; diagnostic evidence alone grants no new proof authority or business eligibility.

The i deployment and diagnostics have identified a concrete acquisition blocker, not established successful recovery. New validated facts, publication, purchases and the complete radar closed loop remain unaccepted pending the reviewed fix and subsequent actual acceptance evidence.

This entry records parent-supplied findings and the receipt path only; the receipt was not independently read for this documentation update. No production queries, RPC calls, service actions or database writes were performed.

## Release j: activation completed; transaction-version evidence pending

Parent-reported production activation completed successfully on 2026-10-09 at 20:38:53-54 UTC+8. The journal is COMPLETE; all six services are active with zero restarts. Available disk space was 5,472,702,464 bytes. Reported gates: 3,714 tests passed, 110 skipped, and all 18 type-check gates passed. These activation and gate results were supplied by the parent, not rerun for this documentation update.

Before activation, an independent bounded root read-only review verified the actual metadata pins, sealed release inventory, entry, new j native verifier, separate unchanged settings JSON, and the healthy i COMPLETE origin. The measured release inventory contained five entries totaling 1,258,101 bytes.

| Evidence | Path | SHA-256 |
| --- | --- | --- |
| Release seal | `/opt/address-radar/releases/address-only-stability-20261009j` | `02bb2e23157bd6f289dff0387d98859fe04146bee52c3f8ece0ed49e6007dfda` |
| Entry | j sealed release entry | `982ee947891f68faa14156d70da6b1a210f673a6d03d243449d38a161ef6a1e0` |
| Native verifier | `/var/lib/address-radar-maintenance-tools/native-preflight-20261009j/preflight.mjs` | `ffe4b429eb41d8f73625ba2382896d35d4c07dfc82253155a04b85b4bd34ab17` |
| COMPLETE journal | `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009j-state.json` | `d8e416cd7cfba70d9a4dcfb5dabf1639174c9693d6062ca34caa073a3a7cb987` |
| Activation receipt | `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009j-receipt.json` | `167768aba3096a2614fbfa93bbe3494a1392081ecb4dbf7d3fcb8990de26c640` |
| Activation audit | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009j/activation-complete-1791549521463.json` | `e18e673e826a5930dd02c5f95231fe98a30423ed04d75091a041987d26379248` |

Release j adds bounded safe transaction-version diagnostics based on the exact serialized request body passed to fetch, together with reviewed legacy/v0 decoding compatibility. It does not raise the execution/replay supported-version ceiling. The observed capture declaration of version 1 versus execution/replay declaration of version 0 does not establish the version actually required by the failing production response. Natural production requested/required-version evidence remains pending; neither the `-32015` acquisition failure nor successful execution-proof acquisition is claimed fixed.

Configuration remains equivalent to i: execution retry is one capture / 2 MiB / 5 seconds in the shared deployment configuration, executed only by the wallet runtime branch. Provider pacing remains off and source retry is not newly enabled. No new import or global-current change occurred; gateway and FOMO remain disabled. Startup acceptance is complete, but business closed-loop acceptance and native full-radar completion are not established. The earlier d failure, audited c restoration, and subsequent e through i records remain preserved above.

## Release j follow-up: client-version mismatch confirmed; v1 remediation pending

The parent subsequently reported ten natural production diagnostic events with requested transaction version 0 and required version 1, with no publication. This supersedes the preceding pending-version-evidence status: the observed Solana acquisition failure is now attributed to a stale client transaction-version ceiling, not rate limiting. It does not reclassify unrelated Base/BSC backoff events. The event count and production diagnosis are parent-reported; this documentation update made no production query.

The [Solana Foundation transaction-v1 reference](https://github.com/solana-foundation/solana-dev-skill/blob/main/skills/solana-dev/references/transactions-v1.md) states that v1 activated on mainnet on 2026-09-15, requires numeric `maxSupportedTransactionVersion: 1` for RPC reads, uses inline account addresses without address lookup tables, and projects configuration under RPC `message.transactionConfig`. Its RPC fee field is `priorityFee`, distinct from the SDK's `priorityFeeLamports`; v1 configuration must not be inferred from ComputeBudget instructions. The Foundation's [transaction-v1 examples](https://github.com/solana-foundation/transaction-v1-examples) provide supplementary implementation examples.

The next source review must assess actual read-only v1 decoding, not merely a higher RPC parameter. Required checks include consistent numeric version 1 declarations in producer and independent replay; legacy/v0 regression coverage; rejection of unknown versions above 1 and malformed version/configuration shapes; correct inline account and instruction-index binding without v0 loaded-address expansion; and correct version-specific configuration interpretation. Existing signature, transaction/block identity, wallet ownership, independent proof, resource bounds, and business eligibility checks must remain intact. No transaction signing/submission capability or business-threshold change is authorized by this compatibility work.

Turing's v1 implementation is in progress and remains subject to independent source review, test gates, deployment, and natural production acquisition/publication acceptance. No completed v1 repair, successful RPC acquisition, new published proof, purchase, or full radar closed loop is claimed here.

## Release k: read-only v1 compatibility deployed; business acceptance pending

Parent-reported activation completed successfully on 2026-10-09 at 21:02:50 UTC+8. The journal is COMPLETE; all six services are active with zero restarts. Available disk space was 5,466,435,584 bytes. Reported gates: 3,875 tests passed, 110 skipped, all 18 type-check gates passed, reference build passed, and compiled v1 acceptance / v2 rejection checks passed. These activation and gate results were supplied by the parent, not rerun for this documentation update.

An independent bounded root read-only review before activation verified all five metadata SHA-256 pins and private permissions, the actual sealed inventory, entry and new k verifier, separate unchanged settings JSON, and exact j COMPLETE journal/receipt origin. The inventory contained five entries totaling 1,266,624 bytes. No production database query or service mutation was performed by that review.

| Evidence | Path | SHA-256 |
| --- | --- | --- |
| Release seal | `/opt/address-radar/releases/address-only-stability-20261009k` | `b39e31a80fc162f8e68a3cfb64d1f6503e4af17bc05aa32af57f39464421244f` |
| Entry | k sealed release entry | `c97de9b4f7461474a9dbdbb0db47f25e57c76d98e1cf8b25537059071e5c6de5` |
| Native verifier | `/var/lib/address-radar-maintenance-tools/native-preflight-20261009k/preflight.mjs` | `36fdd07e715ffec300d875c82028b893726fbc079079279b73bd2f7f3395f22d` |
| COMPLETE journal | `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009k-state.json` | `508c56671bf86b1d66fe40c9a2f455285bdaae70f1093a93216428c29a860072` |
| Activation receipt | `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-stability-20261009k-receipt.json` | `d2f327f538dbfc0dcd1029c8bd148b27db4af44945d87daa7dc6de1afb217712` |
| Activation audit | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009k/activation-complete-1791550958509.json` | `14a3e60ef9cd5f9668ec4ef5fad916b50317e81e24e9ae53721764e725fdf2eb` |

The j evidence remains the production diagnosis: ten natural events reported requested version 0 and required version 1, with no publication. That acquisition failure was a client-version compatibility mismatch, not rate limiting. The [official Solana upgrade reference](https://solana.com/upgrades/larger-transaction-sizes) documents numeric `maxSupportedTransactionVersion: 1` for reads, continued legacy/v0 support, v1 inline accounts without ALT, and RPC `message.transactionConfig` rather than ComputeBudget-derived configuration.

Release k deploys reviewed JSON read-only legacy/v0/v1 compatibility, with producer and independent replay consistently declaring numeric maximum version 1. V1 validation rejects unknown versions above 1, malformed configuration, duplicate or excessive inline accounts, ALT use, and invalid token-balance or outer/inner compiled instruction indices. Parsed address lists remain distinct from compiled numeric indices. Legal `innerInstructions: null` or omission is accepted; arrays remain strictly validated. Actual fee handling still uses `meta.fee`. The two review P2 findings (index bounds and legal null inner instructions) were closed before release. This adds no transaction signing/submission capability or must-signer business condition and does not alter proof requirements, TTL, budgets, or eligibility thresholds.

Configuration remains equivalent to j apart from release/pin/inventory bindings: retry stays one capture / 2 MiB / 5 seconds in shared configuration with wallet-only runtime execution; pacing remains off and source retry is not newly enabled. No new import or global-current change occurred; gateway and FOMO remain disabled. Deployment/startup acceptance is complete, but natural production v1 acquisition, proof publication, purchase outcomes, and business closed-loop acceptance remain pending. This record does not claim a completed production RPC repair or native full-radar completion. Earlier failed d activation and audited c restoration records remain preserved.

## Release k: production version repair and proof recovery verified; purchases still pending

The parent reported two production acceptance rounds on 2026-10-09 from 21:04:13 to 21:06:21 UTC+8. These observations supersede the preceding pending production-version-repair status: `-32015` and transaction-version-failure diagnostics disappeared, and execution-proof publication recovered. This documentation update did not independently query production.

| Observation | First snapshot | Second snapshot |
| --- | --- | --- |
| Execution facts | 129 | 145 |
| New k facts | 9 | 25 |
| Live valid proofs | 7 | 7 |
| Expired facts | 122 | 138 |
| Matching buys | 11 | 27 |
| Purchases | 0 | 0 |

The retry rounds reported 9/9 and 12/12 publications, all acknowledged, with no defer/failure reported. Total execution facts increased by 16 across the snapshots. These results provide natural production evidence that the client-version repair restored acquisition/proof publication; they do not establish successful downstream purchase consumption or a complete radar loop.

All six services remained active with zero restarts; observed locks were zero and available disk space was 5,458,427,904 bytes. Source captures remained at 896 and tokens at 204, with no increase during this window. Independent Base/BSC rate-limiting issues remain unresolved. Gateway remained disabled and global current remained unchanged.

Purchase acceptance remains open. Turing is investigating fresh-proof adapter predicates and consumer due scheduling. No TTL root cause, TTL change, or eligibility relaxation is assumed from these snapshots. Existing live/expired counts alone do not explain the missing purchases. Business closed-loop and native full-radar completion are not claimed.

## Release k follow-up: scheduling delay demonstrated; complete predicate validation outstanding

The parent reported a subsequent read-only production sample with a fresh proof aged 1.9 seconds and approximately 58 seconds remaining. Checked tuple, authority, time, and profile bindings were consistent; the payload was 308,570 bytes, below the configured 2 MiB limit. The associated job was pending and unleased, overdue by approximately 82.7 minutes, with 215 items ahead of it and quota 1. Acknowledged proof publication did not wake purchase processing. These observations demonstrate a scheduling-delay case, not a complete single-cause diagnosis.

Cryptographic validation, result-page behavior, and current-profile validation have not all been completed for this sample. It must not be described as passing every adapter predicate, and proof freshness alone does not authorize a purchase.

Turing is preparing a bounded fresh-fact-driven readiness hint within the existing automation claim path to select same-subject purchase work. Review must verify that the hint affects scheduling only: full adapter validation remains mandatory; generation/subject bindings remain intact; lease acquisition stays atomic with existing exclusion semantics; quota and fairness guarantees remain unchanged; and sustained fresh arrivals cannot starve other eligible work. SQL review must assess bounded scans, appropriate indexes, and duplicate-fact handling without inflating candidate or lease counts. Readiness hints must never become trusted validation results or purchase acknowledgements.

The intended change grants no new business writes to wallet or publisher components and introduces no TTL change, migration, or bridge. Scheduling remediation and downstream purchase acceptance remain pending. Production business closed-loop completion is not claimed.

## Release l: readiness-aware purchase scheduling deployed; purchase acceptance pending

The parent reported controlled activation SUCCESS on 2026-10-09 at 21:55:37-38 UTC+8. All six services were running with zero restarts. Reported gates for the final scheduling source were 3,886 tests passed / 110 skipped, 302 targeted tests, eight isolated PostgreSQL scenarios plus a two-connection competition check, and all 18 type-check gates with build/smoke checks passing. These execution results were supplied by the implementation/deployment owners, not rerun for this documentation update.

The scheduling change adds fresh-fact readiness hints to the existing automation purchase claim path. Exact subject matching occurs before capture truncation. Qualified facts are deterministically deduplicated by generation/kind/subject before fact count and byte windows; capture and generation-binding semijoins prevent duplicate intent fanout. Capture timestamp matching no longer casts the indexed capture timestamp to text. JSON casts retain explicit byte guards.

Independent source review closed the same-time backlog and duplicate-hint crowding findings. Hints confer no validation authority: complete factual purchase-adapter validation remains mandatory, with existing proof, ownership, generation, and business eligibility checks. Claims retain single-statement row locking, SKIP LOCKED, owner/expiry/claim-generation fencing, original quotas, and alternating readiness/FIFO turns. The implementation owner reported that the second connection skipped the locked candidate and the final lease was acquired once with claim generation 1. No new wallet/publisher business-write permissions, TTL change, migration, or bridge was introduced.

The final exported claim SQL SHA-256 was independently checked as `7122b9f417d4ed862c2569b241ea8b24a8fbaa1283fb4d115e4fd9fbd3fa3a26`. Huygens reported actual automation-role ACL checks passing for nine SELECT tables and four existing job UPDATE columns, and four read-only plans showing fact uniqueness before LIMIT/bytes and no capture/binding fanout. Its evidence receipt is `/var/lib/address-radar-maintenance-tools/ready-purchase-dedup-readonly-1791553637448466464/receipt.json`, SHA-256 `edd6ccf965a3615700657711086c07f57922cc5d40e667e4bcdb713b23a00972`; that receipt was reported, not independently reread by this reviewer.

Before activation, independent bounded root read-only verification matched all five l metadata pins and private permissions, recomputed the release inventory, verified entry/new l verifier and separate unchanged settings JSON bindings, and confirmed the exact k COMPLETE journal/receipt origin. The inventory contained five entries totaling 1,274,891 bytes. Configuration was identical to k except release/pin/inventory bindings; deadline was zero, with no recovery authorization. Controller, native node, and permanent original pins were unchanged. Parent-reported current process identities were not independently remeasured in that review.

| Evidence | Path or identification | SHA-256 |
| --- | --- | --- |
| Release seal | `/opt/address-radar/releases/address-only-stability-20261009l` | `5e46a87f0b3cfbf0bbae6b38f55a7848f87e5d6e7097ba613d28afc8d99951e1` |
| Entry | l sealed release entry | `c8fd9605bbab4620819fb5774d6ac7fec69858fde1904bfb19c36fa826420938` |
| Native verifier | `/var/lib/address-radar-maintenance-tools/native-preflight-20261009l/preflight.mjs` | `349cb3e2237889664231260b2d7359c913597c757e083a59227c8a284e9bfc80` |
| Authority | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009l/authority.json` | `02716f0df8b504cbffaaf3c4c93272d47902c9c1f7dcd1f267b621ecbeaaa910` |
| Deployment | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009l/deployment.json` | `50f38fe2482c1210204f995a2d8496c328737f8e1207bc77fee89e7a779495cf` |
| Environment | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009l/environment.json` | `c24d26a19cfa9960c4b57a0f3ed686d9bae1629a11f8ec128221a345c6dc6519` |
| Request template | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009l/request-template.json` | `e0704e824deda208aaf707163969f5af1eeab1724c6f4c01dd288527754da16f` |
| Preparation | `/var/lib/address-radar-maintenance-tools/configured-stability-20261009l/preparation-complete.json` | `4d78fec403327071f285e1683ea40fc298b69f4970184fb4d60f3cb1f6a3f1a9` |
| Activation journal | Parent-reported l activation journal | `7b104397d748aac85ad6c93ed271c6331151acf3038467fa25aed423526d9bbe` |
| Activation receipt | Parent-reported l activation receipt | `4253314975c39c6f95390d61ec5a444e0de479372ea88727bdc771afda2cafe0` |
| Activation audit | Parent-reported l activation audit | `4899840166843b8f64506ab880f363efdb0a3ed0c5d3ff1e648f3d9a4b52ec45` |

### Residual performance and acceptance boundaries

The reported 33-34 ms plan timings are planning times, not measured execution times. Timestamp matching remains a JoinFilter; join/sort and estimated sequential scans of approximately 904/913 rows precede LIMIT. Neither LIMIT nor EXPLAIN proves a bounded number of scanned rows. Fact representative selection and capture matching can become more expensive as history/backlog grows. Release review accepted this residual scaling risk at the current scale under unchanged statement/lock budgets; timeouts bound failure duration, not successful scheduling latency. No production EXPLAIN ANALYZE was performed by this reviewer, and budgets must not be increased to conceal regression.

Gateway/FOMO remain disabled and pacing remains off under the unchanged configuration. Purchase acceptance is awaiting Ohm's production observations. Startup success and source review do not establish that purchases now succeed, that all downstream predicates pass, or that the full radar loop is complete. The previously verified k version repair and proof recovery remain distinct from this still-pending purchase outcome. Earlier d failure and audited c restoration records remain preserved.

## Release l: purchase acceptance passed; downstream radar loop remains incomplete

Ohm reported natural production acceptance on 2026-10-09 from 21:57:17 to 21:59:36 UTC+8. Purchases increased from 6 to 10, token watches from 208 to 211, and execution facts from 494 to 510. All six services remained at zero restarts, observed locks were zero, and gateway delivery remained disabled. These owner-reported production observations supersede the preceding pending purchase-acceptance status: purchase consumption and token-watch progression are now demonstrated. This documentation update made no production query.

A follow-up snapshot at 22:00:34 UTC+8 reported 12 pending opportunities, including nine with `missing_valid_peak`, and seven pending capability jobs, including one with facts unavailable. No signal rows were present. Price, source, and safety integrations remain unwired, so successful purchases do not establish an opportunity-to-signal or delivery closed loop.

The next stage is a minimal price vertical slice: wire the existing bounded price acquisition/receiver and factual peak path into the configured runtime, then independently validate fresh generation/subject-bound price evidence and downstream opportunity consumption. Source and safety prerequisites remain separate open gates; they must not be defaulted to success or bypassed to manufacture signals. Gateway remains disabled until its own authorized acceptance gates are satisfied.

Base/BSC checkpoints remain unadvanced under external provider backoff, independently of the demonstrated Solana version/proof and purchase-scheduling repairs. No release-l execution-time benchmark or performance-latency guarantee is claimed. Read-only EXPLAIN planning timings and count-limited result windows do not establish bounded execution work; the earlier join/sort scaling risks remain open under unchanged statement/lock budgets. Native full-radar completion is not claimed.

## 2026-10-10: price wiring authorized for local implementation only

The user authorized Ohm to implement and test source/policy-independent price wiring. Production price acquisition remains disabled pending confirmation of the core source and tolerance policy. This authorization does not permit staging, deployment, production enablement, policy-key approval, or invented independence defaults.

The initial scope is a single-sample vertical slice, not complete market coverage or a completed radar loop. Independent review will begin after Ohm freezes the implementation. Required gates are default fail-closed behavior; complete authority and independence validation without bypass; genuine bounded acquisition and factual evidence without fabricated facts or acknowledgements; and regression protection for the existing production execution path. Missing or unapproved source, policy, authority, independence, or tolerance prerequisites must not default to success.

Implementation, tests, and source review are pending; no price enablement or successful price-driven production outcome is claimed. Gateway remains disabled under the existing production configuration. No stage/deploy action was performed for this documentation update.

## 20261010a post-deployment acceptance: sustained progress not demonstrated

The reported read-only snapshots at 2026-10-10 10:45:51 and 10:48:07 Asia/Shanghai show no increase in capture (1203), purchases (605), token watches (243), or execution facts (2941). Post-activation execution facts and live proofs were both zero. The sustained business-progress acceptance gate did not pass, despite successful deployment and service readiness.

Each retry observation window recorded nine attempts, zero published, and nine deferred with `execution_rpc_provider_budget_unavailable`. Solana diagnostics included `rpc_rate_limited` and `unknown_failure`, approximately 46 seconds of cooldown, and usage 1/60. These observations do not establish exhaustion of the per-minute allowance; operational refusal and cooldown must not be relabeled as minute-budget exhaustion. Base/BSC remained in the same backoff state; this window provides no evidence of a new regression there.

All six services remained running with NRestarts=0 and zero locks. Gateway delivery remained false; price count was zero and production price remained disabled. Reported disk availability was approximately 4.356 GB. Source approval remains missing. Deployment success is retained, but sustained progress is unproven and the full radar closed loop must not be reported complete.

Owner-provided evidence receipts: `/private/tmp/address-only-20261010a-acceptance-20261010T024551Z.json` and `/private/tmp/address-only-20261010a-acceptance-20261010T024807Z.json`. This documentation update did not independently query production or rerun acceptance.

## Follow-up diagnostic evidence: source cooldown, cause not fully resolved

The parent reports source cooldown of 24.867 seconds, active count zero, and effective-window usage zero; replay cooldown, active count, and effective-window usage were all zero. Together with collector rate limiting followed by execution retry budget refusal, this is strong evidence of source cooldown as the immediate operational blocker rather than exhausted quota or an occupied lease. It does not identify the originating RPC method, distinguish HTTP from JSON-RPC rate limiting, or explain the unknown failure category. The root cause is not fully resolved.

Turing's next scoped change is closed-set diagnostics identifying refusal stage, allowlisted method, and source/replay role while preserving existing reason compatibility. Independent review will check that logs exclude secrets, URLs, response bodies, raw messages, and transaction signatures; that unknown inputs remain closed and safe; and that diagnostic volume is controlled. Scheduling, quotas, cooldown behavior, and business semantics must remain unchanged. Source review awaits the frozen patch; no approval or deployment of that patch is implied by this evidence update.

## 20261010b diagnostic deployment complete; progress recovery not established

The parent reports successful controlled activation of `20261010b` at 2026-10-10 11:08:42-43 Asia/Shanghai, with all six services running and NRestarts=0. The reported final test gate passed 3950 tests. This documentation update did not rerun that gate or independently inspect activation health.

Deployment evidence pins:

- Journal SHA256: `7f6143260c841cbef00126235b1fe19a34da1bbd2c3ad18ef4a83a8b8cc1a5a5`.
- Receipt SHA256: `d625b80eea5daead8b22cbd2f5716d841aba76e1402c357f599531166d789fd2`.
- Audit SHA256: `a2e500738a784c3e6112d5aa08de6c883f67350a2705a05d097f74314e2411d8`.
- Release seal SHA256: `a156afb0baae951dc7378411f2d880ba9ec123170428661e37820a1aeb5692a6`.
- Entry SHA256: `bf88fad86285556442e224072cb57d1eee270cea4f29e34b4c2e53624117844e`.
- Native verifier SHA256: `3e8eed4d66c1cf3bec602e04e3c0beaeb8912829ecdd4eb50ca36ecf4d0172ba`.

The independent pre-activation root combination review passed: all supplied metadata pins matched, the release seal was recomputed for five entries and 1334147 bytes, and the origin referenced the actual a COMPLETE journal and receipt. Differences from a were restricted to approved artifact identity, pins, and inventory binding. Business budgets and TTL remained unchanged; inventory bytes are not a business processing budget. Deadline was zero, no recovery authorization was present, and settings JSON remained separately pinned from the native verifier. Production price, gateway delivery, and FOMO remained disabled.

This release deploys closed-set RPC diagnostics, not a scheduling, quota, cooldown, or business-progress fix. Ohm's natural-poll acceptance is in progress to establish the actual refusal cause. Deployment and test success do not demonstrate restored publication or sustained business progress, do not resolve the earlier a acceptance failure by themselves, and do not establish the full radar closed loop. Source approval remains missing. No production action was performed for this documentation update.

## 20261010b natural-poll acceptance: external HTTP 429 observed

The parent reports two production observations at 2026-10-10 11:12:29 and 11:14:19 Asia/Shanghai. Capture remained 1203, execution facts 2941, purchases 605, token watches 243, price zero, and pending proof 31. There was no business increment; sustained progress recovery remains unverified.

The new observer identified a Solana source `getSignaturesForAddress` request receiving HTTP 429, with transport `http`, subcategory `rate_limit`, and code null. Subsequent `getSignaturesForAddress` and `getGenesisHash` attempts were refused locally due to cooldown without fetching. This establishes an external HTTP rate-limit response and the subsequent local cooldown refusal path for these observed attempts, not a complete explanation of every failure.

Reported source cooldown was 12.727 seconds, with effective-window usage zero and active count zero; replay cooldown, usage, and active count were all zero. An initial active count of one subsequently returned to zero, and released leases increased from 56209 to 56211. These observations do not establish a lease leak or exhausted local quota. Some unknown failures remain unattributed; the evidence does not prove a pacing defect and does not authorize quota expansion or clearing cooldown.

Evidence receipt: `/private/tmp/address-only-b-two-snapshot-acceptance-20261010.json`, SHA256 `ed4a15225e1802412d389863635e5c6a9d97120bdec335ed6a9509da16877a79`. These are owner-provided production observations, not independently rerun by this documentation update. Production price remains disabled, source approval remains missing, and the full radar closed loop remains incomplete.

## Root-cause update: user-confirmed Helius credit exhaustion

The user confirms that Helius credits are exhausted. This trusted user fact supersedes the earlier unresolved quota-versus-RPS interpretation of the observed source HTTP 429; it must not be confused with exhaustion of the local provider request budget. Usage investigation has stopped. No credits are being purchased and no Helius account rotation is authorized.

The parent reports checking the official PublicNode page, `https://solana.publicnode.com`, identifying the Allnodes public Solana RPC endpoint `https://solana-rpc.publicnode.com`. A legitimate replacement source service is under evaluation, retaining official Solana independent replay and the existing overall allowance of 60 requests per minute with concurrency one. This is not a workaround for the original service's quota. Huygens and Turing are analyzing immutable replacement-source authority and provider-contract audit requirements only; no source switch has occurred. Public RPC is best-effort, not a stable SLA, and cannot support a promise of full closed-loop availability.

For price work, the parent reports actual Gecko candles, but market capitalization remains null. An independent RPC trade path is still being designed. Actual trade evidence must not be substituted for or represented as a candle high; candle peaks and execution prices retain distinct semantics. Unknown market capitalization must remain unknown, not be replaced with FDV or guessed supply. Production price enablement and full closed-loop acceptance are not established by these observations.

This update records user and parent-provided evidence; it did not perform further usage probes, independently browse the provider page, change provider authority, or operate production.
