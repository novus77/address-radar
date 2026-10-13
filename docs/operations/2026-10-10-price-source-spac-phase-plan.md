# Price and Source SPAC / Phase Plan

> For agentic workers: use subagent-driven-development or executing-plans for the authorized local implementation. Ohm owns implementation; independent spec/quality review follows each freeze. This document is a requirements and acceptance plan, not production enablement authorization.

**Goal:** Establish a truthful, fail-closed, single-sample price vertical slice without weakening execution evidence, independence, policy, or business eligibility.

**Architecture:** Supply explicitly constructed price-authority dependencies to the existing configured entry path. Preserve the independent validator, distinct publisher connection, native preflight, bounded provider execution, and ordinary factual adapter validation. Missing prerequisites defer rather than manufacturing usable prices or acknowledgements.

**Tech stack:** TypeScript, existing PostgreSQL business adapters and bounded transports, Vitest, isolated PostgreSQL fixtures where database behavior is exercised.

## 1. Status and scope

| Component or outcome | Status | Meaning |
| --- | --- | --- |
| Native price dependency factory | Completed and independently reviewed | `scripts/postgres-price-authority.ts` assembles existing validator/publisher dependencies; available means assembly only. |
| Factory tests | Owner-reported 335 targets and type check passed | Assembly tests mock downstream factories; they do not prove native identity, independence, or production acquisition. |
| Entry integration of this factory | Not wired | Ohm's next authorized local task; no deployed root dependency assembly is claimed. |
| Production price acquisition | Disabled | Remains disabled pending core-source and tolerance-policy confirmation and later explicit enablement gates. |
| Single-sample isolated integration | Pending | A bounded test of the real component chain, not comprehensive market coverage. |
| Execution/proof and purchase recovery | Observed in production | Earlier k/l observations are recorded in the stability timeline; preserve these working paths. |
| Price/source/safety-to-signal closed loop | Not complete | No successful price-driven production opportunity/signal or full-radar completion is claimed. |

Scope is internal radar evidence and observation only. This phase does not authorize transaction construction, trading, transaction signing/submission, external delivery, gateway/FOMO enablement, migration, policy provisioning, key approval, or production writes. Validator attestation signing is not transaction signing and still requires its complete existing authority contract.

## 2. Required semantic contract

### Execution-derived entry price

A true entry-price claim must be derived from the actual successful execution and its verified acquired token quantity and paid quote amount, with the applicable quote currency and valuation basis explicit. A spot quote, candle open/close/high, current market price, or guessed USD conversion is not the execution entry price. Existing nominal-stablecoin execution estimates must retain their estimation/basis labels; this phase must not relabel them as exact USD prices. Execution fees must retain their existing accounting semantics and must not be silently counted twice or replaced with a price-provider fee/configuration field.

### Candle peaks

A peak must come from actual approved-source evidence for the correct chain, token, pool, token side, timeframe, and aggregate. Use closed post-purchase candles, bound their window and payload, preserve timestamps/revisions, and bind each result to the exact sample and execution fingerprint. A candle high is an observed interval high, not an executable fill price. Incomplete bounded observations cannot prove exhaustive coverage, a non-hit, or the absence of a higher peak. Do not synthesize candles, interpolate missing highs, or substitute live spot prices to force a peak.

### Source independence, conflict, and tolerance

Different URLs, hosts, credentials, provider IDs, or API brands alone do not establish independence. The existing validator requires current explicit approval, operator/data-platform independence, mapping/source pins, and an approved consistency policy. Static reviewed bindings are not that approval.

Conflicting observations must not be silently averaged, cherry-picked, or resolved by whichever source allows the desired outcome. Defer unless a current explicitly approved policy resolves that specific comparison. Do not introduce arbitrary percentage/absolute tolerances, infer tolerance from historic deviations, or treat missing tolerance policy as zero-tolerance approval. The existing `exact_closed_candles_v1` policy check does not itself approve that policy for production; retain it without substituting a guessed permissive policy.

The factory's `available` result means compatible dependencies were constructed. It does not mean a source/policy was approved, native preflight passed, a candidate was validated, facts were committed, or a consumer acknowledged them.

### Unknown liquidity

Where eligibility, source suitability, or safety requires liquidity evidence, unknown, stale, unverified, or unbound liquidity must defer the dependent decision. Do not convert unknown liquidity to zero, infinity, sufficient liquidity, or an approval. Missing liquidity does not justify inventing a usable market-depth or executable-price claim. Separate storage of bounded raw observations must not imply downstream eligibility.

### Market capitalization

Market capitalization is not FDV. Any market-cap claim requires an approved price basis and authoritative, correctly scoped circulating-supply evidence at the relevant time, with provenance and numeric bounds. Do not guess supply, use maximum/total supply as circulating supply, relabel FDV as market cap, or copy execution notional into market cap. If the required basis is absent or conflicting, preserve unknown and defer decisions that require market cap. No supply-estimation subsystem is included in this phase.

## 3. Invariants and authority controls

- Missing price configuration, approval port, current approval, mapping, independent source, consistency policy, or required dependency stays fail-closed.
- Factory pins bind generation/activation, mapping/source configuration, one matching validatorId/keyId, actorId, authorizationRef, all replay providers, and equivalent Ed25519 public keys by SPKI DER.
- Native identity/ACL refusal exposes only closed reason codes, not connection strings, keys, raw exceptions, provider responses, or secret-bearing metadata.
- Entry wiring cannot bypass native preflight or convert assembly availability into its success.
- Keep publisher transactions distinct from the six-service business writer; no added wallet/publisher consumer-job permissions or implicit root pools.
- Actual acquisition, independent replay, signed attestation validation, current sample/revision/authority checks, and committed publication remain separate gates.
- Publication/dependency success is not a consumer ACK. Duplicate publication must retain existing immutable collision and receipt semantics; no fabricated facts, ACKs, or wake success.
- Preserve execution configuration, version support, retry quotas, leases, TTL, profile checks, business thresholds, and production behavior when price is absent/disabled.
- Keep existing provider/SQL/request/response/deadline budgets. Do not bypass durable budgets with bare network calls or raise limits to hide failures.

## 4. Authorized next phase: local entry dependency wiring

**Owner:** Ohm. **Reviewer:** independent spec/quality review after freeze.

**Existing files and responsibilities:**
- `scripts/postgres-price-authority.ts`: reviewed dependency assembly; keep assembly and approval semantics separate.
- `scripts/test/postgres-price-authority.test.ts`: pin mismatch, missing dependency, cancellation, and sanitized refusal tests.
- `scripts/postgres-service-entry.ts`: smallest explicit injection/assembly connection to the existing price-authority contract, without changing execution or approving configuration.
- `scripts/test/postgres-service-entry.test.ts`: disabled-path regression and single-sample orchestration tests.
- `apps/automation/src/postgres-independent-price-validator.ts`: reuse actual approval/replay validation; no policy relaxation.
- `apps/automation/src/postgres-price-fact-publisher.ts`: reuse actual native identity, signature, sample/revision, authority, and transactional publication checks.

The automation modules above are reuse dependencies, not an instruction to modify them. Name any additional isolated integration fixture in the freeze handoff before review. Do not expand scope into preflight/provision/source/policy changes to make the test pass.

- [ ] Write failing entry tests showing absent/disabled price makes zero price acquisition, approval, signing-key, and publisher calls while existing execution still runs.
- [ ] Write a positive single-sample isolated orchestration test using the real factory, independent validator, and publisher; explicitly identify any fake transport, test key, approval fixture, or PG double.
- [ ] Add refusal cases for missing/changed/revoked approval, same operator/data platform, conflicting replay, missing policy, wrong mapping/sample/execution fingerprint, malformed/oversized response, expired evidence, and native identity/ACL failure. Assert no unauthorized publication or ACK.
- [ ] Add cancellation/deadline coverage, including abort during dependency probe and replay/publication boundaries; preserve transaction and outstanding-port behavior.
- [ ] Implement the smallest entry dependency connection and keep unconfigured production behavior unchanged.
- [ ] Run targeted tests and relevant type checks; freeze exact changed paths and report real versus mocked integration coverage.
- [ ] Obtain independent spec review followed by quality review. Fix confirmed P1/P2 findings before wider gates.

Targeted local command for the existing factory/entry tests:

```sh
/Users/a77/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run scripts/test/postgres-price-authority.test.ts scripts/test/postgres-service-entry.test.ts
```

