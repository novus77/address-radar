# Address Radar Forward Opportunity Discovery Implementation Plan

> **For agentic workers:** Use the executing-plans skill in this session. Do not delegate to subagents. Execute dependency-ordered tasks with phase checkpoints and preserve the user's one-read / single-patch workflow.

**Goal:** Deliver the approved forward trade-to-opportunity-to-target-to-radar workflow without making FOMO identity lookup or legacy token mining a prerequisite.

**Architecture:** Reuse the six-service system, canonical events, existing source/price stores, identity trust, economic matching, automation queue and outbox. Add bounded prospective window/scope contracts and small adapters; preserve legacy evidence and jobs in a gated cohort. Source capability and business thresholds are release gates, not optimistic assumptions.

**Tech Stack:** TypeScript, Node 24, pnpm workspace, SQLite, Vitest, Playwright, existing systemd release deployment.

**Scope authority:** `2026-10-02-forward-opportunity-radar-spac.md`. This turn creates documents only. No tests, commits, migration or deployment have been performed. Existing standing stage-by-stage execution preferences apply after the user approves this final plan; production cutover and Gateway activation remain explicit gates.

---

## Execution protocol

- Map exact files before each task; inspect each required file once during that task. The paths below marked Create are proposed, not existing capabilities.
- Use existing schema ownership and exports; do not create an equivalent table if the actual store already supports the invariant.
- Implement one focused patch/application per task; do not change unapproved business thresholds.
- The code examples specify proposed pure contracts/tests, not ready-to-run production integration.
- New public fields, migrations and irreversible production operations require their scoped approval.
- Tests and commands below are planned, not executed. Do not infer successful acceptance from a command listed here.
- After each phase: targeted tests, full tests, types, build, package smoke, boundaries, browser tests; then scoped commit, safe deployment and readonly acceptance before the next phase.
- Preserve delivery disabled, user authentication tabs, legacy data and auditable identity conflicts. Do not recreate the cancelled hourly monitor.

## Actual reuse map

| Layer | Existing files | Planned change |
|---|---|---|
| FOMO capture | `apps/scanner/src/fomo-browser-collector.ts`, `fomo-cdp-observer.ts`, `fomo-live-collector.ts`, `fomo-socket-provenance.ts` | Reuse origin validation/durable capture; add coverage and selectable ownership, not automatic follows |
| Durable inbox | `packages/database/src/fomo-live-inbox.ts` | Reuse append/replay/receipt semantics for bridge ingestion |
| Identity | `packages/identity/src/monitoring-registry.ts`, `manual-resolution-service.ts`, `identity-resolution-service.ts` | Separate monitoring/manual radar authorization and optional wallet mapping |
| Canonical evidence | `packages/aggregation/src/canonical.ts`, `repository.ts`, `evidence.ts`, `bundle.ts` | Preserve matched economic event and correlated-wallet semantics |
| Provider routing | `apps/automation/src/provider-route-registry.ts`, `token-fact-orchestrator.ts`; market clients in `packages/collectors/src` | Capability-aware prospective acquisition and scoped repairs |
| Legacy planners | `apps/automation/src/token-partition-planner.ts`, `trader-backfill-planner.ts`; `apps/wallet-analysis/src/historical-stage-planner.ts` | Guard old batch generation and claims |
| Evaluation | `apps/automation/src/candidate-evidence-worker.ts`, `trader-ability-worker.ts`, `apps/wallet-analysis/src/opportunity-history.ts`, `packages/scoring/src/trader-ability-evaluator.ts` | Versioned forward sample input; existing admission rules retained |
| Signal delivery | `apps/automation/src/signal-projection-worker.ts`, `packages/signal-engine/src/policy.ts`, `packages/delivery/src/gateway-client.ts` | Semantic updates, current-buy policy result and existing outbox |
| Operations/UI | `apps/console/src/application.ts`, `current-opportunity-ability-progress.ts`, `packages/observability/src/data-flow-progress.ts` | Cohort-aware counters and readable forward state |

## Phase 1 — Forward policy and legacy work isolation

### Task 1: Pure origin and time contracts

**Create:** `packages/domain/src/forward-policy.ts`, `packages/domain/test/forward-policy.test.ts`.
**Modify:** `packages/domain/src/index.ts` after locating its actual export convention.

- [ ] Read actual domain and time contracts once; define work origin, generation and immutable observation clocks from SPAC.
- [ ] Add failing tests for new live/scoped repair work versus legacy work, invalid timestamps and no implicit pre-discovery recovery.
- [ ] Implement small pure functions; keep seven-day capture and 30-day sample constants separate.
- [ ] Run the targeted suite, then phase quality gate.

Contract tests to implement:

```typescript
import { describe, expect, it } from "vitest";
import { extendBuyerCaptureExpiry, opportunityExpiresAt } from "../src/forward-policy.js";

const DAY = 24 * 60 * 60_000;
describe("forward time windows", () => {
  it("extends from event occurrence without shortening a later deadline", () => {
    expect(extendBuyerCaptureExpiry(10 * DAY, 2 * DAY)).toBe(10 * DAY);
    expect(extendBuyerCaptureExpiry(10 * DAY, 8 * DAY)).toBe(15 * DAY);
  });
  it("keeps the purchase window independent", () => {
    expect(opportunityExpiresAt(DAY)).toBe(31 * DAY);
  });
});
```

Planned command: `pnpm exec vitest run packages/domain/test/forward-policy.test.ts`.
Expected: occurrence-time arithmetic, invalid-time rejection and independent windows pass.

### Task 2: Persist generation, origin and auditable holds

**Create:** `packages/database/src/forward-policy-store.ts`, `packages/database/test/forward-policy-store.test.ts`.
**Modify:** `packages/database/src/index.ts` and actual existing migration owner located before editing.
**Create:** `scripts/plan-forward-cutover.ts`, `scripts/migrate-forward-policy.ts`.

- [ ] Map current jobs, leases, generation/version stores and migration conventions; reuse stores where possible.
- [ ] Add tests for idempotent migration, retained old rows, unknown-origin classification and fenced pre-cutover claims.
- [ ] Implement additive generation/hold audit; dry-run classification outputs legacy/live/repair/manual/unknown cohorts without mutating them.
- [ ] Make application of classification bounded, explicit and resumable; do not bulk-cancel jobs or erase audit.
- [ ] Test a restart after partial application and a rollback worker attempting to claim held jobs.

Planned command: `pnpm exec vitest run packages/database/test/forward-policy-store.test.ts`.
Expected: existing evidence/job IDs unchanged; holds survive restart; unknown jobs are visible, not guessed.

### Task 3: Gate every legacy enqueue and claim route

**Modify:** `apps/automation/src/runtime.ts`, `token-partition-planner.ts`, `trader-backfill-planner.ts`, `token-fact-orchestrator.ts`, `consumer-history-recovery.ts`; `apps/scanner/src/recovery-runtime.ts`; `apps/wallet-analysis/src/historical-stage-planner.ts`, `historical-cli.ts`.
**Create:** `apps/automation/src/forward-work-gate.ts`, `apps/automation/test/forward-work-gate.test.ts`.

- [ ] Trace runtime planners, workers, terminal reopening, manual endpoints and recovery consumer entry points before choosing integration boundaries.
- [ ] Test that old partition mining and automatic initial-wallet history cannot enqueue or claim in forward mode.
- [ ] Test that live wallet monitoring, forward sample enrichment and proven post-discovery gap repair remain eligible.
- [ ] Require explicit origin on new tasks; classify existing tasks through Task 2's audited mapping.
- [ ] Enforce the same scope at enqueue and claim; prevent scanner recovery from bypassing the automation guard.

Planned command: `pnpm exec vitest run apps/automation/test/forward-work-gate.test.ts apps/automation/test/runtime-planning.test.ts apps/automation/test/trader-backfill-planner.test.ts`.
Expected: no new legacy batch work and no starvation of allowed forward work.

**Phase gate:** Deploy guards in non-cutover/shadow mode only. Activation requires a backup, resolved origin report and explicit cutover approval. Service activation alone does not prove guards cover all routes.

## Phase 2 — User/wallet registries and explicit authorization

### Task 4: Independent channel targets and manual radar grants

**Create:** `packages/identity/src/target-authorization.ts`, `packages/identity/test/target-authorization.test.ts`.
**Modify:** `packages/identity/src/monitoring-registry.ts`, `manual-resolution-service.ts`, `identity-resolution-service.ts`; existing database persistence owner and console handlers found through `apps/console/src/application.ts`.

- [ ] Map current trust, lifecycle, monitor switches and manual tag storage; do not equate a high-confidence row with confirmed ownership.
- [ ] Test immediate monitoring for FOMO-only and wallet-only entries, idempotent re-add and ambiguous ownership exclusion.
- [ ] Add explicit grant/revocation audit independent of ordinary notes/tags and derived capability.
- [ ] Ensure a manual grant does not override missing identity trust, disabled monitoring or unrelated signal gates.
- [ ] Confirm the resolved eligible-target predicate before wiring buyer-window extension or signal participation.

