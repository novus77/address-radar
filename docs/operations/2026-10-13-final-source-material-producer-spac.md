# Final Source Material Producer SPAC and Implementation Plan

**Goal:** Prepare final, reviewable source materials using the real source plan and production material validator, without activation, authority renewal, credential rotation or execution deadlines.

**Architecture:** A pure TypeScript generator performs semantic validation and renders exact file bytes. A root-only Python CLI loads a pinned existing assembler reader and invokes a pinned standalone generator through a bounded process group. The CLI verifies actual protected dependencies and sealed staged release, writes one exclusive directory, and publishes a durable review receipt last.

**Tech stack:** TypeScript, Node ESM standalone bundle, Python standard library, Vitest, disposable offline Linux root container.

## Exact scope

Create only:

- `docs/operations/2026-10-13-final-source-material-producer-spac.md`: requirements, authority boundaries and execution plan.
- `scripts/produce-final-source-material.ts`: pure generation and bounded stdin CLI used as a standalone bundle.
- `scripts/prepare-final-source-material.py`: protected preparation orchestration and exclusive durable output.
- `scripts/test/produce-final-source-material.test.ts`: real-plan semantic success and refusal regressions.
- `scripts/test/prepare-final-source-material-native.test.py`: real protected reader, bundled generator, existing validator and final preparation composition.

Do not modify executor, assembler, validator, source-plan implementation, existing fixtures, deployment configuration or business code. Temporary bundles are build artifacts under `/private/tmp`, not repository changes. No Git, SSH, production access or deployment is authorized.

## Safety and authority contract

The input envelope has protocol `address-only-final-source-material-inputs-v1` and exact fields: `protocol`, `transitionId`, `walletServiceUser`, `runtimeAuthority`, `sourceInput`, `review`, `approvalEvidence`, `currentPins`, `stageReceipt`, `origin`, `node`, `generator`. All file references are explicit canonical path/SHA256 pairs. `currentPins` contains exactly authority/deployment/settings/environment. `origin` contains exactly oldState/originalManifest/configuredOrigin. The nested configuredOrigin has the existing executor fields journal/receipt/releaseRoot/node. Degraded or restored recovery extensions are excluded from this initial preparation path, as in the healthy source-origin capture ABI. The requested new directory must be directly below the maintenance root, named `final-source-materials-<identifier>`.

The separate root-protected approval evidence must already exist. Its protocol is `address-only-final-source-material-approval-v1`; exact fields are protocol, purpose, approvalRef, generationId, trustedReviewSha256, replacementSha256, validFrom, validUntil, revoked. Purpose is `source_material_preparation`, revoked is false, and the validity interval must contain the real observation time. References and hashes must match the actual reviewed source plan. This is an input contract for externally reviewed evidence, not a new authority issuer. A root pin alone does not prove an external approval process. No production evidence has been supplied or accepted in this task.

The separate review must equal input.review. Actual current files must equal input.material. Recompute `createSourceReplacementPlan`, including its reviewed-provider seed hash; never accept guessed replacement hashes. The review importedAt must not be in the future or older than the existing import maximum lag of 86400000 ms. Publisher trusted keys are preserved exactly and are never required to contain time fields. Read the independently pinned existing runtime-authority document already consumed by the source probe (approvalRef, target and validators). Bind its unique execution configuration to authority.validator, the exact publisher trusted-key fields (validatorId/keyId/publicKey/actorId/authorizationRef/reviewedSourceProviders), and the preflight settings validator importId/sourceFingerprint. Recompute that fingerprint using the existing runtimeAuthorityFingerprint with validator_authority scope. Only the independent configuration supplies importedAt/validFrom/validUntil; require the existing probe coverage of now + validationTtlMs + 5000, and check runtime document approvedAt/expiresAt when supplied. Missing evidence refuses. This metadata check does not claim current DB revocation or ledger validity; native preflight remains mandatory. Source/replay bindings, private references, keys, TTLs, quotas, budgets and all evidence timestamps remain unchanged.