Run from `/Users/a77/Documents/ChatGPT/address-radar`, not the similarly named `address-radar 2` checkout. Invoke Node directly; do not use the pnpm wrapper. This document does not claim that command was executed. Isolated database tests must identify their fixture database, use rollback/cleanup restricted to that fixture, and never execute claims or writes against production.

## 5. Later phase gates: not authorized for execution by this draft

| Gate | Required evidence before progression |
| --- | --- |
| Source/policy decision | Explicit core source, independent replay authority, conflict policy, and tolerance decision; no inferred approval. |
| Local integration acceptance | One real component-chain sample; exact sample/execution bindings; valid and refusal paths; test-double boundaries disclosed. |
| Native contract acceptance | Existing preflight genuinely validates the configured contracts and least-privilege roles; no success stub or dependency-only shortcut. |
| Release readiness | Frozen source, independent review, full tests/types/build/compiled-config checks, and later separately authorized root pin/combo review. |
| Production enablement | Separate parent-controlled decision after source/policy and native contracts are approved; this draft grants none. |
| Production price acceptance | Natural bounded acquisition, independently verified evidence, committed facts, and truthful downstream consumption for the selected sample. |
| Wider internal radar | Separate source, liquidity/market-cap, safety, opportunity/capability, and signal acceptance; no inference from one price sample. |

## 6. Evidence and reporting rules

Keep statuses separate: dependency assembly, entry integration, native prerequisite validation, acquisition, independent validation, committed facts, consumer processing, opportunity evaluation, internal signal, and external delivery. Report each as observed, tested with disclosed doubles, pending, deferred, or disabled. Do not collapse them into one success flag.

The prior readiness-claim SQL performance caveat still applies: EXPLAIN planning time is not execution time, result LIMITs do not bound pre-LIMIT scans/sorts, and no latency commitment is established. Base/BSC external provider backoff remains a separate unresolved issue. Price wiring does not repair those checkpoints or authorize bypassing cooldowns.

**Current decision:** factory review complete; next local entry/single-sample phase pending Ohm freeze and independent review. Production price remains off, no stage/deploy is authorized here, and the full closed loop remains incomplete.

## Freeze review update: scanner dependency hook implemented; entry acceptance still pending

This update supersedes the earlier entry-not-wired implementation status, but does not mark the phase complete. Ohm's four-file freeze adds a trusted `nativePriceAuthority` dependency to `scripts/postgres-service-entry.ts` and composes it for scanner after the existing startup fence. `scripts/postgres-price-authority.ts` rejects simultaneous preconstructed/native price authorities when configured and preserves the unconfigured/non-scanner no-probe path. Existing independent validation and publisher checks remain in use; native preflight, source/policy provisioning, and production configuration were not changed.

Owner-reported gates are 367 targeted tests and two type checks passing; this reviewer did not rerun them. Source inspection found no new authority bypass or fabricated business acknowledgement. Production price remains disabled, and no stage/deploy action is authorized by this review.

The new single-sample test uses the real composer/factory, source producer, independent validator, publisher, peak receiver/repository, and opportunity evaluator. HTTP source/replay, approval, native identity/catalog/ACL results, transaction storage, consumer lease ownership/completion, and sample execution evidence are synthetic fixtures. The test manually extracts published peaks into the consumer batch; it does not establish the real fact-adapter read/authority path, real PostgreSQL commit behavior, or genuine consumer lease/ACK correctness. It evaluates an opportunity in memory and does not persist its evaluation. These are disclosed scope limits, not production acceptance evidence.

Review P2: the new tests call the composer directly and manually construct the receiver; they do not call `runPostgresServiceEntrypoint`. Removing the entry's composition call or failing to pass its returned authority into price retry could therefore leave these new tests green. Before claiming entry integration acceptance, add a targeted test through the actual scanner entry with trusted dependency injection and controlled lifecycle shutdown. It must demonstrate that native assembly occurs only after the startup fence, the returned authority reaches the actual price path, absent price configuration causes no price calls, dual authority refuses without probing, and failed startup never constructs price authority. The existing execution path must remain covered. Real entry orchestration may still use disclosed transport/PG fixtures; it must not be described as production approval or real database acceptance.

**Current decision:** factory binding review remains complete; scanner hook is implemented in local source; phase acceptance is HOLD pending actual-entry regression coverage and review. Core source/tolerance decisions, production price enablement, evaluation persistence, and full closed-loop acceptance remain pending.

## Follow-up review: actual scanner entry coverage closed

The prior P2 entry-coverage finding is closed. The new regression cases call the real `runPostgresServiceEntrypoint` scanner branch and real dependency composer. They verify startup fencing before native probing, propagation of the assembled authority into the real price retry path, zero price calls without configuration, rejection of dual authority, startup failure without probing, and rejection of missing native authority. No new P1/P2 was identified in this narrow follow-up.

These are isolated entry-orchestration tests: startup/transport and validator/publisher boundaries use fixtures or doubles. They do not establish production approval, native preflight acceptance, PostgreSQL persistence, or production price acquisition. The earlier real-component single-sample test retains its documented persistence and consumer-adapter coverage limits.

Ohm reports 372 targeted tests and type checks passing; this review did not rerun them. The full-suite report remains 3921 passed, 110 skipped, and 2 failed, with compiled SQLite warning stderr under investigation by Kepler. The overall release gate remains HOLD until those failures are resolved and the gate is rerun. Production price remains disabled; no staging or deployment is authorized by this review, and the full radar closed loop is not complete.

## Final local gate update: fixed-runtime gates passed

This update supersedes the earlier full-suite HOLD caused by two compiled SQLite warning stderr failures. Kepler reports that Node 24.11.1 reproduces those failures, while the fixed runtime Node 24.19.0 passes the original assertions without changing tests or filtering stderr. Final local gates: 3923 tests passed, 110 skipped, all 18 type checks passed, build passed, and all 21 compiled smoke checks passed. These results are owner-reported; this documentation update did not rerun the gates.

Evidence: `/private/tmp/address-only-price-entry-final-gates-1791598217272.log` and its accompanying JSON report. Old-runtime reproduction: `/private/tmp/address-only-compiled-warning-node24111-repro.log`.

The local code/test gate is PASS; the earlier two-failure HOLD is obsolete. This does not establish real PostgreSQL or approval acceptance. Production price remains disabled, this change has not been deployed, and the full radar closed loop remains incomplete.

## Production code deployment: 20261010a complete, price still disabled

The parent reports successful controlled deployment of `20261010a`, journal COMPLETE at 2026-10-10 10:43:17 Asia/Shanghai. All six services are running with NRestarts=0; reported available disk bytes: 4356747264. This supersedes the earlier not-deployed status for the price factory and entry wiring code, not the production price enablement status.

Deployment evidence pins:

- Journal SHA256: `6316d6350981b1f02b8987ed520fc08ae2f30efb303171255c939306aa8241d8`.
- Receipt SHA256: `e91846103642a54bb7bbe59ce33d80e55b7d166d1d473a6937dce567c3c2fb69`.
- Audit SHA256: `1fb0e48c46bd3036e5180b28005faef895ad29fb3b42f52c80ed86ef277e6fd2`.
- Release seal SHA256: `18a70f6ac40eddee73622659a19236926465ebebcd53ec454467d3ce14a9d653`.
- Entry SHA256: `aa3901c6c4e82bf3a9bc343d06b7991f7a922914af2fb54dfe063fad9d27deca`.
- Native verifier SHA256: `7d11d71bb414d3b56b199b5501d82c28b3ce160291fea791c493a18e761ad063`.

The independent pre-activation root review passed. Relative to release l, the authority/deployment/environment differences were restricted to approved artifact identity, pins, and inventory binding. `execution.maximumBytes` changed from 1274891 to 1327725, with five inventory entries. This field is the release inventory byte binding and scan cap, not a business processing or fact payload budget. The pinned controller requires exact equality with the new inventory; native preflight enforces its scan cap. The actual release seal, entry pin, and verifier pin were verified. Business configuration and processing budgets remain unchanged; the earlier phrase "config identical" must be read as business configuration unchanged, not byte-for-byte metadata equality.

Ohm's read-only post-deployment acceptance is in progress. Production price remains disabled and source approval is missing. Code deployment success does not establish real PostgreSQL/approval acceptance for price, successful price acquisition, or completion of the full radar closed loop. No additional production operation was performed for this documentation update.

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

## Close-loop gate map: source replacement preparation, 2026-10-11

### Current factual boundary