Planned command: `pnpm exec vitest run packages/identity/test/target-authorization.test.ts packages/identity/test/fomo-trust-parity.test.ts packages/identity/test/fomo-monitoring-registry.test.ts`.
Expected: notes never grant radar; approved grants remain distinguishable; no wallet is required for the trusted FOMO channel.

**Phase gate:** A real manually added target appears in the correct channel registry and its authorization basis is visible. No automatic platform following or automatic old-wallet backfill.

## Phase 3 — Reliable FOMO and onchain acquisition

### Task 5: Unified capture ownership and reliable bridge

**Create:** `packages/collectors/src/fomo/bridge-client.ts`, `packages/collectors/test/fomo-bridge-client.test.ts`; `apps/console/src/fomo-bridge-ingestion.ts`, `apps/console/test/fomo-bridge-ingestion.test.ts`.
**Modify:** FOMO capture modules and `packages/database/src/fomo-live-inbox.ts`; console API wiring.

- [ ] Trace server-owned capture versus device-owned Live Feed; select the deployment mode only after confirming source ownership and permissions.
- [ ] Define versioned scrubbed envelopes, collector authentication, event idempotency and durable acknowledgement.
- [ ] Add tests for disconnect, commit-before-lost-response, duplicate delivery, truncated payload, revision conflict and wrong collector identity.
- [ ] Reuse inbox persistence; acknowledge only after server commit, preserving replay cursor on failure.
- [ ] Persist desired/subscribed/observed states and gap ranges; implement source-only failure alerting without automatic account rotation/navigation.
- [ ] Define bounded spool/retention and request budgets as deployment gates; no secrets in event logs.

Planned command: `pnpm exec vitest run packages/collectors/test/fomo-bridge-client.test.ts apps/console/test/fomo-bridge-ingestion.test.ts apps/scanner/test/fomo-durable-collector.test.ts apps/scanner/test/fomo-browser-recovery.test.ts`.
Expected: transport retry produces one canonical event; logout is distinguishable from no observed trade.

### Task 6: Source capability and shared token buyer acquisition

**Create:** `packages/collectors/src/forward-trade-capability.ts`, `apps/scanner/src/forward-token-trade-collector.ts`, `apps/scanner/test/forward-token-trade-collector.test.ts`.
**Modify:** `apps/scanner/src/runtime.ts`, `apps/scanner/src/cli.ts`, provider registry and actual shared gate callers located during this task.
**AVE ownership:** Task 8A implements supplemental market/K-line support only; AVE discovery is excluded.

- [ ] Inventory configured five-chain sources by token discovery, spot quote, historical price, attributable trade and gap replay capabilities.
- [ ] Obtain scrubbed real source fixtures where authorized; no assumed AVE buyer endpoint or exhaustive DexScreener discovery.
- [ ] Test that price/holder responses never manufacture a buyer; validate chain/CA, pool orientation, trade ID and execution status.
- [ ] Share one token transaction cursor among many samples/targets, retain finality/reorg behavior and separate it from known-wallet monitoring.
- [ ] Keep AVE hot-list discovery, holder mining and direct alerts outside this task; supplemental market requests belong to Task 8A.
- [ ] Gate production capacity expansion on approved provider budgets and real coverage; unsupported chains remain explicitly unavailable.

Planned command: `pnpm exec vitest run apps/scanner/test/forward-token-trade-collector.test.ts apps/wallet-monitor/test/runtime.test.ts`.
Expected: actual below-100K buys can be saved when source supports them; market-only adapters declare the missing buyer capability.

**Phase gate:** At least one real trusted FOMO event and one real attributable wallet event reach durable storage. Each chain has a documented actual capability, including unavailable cases. This does not require an impossible universal coverage claim.

## Phase 4 — Token observation windows and shared market tracking

### Task 7: Transactional discovery and extension store

**Create:** `packages/database/src/forward-token-store.ts`, `packages/database/test/forward-token-store.test.ts`; `apps/automation/src/forward-token-window-planner.ts`, `apps/automation/test/forward-token-window-planner.test.ts`.
**Modify:** database exports/migration owner, scanner observation caller, automation planner wiring.

- [ ] Implement immutable first-discovery time and initial seven-day capture expiry.
- [ ] Atomically insert a unique milestone/economic-buy trigger and apply max(old expiry, occurrence + seven days).
- [ ] Test duplicate redelivery, repeated current quotes, concurrent triggers, delayed events, threshold oscillation and re-open after expiry.
- [ ] Distinguish first observed milestone from first historical crossing. Reject FDV substitution and invalid market identity.
- [ ] Stop token-level new buyer discovery at expiry; keep explicitly monitored target ingestion and active sample market tracking running.

Planned command: `pnpm exec vitest run packages/database/test/forward-token-store.test.ts apps/automation/test/forward-token-window-planner.test.ts`.
Expected: no duplicate renewal; expiry cannot shorten; sample tracking survives buyer capture expiry.

### Task 8: Market fan-out and bounded scoped repair

**Create:** `apps/automation/src/forward-sample-demand-planner.ts`, `apps/automation/test/forward-sample-demand-planner.test.ts`.
**Modify:** `apps/automation/src/token-fact-orchestrator.ts`, `provider-route-registry.ts`; `apps/scanner/src/recovery-runtime.ts`; existing demand stores and quote clients only where needed.

- [ ] Reuse token-level price observations for all samples without repeated per-wallet fetches.
- [ ] Define due times/cadence through approved source policy, not hard-coded speculative frequency.
- [ ] Restrict repair to actual new-sample fields and demonstrated post-discovery gaps; no pre-discovery buyer backfill.
- [ ] Test unsupported routes, rate cooldown, delayed partial results, field-level completion and starvation by busy live lanes.
- [ ] Release waiting leases and use existing retry/idempotency contracts; temporary failure never becomes fake satisfaction.

Planned command: `pnpm exec vitest run apps/automation/test/forward-sample-demand-planner.test.ts apps/scanner/test/recovery-runtime.test.ts`.
Expected: allowed gaps remain visible and all requests respect the shared source gate.

**Phase gate:** Real token trace shows pre-100K live capture, observed 100K screening eligibility, shared market updates and explained window expiry. Any missing real milestone scenario remains awaiting verification.

## Phase 5 — Opportunity evidence and 30-day capability

### Task 9: Execution-based samples and quality-controlled peaks

**Create:** `packages/scoring/src/forward-opportunity-evaluator.ts`, `packages/scoring/test/forward-opportunity-evaluator.test.ts`; `packages/database/src/forward-opportunity-store.ts`, `packages/database/test/forward-opportunity-store.test.ts`.
**Modify:** existing execution basis integration, source/consumer fact revision propagation, exports.

- [ ] Map actual economic event/entry amount/price provenance; derive no price from today's spot quote.
- [ ] Test amount 49.99 versus 50, stable nominal annotation, price missing, pre-entry high, entry-overlapping candle, exactly 3x/5x and sample expiry.
- [ ] Version samples and peak evidence. Preserve both uncertain and proven observations; do not fabricate numeric quality limits.
- [ ] Record hit, observing, awaiting verification, insufficient coverage and complete-without-hit separately.
- [ ] Require coverage proof for complete non-hit; do not treat provider empty or sample expiry as zero performance.
- [ ] Test late real execution revisions invalidate/recompute only affected evidence, retaining the revision audit.

Planned command: `pnpm exec vitest run packages/scoring/test/forward-opportunity-evaluator.test.ts packages/database/test/forward-opportunity-store.test.ts`.
Expected: qualifying observed opportunities need real entry and reliable post-entry evidence; no sale is necessary.

### Task 10: Screen at 100K and reuse admission

**Create:** `apps/automation/src/forward-opportunity-worker.ts`, `apps/automation/test/forward-opportunity-worker.test.ts`.
**Modify:** `apps/automation/src/candidate-evidence-worker.ts`, `trader-ability-worker.ts`, runtime dispatcher; `apps/wallet-analysis/src/opportunity-history.ts`, `packages/scoring/src/trader-ability-evaluator.ts` only for input-cohort integration.

- [ ] Snapshot existing approved admission predicates and thresholds into regression fixtures before integration.
- [ ] Test a buy below 100K whose post-entry high already qualifies when 100K is observed; no earlier historical buyer query is issued.
- [ ] Continue checking saved samples after the milestone; candidates need not qualify at the crossing instant.
- [ ] Count distinct token opportunities without counting 3x and 5x twice; keep total observable sample denominator and 30-day maturity separate.
- [ ] Exclude legacy batch input from new forward facts; retain old strategy snapshots and approved eligibility basis without rewriting them.
- [ ] Dispatch ability/admission by semantic revision; no timestamp-only queue expansion or mandatory wallet resolution.

Planned command: `pnpm exec vitest run apps/automation/test/forward-opportunity-worker.test.ts apps/automation/test/candidate-evidence-worker.test.ts apps/automation/test/trader-ability-worker.test.ts`.
Expected: existing admission rules unchanged; one opportunity does not imply unapproved stable status.