Production generation remains exactly `production-20261006-v1`. The immutable original manifest retains the fixed production database/schema/system identifier. Keep immutable waiting state/manifest separate from the currently configured COMPLETE journal/receipt/release. The waiting state must bind the original manifest through its base-serializer hash and measurement.binding. The configured checkpoint follows validate_configured_origin: COMPLETE/no pending, exact pinned receipt, distinct prior and next transitionIds, same original operation/generation/import, configured_pending_observation, databaseImported true, newImportPerformed false, businessReleaseSwitched true, monitoringCompleted false, businessEligibilityGranted false and disabled safety flags. Derive the current manifest by replacing only the immutable release hash with the configured receipt release hash; bind its base-serializer hash to both newManifestSha256 values. Bind configured node hash, wallet identity and original commit measurement. Current material must match the configured release/root/cutover, not the old waiting release. The staged next release must differ from both. These are metadata bindings only, not live readiness, ledger or healthy-origin proof.

Stage receipt must be CODE_STAGED_ONLY and stageOnly true. Its actual authorizationRef binds the source preparation approvalRef, and its actual transitionId binds the separately supplied next transitionId. Neither is equated to the immutable manifest operationId; all three may legitimately differ. Its permanent oldState/originalManifest and nativeNode pins must match the supplied pins. Verify the actual staged release with the existing ProtectedReader release verifier. Preserve the original cutover manifest except the release hash allowed by the existing validator.

## Allowed transformation and bytes

Start exclusively from `createSourceReplacementPlan(input).material`. Apply only changes already accepted by `validateProductionSourceMaterial`: authority.releaseSha256, deployment.releaseRoot, cutover.addressOnly.releaseSha256, environment RELEASE/ENTRY hashes, and authority/deployment/settings FILE/SHA references. Do not add unrelated fields or rebind credential/key paths. Do not compute new execution deadlines, modify source importedAt, rewrite review timestamps, renew approval, change scheduling, business thresholds or runtime resource policy.

Render authority.json, deployment.json and settings.json first, using UTF-8 JSON plus newline. Hash those actual bytes and bind their final paths into environment.json. Render and hash environment.json. Run the real production material validator against the resulting objects and actual final pins. Emit a review-receipt.json with source input pins, stage/origin/evidence pins, final file pins, source-plan public summary and explicit PREPARED_NOT_EXECUTED, activationPerformed false, productionProof false, ledgerVerified false, retryAuthorized false. Never include raw keys, credentials, input bodies or exception text in stdout or receipts.

## I/O, race and failure contract

Reuse the existing assembler's ProtectedReader without changing it; load its sibling source from an explicitly supplied SHA256 after bounded protected bootstrap validation. Validate JSON at 512 KiB, generator at 128 MiB, Node at 256 MiB; retain the reader's unique 384 MiB, cumulative 1 GiB and 30-second budgets. Child stdin and stdout are streamed, capped at 2 MiB, with an independent process group, a bounded run timeout and bounded kill/reap cleanup. A residual child group refuses success.

Recheck Node and generator around invocation. Revalidate all dependencies, waiting/configured origin/current/runtime-authority/evidence pins and staged release before directory creation and again before publishing the review receipt. Check actual current evidence time at both boundaries. No claim of a global atomic snapshot is made; the later executor must still revalidate final input pins.

Create the output directory exclusively at mode 0700; files use O_EXCL/O_NOFOLLOW and mode 0600. Fsync each file, output directory and maintenance parent. On failure retain incomplete artifacts without a completion receipt; never delete/reuse/overwrite an existing attempt. The emitted receipt is a preparation artifact, not execution authorization. Stdout returns only receipt pin and closed status. No database, HTTP, RPC, systemctl, import, source acquisition or activation port is constructed.

## Implementation and acceptance sequence