The prepared PublicNode source materials passed an actual root read-only combination review. This is **materials approval only**: the replacement has not been imported or activated. The reviewed root is `/var/lib/address-radar-maintenance-tools/source-replacement-publicnode-1791626195136`; preparation receipt SHA-256 is `48763ed19a9d676415ba0ad0cedfd6336c43e99533d16782bf4ecb804d83ee84`. The actual material differences are nine source-contract fields plus six environment FILE/SHA bindings. Collector, execution producer, authority and native preflight agree on the new source identity. The configured contract remains 60 requests per 60 seconds with concurrency one; this local contract is not a provider SLA. Publisher/key and independent replay bindings remain unchanged.

Source replacement execution remains separately gated by continuous exclusion, physical drain, the complete stopped window, genuine rotation/import receipts, budgeted source/replay verification, and the controlled controller handoff. Materials do not prove those events. A source switch must not increase aggregate acquisition budgets, erase old cooldown/window audit, automatically fall back to exhausted Helius, or imply radar completion.

Production price remains off. Real candle acquisition has been observed, but the candidate market-cap result is null. Independent price-source approval and the applicable policy decisions are outstanding. Price factory and entry dependency wiring are implemented and tested; fixture approval/PG/provider tests are not production authority or successful production evaluation persistence. No production change is authorized by this document.

### Ordered acceptance gates

| Stage | Required real acceptance evidence | Implemented versus outstanding |
| --- | --- | --- |
| Execution ingestion | A naturally acquired transaction is decoded within supported versions, independently replayed and fully validated under the approved generation, subject, profile, authority and time bindings. Publish through the existing fact path and confirm its native ACK and durable result. | Legacy/v0/v1 read-only compatibility and the execution retry path are implemented. Historical k acceptance demonstrated restored proof publication and ACKs; l acceptance demonstrated purchases. These historical successes do not establish current source availability or validate the pending replacement. |
| Actual entry price | Bind the price to the relevant real purchase, asset, chain and observation time, using approved units and source semantics. Missing or contradictory evidence must defer; a quote, unrelated sample or guessed price is not an entry price. | Price dependency factory, scanner entry wiring and a single-sample fixture vertical slice exist. Production approval, actual authority provisioning and production persistence acceptance remain outstanding; production price stays off. |
| Real market capitalization and valid peak | Evaluate the existing 100K market-cap rule with an approved source's explicit, time-aligned reported `market_cap` value. Establish a valid high from approved candle/peak semantics with complete asset/time binding and required independent validation. Null market cap or unknown liquidity defers. | Candidate candles are not enough: market cap is currently null. Do not substitute FDV, guess supply, or represent an execution/trade sample as a candle high. Source coverage and source approval remain external gates. |
| 3x / 5x progression | Apply the existing 3x and 5x rules to the validated entry basis and valid peak, with existing timing and deduplication rules unchanged. Confirm actual evaluation and durable transitions, not only a dependency returning available. | The single-sample test exercises peak consumption, fanout and the opportunity evaluator with fixtures. It does not establish production evaluation persistence or satisfaction of both multiplier gates. |
| Capability | Consume current, fully validated prerequisite evidence and persist the existing capability decision with its actual provenance. Missing, expired, conflicting or unavailable prerequisites defer. | Prior acceptance contained pending capabilities and unavailable facts. Current real capability progression remains to be demonstrated after its upstream gates pass. |
| Admission | Apply the existing admission policy, including the existing 50U rule and activation/checkpoint boundaries, without relaxing eligibility to obtain progress. Confirm the admitted subject and persisted decision. | Price/source enablement is not admission authority. No threshold, activation time or eligibility rule is changed here. |
| Aggregation and safety | Carry approved provenance through aggregation and full safety checks. Resolve source-independence conflicts according to approved policy; unknown liquidity, unresolved conflicts or missing safety evidence must not become success. | Remaining price/source/safety production wiring and authority coverage require explicit acceptance. A shared provider or duplicated upstream must not be labeled independent merely because endpoints differ. |
| Internal radar | Demonstrate a naturally progressing end-to-end case through the preceding durable decisions into the internal radar output, with rejected/deferred controls, bounded resource use and healthy services. | Full closed-loop acceptance is not complete. Internal radar is the target boundary; gateway/FOMO enablement, external delivery or trading are not implied. |

Each downstream stage must revalidate its own authority, freshness, profile and evidence contract. An upstream scheduling hint, successful ACK, signed fact, healthy service or successful deployment is not a substitute for downstream business eligibility. No stage may manufacture facts, renew old signatures, silently approve sources, or ACK work as successful merely to clear a queue.

### Implementation gates versus external decisions

Engineering can implement and test fail-closed wiring, independent validation, bounded acquisition, atomic leases, fair scheduling, durable publication/evaluation, provenance and rejection behavior. Isolated real-PG tests and compiled configuration tests should cover those contracts before deployment. Production acceptance must then show natural durable progression; test doubles and query planning time cannot establish provider availability, business success or execution-time performance guarantees.

Engineering cannot supply missing provider data, authorize an unapproved operator, infer independence from hostnames, decide an arbitrary price tolerance, turn null market cap into a value, or promise a best-effort public RPC SLA. Base/BSC external backoff remains a separate limitation; Solana source preparation does not prove EVM progress.

### Consolidated user policy decisions

Resolve these as one policy review, not as repeated approval requests for individual tests:

- Approve the core price/candle/market-cap operators, datasets and independence relationships, including the treatment of shared upstreams and conflicting sources.
- Confirm the entry-price basis and candle/high semantics, including temporal alignment and acceptable evidence coverage for the existing business rules.
- Confirm any tolerance, freshness or conflict-resolution policy that is not already explicitly approved. Until confirmed, do not invent numeric defaults or silently choose a winner.
- The market-cap policy is now approved: accept an approved source's explicit reported `market_cap` for the existing 100K rule, retaining provenance, time and audit. Independent proof of circulating supply is not required. Null/unknown values and conflicts defer; FDV remains separate and supply must not be guessed. Any still-unapproved liquidity policy remains a separate decision.
- Confirm a production price-enablement decision only after the approved source/policy contracts, native preflight and real acceptance evidence are complete. Keep the output scope internal radar unless separately authorized.

Routine implementation and negative tests can proceed within those fixed contracts without per-test policy approval. Unresolved policy or unavailable external evidence remains an explicit deferred gate, not a reason to alter business rules or claim completion.

## Approved market-cap policy amendment: 2026-10-11

This amendment supersedes any earlier wording requiring independently proven circulating supply or independently verified circulating market capitalization before the existing 100K decision. That additional requirement is withdrawn; the business threshold itself is unchanged.

An explicitly approved data source's explicit `market_cap` report may be used for the 100K rule. Record its assurance as **`reported`**, not **`independently_verified`**. Retain the approved source/operator identity, asset/chain binding, source observation time, acquisition time and audit/provenance references. An approved source's market-cap field must not be relabeled as independent verification merely because an independent validator checked its signature, bindings or faithful replay.

FDV is a separate metric and must never fill a missing `market_cap`. A null, absent, malformed or ambiguously mapped market-cap value defers; do not infer supply or calculate a guessed replacement. A valid numeric zero must not be confused with a missing value: it is evaluated under the unchanged threshold. Preserve the existing anomaly, liquidity and conflict verification behavior; source conflicts remain pending verification rather than automatically selecting a favorable value. No new tolerance, freshness interval, liquidity cutoff, conversion rule or rounding policy is authorized here.

### Revised acceptance requirements

- Approved source explicitly supplies `market_cap` for the bound asset and chain; provider field mapping is reviewed rather than inferred from an FDV or generic valuation field.
- Persist the reported value and its units, source identity, observation/acquisition times and audit references through production, validation, publication and consumption. Assurance remains `reported` throughout.
- The existing 100K evaluator can consume that approved reported evidence without requiring an additional circulating-supply proof. All other authority, freshness, binding and business predicates remain in force.
- Negative tests cover missing/null/malformed values, FDV-only responses, unapproved sources, asset mismatch, stale evidence under existing policy and source conflicts. These cases must not become eligibility success or fabricated facts.
- Verify actual durable evaluation and downstream behavior before claiming production acceptance; a fixture or available dependency is not an approved production source.

### Module handoff, not implementation in this amendment

The approved price-source mapping/producer must distinguish `market_cap` from FDV and preserve reported provenance. The native authority and independent validator must validate the approved source and evidence contract without asserting independently verified supply. The fact publisher/storage contract and consuming adapter must preserve the value, provenance and assurance without silent upgrades. The opportunity/100K evaluation path must accept the approved reported metric while retaining existing conflict/defer rules; capability, admission, aggregation and internal-radar paths must retain that provenance.