**Phase gate:** A real purchase with reliable opportunity evidence traces through sample, evidence and existing admission result. Newly collected immature cohorts are labelled immature, not fully stable.

## Phase 6 — Radar, console and rollout

### Task 11: Dual-source canonical aggregation and signal receipts

**Create:** `apps/automation/test/forward-signal-closure.test.ts`.
**Modify:** `packages/aggregation/src/canonical.ts`, `evidence.ts`, `service.ts`; `apps/automation/src/signal-projection-worker.ts`; existing signal policy/receipt integration without relaxing gates.

- [ ] Test one matched FOMO/onchain buy versus two genuine distinct buys; ambiguous matches cannot inflate independent participant count.
- [ ] Test manual grant, disabled target, conflicting ownership and revocation while queued.
- [ ] Test a late event/replay updates analysis but cannot create a new live alert; preserve existing live-time policy.
- [ ] Keep bundle checks and signal thresholds; update once per semantic revision with traceable producer/consumer receipt.
- [ ] Verify generated signal/outbox state while Gateway delivery remains false.

Planned command: `pnpm exec vitest run apps/automation/test/forward-signal-closure.test.ts packages/signal-engine/test/policy.test.ts packages/aggregation/test/canonical-trader-events.test.ts`.
Expected: a qualifying current event contributes once; delivered status requires a delivery receipt.

### Task 12: Forward progress API, trace and Chinese console

**Create:** `apps/console/src/forward-progress.ts`, `apps/console/test/forward-progress.test.ts`, `scripts/audit-forward-radar.ts`.
**Modify:** `apps/console/src/application.ts`, actual UI source located before editing, `packages/observability/src/data-flow-progress.ts` and existing progress views.

- [ ] Define response cohorts/units for tokens, trades, users, wallets, opportunities and signals; no mixed denominator.
- [ ] Expose source connection/subscription/capture state, first discovery, buyer expiry, 100K observation, sample expiry, quality and authorization basis.
- [ ] Show one entity per row with chain/source/tag/state/time filters; make missing-data explanations Chinese.
- [ ] Add trace links from raw event to execution to price to evidence to admission to aggregation/outbox.
- [ ] Ensure readonly endpoints neither migrate nor schedule jobs; bounded queries cannot leave runaway diagnostic processes.
- [ ] Browser-test disabled/expired/unknown states, narrow viewport and reconnect behavior.

Planned command: `pnpm exec vitest run apps/console/test/forward-progress.test.ts` followed by `pnpm test:e2e`.
Expected: render and API tests pass; no active work is created by refreshing the dashboard.

### Task 13: Safe production cutover and honest acceptance

**Create:** `scripts/deploy-forward-radar-release.sh`, `docs/specs/2026-10-02-forward-radar-acceptance.md` during execution, not this document-only turn.
**Reuse:** existing backup/deployment procedure represented by `scripts/deploy-execution-basis-release.sh`; inspect once before implementing forward wrapper.

- [ ] Record final approved quality/capability/budget/authentication settings and explicitly approved cutover time policy.
- [ ] Run origin classification dry-run and baseline audit with strict timeouts; retain release and restore evidence.
- [ ] Verify backup, additive migration and rollback compatibility in the permitted test environment.
- [ ] Deploy without Gateway activation; drain/fence legacy claims, persist generation and activate only forward work.
- [ ] Run readonly real-trace acceptance; document passed, awaiting applicable event and unavailable-provider cases separately.
- [ ] Exercise session loss/recovery, restart, duplicate transfer and scoped gaps without manufacturing production trades.
- [ ] Report operational readiness separately from elapsed 30-day stable capability validation; do not restart deleted automations.

**Phase gate:** User approves the acceptance report. Gateway activation, if desired, is a separate action. Full implementation is not full five-chain acquisition proof when an external provider remains unavailable.