- Write pure tests first and confirm failure because the producer module is absent. Test closed metadata bindings, valid generation, current evidence, exact final file hashes, unchanged input/current material and unchanged private references/TTL/budgets.
- Implement pure generator and bounded stdin entry in one implementation phase. Use real `createSourceReplacementPlan` and `validateProductionSourceMaterial`; do not reimplement plan hashing.
- Implement protected Python CLI in that same phase, including sibling reader pin, child limits, release checks, dependency revalidation, independent freshness checks and receipt-last durable exclusive publication.
- Build the actual generator bundle using local esbuild and run targeted Vitest. Type-check the new TypeScript boundary with the existing script project when practical. Do not claim broad release gates from targeted checks.
- Run a new native test in an existing disposable Linux root image with `--network=none`, read-only host repository and bundle mounts. Reuse the existing synthetic native fixture only as input construction; do not mock ProtectedReader or either TS semantic boundary.
- Demonstrate real protected CLI -> bundled generator -> real validator -> final files/receipt. Revalidate generated final objects through the unchanged validator; cover collision, expired evidence and changed current source metadata with no success receipt.
- Report actual test results and any newly introduced issue. A new bug requires human approval before corrective changes. Independent review follows implementation; no production invocation is included.

## Acceptance limits and genuine outstanding authority

All native metadata, approvals, COMPLETE state and release module contents are explicitly synthetic fixtures. Container paths use fixed production identity only inside disposable isolation; no live database ledger, provider approval, production capacity, healthy services or production release acceptance is proven. Real current protected inputs, externally reviewed non-expired preparation evidence, actual stage/origin pins and later execution authorization remain outstanding production gates. Missing evidence blocks preparation, not permission to create approval or fake current time.

## Approved contract corrections (implementation follow-up)

The human approved the three initial review findings: separate immutable waiting and configured origins, use exact stage field meanings, and move validity out of publisher configuration. The implementation and synthetic fixtures now target these corrected contracts. Tests must include different waiting/current/staged releases, different stage approval/next transition/old operation values, unchanged publisher keys without time fields, and expired independent validator-import rejection. Final test results are reported separately; this document does not assert unexecuted checks passed.

## Approved standalone and evidence-hash follow-up

The independent validator/import configuration must contain evidenceSha256 as a lowercase 64-character hexadecimal digest. Missing or invalid values refuse even when settings sourceFingerprint and replacementSha256 have been recomputed consistently using the real existing fingerprint and source-plan functions. Publisher trusted-key configuration remains unchanged.

Use buildAddressOnlyMaintenanceModule from scripts/build-address-only-compiled-release.mjs for standalone artifacts. Its existing library plugin now explicitly suppresses imported validate-production-source-material and produce-final-source-material CLI guards, while keeping the selected entry CLI active. The existing CommonJS compatibility banner, native-pg refusal and external-dependency checks remain in force. Do not use a plain esbuild ESM bundle for this entry.

Host test artifacts use seal:false and unique new temporary output paths. The offline root fixture copies the actual artifact into root-owned protected paths at mode 0444 and rehashes the bytes. Host unsealed output is not a production deployment artifact. Dedicated builder regressions require exactly one selected-CLI refusal output and silent library import without launching either imported CLI. Native regressions cover successful protected preparation and missing/invalid independent evidence hashes with synchronized fingerprints.

## Engineering acceptance record: 2026-10-13

The approved origin/stage/independent-validator contracts, imported CLI isolation, evidenceSha256 validation, and canonical test launch correction are implemented. Fresh verification completed: targeted tests 103 passed; dedicated producer type check passed; reference build and configured engineering type checks passed; full Vitest 4,369 passed / 206 skipped; compiled smoke tests 68 passed; real offline protected preparation composition 6 passed. Independent review found no remaining defects in the reviewed implementation and final correction.

Engineering acceptance is complete for this producer scope only. No production invocation or deployment was performed. Actual valid external evidence, live origin/ledger readiness, final runtime execution and production closed-loop acceptance are not proven by synthetic isolation and remain required before claiming overall completion.