Owners should check those exact contracts and add focused producer-to-consumer regressions before production enablement. This document does not assert that the corresponding code/schema fields already exist or are wired. Production price remains off pending source-specific authority/configuration and acceptance. The pending execution-source replacement is separate and does not approve price datasets or complete the radar loop.

## Current delivery status: 2026-10-11

| Workstream | Actual status | Remaining gate / boundary |
| --- | --- | --- |
| AVE | Developed, not deployed; owner reports 39 passing tests. Kepler completed independent static review: both P2 findings are closed, with no new P1/P2. Kepler did not rerun the tests. | Live validation remains pending. Owner test evidence and static review are not production acceptance, source approval or deployment proof. |
| Reported market-cap protocol | In development by Ohm under explicit authorization: a minimal dedicated producer/validator/publisher protocol extension for approved reported market cap. | Must not borrow candle authority. Missing approval or unresolved conflicts defer. Preserve `reported` assurance, source/time/audit provenance, separate FDV and the unchanged 100K rule. No production wiring or acceptance is claimed yet. |
| Execution-source replacement materials | Actual root material combination review passed; materials remain prepared, not imported or activated. | Materials approval does not establish exclusive budget handoff or successful acquisition. |
| Source replacement execute | HOLD: the explicit isolated activation entry has a manager-authentication P1; Turing is fixing it. Real schema/ACL fixture and Node runtime environment work also remains in progress. | Freeze, independent P1 re-review and genuine isolated execution evidence are required. Do not fabricate receipts or treat a fixture/environment failure as successful rotation/import/controller acceptance. |
| Production price / full radar loop | Production price remains off; complete end-to-end acceptance remains outstanding. | Approved source-specific authority, real data coverage, durable downstream evaluation and all existing capability/admission/aggregation/safety gates still apply. No plan-completion claim is made. |

The approved reported-cap policy removes an independent circulating-supply proof requirement; it does not approve a provider implicitly, authorize candle credentials for a new purpose, or remove conflict verification. Routine engineering work may continue within these boundaries without changing the existing business rules.

## Consolidated phase tracking and remaining work: 2026-10-11

This update supersedes earlier delivery-status rows where progress has changed. Counts below are owner-provided test evidence, not test reruns by the document owner or production acceptance.

| Workstream | Latest evidence | Still required |
| --- | --- | --- |
| AVE | Developed; owner 39 PASS; Kepler independent static review closed both P2 findings with no new P1/P2. Not deployed. | Live validation and the applicable approved-source binding. |
| Reported market-cap authority and revocation | Real isolated-PG approval/revocation coverage: 46 PASS; review findings closed. | Production source approval/provisioning and genuine producer-to-consumer acceptance remain distinct. Do not infer deployment from the isolated-PG result. |
| Reported entry / preflight | Owner reports 521 PASS and type checks passing. | Loader/client completion, focused review and their actual composition evidence are pending. Entry/preflight evidence alone does not demonstrate acquisition. |
| Execution-source replacement materials | Root combination review passed; prepared source contract and collector/producer/authority/preflight pins agree. | Final execution artifacts and any changed pins must be frozen and reviewed together before use. Materials are not an import or activation receipt. |
| Source execute serialization / encoding | Owner reports 18 PASS for encoding coverage. The isolated manager P1 and COMPLETE-admission static reviews are closed. | Genuine full-chain execution is still blocked on configured isolated capability integration and the probe/verifier identity conflict, both under repair. No full-chain success is recorded. |
| Production price / end-to-end radar | Price remains off. No new source-switch, price-enablement or full-loop completion is asserted here. | Actual approved evidence, durable evaluation and downstream acceptance through internal radar. |

### Complete remaining acceptance checklist

The following are completion gates for the existing plan, not new product scope. Previously completed implementation/review gates should not be reopened without a concrete change or finding.

- Close the two source-execute integration defects: pass the genuine configured isolated capability through the actual controller route and align probe/verifier identity contracts without weakening either check or manufacturing receipts.
- Demonstrate the genuine isolated rotation -> physical fence/drain/full window -> import -> guarded probe -> configured native preflight -> publication/handoff -> six bound readiness chain. Include failure preservation and uncertain-result refusal; encoding and port doubles alone do not satisfy this gate.
- Freeze the final executable/module pins and run applicable targeted regressions, types, compiled/schema checks and the agreed release gate on the final reachable code. Recheck only changed contracts rather than restarting unrelated workstreams.
- Before production source replacement, review the exact root job/material combination and healthy origin. Preserve old source budget/window/cooldown audit, prohibit parallel old/new acquisition and automatic fallback, and obtain real one-attempt execution receipts. Confirm natural post-switch acquisition separately; public RPC availability is an external limitation, not a code success predicate.
- Complete and review the reported-cap loader/client composition. Demonstrate the actual approved producer -> dedicated validator -> publisher -> consumer path, retaining `reported` assurance and source/time/audit evidence. Missing/revoked approval, identity drift and conflicts must defer without false publication or business success ACK.
- Provision only explicitly approved price/candle/reported-cap sources and purpose-specific authority. Do not borrow candle authority for reported cap or execution authority for price. A passing native preflight must use the final compiled schema and actual pinned settings; settings JSON and verifier program are separate pins.
- Demonstrate durable evaluation using a real purchase entry basis, a valid Kline peak and an approved source's explicit reported `market_cap` for the unchanged 100K rule. Current null market cap is not acceptance. FDV, guessed supply and trade-as-candle substitutions remain prohibited.
- Verify the unchanged 3x/5x progression, capability, admission and aggregation/safety decisions with actual persisted provenance and deferred/rejected controls. Preserve the established 50U, 30d, no-profit-taking and 15min/two-person rules under their existing approved meanings; this checklist does not reinterpret them or add thresholds.
- Confirm an actual internal-radar outcome and bounded operational behavior. Deployment health, source acquisition, published facts, purchases and opportunity/capability progress are distinct milestones, none individually proves the whole loop. Gateway/FOMO and external delivery remain outside this plan's enablement boundary.

### Minimum production material set, without secrets

| Material | Required reviewable contract |
| --- | --- |
| Release and executable inventory | Sealed release root/inventory/entry pins; exact Python/Node/tool/module pins; final native verifier pin. Respect the probe CLI unbundled-module deployment restriction. |
| Source contract / replacement | Approved provider review and seed/import plan; replacement hash; new immutable provider/operator/origin and fixed budget contract; generation/activation binding; old-source preservation and no-parallel-acquisition requirements. |
| Runtime configuration | Deployment, environment, source authority and native settings pins; collector/producer/reviewed-binding/provider-contract agreement; all FILE/SHA references bound to actual new root paths. Preserve unrelated budgets, TTLs, floors and safety flags. |
| Origin and controller request | Actual healthy COMPLETE origin journal/receipt pins, immutable original manifest/state pins, approved transition request and controller binding. No fabricated old readiness or completion. |
| One-attempt maintenance execution | Exact authorized execution job, pinned import/probe inputs, rotation operation/approval/replacement binding, persistent fence request and genuine drain proof. Rotation credentials and signing keys are private references only; never include their values in documentation or stdout. |
| Price / reported-cap enablement, separately | Explicit source/dataset/purpose approval, dedicated validator/publisher authority and public identity pins, approved field mapping and conflict policy, final loader/client/config/settings/verifier bindings. Include revocation handling and `reported` provenance contract. This set is not implicitly authorized by source replacement. |
| Acceptance audit | Genuine rotation/import/probe/controller/readiness receipts and safe diagnostic codes; subsequent natural acquisition and durable business-stage evidence. Record each milestone and remaining defer reason without claiming unobserved success. |

Secrets are not review artifacts: use root-private credential/key references and approved public identity/hash projections. Review receipts do not replace real authorization, and no deployment, service action or DB write is authorized by this document.

### Scope and external limits

No full-cluster backup/PITR framework, provider-account quota circumvention, budget increase, TTL extension, invented tolerance, independent supply-proof requirement, trade execution or external gateway delivery is added. Existing approved business rules stay fixed. Source-specific approval, data availability, truthful independent provenance, market-cap coverage and unresolved anomaly/liquidity conflicts remain explicit external or policy gates. They must be reported as blocked/deferred rather than turned into endless implementation scope or silently waived.

## AVE console evidence and unknown limits: 2026-10-11