## Mandatory quality gate after each implemented phase

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:packages
pnpm check:boundaries
pnpm test:e2e
```

Run the task's targeted suite first. Expected: all suites/types/build/import/boundary/browser checks pass. If no browser tests apply, say so; `--pass-with-no-tests` is not browser behavior proof. Failed checks block commit/deployment of that phase until repaired within authorized scope.

Use a scoped commit after checks and explicit execution approval; never include unrelated user changes. Commit subjects use English, such as `feat: add forward token observation windows`. Reuse the actual deployment procedure, verified backup, current/rollback release retention and disk guard; do not invent server paths, credentials or a new service topology.

## Migration mapping and rollback checks

| Population | Treatment | Required assertion |
|---|---|---|
| Old raw market/trade events | Preserve original IDs, timestamps and source | No deletion or relabeling as forward |
| Historical snapshots/evidence | Preserve strategy and provenance | No automatic grant/capability promotion |
| Legacy pending/terminal jobs | Audited hold; guard producers and consumers | No re-open through capability revision |
| Leased/running legacy jobs | Drain or fence before activation | No late legacy result creates forward work |
| Existing monitored targets | Preserve switches and explicit authorized basis | No ordinary tag becomes radar grant |
| Forward events during shadow/cutover | Keep durable records and generation | Replay cannot duplicate or pretend to be live |
| Unsupported source coverage | Explicit unavailable/partial | Not marked completed by empty response |
| Rollback binary | Validate hold/generation compatibility | Does not reactivate legacy mining or delete new facts |

## Coverage checklist

- [ ] R01: Task 6 validates five-chain capability, Tasks 12-13 show unavailable coverage honestly.
- [ ] R02/R14: Tasks 1-3 and 13 isolate legacy work, preserve data and activate explicit generation.
- [ ] R03/R04/R09/R10: Tasks 6-8 collect below 100K, deduplicate extension and retain sample tracking without trigger lookback.
- [ ] R05/R06/R07/R08: Tasks 9-10 retain real entry, USD 50 threshold, 3x/5x evidence and independent 30-day maturity.
- [ ] R11/R12: Task 4 and 11 separate manual grants, identity trust and system admission.
- [ ] R13: Task 5 source-local failure handling and Task 13 real recovery acceptance.
- [ ] R15: Tasks 5 and 11-13 preserve replay semantics and Gateway-disabled rollout.

## Remaining release decision gates

Use the companion SPAC decision register. Numeric price-quality thresholds, coverage completeness, budget/cadence/capacity, exact extension tier/predicate binding, transport ownership and credentials, source replay support, retention and production activation are not silently assigned defaults by this plan. Their unresolved state blocks the affected activation, not unrelated pure-domain or fixture work.

## Delivery record

For each phase record: files changed, tests actually executed/results, commit, deployed release, migration/backup identifiers, readonly real trace, remaining decision gates and rollback state. Implementation remains pending until executed. Do not claim completion from this plan's existence.

## Approved amendment — Task 8A: AVE supplemental market and K-line adapter

**Execution position:** Phase 4, after Task 8 and before the Phase 4 acceptance gate. It depends on Task 6's capability contract and existing shared budget infrastructure. It does not add a discovery path to Task 6.

**Create:** `packages/collectors/src/ave-market-client.ts`, `packages/collectors/test/ave-market-client.test.ts`, `apps/automation/test/ave-supplemental-routing.test.ts`.
**Modify:** `packages/collectors/src/index.ts`, `apps/automation/src/provider-route-registry.ts`, `token-fact-orchestrator.ts`, and scanner provider/configuration wiring in `apps/scanner/src/cli.ts` only where required by the verified current integration.

- [ ] Inspect current field/range demand contracts, provider clients and shared request gate once; register AVE as a supplemental source for known tokens only.
- [ ] Verify official endpoint permissions, current quota/cost, five-chain support, K-line ranges and response timestamp/identity semantics using authorized fixtures; do not assume all chains are supported.
- [ ] Obtain user approval for bounded spend/rate, route order, cross-check cadence and restricted key provisioning before live requests or activation.
- [ ] Write fixture tests for valid spot and K-line responses, missing fields, malformed identity, FDV-only response, unsupported chain, wrong time units, completed versus open candles, partial history and entry-overlapping peaks.
- [ ] Implement an independently authored adapter with finite timeout, response bounds, secret redaction, capability declarations and shared request/cooldown/quota coordination. No copied third-party project code.
- [ ] Route only existing missing-field/range or explicit conflict-validation demands to AVE; no hot-list request, buyer enumeration, broad history task or credential rotation.
- [ ] Persist source-separated facts and coverage. A current quote never substitutes for entry price or historical range; conflicting providers stay pending verification.
- [ ] Test that concurrent samples share a token fetch, duplicate completion does not duplicate evidence, late poorer facts do not downgrade proven evidence, and unavailable AVE leaves healthy primary routes usable.
- [ ] Keep activation disabled until capability, authentication and budget gates pass. Add readiness and failure explanations to Task 12's source view without exposing the key.
- [ ] Run targeted and complete phase tests, then commit/deploy under the phase protocol. Use a real known-token supplemental trace for acceptance; otherwise record awaiting verification.

Planned targeted command:

```bash
pnpm exec vitest run packages/collectors/test/ave-market-client.test.ts apps/automation/test/ave-supplemental-routing.test.ts
```

Expected: AVE supplements supported market facts and price ranges without changing discovery, buyer collection, admission or signal policy. Empty/partial/quota-failed requests never masquerade as complete repair.

**Regression assertions:** zero AVE trending requests; zero new tokens sourced from AVE hot lists; zero new buyer samples sourced from holder lists; no timestamp-refresh window renewal; no AVE-only alert; Gateway remains disabled.

**Delivery evidence:** scrubbed known-token request/response trace, approved budget configuration, source timestamps and coverage bounds, canonical fact revision, scoped demand satisfaction, affected consumer result, actual test/commit/release records. Report costs and provider coverage only from verified facts, not estimates presented as account billing.

## Approved amendment — Task 5A: Browser Live Feed ingestion and consumer closure

**Source selection:** FOMO browser Live Feed only. Third-party FOMO API adapters and the previously supplied credential are excluded. This supersedes the optional FOMO API source choice; Task 8A's AVE supplement is unchanged.

**Execution position:** Extend Phase 3, following Task 5's transport foundation and before the Phase 3 gate. Integrate the semantic matching and consumer trace with Tasks 9-12 rather than creating a second scoring or signal pipeline.

**Inspect/reuse:** `apps/scanner/src/fomo-browser-collector.ts`, `fomo-cdp-observer.ts`, `fomo-live-collector.ts`, `fomo-socket-provenance.ts`; `packages/database/src/fomo-live-inbox.ts`; `packages/collectors/src/fomo/live-activity.ts`, `live-target-filter.ts`; existing identity registry, execution contracts, canonical matching and transactional task dispatch.

**Modify where required:** the reused capture/normalization/inbox modules; authenticated console ingestion wiring for device-owned capture only; existing database migrations/exports only when current persistence cannot provide the required receipt or provenance. Task 12 owns console views. File additions depend on the initial wiring/schema inspection, not an assumption that all stores are absent.

### Implementation work packages

- [ ] Trace the existing page-message-to-inbox path and document actual deployed versus unaccepted components. Resolve server-owned versus device-owned capture before wiring transport.
- [ ] Passively attach to the approved page, validate source provenance, and preserve login pause. No repeated tab opening, automatic account rotation, follows or trading.
- [ ] Persist scrubbed business messages with source/session/schema/time provenance before parsing. Explicitly preserve unknown formats, parse failures and missing timestamps.
- [ ] Implement atomic server receipts and durable local checkpoints where a bridge is needed; replay after lost acknowledgement must produce one stored source event.
- [ ] Atomically commit normalized events and durable downstream work intent. Ensure raw-received, parsed, normalized and consumer-completed states are not interchangeable.
- [ ] Separate buys/sells/transfers/theses/market notices; validate chain/contract, ownership, nominal stable amount flags and real entry basis. Missing data remains explained and recoverable without inventing prices.
- [ ] Match the internal registry by stable user identity; retain unresolved FOMO actions without requiring a wallet, and quarantine identity conflicts without merging.
- [ ] Reuse economic matching for FOMO/onchain observations. Distinct fills on one position remain distinct; uncertain matches cannot inflate evidence or participant count.
- [ ] Implement bounded buffering, backpressure and source-local pause/recovery after retention/capacity settings are approved. Persist disconnect gaps; unsupported source replay must remain uncovered.
- [ ] Route valid current events to existing sample/evidence/ability/aggregation consumers with versioned result receipts. Late replay is research input, not a new live alert.
- [ ] Expose Task 12's source counters, last message/commit/trade times, quarantine, missing execution, unresolved identity, matching and consumer backlog, with defined measurement intervals.

### Targeted tests and phase gates

Extend existing test suites or create focused tests only where equivalent coverage is absent. Test valid buys, below-threshold buys, nominal stable amount flags, missing entry, transfer-only activity, malformed/source-invalid messages, renamed handles, unresolved ownership, mapping conflict, repeated source ID, distinct fills under one position, wallet duplicates, ambiguous matching, lost acknowledgement, restart, session loss and late replay.

Targeted tests must exercise the full transaction boundary, not just a parser mock. Run the mandatory complete phase quality gate before any scoped commit/deployment under separate execution approval. Test commands and actual file names are recorded after the one-pass implementation inspection; no tests were run for this document amendment.

**Real acceptance chain:** approved page -> raw persisted event -> parser outcome -> normalized event -> ownership/execution result -> economic match -> sample or explicit waiting reason -> durable consumer result -> console trace. Evidence/admission/signal scenarios pass only when their existing real-world gates are satisfied; no transaction is created merely to satisfy acceptance.

**Regression assertions:** zero third-party FOMO API requests; no API secret in files or telemetry; no unsolicited tabs/follows/account rotation; no duplicate economic buy; no guessed entry price; no missing-data success receipt; no legacy batch mining; independent wallet/market operation during FOMO outage; Gateway delivery remains disabled.

**Delivery record:** fixture/test results, real scrubbed event trace, transport ownership, approved capacity/retention values, source gap/coverage limitations, actual commit/release and migration identifiers, and per-consumer passed/waiting/unverified states. Do not label the full Live Feed route complete from collector connection or inbox growth alone.

## Approved amendment — PostgreSQL foundation and fifteen-day raw lifecycle

This amendment adds the storage workstream and overrides the earlier unresolved FOMO transport choice. Server-owned browser capture persists directly to the authoritative inbox; a device bridge and third-party FOMO API are excluded from this release. Task 5's bridge scenarios are future capability, not mandatory current scope. The companion SPAC's resolved policy register is authoritative for capability, radar, milestone extension and dispatch rules.

### Phase ordering and dependency updates

Extend Phase 1 with P1-P2 before choosing schemas or adapters. Implement P3-P4 in an isolated environment before Phase 3's PostgreSQL capture gate. Existing pure-domain policy work can proceed independently; PostgreSQL-dependent consumers cannot be declared complete using SQLite-only tests. P5 joins Task 13's controlled production cutover. P6 joins Task 12's visibility and the final acceptance report. This is not approval to start migration or erase old data.

### P1 — Actual workload and persistence boundary inventory

- [ ] Record table sizes/growth, hot queries, write and lease patterns, indexes, raw duplication and resource limits with bounded read-only measurements.
- [ ] Trace direct synchronous SQLite calls, transaction closures, database initialization, backup scripts and connection ownership across all services.
- [ ] Identify caller changes required for asynchronous PostgreSQL I/O; do not pretend swapping a connection object preserves synchronous semantics.
- [ ] Define repository/unit-of-work boundaries and one authoritative write destination. Keep policy functions database-independent and avoid an unrelated general repository rewrite.
- [ ] Present sizing, connection pool budget, maintenance/backup needs and feasible write-pause duration for approval.

### P2 — Schema, identity and contract tests

- [ ] Design typed business schema, immutable source records, identity ledger, normalized events, evidence revisions, leases, receipts and outbox; inspect and map existing stores rather than duplicating their concepts.
- [ ] Separate bulky raw payloads from references and preserved execution excerpts. Verify numeric precision, timestamp units and chain/address canonicalization.
- [ ] Select daily raw partitioning only with justified workload, and implement partition-independent replay idempotency. Date-key uniqueness alone is insufficient.
- [ ] Test same source event redelivered on another day, distinct fills of one position, concurrent semantic updates, lost acknowledgement, lease expiry/fencing and transaction rollback.
- [ ] Test connection limits, statement/lock timeout behavior and bounded queue claims. Preserve fairness between capture, repair and consumer work.

### P3 — Service adapters and consumer atomicity

- [ ] Wire the server browser inbox, normalization, identity, opportunity, automation and signal/outbox services through compatible PostgreSQL adapters.
- [ ] Commit normalized facts and durable work intents together; consumer receipts attest to results, not just producer delivery.
- [ ] Preserve the approved stable capability predicate: three distinct 3x tokens OR two distinct 5x tokens in the rolling 30-day purchase cohort, with qualifying execution-based buys.
- [ ] Replace age-dependent forward radar gates with the approved 15-minute/two-eligible-trader/USD-50-each base rule; inventory and obtain approval for any remaining independent score gates.
- [ ] Bind capture extensions to first observed approved tiers and distinct qualifying authorized-target buys. Keep sample expiry and token capture expiry separate.
- [ ] Add event-driven dispatch with five-minute ability reconciliation, token-shared market acquisition, independent source pauses and honest gap states.
- [ ] Run contract parity tests against both implementations where needed during transition; no production application dual-write shortcut.

### P4 — Retention, protection and operational maintenance

- [ ] Implement raw hot-storage eligibility after 15 days by reception time, with recorded dispositions and protection references.
- [ ] Protect unresolved/failed/disputed raw records and all evidence needed by active 30-day samples, proven hits and revision audit. Digests do not replace source evidence.
- [ ] Keep archive/removal execution disabled until archive location, audit duration and permanent-deletion policy are approved. Provide a dry-run eligibility report first.
- [ ] Test day-15 expiry, delayed old events received today, overlapping sample windows, unresolved parsing, missing ownership, replay across expiry and evidence lookup after raw movement.
- [ ] Ensure partition maintenance cannot cascade-delete normalized facts or invalidate foreign keys. Demonstrate retained deduplication identities after raw expiry.
- [ ] Add disk/backlog protection, WAL/backup growth accounting, rotation and recovery alarms without inventing numeric limits.

### P5 — Snapshot, parity, fenced cutover and rollback

- [ ] Extend the approved deployment wrapper only after schema/repository implementation and tests pass. Preserve existing source data and restore material.
- [ ] Verify a consistent SQLite snapshot copy in an isolated PostgreSQL target, including counts, references, IDs, revisions, numeric values and representative consumer outcomes.
- [ ] Rehearse the approved capture drain/final delta/checkpoint procedure and establish the single-writer switch point.
- [ ] Gate production switch on explicit approval, measured resources, restore evidence and replay/lease fencing; Gateway stays disabled.
- [ ] Define rollback before and after target-only writes separately. Never roll back to a stale SQLite database without verified reverse-delta replay.
- [ ] Accept a real server-page event through PostgreSQL raw commit, normalization, matching, sample/wait reason, consumer receipt and console trace.

### P6 — Progress reads and final evidence

- [ ] Build indexed/paginated entity traces and incrementally maintained progress summaries; refresh must not scan every raw payload or schedule work.
- [ ] Show raw hot/archived/protected populations, oldest pending item, preserved evidence references, ingestion lag, consumer lag, database growth and retention exclusions.
- [ ] Compare measured before/after performance using realistic isolated replay, not unapproved production load generation. Thresholds and capacity expansion require recorded approval.
- [ ] Record targeted/full/type/build results, migration mapping, approved settings, restore/cutover evidence and real traces by phase. Unobserved real-world cases remain awaiting verification.

### Quality and authorization gates

Use the existing mandatory phase quality protocol. Add real PostgreSQL integration tests in an isolated disposable database; mock-only tests do not prove transaction, lease or partition behavior. Resolve driver/dependency and test-service setup after inspecting the current runtime and package boundaries. Document-only amendments do not execute these tests.

No production installation, purchasing, migration, deletion, database switching, service restart or collector resume is authorized merely by this plan. Numeric quality/coverage limits, provider cadence/budget, archive/deletion rules, deployment sizing, residual score gates and final cutover remain unresolved release gates.

### P1 design deliverable and next execution boundary

`2026-10-02-postgresql-migration-and-retention-design.md` records the first bounded production snapshot and initial local persistence inspection. P1 is not fully complete: daily growth, per-table byte distribution, peak ingestion and migration pause/resource approval remain outstanding. Synchronous node:sqlite callers need asynchronous transaction-boundary mapping; the current file-copy backup must not be assumed consistent without verified fencing. P2 can begin schema/repository design after those boundaries are mapped; production installation, purge and cutover remain gated.

### P2 storage and asynchronous contract refinement

The migration companion now specifies target logical tables, epoch/decimal representation, transaction-bound repositories, fenced completion and six implementation slices. Verified difference: legacy trader_token_samples is unique by trader/token, so it must not represent each forward purchase's independent 30-day window. Preserve that legacy aggregate and introduce/adapt a per-economic-buy forward store. The current write port covers only synchronous candidate evidence writes; do not claim PostgreSQL readiness by adapting that one method. All interfaces and table names in this refinement remain design proposals, not implemented exports or deployed schema.

### P2 implementation slice — Transaction foundation drafted

Added internal `packages/database/src/postgres-unit-of-work.ts` with an injected driver-compatible pool, explicit transaction-local timeouts, asynchronous composition on one client, rollback-only propagation, pending SQL tracking, closed-scope rejection and uncertain-commit reporting. No automatic transaction retry, root package export, production driver dependency or existing SQLite caller switch was added.

Added `postgres-unit-of-work.test.ts` and opt-in `postgres-unit-of-work.integration.test.ts`. The latter accepts only a localhost PostgreSQL URL whose database name ends in `_test`, requires a separately available `pg` driver, uses temporary tables and never auto-installs a database. Missing opt-in URL skips real tests and must be reported as unverified, not passed PostgreSQL acceptance.

No test, typecheck, commit or deployment was executed for this slice. Next gate: authorize targeted/type tests and provision the isolated driver/database environment before claiming transaction readiness. Existing production services remain unchanged.

### P2 transaction foundation — Executed validation record

On 2026-10-02, following explicit user authorization:

- Targeted unit suite: 10 tests passed.
- Database package typecheck: `pnpm --filter @address-radar/database typecheck` exited successfully.
- Combined unit and real PostgreSQL integration suites: 12 tests across two files passed; the two integration cases ran against a localhost-only disposable PostgreSQL 16 container, not skipped.
- Test-only pg driver was installed into `/private/tmp/address-radar-pg-test.9L57dn`; the project dependency manifests and lockfile were not changed. PostgreSQL used temporary container storage and the shell exit cleanup removed the test container. Docker Desktop and the downloaded image remain available locally.
- Verified integration scope: nested operations share the transaction client, rollback removes temporary-table writes, committed execution returns its result, and a caught SQL error still prevents commit. This does not prove queue fencing, source deduplication, partition retention or application consumer integration.

Full-project tests/build/boundary/e2e checks, commits, production deployment, schema migration and cutover were not executed. The next implementation slice is the source identity/raw inbox transaction contract; target production driver dependency and connection budgets remain unconfigured.

### P2 implementation slice — Source identity and raw capture drafted

Added internal PostgreSQL capture schema/repository with partition-independent source identity, immutable semantic revisions and separate scrubbed raw payloads. Canonical business JSON excludes reception/session metadata supplied separately; opaque input remains persistable without trader ownership. Stable source event identity is required; no position-ID-only or guessed economic-key adapter is introduced. Payload/numeric bounds fail before SQL access. Changed semantics remain pending revisions, not automatic original replacement.

Repository append returns a staged result; only successful completion of the outer unit of work may acknowledge transport receipt. Raw retention actions, source credential scrubber, normalization leases/outbox dispatch, production partitions, concurrency stress and scanner wiring remain unimplemented. The included SQL is a target fixture/schema contract, not a production migration and does not run at startup.

Added three input-bound unit tests and six real PostgreSQL cases covering cross-day deduplication, revisions, opaque input, replay identity after test-only raw removal, atomic rollback and distinct event IDs. No production retention or deletion occurs. Validation results are recorded separately after execution.

### P2 source capture — Executed validation record

On 2026-10-02, the targeted unit suites passed 13 tests and the database package typecheck exited successfully. The combined four-file run passed 21 tests, including eight real PostgreSQL integration cases (two transaction-foundation and six capture-inbox cases), against a disposable localhost PostgreSQL 16 container. Test-only raw removal happened only inside temporary test tables. The shell exit cleanup removed the container.

The source capture slice is not production-ready: it has no active scanner adapter, credential scrubbing implementation, economic matching, parsing lease/outbox dispatcher, retention protection executor or partition migration. Multi-client race/load tests and full-project quality gates remain outstanding. No commit, deployment, production data write or retention change was performed.

### P2 implementation slice — Fenced normalization and durable consumer intent

Added an internal normalization repository/schema and seven isolated PostgreSQL integration cases. Capture plus parsing request can compose in one transaction. Claims increment a generation; completion/retry/quarantine require matching owner, generation, source/parser revision and an unexpired lease. Normalized source results, pending consumer intents and completion commit together. Business revisions carry requires_review and do not automatically replace the original event.

These are normalized source result records, not accepted economic trades, opportunity evidence or downstream consumption receipts. Actual parser/ownership/execution validation, lease renewal, fair admission, intent dispatch with fenced receipts, multi-client concurrency coverage and production wiring remain outstanding. No scanner caller, schema migration or production setting changed. Validation results follow actual test execution.

### P2 normalization — Executed validation record

On 2026-10-02, the database package typecheck succeeded. Five PostgreSQL foundation/capture/normalization test files passed 28 tests, including 15 real PostgreSQL integration cases, against a disposable localhost-only PostgreSQL 16 container. The exit cleanup removed the test container. Seven new real cases verified parsing-request deduplication, expired generation fencing, pending downstream intent, atomic result/intent rollback, delayed retry, raw-preserving quarantine and revision review flags.

No full-project suite, commit, deployment, schema migration, live scanner hook or consumer dispatch ran. Next slice: fenced consumer-intent claim and idempotent result receipts, followed by actual parser/ownership/execution integration. These test results do not establish complete forward radar closure or full production migration readiness.

### P2 implementation slice — Fenced consumer jobs and revision-specific receipts

Added consumer scheduling/claim/defer/complete repositories and receipt schema. Scheduling is bounded and idempotent by intent/consumer/version. Lease checks bind owner, generation, expiry and source/parser revision. Successful completion records produced or explicit policy/non-trade no-output separately; missing facts defer without a completion receipt or dispatched marker. Unreviewed source business revisions cannot complete. The caller's actual result must be persisted in the same transaction; the generic receipt repository is not proof that canonical matching has been wired.

Added seven integration cases, including two real database connections claiming distinct intents in an isolated per-test schema. Test fixtures verify an actual result row rolls back with the receipt. The dispatched marker is transport/consumer progress, not evidence that every downstream stage or every consumer version is complete. Actual FOMO parsing, ownership/execution validation, canonical result adapters, review authorization, source scrubbing, consumer fairness/capacity and production wiring remain outstanding. Validation is recorded after execution.

### P2 consumer work — Executed validation record

On 2026-10-02, database package typecheck succeeded and six focused test files passed 35 tests, including 22 real PostgreSQL integration cases, in a disposable localhost PostgreSQL 16 environment. Seven new cases cover idempotent admission, two-connection distinct claims, stale completion rejection, missing-data deferral without receipt, result/receipt rollback, explicit no-output and unreviewed revision rejection. Generated test schemas and the disposable container were cleaned up by the fixture/exit routines.

These are isolated repository/transaction results, not a production feed or canonical economic-trade acceptance. No full-project tests, commit, deployment, production migration, live parser or consumer adapter was executed. Next: integrate source message parsing/scrubbing with ownership and execution states, then canonical result persistence and consumer receipt in the same transaction.

### FOMO source adapter slice

- Added an inactive PostgreSQL FOMO capture/normalization adapter and package exports.
- Persistence uses an allowlisted message projection; credentials, arbitrary nested fields and transport URLs are excluded. This projection is not a lossless raw frame archive.
- Source admission requires an observer-supplied stable message identity and an explicit approved source origin. A position ID is not accepted as proof of a unique economic purchase.
- Source-reported USD amounts and prices remain observations. Wallet ownership, amount estimation and execution basis require separate validation; no capability or radar eligibility is granted by normalization.
- Incomplete/unsupported activity is preserved for quarantine rather than silently converted into a purchase. Display handles are excluded from immutable business fingerprints.
- Browser/runtime activation, real source-message identity coverage, canonical economic-trade storage and production cutover remain pending.

Validation for the FOMO source adapter slice:

- Seven FOMO source-projection unit tests passed.
- Corrected an initial regression command that selected only the source-projection tests; that run did not validate database behavior.
- The corrected isolated PostgreSQL 16 regression run passed 42 tests in seven files: 20 unit tests and 22 real database integration tests. The temporary container was removed by the command cleanup trap.
- Collectors, database and scanner package typechecks passed. Full-project tests/build and the new scanner adapter's end-to-end integration were not run.
- Known pending defect: the normalized observation still carries the legacy position-derived eventId. Separate source messages are captured independently, but a future economic-trade consumer must not use that field as a unique purchase key. Requested approval to separate source-message and position identities and add adapter-level integration coverage before activation.
- No commit, production deployment, database migration, browser resume or gateway delivery was performed. The complete implementation plan remains open.

### Source-message and position identity correction

- Removed the legacy position-derived eventId and ambiguous sourceTradeId from PostgreSQL normalized FOMO observations. The observer-supplied sourceEventId and sourcePositionId are now separate fields.
- Independent source messages sharing one position remain independent observations; they are not automatically counted as distinct validated economic purchases.
- Added adapter-level real PostgreSQL fixtures for capture/normalization, replay deduplication, message identity separation, review-required revisions, incomplete-message quarantine, atomic rollback and source-origin rejection.
- The fixtures do not establish production Live Feed coverage or authenticate a real source. Runtime activation, actual stable message identity availability and economic execution verification remain pending.
- No unconfirmed quality threshold, retention action, production cutover or gateway authorization was introduced.

Validation for the identity correction:

- Passed 52 tests across eight files: 22 unit tests and 30 real PostgreSQL 16 integration tests, including eight new scanner adapter integration cases.
- Collectors, database and scanner package typechecks passed.
- Test execution emitted the existing Node SQLite experimental-feature warning when loading package exports; it did not fail tests.
- Full-project tests/build and production Live Feed acceptance were not performed. The temporary PostgreSQL test container was removed by the cleanup trap.
- The position-derived eventId defect described in the previous slice is corrected for the new PostgreSQL observation path. Source message identity remains distinct from verified economic purchase identity.
- No commit, deployment, production migration, browser resume, retention cleanup or external signal delivery occurred. The full implementation plan remains incomplete.

### Inactive CDP delivery capture adapter

- Existing CDP frames provide socket provenance and payload text, not a demonstrated globally stable economic transaction identity. Added a separate collector-delivery identity scoped to one adapter session/page/sequence.
- Collector-delivery observations remain economically unverified. Repeated frames across sessions cannot yet be distinguished from independent fills and must not directly increase capability evidence counts.
- Added bounded volatile buffering and serialized PostgreSQL flushes. Buffer admission is explicitly not a durable acknowledgement; a delivery is released only after the transaction returns successfully.
- Overflow and persistence errors pause only this inactive capture adapter and expose coverage-loss counters. Explicit retry preserves the original delivery identity, including when the first commit acknowledgement is lost. Resume requires an empty, non-flushing buffer.
- Reuses existing approved-socket provenance tracking without attaching, navigating or resuming a browser. Production runtime wiring remains disabled.
- Volatile buffering cannot protect against a process crash before commit. Durable source-gap history, browser lifecycle integration, actual replay capability and economic transaction matching remain pending; coverage is never reported complete by this adapter.

Validation for the inactive CDP delivery adapter:

- Passed 57 tests across eight files: 22 unit tests and 35 real PostgreSQL 16 integration tests.
- Five additional integration cases cover approved socket provenance, independent collector deliveries, buffer overflow/manual resume, concurrent flush serialization and reconciliation after a lost commit acknowledgement.
- Collectors, database and scanner package typechecks passed. The existing Node SQLite experimental-feature warning remains when loading package exports.
- This result validates synthetic CDP fixtures and real local persistence, not authenticated production source coverage. Full-project tests/build and real Live Feed acceptance remain unperformed.
- The temporary local PostgreSQL container was removed by the cleanup trap. No browser attachment/resume, production configuration change, commit, deployment, migration, cleanup or signal delivery occurred.
- Next dependencies: durable source-gap accounting and lifecycle integration, verified economic-purchase matching, and controlled runtime wiring after the relevant activation/cutover decisions. The full plan remains open.

### Durable source lifecycle and coverage gaps

- Added PostgreSQL source-session ownership, health-event deduplication and gap records. Replacing the same collector/page head fences previous sessions inside the same transaction as source capture.
- A replacement session records the prior session's uncertain tail from its last durable heartbeat as a lower-bound estimate, not an exact crash timestamp.
- Disconnection, capacity exhaustion, persistence failure and shutdown create explicit gaps. Reconnection bounds an interval but leaves coverage awaiting verification; there is no automatic restored-coverage assertion.
- Added inactive lifecycle composition for explicit start, connection reporting, heartbeat, manual resume, fenced flush and drain-before-close. It does not navigate, attach or resume a real browser.
- If storage is unavailable, the first pending health event and queued delivery remain in memory for explicit recovery. A crash before persistence cannot preserve those exact values; replacement-session lower-bound accounting remains conservative.
- Gap reads are bounded and scope-indexed. No polling/heartbeat budget is selected by default, and no retention or replay-completion action is enabled.

Validation and stop boundary for durable source lifecycle:

- Passed 63 tests across eight files: 22 unit tests and 41 real PostgreSQL 16 integration tests. Collectors, database and scanner package typechecks passed.
- Six new cases validate durable disconnect/reconnect gaps, old-session fencing and uncertain-tail accounting, overflow persistence, pending health markers during storage failure, drain-before-close and sequential health-event deduplication/conflict checks.
- Known unvalidated implementation defects require correction before activation: local started state is currently assigned inside the transaction callback instead of after successful commit; health-event duplicate detection is performed before acquiring source ownership locks and needs a second locked check for concurrent replay.
- Requested user approval to correct these boundaries and add commit-failure/concurrent-replay regressions. Passing existing tests does not establish those missing properties.
- The temporary local PostgreSQL container was removed by the cleanup trap. No full-project suite/build, commit, deployment, production schema write, browser resume, retention execution or external delivery occurred. Development is paused at this correction-approval boundary; the full plan remains incomplete.

### Lifecycle acknowledgement and concurrent replay correction

- Moved local startup confirmation after successful transaction acknowledgement. A lost acknowledgement leaves startup unconfirmed; explicit retry reconciles the same durable session identity.
- Shutdown waits for in-flight startup, is serialized, and reconciles the retained closed event after a lost acknowledgement instead of emitting another close transition.
- Health transitions recheck event identity after acquiring source ownership locks, including concurrent close events. Terminal ownership is inspected after locked replay reconciliation; unrelated late writes remain fenced.
- Added six real PostgreSQL regressions covering delayed/lost startup acknowledgement, startup/shutdown overlap, lost shutdown acknowledgement and synchronized concurrent connected/closed replay.
- No production schema application, browser resume, scoring change or delivery activation was introduced. Validation results follow executed tests.

### Lifecycle correction — Executed quality gates (2026-10-03, Asia/Shanghai)

- Targeted regression: 69 tests across eight files passed, comprising 22 unit tests and 47 real PostgreSQL 16 integration tests. The six new acknowledgement/concurrency regressions passed.
- Full Vitest regression: 234 test files and 1006 tests passed with the local disposable PostgreSQL opt-in enabled; real database cases were not skipped.
- Root typecheck, repository boundary check, workspace build and built-package import smoke checks all completed successfully. Node's existing SQLite experimental-feature warnings remain non-fatal.
- The disposable PostgreSQL container was removed by the exit cleanup. The project pg dependency and production driver configuration remain unchanged; no commit, push, deployment or production migration was performed.
- Browser e2e and authenticated real Live Feed acceptance were not performed. Local fixtures still do not prove economic transaction identity, actual source coverage or live replay capability.
- Next approval boundary: read-only observation of a small number of messages from the existing authenticated server FOMO page, or user-provided scrubbed source samples. Do not resume the paused legacy collector, open replacement pages, add follows, transact or deliver signals without separate authorization.
- No numeric quality/coverage threshold, API budget, retention executor or PostgreSQL production cutover has been implicitly approved by these quality gates. The full plan remains open.

### Vertical slice: verified economic purchase to independent 30-day sample

- Adopt dependency-driven vertical slices: target schema, asynchronous transaction repository, fenced consumer and isolated database regressions together. Do not count generic queue infrastructure as an actual business result.
- Added a separate verified economic-trade/revision/source-link store and per-generation purchase samples. Legacy trader/token aggregate storage is not reinterpreted or removed.
- An internal verified-match port must supply a canonical economic execution key, attributable ownership and real execution evidence references. Current FOMO page prices and collector-delivery IDs do not satisfy this port; the real verification producer is not yet connected.
- Qualified buys require at least 50 nominal/verified USD; USDT/USDC nominal amounts retain an explicit estimate marker. Decimal values are accepted as bounded lossless strings and preserved alongside NUMERIC values.
- Each distinct execution has its own 30-day window. Independent source observations sharing a proven economic execution share one sample. Ownership/content conflicts become immutable pending revisions without auto-merging or overwriting original evidence.
- Generations require explicit registration; before-generation trades are preserved without forward samples. An elapsed window with unverified market coverage is not classified as a failed opportunity.
- Trade/sample/work intent and consumer receipt compose in one transaction. Stale receipt confirmation aborts that transaction; missing execution evidence defers without creating a successful receipt.
- The target DDL is an isolated fixture contract, not an installed production migration. Actual chain/platform proof validation, verified cross-source identity derivation, review authorization, opportunity tracking and runtime activation remain pending.

### Vertical slice: token discovery, screening gate and capture-window events

- Added an independent token-discovery consumer: unresolved wallet identities do not block a token watch or its durable buyer-capture intent.
- Initial capture runs from discovery for seven days. Verified 100K enables screening separately; launch time is not a gate.
- First reaches of 100K/200K/300K/500K/1M extend from event time. Same-tier refreshes, repeated source observations and duplicate economic buys never renew a window.
- Verified >=50 USD economic purchases require explicit system-stable or manual-authorized target evidence to renew capture. Notes and unresolved identities do not authorize renewal.
- Existing individual 30-day samples are not shortened or deleted by buyer-capture expiry.
- Added exact-decimal 3x/5x assessment policy. Entry evidence and validated within-window prices are required; no sale is required. Missing data, pending review and elapsed time without coverage proof remain deferred.
- Time windows use an inclusive start and exclusive expiry. Provider numeric quality thresholds remain unconfigured.
- Previous slice: 79 focused tests passed, including 57 real PostgreSQL integration cases; 968 general tests, full typecheck, boundaries, build and import smoke passed with bounded test concurrency.
- Previous slice committed and published as 9a548d2. Production deployment was code-only: no database migration or activation, no service restart, paused FOMO capture and disabled delivery preserved.
- This slice is not yet validated or deployed. Production PostgreSQL wiring, external proof verification, opportunity projections, ability projections and source acceptance remain separate gates.

#### Token-watch slice validation

- Aligned new foreign-key types and normalized-result field names with the existing PostgreSQL contracts; corrected the fixture's required payload limit.
- Focused validation: 98 tests passed, including 66 real PostgreSQL integration tests. The nine new discovery cases executed, rather than being skipped.
- General validation: 978 tests passed; the 66 PostgreSQL cases are skipped in the generic run because its connection URL is unset, and are covered by the isolated database run above.
- Full typecheck, repository boundary check, build and built-package import smoke passed.
- Production activation remains gated: code publication is not database cutover, live-source acceptance or proof of full business closure.

## Isolated Production PostgreSQL Infrastructure Slice

The operator approved an isolated local-only PostgreSQL 16 acceptance instance after the forward token screening/capture-window code-only publication. Implementation is tracked in `scripts/provision-postgres-acceptance.sh` and `docs/operations/postgres-acceptance-instance.md`.

This slice provisions an independent acceptance database with resource limits, restricted authentication, transactional probes, and business-service preservation checks. It does not migrate SQLite, apply business schema/data, switch any write path, restart existing business services, resume FOMO, or enable delivery. Provisioning outcomes must be reported from the actual command exit status; the script's presence is not evidence of successful installation.

Next dependencies remain production driver/configuration wiring, explicit schema activation and cutover authorization, verified execution/ownership resolution, durable opportunity/ability consumers, identity/manual-grant read models, and real-source coverage acceptance. No stable-ability or admission rules are changed by this infrastructure slice.

## PostgreSQL Acceptance Driver Wiring Slice

Add the project-owned pinned pg driver and typings, an explicit acceptance-only pool adapter, unit/real-driver tests, and a standalone temporary-table verification script. Reuse the existing unit-of-work for commit acknowledgement, rollback-only propagation, nested composition, and uncertain-commit handling. Constructor calls do not connect, migrate, read ambient database credentials, or switch SQLite callers.

This slice is limited to loopback `_test` databases and at most two explicitly budgeted connections. Native BIGINT/NUMERIC representations remain exact strings. Pool shutdown drains existing work and refuses new root acquisition; idle errors are counted without exposing raw errors/credentials. The standalone probe verifies identity, precision, and rollback without permanent business data. See `docs/operations/postgres-acceptance-driver.md` for its test and deployment boundaries.

Required gates: failing new export assertion before implementation, targeted driver/UOW tests, opt-in real PostgreSQL cases in a disposable local container, package/full typechecks, build/import/boundary checks, and isolated server probe. Report full-test runner timeouts honestly and separately from extended-budget diagnostic runs. Business service restart, source activation, schema cutover, and delivery remain prohibited in this slice.

## PostgreSQL actual-driver synthetic pipeline acceptance stage

Add an exclusively owned acceptance entry point that reuses capture, normalization, independent token/purchase consumers, 100K screening and the 30-day purchase-sample policy. Use transaction-local temporary versions of the exported schemas and roll back all synthetic fixture writes. Verify source replay, missing-basis deferral, semantic-revision review, result/receipt totals, numeric evidence preservation, estimation flags and cleanup after both success and interruption.

Required gates: failing export test before implementation, targeted unit and actual-driver integration tests, complete test suite, build, types, boundary and package-import checks, commit and isolated operations deployment. Business services, SQLite, the current release, paused FOMO source and disabled gateway delivery remain unchanged. Synthetic rollback acceptance must not be reported as real-source coverage, durable acquisition acknowledgement, opportunity/admission/signal completion or production cutover.

## Task 9 foundation: version-bound opportunity evidence and isolated acceptance

Implement the exact-decimal evaluator, immutable market/evaluation revisions, current execution-bound heads, and semantic downstream intents. Verify 50 USD, stablecoin estimate preservation, post-entry trade/candle evidence, 3x/5x without sales, stale execution fencing, refresh deduplication, and retention of proven evidence under incomplete inputs. Run actual-driver transaction-local temporary-table acceptance with rollback and interruption cleanup.

This foundation does not activate opportunity, ability, admission or signal workers and does not apply permanent production schema. Complete-non-hit coverage and numeric provider-quality thresholds remain approval gates; elapsed time is not a failure proof. Review-authorized execution replacement, affected-only recomputation and distinct-token stable-capability/admission projections remain subsequent work. Validation and deployment outcomes must be reported only after the corresponding commands pass.

## Task 9 consumer slice: version-fenced opportunity work and atomic receipts

Reuse durable purchase-sample intents and immutable market facts. Add semantic request identities, request/claim generation fencing, bounded initial admission, missing-data deferral, current execution checks and same-transaction evaluation/result/receipt persistence. Actual-source consumers, approved numeric coverage thresholds and candidate rules remain unchanged. Task 10 admission and capability projection are not implicitly activated by an opportunity receipt.

Required gates: RED missing-export assertion, actual PostgreSQL synthetic consumer tests including interruption rollback, full regression, build/type/boundary/import checks, commit and isolated operations acceptance. Permanent schema activation, token-wide bounded market wakeup dispatch, recurring reconciliation, simultaneous claim stress, authorized execution revision application and live-source verification remain subsequent dependencies. Do not report isolated test transactions as production data throughput or a completed business cutover.

## Task 9 propagation slice: durable peak fanout and factual reconciliation

Compose immutable market revision publication with a durable fanout intent. Process token-related purchase samples through bounded cursor pages with owner/generation/expiry fencing. Commit each page's semantic sample requests and cursor together; never advance past a locked, unprocessed sample. Reconcile omitted producer intents and initial sample intents without arbitrary clock keys. Independently evaluate late-arriving saved samples against already available within-window evidence.

Expose the approved five-minute reconciliation cadence and explicit runtime transaction adapters, without activating production timers or providers. Validate page/reclaim/replay/late-sample behavior and interrupted cursor rollback in actual PostgreSQL temporary fixtures, then run full quality gates, commit and isolated operations acceptance. Runtime stress, provider quality/budgets, production schema/write-path activation, review-authorized execution replacement, distinct-token capability/admission and live-source coverage remain open dependencies. Synthetic counts are fixture counts, not production progress.

## Task 10 foundation: observed screening and explicit forward stable capability

Add the approved rolling-purchase-cohort predicate (three distinct 3x tokens OR two distinct 5x tokens), using actual current sample/evaluation/peak versions and observed available 100K evidence. Preserve unknown-data denominators, distinct token identity, nominal amount markers and cohort maturity independently. Store immutable capability versions, serialized heads and semantic transition intents. Budget overflow defers instead of truncating eligibility inputs; old decisions cannot overwrite new heads.

Do not modify the legacy two-Early/one-Strong candidate predicate or rewrite historical statuses. Forward candidate observation, stable capability and manual/radar authorization remain different states. This foundation creates no radar grant and does not invent a legacy milestone classification. Subsequent work must connect opportunity/milestone/aging requests through capability consumer leases/receipts, integrate admission explicitly, preserve manual grants/risk checks and validate live-source coverage before production activation.

Required gates: missing-export RED, exact provenance and distinct-token pure regressions, real PostgreSQL synthetic projection/rollback acceptance, complete tests and build/type/boundary/import checks, commit and isolated operations deployment. Report fixture outcomes separately from production cohorts and business completion.

## Task 10 consumer slice: independent wakes and fenced capability receipts

Add bounded independent sample/opportunity/100K wake links without changing other consumers' transport state. Coalesce requests per entity/generation while retaining immutable wake/request audit; fence request replacement and claim expiration. Persist capability projection and its receipt in one transaction, deferring sample-budget overflow without confirmation. Clock-only results may confirm a work request without creating a semantic capability version.

Add a durable lexical cohort cursor that revisits samples and existing heads, including age-out decisions. Explicit caller budgets govern reconciliation cadence, pages, leases, retries and sample limits; no production timer or permanent schema activates implicitly. Actual PostgreSQL acceptance must prove wake replay, 100K wakeup, expiry rollback, stale request rejection, fair retry, bounded cursor, age-out, interruption cleanup and two-connection distinct claims. Candidate/manual/radar integration, business cutover and real-source coverage remain open gates; legacy admission is unchanged.

## Task 4/10 authorization foundation: audited independent targets and radar eligibility

Add independent FOMO/wallet target channel revisions, unique ownership quarantine, default monitoring and explicit manual grant/revocation audit. Reuse the confirmed association and `fomolens_manual` trust conditions rather than treating high confidence as ownership. Require authenticated internal write principals and keep ordinary metadata outside authorization. Build temporal reads and bounded registry pages; provide semantic authorization stamps that downstream consumers must revalidate.

Read current approved stable capability separately from candidate observation and manual grants. Do not invent a freshness tolerance: the system path requires a capability decision at the explicit decision time. Preserve legacy admission and statuses; no automatic identity merge or conflict clearing. Validate disabled monitoring, unverified identities, queued manual revocation, same-time revoke precedence, age-out, clock-only refresh, permissions, audit, idempotency and interruption rollback in isolated actual PostgreSQL fixtures. Production identity hydration, console endpoints, actual signal consumption, permanent schema activation and real-source phase gates remain unimplemented by this foundation.

## Task 4 control-plane slice: authenticated hydration and explicit grants

Add a read-only legacy registry proof adapter and an opt-in asynchronous console extension. Read existing confirmed association/direct-wallet facts under a SQLite snapshot; preserve ownership ambiguity, disabled monitoring and suspension. Evidence references attest legacy registry linkage only, not independently verified new platform/chain ownership.

Protect the forward target namespace with a mandatory bearer token and a server-configured principal, even when bound to loopback. Keep old console behavior compatible and leave its CLI composition unchanged. Use actual PostgreSQL decision and filtered registry ports; whitelist client identifiers and reject client-supplied confidence, actor, permissions and timestamps. Preserve immutable idempotent grant/revoke commands and original server timestamps under the existing entity control lock.

Validate source read-only behavior, independent FOMO/wallet channels, trust parity, authentication, actor derivation, default monitoring without grants, command retries, explicit audit, source disable/re-enable, revocation, ownership quarantine and outer fixture rollback. The real-driver HTTP fixture uses one outer temporary-table transaction; per-request HTTP commits and multi-client acceptance remain outstanding. Do not infer production activation from fixture success.

Next gates: real operator UI composition, continuous source-change hydration, actual signal consumers/receipts, live-source acceptance, explicit permanent-schema activation and business cutover. No legacy admission, risk threshold or delivery setting changes in this slice.

### Operator surface and independent request acceptance increment

Implemented the separate authenticated operator surface at `/forward-targets`, using the existing identity hydration, current decision, bounded registry, explicit manual grant and revoke APIs. Credentials and uncertain-command retry IDs remain session-local; actor identity and permissions remain server-derived. Static asset serving does not enable business controls. Candidate observation, system capability and manual eligibility are not conflated.

Added real HTTP acceptance with independently committed PostgreSQL requests in an owned session-local TEMP fixture. Later transactions verify grant/revoke visibility, immutable retries, rollback of audit/head/intent on injected failure, and successful recovery of the same command. This closes the earlier per-request commit proof gap, not the live coverage, multi-client HTTP, full browser interaction, continuous identity hydration, signal receipt or permanent-schema cutover gates. Production business activation remains separately gated.

### Fresh identity qualification increment

Added explicit assessment-clock identity refresh receipts and a fresh qualification reader that fences stale or revoked authorization stamps. Registered FOMO and wallet targets receive independent bounded, interleaved refresh slots; source absence or errors defer live eligibility without deleting prior identity facts or counting a missing source as a failed ability sample. Runtime cadence, durable cursor composition and permanent schema activation remain gated.

Confirmed by the user: legacy contribution-score and age-dependent large-buy thresholds are retained only in the old route, not inherited by the new forward route. The forward signal implementation must use the confirmed eligible-identity, fifteen-minute, two-independent-trader, single-buy-at-least-50-USD conditions, preserving provenance, economic-event deduplication and risk checks. No launch-time requirement is introduced into the forward route.

### Forward signal projection increment

Implemented a separate forward signal policy with current-clock fifteen-minute windows, at least two independent eligible traders and qualifying single buys of at least 50 USD. Legacy score, launch-time and age-based large-order gates stay unchanged in the legacy route. The forward route preserves estimated stablecoin amounts, execution evidence, fresh identity authorization, economic deduplication and explicit live/risk provenance requirements.

Added atomic PostgreSQL readiness intents, sample execution receipts and economic consumption. Missing proof, pending risk or incomplete input pages do not receive successful execution receipts. Readiness is revalidated before any future transport; current revocation cancels it, while unavailable fresh proof defers it. The isolated fixture begins after normalization and uses synthetic live/risk ports, so it does not prove real capture-to-signal coverage. Runtime safety-source composition, permanent activation and actual delivery remain gated.

### Task 12 increment: bounded read-only trace console

Add an independently configured loopback trace reader, a single-statement MVCC read model, purchase keyset pagination and explicit current-page scope. Display execution provenance, 30-day opportunity evaluations, persistent capability, identity refresh records and signal intents/receipts without equating pending to delivered. Use synthetic PostgreSQL fixtures and actual HTTP acceptance before isolated deployment. This does not authorize business activation, FOMO resume or transport delivery; durable identity scheduling and real-source closure remain outstanding.

### Target synchronization completion increment: durable refresh coordination

Persist independent FOMO/wallet scan cursors and generation-scoped leases. Advance cursors only after matching identity refresh receipts exist; atomically append a checkpoint audit. Fence expired workers, preserve progress across instance restarts and reject regressed clocks. Add a cancellation-aware non-overlapping loop with explicitly supplied cadence and lease duration. Isolated PostgreSQL acceptance uses synthetic source failures and does not prove live coverage or authorize permanent migration, daemon activation or FOMO resume.