The parent inspected the authenticated AVE console at `https://cloud.ave.ai/back` in Chrome. After loading completed, the console repeatedly showed **Package: Free**, **Remaining units: 1,000,000**, **Units Usage: 0**, and **Total Requests (24h): 0**. Initial `--` / `0` display values were loading placeholders and are not the final account evidence. The parent did not expand an API key or make an API request during this inspection.

The Data API Rate Limit field remained `--`. Exact RPS, WSS limits and concurrency limits are not established by this observation. Units are not a request count; do not convert the remaining units into a number of requests or claim a precise Free-plan RPS. Account-console evidence is not a successful endpoint/schema/coverage test, source approval, production credential provisioning or an SLA.

A newly supplied API key must not be repeated, committed to source, included in this document, written to logs or exposed in receipts. No server credential configuration has been completed. Production reported authority FILE/SHA remains unconfigured on the last actual read-only check; price remains off. Any future credential provisioning must use the approved private credential contract and purpose-bound guarded transport, not an ad hoc API call.

Remaining external evidence includes the applicable Data API rate/concurrency contract and actual approved endpoint/field coverage. Unknown limits must stay explicit and fail closed where a valid provider contract is required; they must not be replaced with guessed RPS or inferred from units. WSS evidence is needed only if WSS enters the approved implementation scope, not as a new prerequisite for an HTTP-only path.

## Native replacement identity boundary: 2026-10-13

This update supersedes the earlier manager/capability/probe blocker descriptions only where the following execution evidence establishes progress. It does not mark source replacement, production deployment or the radar loop complete.

The genuine disposable PostgreSQL/systemd execution reached credential rotation, committed source-contract import and independently guarded source/replay probes (`sourceRequests=4`, `replayRequests=4`, verified). The next boundary is configured publication and first unguard. A configured wallet unit changes to its approved distinct service user, while the original physical-drain verifier still expects the origin user. The origin journal must remain immutable; relaxing identity checks or dropping the old UID from process scanning is not an acceptable repair.

Local implementation separates an explicit published-user binding from the default origin-user check. It retains scans for both old and new UIDs, stopped units, empty cgroups, guard identities, retained OFD ownership, boot identity and the full two-clock window. New bottom-layer regression tests passed 5/5; existing fence tests passed 26/26; adapter tests passed 18 with 2 platform-dependent skips on macOS. These test results do not establish the real publication gate.

Independent static review identified a P1 in the new publication capability check: `walletServiceUser` is a validated identity object, not a username string. Comparing it directly with `pw_name` rejects legitimate publication. This must be corrected using the validated `user` field and covered through the capability gate before any release. The genuine isolated execution remains failed/HOLD; no source replacement or production deployment occurred in this update. Test log: `/private/tmp/source-execute-published-identity-20261013.log`.

Required next acceptance steps:

- Correct the publication identity comparison and add capability-gate regressions for the approved identity, changed identity, retained old/new process checks and missing or changed published configuration.
- Re-run the genuine rotation/import/probe/publication/handoff/six-readiness chain and its failure-preservation controls. A green lower-level mock test is insufficient.
- Obtain independent follow-up review and run the final applicable release gates on the corrected frozen artifacts; regenerate all changed tool pins rather than reusing old source-replacement job hashes.
- Only then prepare the exact fresh production root/material combination. Preserve the independently approved source budget, the old acquisition history, rollback/failure guards and disabled external delivery.

Actual production read-only observation at `2026-10-13T01:29:23Z`: all six services active/running with `NRestarts=0`; available disk `4,325,289,984` bytes; gateway delivery disabled. Current generation counts: captures 1,203, normalized 1,203, purchases 605, token discoveries 243; their reported one-hour new-record counts were all zero. There were 605 opportunity samples awaiting `missing_valid_peak`, 31 pending consumer jobs with `wallet_canonical_execution_proof_unavailable`, and 53 pending ability jobs (one explicitly missing capability facts). Coverage remained unverified and runnable delta unavailable. Service health is not business progress or closed-loop acceptance.

## Consolidated implementation and release-gate update: 2026-10-13

This update supersedes the old `Not wired` and `loader/client completion pending` implementation rows; those historical rows are not current engineering TODOs. A separate read-only implementation audit confirmed that the reported-cap loader/client is composed by the actual scanner entry, with dedicated approval, validator, publisher and controlled AVE transport. The isolated native reported-market fixture exercises real component publication, fact-adapter consumption and persisted provenance, including revocation. These implementation and historical isolated-PG results do not establish production source approval or live market coverage.

The fixed Node 24.19.0 release runner completed reference build, all 21 type-check projects, full Vitest (4,272 passed, 206 skipped) and compiled smoke gates on 2026-10-13. The subsequently added isolated recovery grant fixture passed its dedicated TypeScript check and was compiled through the maintenance-module builder. A full-gate result does not cover an unexecuted native recovery branch or waive a later finding.

The wallet publication comparison was corrected to the validated identity object's `user` field. Its regression first reproduced the refusal before the fix; afterwards the adapter suite passed 21 tests with two macOS platform skips, alongside the five published-identity and 26 original-fence tests. Source-origin tests passed 13 and transition sequencing tests passed 14. The genuine chain then progressed through publication and handoff, but configured workers lacked runtime mutation permissions in the waiting-mode-only rehearsal grants.

The rehearsal now generates the existing restricted business provisioning and protocol-v2 supplemental grants, rather than arbitrary full-table write or superuser privileges. Synthetic capacity values are explicitly offline fixture planning inputs, not production measurements. Independent follow-up review found two P2 issues that remain release blockers: the new grant invocation must read the envelope's `generationId`, and post-failure reblocking must not verify a configured dropin already removed by rollback. The latter remains fail-closed but does not prove recovery completed; original and recovery failure diagnostics must remain distinct and sanitized. No production release switch occurred.

Current completion matrix:

| Workstream | Local implementation status | Remaining completion gate |
| --- | --- | --- |
| Price factory / scanner entry | Implemented, previously deployed code; current full tests passed | Purpose-bound source approval and production enablement remain separate. |
| Reported-cap producer / validator / publisher / loader / client | Implemented and independently reviewed; actual scanner composition confirmed | Dedicated production materials and genuine approved-source-to-business acceptance. |
| AVE adapter | Implemented and previously reviewed | Actual endpoint/field coverage, approved request limits, private credential provisioning and controlled live acceptance. |
| Source replacement controller | Implemented; genuine native chain reaches publication/handoff | Close the two reviewed P2 findings, then prove six-service readiness and failure recovery in the real isolated chain. |
| Release readiness | Current business build/types/tests passed | Corrected final controller/fixture review, native acceptance, regenerated exact release/tool/material pins. |
| Complete production radar | Not accepted | Natural acquisition, valid price peaks, reported market-cap evidence, durable evaluation and internal radar outcome under unchanged rules. |

External delivery, gateway and FOMO enablement remain disabled. Missing external credentials, source-specific approval, provider limits or genuine data coverage must stay explicit; they must not be relabeled as undeveloped local modules or silently waived.

## Native execution acceptance update: 2026-10-13

The approved fixture generation lookup now uses `binding.generationId`.
Configured rollback that removes publication files no longer guesses the effective
base-unit identity: the outer recovery path verifies retained guards, requests
service stop, and reports `UNVERIFIED_HOLD`. Only a successful native block may
report `VERIFIED_BLOCKED`; neither state is a business activation receipt.
Recovery failure preserves the original execution exception and revokes the gate.

Targeted sequence regressions: 16 passed. Execution boundary regressions: 23
passed, 1 platform skip. Genuine isolated PostgreSQL/systemd acceptance: all 7
passed in 83.504 seconds, including actual original COMPLETE activation, restricted
fixture grants, native source replacement, publication handoff and real execution
completion. Evidence: `/private/tmp/source-execute-recovery-hold-20261013.log`.
This is isolated engineering evidence, not production source or business proof.

Independent review closed both approved defects but identified one remaining
exception boundary: failure to persist `hold.json` can still mask the primary
failure. User approval for that correction has been requested. No production
commit, release switch, configuration update or service restart occurred in this
step. Production deployment remains gated on this final correction and review;
external source authorization and real price/opportunity/radar coverage remain
separate live acceptance requirements.

## Final exception-boundary gate: 2026-10-13

User approved the HOLD-write correction. Recovery and persistence errors are now
contained independently: the primary exception is re-raised unchanged, the gate
remains revoked, and `hold_persisted` is true only after successful persistence.
A failed write is not represented as a durable HOLD receipt. Regression coverage
includes both successful and failed reblocking combined with storage failure.
Independent static follow-up found no remaining P1/P2 in this correction scope.

Final local gates: sequence 18 passed; execution 23 passed / 1 platform skip;
reference build and all 21 type checks passed; Vitest 4272 passed / 206 skipped;
compiled smoke tests 67 passed. Final genuine isolated PostgreSQL/systemd chain:
7 passed in 81.762 seconds, with actual replacement execution COMPLETE.
Evidence: `/private/tmp/reported-full-gate-20261013-final-summary.json` and
`/private/tmp/source-execute-final-20261013.log`.

Production read-only observation at 2026-10-13T02:15:42Z: all six services active,
NRestarts zero, current release `4b48fc2-forward-token-code`, 4313903104 bytes free.
Gateway delivery remains false; coverage is unverified. Capture 1203, purchases
605, token discovery 243; all returned stage increments for the last hour are
zero. Missing valid peak blocks 605 opportunity samples; canonical execution proof
is unavailable for 31 pending consumer tasks. These results do not establish
business recovery or authorize price-source enablement.

No commit or production deployment has been performed in this correction step.
The native engineering gate is now passed; fresh immutable production execution
materials and source-specific authority remain separate deployment requirements.
Do not substitute isolated fixture grants, budgets or source approvals for them.

## Production code staging: 2026-10-13

Built the final standalone three-file runtime and uploaded a bounded USTAR archive.
The reviewed exclusive staging tool returned `CODE_STAGED_ONLY` for
`/opt/address-radar/releases/address-only-20261013-final`.
Root-owned sealed inventory SHA256:
`83fed25a2cd61f4d950f1b55d755e0990a34e4d8c7200bcc85fbff649803835e`.
Archive SHA256:
`d65ff07948af0f85215fd69e6dc87dfddaf7c655fdf3614a87a94497c45ae105`.
Receipt pin:
`/var/lib/address-radar-maintenance-tools/code-stage-20261013-final.json`, SHA256
`77ac3708ceb055fe2dd919167e1a44250bde90aad49b6ee490781c881e733d70`.

The unsealed local inventory differs from the sealed root inventory because file
and directory modes are part of the inventory contract; individual file digests
are unchanged. Staging reused the pinned native Node executable and verified both
permanent original activation pins. The receipt explicitly reports no controller
invocation, activation, service stop/restart, runtime configuration modification,
PostgreSQL connection/write or SQLite access. This is not a production deployment
or business recovery receipt. Fresh activation materials must bind this sealed
inventory and the current native tool pins; expired source/preflight materials
must not be reused or treated as current approvals.

## Production assembler first implementation review: 2026-10-13

Added a preparation-only production assembly port, implementation plan and nine
pure regression tests. All nine pass locally and in a network-disabled Linux
container. No production assembler invocation, job issuance or activation occurred.

Independent security and specification reviews reject release readiness: actual
sealed release verification, source-plan hash recomputation, complete nested
schema/identity/tool/probe bindings, typed bounded reads with a final deadline
check, and a durable preparation receipt remain incomplete. Current passing tests
prove local shape/refusal rules only, not executor compatibility. Metadata
rebinding is also not implemented by this port. A consolidated user correction
request has been submitted. Do not deploy or treat PREPARED_NOT_EXECUTED as proven
production readiness until these findings are closed with complete regressions.

## Approved assembler corrections, second review: 2026-10-13

Implemented actual sealed release inventory verification, exact source-plan
recomputation through the existing TypeScript planner, nested material checks,
streamed typed file reads, unique versus cumulative budgets, preparation timeout,
and durable job/preparation receipt with parent fsync. Pure Python regressions:
27 passed. Disposable Linux real-file checks: 6 passed. Source-plan validator
behavior tests: 67 passed; standalone maintenance bundling succeeded.

The dedicated TypeScript check failed in new test fixtures due to mutation of
readonly fields and the parameterized CLI argument test type. Production helper
behavior tests passing does not waive these type errors. No final full gate or
production assembler invocation is claimed.

Second independent review still blocks readiness: subprocess output must be
bounded while streaming with process-group cleanup; controller jobTemplate,
configured resource policy and supplementary-group checks must match actual
entry contracts; stage receipt approval/transition/native Node/permanent pins
must bind final materials. Output-time dependency and directory revalidation
must be strengthened rather than claiming simultaneous immutable evidence from
sequential reads. All remaining corrections were grouped into one user request.

### 2026-10-13: Approved assembler hardening regression

The user approved the consolidated remaining assembler corrections. The changes cover immutable TypeScript test fixtures, bounded subprocess streaming and process-group cleanup, the full controller/resource/wallet-group contracts, staging approval and permanent-pin binding, and dependency/release-directory revalidation before output publication.

Validation completed in this round:

- Dedicated source-material TypeScript check: passed.
- Source-material validator tests: 67 passed.
- Reference build and all engineering type-check projects: passed.
- Full Vitest regression: 4,339 passed; 206 skipped.
- Compiled-release smoke tests: 67 passed.
- Assembler Python regression in an isolated, network-disabled Linux container: 46 passed.
- Root filesystem and release-inventory isolation checks: 6 passed.

Independent review and the native recovery regression are still pending at the time of this entry. These results establish engineering regressions only: no production database, business rules, runtime configuration, or delivery flags were changed. The production source-material combination and activation have not been validated by these tests; code staging is not runtime deployment or closed-loop acceptance.

Independent review follow-up: the previously approved hardening points have been implemented, but two additional preparation-contract gaps remain. The probe runtime budget must match the actual CLI's 5,000 ms ceiling, and the import schema version/fingerprint must be bound to the final deployment contract rather than merely format-checked. Both can defer rejection until after runtime preparation has already stopped services. Production execution remains blocked; consolidated permission to correct these newly identified issues has been requested. The isolated tests do not establish real protected-reader-to-validator-to-executor compatibility.

Native recovery regression also completed: 7 tests passed in 81.880 seconds against isolated PostgreSQL/systemd fixtures. The fixture explicitly reports `productionProof: false`; it does not remove the two remaining preparation-contract blockers or authorize production activation.

### 2026-10-13: Probe and import-schema contract corrections

Following explicit user approval, the assembler now accepts probe runtime budgets only in the actual CLI range of 1 through 5,000 ms. Import target schemaVersion and schemaFingerprint must exactly match the final deployment.driver contract before preparing execution materials. Regression coverage includes the 5,000/5,001 boundary, valid-format mismatching schema versions and fingerprints, matching schema pins, and an invalid driver contract.

Targeted assembler regression passed 51 tests locally and 51 tests in a network-disabled Linux container. Independent static review closed both previous P2 findings and found no new defects in these corrections.

An additional root filesystem test run passed five tests but failed the release-inventory fixture: tempfile-generated directory suffixes may contain an underscore, which the production release-name contract correctly rejects. Permission has been requested to use a valid random hexadecimal suffix in that temporary fixture without relaxing production validation. This additional run is not recorded as passed.

No production data, business rules, permissions, runtime configuration, or delivery flags were changed. Real protected-reader/bundled-validator/executor/database-ledger composition, metadata rebinding, and final production activation remain separate incomplete acceptance gates. No commit or deployment was performed in this round.

### 2026-10-13: Isolated release fixture naming correction

With explicit user approval, the temporary native I/O fixture now creates its release directory using a random hexadecimal suffix and exclusive mkdir rather than tempfile's unrestricted suffix alphabet. Production release-name validation is unchanged. The network-disabled Linux root filesystem regression was rerun: all 6 tests passed. This closes the fixture failure recorded above, but does not establish real production material composition or activation. No production code, data, configuration, or permissions were changed in this correction.

### 2026-10-13: Remaining final-material preparation boundary

Read-only implementation tracing confirmed that source-only preparation, final-material validation, and execution-job assembly already exist, but a general final metadata rebinding producer that preserves existing authority and credentials does not. The older stability metadata tool is release-specific and changes unrelated runtime settings; the server-material generator creates credentials and is not a safe substitute.

The next preparation-only producer must rebuild the source plan from valid, independently confirmed input/review evidence, preserve existing credentials, keys, budgets, scheduling, and business rules, and apply only the release/entry/environment pin substitutions accepted by the current TypeScript validator. It must compute file pins in dependency order and retain original state/manifest plus the current COMPLETE origin bindings. Missing or expired source evidence is a blocker, not permission to edit timestamps, extend authority, or reuse stale hashes. Provider import also enforces a real evidence-age limit; a staged release approval does not renew source approval.

Before implementing that producer, isolated combination coverage is being added for actual protected file reads, the bundled TypeScript material validator, and preparation output. These tests must not replace the reader or validator with stubs, invoke production, or claim database-ledger/production proof. Final production material generation and activation remain incomplete.

### 2026-10-13: Real preparation composition regression

Added scripts/test/assemble-production-source-native.test.py. In a network-disabled Linux root container, it exercises the actual ProtectedReader, the unmodified bundled TypeScript validator, and the production prepare() function without replacing the reader or material validator. Six tests cover exact job/receipt pins and permissions, exclusive output creation, refusal to reuse an existing execution attempt, changed review evidence, invalid final budget substitutions, tampered dependencies, and an unsealed release. Independent static review found no defects in this coverage.

The validator was then rebuilt directly from the current source with buildAddressOnlyMaintenanceModule using seal:false for the temporary host artifact; the isolated root fixture performs the protected installation. All six combination tests passed again in 2.641 seconds. An earlier direct esbuild invocation failed because there is no root-level esbuild executable, and the first project-builder attempt correctly refused host sealing without root ownership; neither attempt reached production or changed the protection contract.

This establishes actual preparation composition only. The test uses synthetic approval/COMPLETE/schema/release materials and does not execute argparse, native preflight, credential rotation, import, probe, or the executor against a real database ledger. General final metadata generation and genuine production acceptance remain incomplete. No Git commit, production deployment, SSH, or production data/configuration changes were performed in this round.

### 2026-10-13: Final material producer implementation hold

The final-source-material producer SPAC and implementation plan were written before creating the new TypeScript generator, protected Python preparation CLI, and their semantic/native tests. Independent specification review identified three contract corrections requiring explicit follow-up approval: distinguish immutable waiting origin from current configured COMPLETE evidence; precisely describe staging authorizationRef/transitionId separately from original operationId; obtain validator validity from existing independent evidence rather than requiring unsupported time fields on publisher configurations.

Implementation has been paused. The generator and fixture currently include the incorrect origin equality and publisher time-field constraints; they are not approved for production use. The stage fields are separated in code, but documentation and distinct-identity regression coverage still require correction. Only a pre-implementation missing-module RED check ran; no test cases executed and no successful build, type check, or regression is claimed for these new files. Consolidated correction permission has been requested. Existing assembler/executor and production remain unchanged.

### 2026-10-13: Approved producer contract corrections and build follow-up

The three explicitly approved contract corrections were implemented across the producer SPAC, TypeScript generator, protected Python CLI and their tests. Original immutable waiting evidence is now separate from current configured COMPLETE evidence; stage authorizationRef/transitionId are distinct from the original operationId; publisher configuration bytes are preserved and validator validity is sourced from separate runtime-authority/import evidence bound to the settings fingerprint.

Targeted producer plus unchanged-validator tests passed 92 cases, and the dedicated type check passed. The full engineering gate completed with reference build and all configured type checks passing, Vitest reporting 4,364 passed / 206 skipped, and compiled smoke tests reporting 67 passed. These gates do not establish native preparation success.

After explicit permission to correct ESM/CommonJS compatibility, rebuilding through the existing maintenance-module builder removed the dynamic-require loading failure. Native combination results are currently four passed and one failed: the bundled imported validator CLI also handles producer arguments, causing generator_refused. The success path remains unverified. Separately, independent full spec/security review found that approved.evidenceSha256 must be required and format-validated to match the existing probe contract, even when the configuration fingerprint has been rebound consistently. Consolidated permission has been requested for the CLI-entry isolation and evidence check; neither remaining fix has been applied.

No production data, configuration, business rules or authority were changed. No commit, deployment, activation or genuine production acceptance is claimed.

### 2026-10-13: Approved producer entry and evidence hardening

With explicit user approval, the maintenance builder now isolates imported module CLI guards while preserving the selected entry, and the producer requires a lowercase 64-hex approved.evidenceSha256. Missing/invalid evidence regressions rebind fingerprints and source hashes consistently, so refusal is not merely caused by stale hashes. Independent review found no additional defects in these corrections.

The real offline native preparation combination passed all 6 tests, covering Python CLI, protected reads, actual bundle CLI, final files/receipt and existing-validator verification. The dedicated producer type check and maintenance build passed. Targeted TypeScript tests reported 102 passed and 1 failed: the new builder test launches a macOS temporary-path alias rather than the canonical realpath, preventing its CLI guard from running. The test correction has not been applied; permission to canonicalize its launch path and rerun targeted/full regression was requested. This round is not recorded as an all-green engineering gate.

The bundle under test is /private/tmp/produce-final-source-material-approved-final-20261013.mjs, SHA256 93b0534bac64f618c1f64c2772a5d5b8e8e4d98afe7b6a1c0221418005747836 (400765 bytes). Host sealing is disabled only for this temporary build artifact; protected installation occurs inside disposable isolation. Synthetic evidence does not establish live production authorization, ledger or service health. No Git commit, production deployment or production mutation occurred.

### 2026-10-13: Final source-material producer engineering gate passed

The explicitly approved canonical-path test correction is complete. Final targeted producer/validator/builder tests passed 103 cases; the dedicated producer type check passed. The full reference build and all configured engineering type checks passed. Fresh full Vitest results: 4,369 passed, 206 skipped. Compiled artifact smoke tests: 68 passed. The real network-disabled Linux root preparation combination was rerun: 6 passed in 5.292 seconds. Independent review confirmed both CLI entry isolation and evidenceSha256 validation, and then confirmed the test-only realpath correction with no further findings.

This supersedes the preceding failed builder-test and native-entry status for this engineering stage. Final source-material generation, protected exclusive file publication, receipt creation and offline validator composition now have passing engineering evidence. The 206 skipped cases remain excluded evidence, not successful tests.

This does not establish live production approval, evidence freshness, authority revocation status, database ledger or healthy-origin readiness. Genuine production material preparation, executor preflight, activation and post-cutover closed-loop acceptance remain separate incomplete gates. No Git commit, production deployment, service restart, database write or business-rule change was performed during this stage.

### 2026-10-13: Live production preparation precheck (read-only)

A bounded ubuntu SSH precheck observed all six business services active with NRestarts=0. The active release remains /opt/address-radar/releases/4b48fc2-forward-token-code. Available disk space was 4,255,301,632 bytes. The actual scanner environment keeps gateway delivery, both FOMO capture flags, and full historical mining false. Startup evidence and deployment pins matched their scanner environment references. Runtime configuration is under configured-stability-20261010c; an assumed authority.json at that location is absent, so it is not accepted as a current authority input.

The staged code receipt exists with CODE_STAGED_ONLY, transitionId source-replacement-20261013-final and authorizationRef user-approved-20261013-continue. The prior source preparation receipt remains PREPARED_NOT_IMPORTED_NOT_ACTIVATED. No final-source-materials directory was observed directly under the maintenance root.

At observation time 1791875619651, the existing provider plan/review importedAt was 1791624723230: age 250,896,421 ms, approximately 69.7 hours. This exceeds the existing 86,400,000 ms import evidence-age limit and blocks reuse. The older authority issuance job also has an expired job deadline, but that alone is not evidence that previously issued runtime validator authority has expired; runtime validity requires separate verification. No matching new preparation-approval protocol was found among the bounded top-level approval JSON candidates inspected; this is not an exhaustive absence claim.

Permission has been requested to reverify the previously approved source and request budgets and prepare fresh review/preparation-approval evidence. Changing timestamps on old proof, renewing authority implicitly, or treating a code-stage receipt as source approval is prohibited. No production configuration, service, database or signal state was changed in this read-only stage; engineering completion does not yet establish production execution or closed-loop acceptance.

### 2026-10-13: Fresh source verification blocked by PublicNode HTTP refusal

Following explicit permission to correct the temporary command and re-execute verification, the bounded live check completed three read-only RPC attempts in total. The initial PublicNode request failed with HTTPError. A second request to the same approved source returned HTTP 403, no Retry-After, and no successful RPC result. The third request was the already-approved independent official replay control: HTTP 200 with a JSON-RPC result and no proxy environment present. This supports an access refusal specific to the PublicNode request path, not a general inability of the server to reach RPC services. It does not establish whether the refusal is caused by provider policy, WAF, IP reputation, or request-client policy; no such cause is asserted.

Only exclusive root-private audit files were created:

- source-reverification-1791876855562/source-observations.json: SHA256 28f78b0c5bf70a6f9e1a437d57c008f374ce5063ecf8c651c220c1f119f92997.
- source-http-diagnostic-1791876965640/source-http-diagnostic.json: SHA256 632fab57a27ba9e307adf2aa1f01db2305903532b4adb340bb0538f394b19358.
- source-replay-control-1791877023348/replay-control.json: SHA256 24bec4f35f4f7c91949d1e2c6922fbfde93abb480e0fec07336ea1c2cc806804.

All paths are below /var/lib/address-radar-maintenance-tools. No successful new review, final preparation-approval evidence, replacement hash or final material set was generated. Existing evidence was not edited or re-dated. No active configuration, provider budget, authority, database, service, release or signal state was changed. The three-request limit has been reached and requests have stopped.

The remaining external gate is restoring approved PublicNode access or explicitly approving and validating another independent source. The official replay must not silently become both primary and replay, which would violate the reviewed operator-pairing contract. A user choice has been requested; production activation remains blocked, while the previously passed producer engineering tests remain distinct evidence.

### 2026-10-13: PublicNode edge refusal identified

Under explicit permission to continue diagnosing the same source without changing its budget, one bounded default-Python JSON-RPC request captured HTTP 403 with Cloudflare error 1010 and Ray ID a49cc3dcbb47cf4c-HKG. Official Cloudflare documentation identifies 1010 as client/browser signature denial; the observed response is not the documented 1015 rate-limit error, and no quota-exhaustion conclusion is supported. The earlier official replay control was HTTP 200.

This result applies to the diagnostic Python client, not an untested production Node client. No browser impersonation, proxy/account rotation, challenge bypass, source change or budget change was attempted. New review/preparation approval remains blocked pending permitted source access; the site owner controls the relevant security rule. Provider-facing evidence and precise scope are recorded in 2026-10-13-publicnode-access-diagnostic.md. No support message was sent. Only the diagnostic audit file was added on production; runtime configuration, database, services, release and delivery state are unchanged.

### 2026-10-13: Independent production readiness checks while source access is blocked

No further PublicNode request or client impersonation was attempted. Read-only process inspection found no authority-file environment references in the inspected scanner/console main processes or bounded cgroup process set. This is an observation, not proof of missing authority: alternative dependency injection and the actual running compiled composition have not been ruled out. Existing authority apply/idempotence/preflight receipt files were located, but their existence is not a current runtime-validity or non-revocation proof.

The production closed-loop HTTP endpoint remained readable at observation 1791878318636 and reported coverageVerified=false. Returned stage progress included null values and older timestamps; this does not establish fresh stable progression. No quantitative completion delta is claimed from this snapshot.

A bounded read-only ledger/revocation/schema query was prepared, but its command failed during local shell expansion before SSH/SQL execution. No database query or mutation occurred. Explicit permission to correct transport by passing SQL through standard input and retry with READ ONLY, 2-second statement timeout and 500-millisecond lock timeout has been requested. Live ledger/revocation validation remains incomplete. Production runtime configuration, services, budgets and delivery remain unchanged.

### 2026-10-13: Live read-only ledger and validator validity verified

The user-approved stdin SQL transport correction succeeded. All three checks used BEGIN READ ONLY, statement_timeout=2000ms, lock_timeout=500ms and ROLLBACK. No database mutation or external RPC request occurred.

The bounded import-ledger query returned the execution validator authority import, six provider-contract imports, and the address-only registry import for production-20261006-v1. Their revoked_at values were null. The actual runtime validator table is wallet_service_fact_validators, not a table whose name contains validator_authority. At database observation 1791878698112, validator address-radar-rpc-replay-v1 had valid_from=1791458409999, valid_until=1794050409999, revoked_at=null and currently_valid=true. This establishes live database validity/non-revocation at that observation, not full running-client key or authority-configuration binding.

The provider budget table still contains the original six contracts, each capped at 60 requests per 60,000 ms and concurrency 1. Solana primary remains rpc-solana-source at https://mainnet.helius-rpc.com; replay remains https://api.mainnet-beta.solana.com. PublicNode is not among the returned production contracts. Thus the proposed source replacement is still preparatory, not active.

At the subsequent live cooldown observation, rpc-solana-source and rpc-base-source had cooldown_active=true; rpc-bsc-source had cooldown_active=false. A cooldown does not by itself identify its reason or prove stable processing on the other chain. No claim is made that the stored validator configuration or runtime composition has been fully verified merely because the database validator is valid.

These results narrow the prior missing-authority suspicion: absence of an environment reference is not proof of absent database authorization. Remaining independent gates include PublicNode permitted access and fresh source review, exact runtime material/key/fingerprint/origin binding, final preparation and execution acceptance, and diagnosis of active source cooldowns. Engineering completion remains separate from live closed-loop coverage; no production configuration, services, budget or delivery state was changed by these checks.

### 2026-10-13: Source cooldown failure attribution

Bounded, read-only service-journal sampling confirmed active Solana execution attempts. In the sampled failure events, getSignaturesForAddress was classified execution_rpc_rate_limited with transport=http and subcategory=rate_limit; later getGenesisHash and getSignaturesForAddress attempts were rejected locally with execution_rpc_provider_budget_unavailable, budgetReason=cooldown and transport=local. These are distinct upstream and local-protection outcomes, not evidence that every logged failure caused a remote request. Numeric code was null in these events; no actual HTTP 429 or current credits-exhaustion response is claimed from this sample.

No attributable Base failure record was found in the bounded per-service samples. This is not an exhaustive absence claim or evidence that Base is healthy. A limited read-only schema query confirmed that provider budgets persist cooldown_until but no last-error reason/status field; provider leases also do not store those diagnostics. The exact initiating Base error remains unverified.

These live attempts further narrow the earlier authority-environment suspicion: an absent environment reference alone is not a demonstrated primary cause. Runtime validator validity was established in the preceding read-only gate. PublicNode remains a separate, not-yet-active replacement source; its diagnostic Python-client Cloudflare 1010 must not be confused with current Helius execution failures.

Proposed next engineering scope, awaiting user confirmation: enrich existing RPC failure/cooldown logs with sanitized provider identity, method, HTTP status, JSON-RPC error code, classification and retry/cooldown context. Preserve request budgets, retry decisions, admission rules and source/operator pairing; do not add database tables or print raw credentials, request parameters, response bodies or keys. Cover Solana/Base with regression and offline integration checks. Do not infer quota exhaustion from HTTP 429 alone or mislabel local cooldown as an upstream response. No implementation, deployment, database mutation, source retry or protection bypass occurred in this diagnostic stage.

### 2026-10-13: RPC observability implementation authorized

The user approved extending existing real-client/cooldown diagnostics with sanitized provider identity, HTTP/JSON-RPC status and classification, with Solana/Base regressions and isolated acceptance. Scope excludes new database tables, budget changes, retry-policy changes, business-rule changes and PublicNode access bypass. The detailed scope, exact source/test files, privacy contract and acceptance gates are recorded in 2026-10-13-rpc-observability-spac.md before implementation.

Implementation is in progress. No new test pass, deployment or production error-cause resolution is claimed at this point. Source access and final production-material acceptance remain independent gates.

### 2026-10-13: RPC instrumentation checkpoint awaiting consolidated corrections

The six-file observability implementation is written. Targeted results are 445 passed / 3 failed; the failures are two overbroad privacy assertions and an incomplete loopback fixture. Correct reference-project build order resolves the initial type-visibility failure; reference build and script type check now pass. Independent review additionally requires Proxy rejection before instanceof in the budget observer to preserve diagnostic isolation. A single correction request covers these remaining items. No production, schema, budget, retry, source or eligibility change occurred; the new instrumentation has not been deployed or fully accepted.

### 2026-10-13: RPC observability engineering gate passed

The user reversed the temporary hold and explicitly authorized completing the pending instrumentation corrections. All approved changes and the Proxy no-trap/original-rejection regression are complete. Fresh targeted tests: 449 passed. Full reference build and all configured engineering type checks: passed. Full Vitest: 4,398 passed, 206 skipped. Compiled smoke tests: 68 passed. Independent review: prior Proxy finding closed, no new findings.

The real local HTTP loopback covers Solana/Base source errors and reviewed Base replay through actual adapters and the sink, with a synthetic database port. Logs now have closed native identity/status/timing context without changing request budgets, retry policy, business eligibility or database schema. Engineering acceptance is recorded in 2026-10-13-rpc-observability-spac.md.

No commit or production deployment occurred. Actual Base initiating failure, permitted PublicNode access, fresh production source approval, final material binding, activation and sustained closed-loop coverage remain separate unfinished production gates. The new instrumentation cannot supply live failure evidence until an authorized release containing it is deployed.
