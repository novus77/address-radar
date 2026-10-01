# Address Radar Full Data Lifecycle Implementation Plan

> For agentic workers: use the executing-plans skill in the current session. Execute dependency-ordered tasks with explicit checkpoints; do not delegate to subagents.

**Goal:** Make the five-chain token-to-trader-to-signal lifecycle measurable, provenance-safe and recoverable under the approved opportunity-discovery rules.

**Architecture:** Incrementally strengthen the existing six-service system, source ledger, canonical events, recovery dependencies and outbox. Introduce small contract/diagnostic modules rather than another queue or a wholesale repository rewrite. Preserve old facts and strategy snapshots with explicit versions.

**Tech Stack:** TypeScript, Node 24, pnpm workspace, SQLite, Vitest and Playwright.

**Scope authority:** Companion SPAC defines business invariants. This plan authorizes document preparation only in this turn; tests, commits, migrations and production rollout need their execution checkpoints. Pending business decisions must be confirmed before implementing the affected policy.

## Working protocol

- Read each required source file once at the task's initial inspection; use known context thereafter.
- Change only mapped files in a focused patch; do not combine unrelated refactoring.
- No live network test or production write during source implementation.
- Tests below are planned commands, not commands already executed.
- A failed assumption changes the task plan before changing the schema or public API.
- Inspect active configuration and capability wiring before claiming a fallback is available.
- Preserve Gateway-disabled, manual trust, identity conflict and historical retention safeguards.

## Phase 1 — Reliable facts and honest diagnostics

### Task 1: Cohort-aware baseline and trace contracts

**Create:** `packages/observability/src/data-flow-progress.ts`, `apps/console/src/data-flow-progress.ts`, `scripts/audit-data-flow.ts`.
**Modify:** `packages/observability/src/index.ts`, `apps/console/src/application.ts`, `scripts/audit-data-closure.ts`.
**Test:** `packages/observability/test/data-flow-progress.test.ts`, `apps/console/test/data-flow-progress.test.ts`.

- [ ] Inspect actual table keys and current API callers; map token, trader, wallet, snapshot, job and dependency populations explicitly.
- [ ] Add tests showing two evaluations of one trader count as one trader, legacy/new snapshots remain separate and missing denominator is unknown coverage.
- [ ] Add a read-only `/api/v2/operations/data-flow` endpoint with frozen-cohort/filter metadata, stage units, unique-fact deltas, source freshness and known coverage boundaries.
- [ ] Add token and trader trace responses linking existing IDs without making writes on read paths.
- [ ] Retain legacy API compatibility; revise closure audit so row presence alone does not imply acceptance.

Proposed additive response contract:

```typescript
export interface DataFlowStage {
  readonly stage: string;
  readonly unit: "token" | "trader" | "wallet" | "event" | "dependency";
  readonly cohortId: string;
  readonly strategyVersion: string | null;
  readonly total: number | null;
  readonly satisfied: number;
  readonly pending: number;
  readonly uncovered: number;
  readonly newUniqueFacts: number;
  readonly lastFactProgressAt: number | null;
}
```

Planned targeted command: `pnpm exec vitest run packages/observability/test/data-flow-progress.test.ts apps/console/test/data-flow-progress.test.ts`.
Expected: unit/population/version isolation passes; endpoint performs no insert, migration or reconciliation.

### Task 2: Temporal provenance and chain-aware ownership

**Modify:** `apps/scanner/src/runtime.ts`, `apps/wallet-monitor/src/runtime.ts`, `packages/collectors/src/types.ts`, `packages/collectors/src/source-observation-ingestor.ts`.
**Create test:** `apps/scanner/test/market-observation-time.test.ts`, `apps/wallet-monitor/test/ownership-case.test.ts`.

- [ ] Trace existing market-provider timestamps and persistence interfaces before extending the observation contract.
- [ ] Test a historical buy replayed today: today's lookup must not create an old price or crossing.
- [ ] Test two Solana addresses differing only in case and case-insensitive EVM ownership.
- [ ] Persist market observed-at separately from event occurred-at; explicitly annotate estimated versus historical values.
- [ ] Produce a read-only affected-provenance report for existing suspect rows; do not delete source facts or silently rewrite old assessments.

Planned command: `pnpm exec vitest run apps/scanner/test/market-observation-time.test.ts apps/wallet-monitor/test/ownership-case.test.ts`.
Expected: correct temporal separation and no Solana ownership collision.

### Task 3: Actual execution normalization

**Modify:** `apps/wallet-monitor/src/collectors.ts`, `packages/collectors/src/evm-swap-evidence.ts`, `packages/collectors/src/solana-swap-evidence.ts`.
**Create:** `packages/collectors/src/execution-basis.ts`.
**Test:** `packages/collectors/test/execution-basis.test.ts`, `apps/wallet-monitor/test/swap-observation.test.ts`.

- [ ] Inspect complete receipt/transaction paths and chain quote-token configuration, including successful status and token decimals.
- [ ] Capture scrubbed fixtures for a stable-quote swap, native-quote swap, transfer, failed execution, multi-hop and ambiguous multi-token purchase.
- [ ] Derive entry basis from attributed execution deltas and historical quote valuation; ambiguous allocations retain missing-field reasons.
- [ ] Separate receipt detection, supported swap, attributed wallet, valued amount, persisted event and projected evidence counters.
- [ ] Keep historical current-spot enrichments diagnostic and out of entry-price evidence.

Planned command: `pnpm exec vitest run packages/collectors/test/execution-basis.test.ts apps/wallet-monitor/test/swap-observation.test.ts`.
Expected: transfers/failed swaps produce no buys; ambiguous values are unknown, not allocated twice.

### Task 4: Consumer-specific coverage demands

**Create:** `packages/domain/src/fact-demand.ts`, `packages/database/src/fact-demand-store.ts`.
**Modify:** `apps/automation/src/token-fact-orchestrator.ts`, `packages/database/src/recovery-fact-link-store.ts`, `apps/automation/src/candidate-source-recovery.ts` and relevant exports/schema migration ownership.
**Test:** `apps/automation/test/fact-demand-recovery.test.ts`, `packages/database/test/fact-demand-store.test.ts`.

- [ ] Map each consumer's actual field/range/precision requirements; inspect existing ledger capabilities before adding redundant tables.
- [ ] Test that a partial positive-hit range satisfies only the matching positive-evidence demand, not complete-range non-hit analysis.
- [ ] Persist demand identity, consumer, chain/CA, required interval and satisfaction proof; reuse existing stores when sufficient.
- [ ] Replace status-only dependency readiness with the demand predicate; missing records remain pending and visible.
- [ ] Wake consumers on satisfied semantic revisions; reject late lower-quality result regression.
- [ ] Make recovery-job completion and dependency satisfaction independent, with explicit no-output explanations.

Planned command: `pnpm exec vitest run apps/automation/test/fact-demand-recovery.test.ts packages/database/test/fact-demand-store.test.ts`.
Expected: gaps never become complete coverage and a late result cannot erase proven facts.

**Phase 1 gate:** Timestamp-safe facts, correct ownership and trustworthy progress API. No policy thresholds changed. Produce the dry-run list of invalid derived assessments before any production repair.

## Phase 2 — Real acquisition and bounded historical closure

### Task 5: Source capability and shared-budget outcomes

**Modify:** `apps/automation/src/provider-route-registry.ts`, `apps/automation/src/token-fact-orchestrator.ts`, `apps/wallet-analysis/src/historical-provider-router.ts`.
**Create:** `packages/collectors/src/source-capability.ts`.
**Test:** `apps/automation/test/provider-capability-routing.test.ts`.

- [ ] Inspect configured provider factories and current shared budget store; register only demonstrated chain/fact/range capabilities.
- [ ] Test rate-budget exhaustion, circuit cooldown, unsupported chain, exact empty range and alternate supported route.
- [ ] Separate temporary unavailable routes from permanent unsupported capability; preserve original reason and retry timing.
- [ ] Share budgets across live and historical processes; release leases during external waiting.
- [ ] Make new capability or authoritative revised facts reopen eligible terminal demands through bounded audited reconciliation.

Planned command: `pnpm exec vitest run apps/automation/test/provider-capability-routing.test.ts`.
Expected: cooldown does not permanently terminate a supported demand, and unsupported routes do not loop forever.

### Task 6: FOMO request-to-commit investigation and ownership cutover

**Modify:** `scripts/sync-fomo-verification.sh`, `apps/wallet-analysis/src/fomo-token-verification.ts`, actual scanner FOMO reader after locating its source.
**Create:** `packages/collectors/src/fomo-request-lifecycle.ts`; dedicated browser adapter files only after verified production collector discovery.
**Test:** `packages/collectors/test/fomo-request-lifecycle.test.ts`.

- [ ] Read-only trace one BSC and one Base request through creation, browser claim, session, query, parse, result append, transfer, normalized insertion and cursor commit.
- [ ] Record which boundary first stops; do not infer query timeout from missing local results alone.
- [ ] Locate the actual browser implementation and authenticated response fixtures; redact credentials and account secrets.
- [ ] Test truncated records, file replacement, crash after append, duplicate results, session expiry and stale request generation.
- [ ] Add commit-aware journal generations/checkpoints; source fact insertion controls successful request completion.
- [ ] Shadow the Address Radar-owned adapter against identical fixtures before requesting single-owner production cutover.

Planned command: `pnpm exec vitest run packages/collectors/test/fomo-request-lifecycle.test.ts`.
Expected: replay is idempotent; no completed query without a committed result or explained authoritative empty response.

### Task 7: Historical inventory, milestone and early-buyer coverage

**Modify:** `apps/automation/src/token-source-adapters.ts`, `token-partition-planner.ts`, `token-mining-worker.ts`, `apps/wallet-analysis/src/historical-stage-planner.ts`, `historical-token-eligibility.ts`, `historical-milestone-worker.ts`, `indexed-early-trade-providers.ts`.
**Create test:** `apps/wallet-analysis/test/historical-cohort-coverage.test.ts`.

- [ ] Distinguish external enumeration, import and local replay in job payloads and counters.
- [ ] Freeze five-chain research cohort revisions and retain source inventory range proofs.
- [ ] Test launch-unknown/pre-window launch with valid in-window 1M crossing, duplicate pools/CA, late imports and missing supply.
- [ ] Recover pool history and supply basis before claiming historical market-cap crossings; interval estimates retain bounds.
- [ ] Recover attributable early buys with range/price provenance; current holders and profitable sellers are not interchangeable with early buyers.
- [ ] Stop endless empty-local scans; persist exact uncovered intervals and schedule only supported upstream acquisition.

Planned command: `pnpm exec vitest run apps/wallet-analysis/test/historical-cohort-coverage.test.ts`.
Expected: no launch-time gate; no false first-crossing proof from a current spot value or unproved supply.

### Task 8: EVM and chain-specific collection coverage

**Modify:** `apps/wallet-monitor/src/cli.ts`, `collectors.ts`, indexed-EVM and RPC adapter files identified during focused inspection; `apps/wallet-analysis/src/rpc.ts`.
**Create test:** `apps/wallet-monitor/test/chain-coverage-funnel.test.ts`.

- [ ] Explain zero EVM output through block scan, candidate receipts, swaps, ownership, amount and persistence counts.
- [ ] Confirm each configured chain ID and supported RPC/index method; surface unsupported history explicitly.
- [ ] Test a monitored wallet buying through a router, token receipt without direct transaction target, finalized blocks, restart and reorg.
- [ ] Persist block-hash checkpoint/provenance and reversible derived events where current index supports it.
- [ ] Ensure historic recovery and live tail collection have separate cursors/budgets; monitor idle intervals cannot imply complete old history.

Planned command: `pnpm exec vitest run apps/wallet-monitor/test/chain-coverage-funnel.test.ts`.
Expected: health reports valid pipeline stages, not just RPC request success.

**Phase 2 gate:** For every chain, document demonstrated coverage and exact uncovered intervals. At least one real trace must show newly acquired facts reaching evidence evaluation; unsupported external coverage is reported separately, not forced to pass.

## Phase 3 — Identity, recurrence and meaningful signal progression

### Task 9: Identity handoff and bounded wallet history

**Modify:** `packages/identity/src/manual-resolution-service.ts`, `identity-resolution-service.ts`, `monitoring-registry.ts`, `packages/database/src/repository.ts`, `apps/automation/src/initial-wallet-backfill-worker.ts`, `trader-backfill-planner.ts`.
**Test:** `packages/identity/test/identity-lifecycle-closure.test.ts`, `apps/automation/test/wallet-history-cursor.test.ts`.

- [ ] Reuse the existing safe manual trust logic and idempotent update API; do not broaden confidence rules.
- [ ] Test one EVM-only or Solana-only wallet, manual remark without FOMO username, repeated submission, conflicting owner and disabled/suspended identity.
- [ ] Verify identity/tag writes and monitoring notification commit atomically; resolved pending candidates leave the pending view.
- [ ] Expose wallet/day/page progress, unique token positions and the 300-position cap reason.
- [ ] Test crash/restart at a page boundary and overlapping live/history purchases without duplicate observations.

Planned command: `pnpm exec vitest run packages/identity/test/identity-lifecycle-closure.test.ts apps/automation/test/wallet-history-cursor.test.ts`.
Expected: a successful save reaches monitoring once; no automatic owner merge or false exhaustive-history claim.

### Task 10: Complete versioned ability cohort progression

**Modify:** `apps/automation/src/trader-ability-worker.ts`, `apps/wallet-analysis/src/opportunity-history.ts`, `performance.ts`, `packages/scoring/src/trader-opportunity-evaluator.ts`.
**Test:** existing `apps/automation/test/trader-ability-worker.test.ts`; create `apps/automation/test/ability-cohort-generation.test.ts`.

- [ ] Inspect production dispatcher version/cursor read-only and quantify eligible yet unevaluated traders.
- [ ] Test a new strategy with the preceding strategy's exhausted cursor; every eligible trader remains dispatchable exactly once per input revision.
- [ ] Version cursor/cohort generation and schedule only changed facts or due observation windows.
- [ ] Preserve partial positive hits while keeping non-hit coverage incomplete; evaluate other observable wallet purchases, not only successful-token discoveries.
- [ ] Expose latest-version distinct trader coverage, sample denominators and historical/current recurrence labels.

Planned command: `pnpm exec vitest run apps/automation/test/trader-ability-worker.test.ts apps/automation/test/ability-cohort-generation.test.ts`.
Expected: no legacy cursor starvation and no snapshot count mistaken for trader count.

### Task 11: Economic matching and semantic projection

**Modify:** `packages/aggregation/src/canonical.ts`, `repository.ts`, `evidence.ts`, `bundle.ts`, `apps/automation/src/signal-projection-worker.ts`, `packages/signal-engine/src/policy.ts` only for approved policy decisions.
**Test:** `packages/aggregation/test/economic-event-ambiguity.test.ts`, `apps/automation/test/semantic-signal-projection.test.ts`.

- [ ] Inspect the canonical match caller's transaction/time/owner constraints before changing matching behavior.
- [ ] Test ambiguous null amounts, two distinct same-size buys, matched FOMO/chain transaction, late enrichment and two correlated wallets.
- [ ] Use semantic evidence/eligibility revisions in projection fingerprints rather than timestamp-only refresh.
- [ ] Coalesce superseded pending metadata projections; never cancel leased work without fencing or discard genuine unconsumed evidence.
- [ ] Test unchanged replay produces no rebroadcast; a distinct qualifying buy increments the existing retained token signal.
- [ ] Explain each policy gate and implement unknown-age/weight changes only after separate user confirmation.

Planned command: `pnpm exec vitest run packages/aggregation/test/economic-event-ambiguity.test.ts apps/automation/test/semantic-signal-projection.test.ts`.
Expected: exactly-once economic contribution and no metadata-driven broadcast inflation.

### Task 12: Signal observation, reports and readable workbench

**Create:** `apps/automation/src/signal-report-worker.ts`, `apps/console/src/data-flow-labels.ts` if no existing equivalent is found.
**Modify:** actual signal tracking/store implementation after locating ownership, `apps/console/public/app.ts`, `apps/console/src/application.ts`.
**Test:** `apps/automation/test/signal-report-worker.test.ts`, `apps/console/test/data-flow-labels.test.ts`; add trace-view Playwright coverage to existing suite.

- [ ] Inspect current seven-day signal retention and persisted report implementation before introducing another worker/store.
- [ ] Test signal-time baseline, later verified peak, missing quotes, corrected data revision, detail expiry and persistent aggregate reports.
- [ ] Distinguish local readiness, projected decision, delivered acknowledgement and actual recent purchases.
- [ ] Present one record per row, five-chain filters, capability/missing-data reasons and trace links using readable Chinese labels.
- [ ] Display real unique-fact progression, pending identity reasons and latest-version ability coverage, not only service activity.

Planned command: `pnpm exec vitest run apps/automation/test/signal-report-worker.test.ts apps/console/test/data-flow-labels.test.ts`; then `pnpm test:e2e` when authorized.
Expected: no invented return during price gaps; console and API denominators agree.

## Phase 4 — Capacity, repairs and production acceptance

### Task 13: Fair scheduling, database and disk safeguards

**Modify:** `apps/automation/src/scheduler.ts`, `queue-policy.ts`, `packages/database/src/automation-job-store.ts`, `connection.ts`, existing deployment/log-retention configuration after inspection.
**Create test:** `apps/automation/test/mixed-workload-drainage.test.ts`.

- [ ] Test live traffic, historical backlog, waiting-source work and projection revisions together with bounded deterministic clock.
- [ ] Verify source wait releases execution capacity and each runnable class gets service without duplicate commits.
- [ ] Keep network operations outside database transactions; inspect targeted slow query plans during authorized validation.
- [ ] Add disk/log/WAL/backup readiness reporting and a deployment stop gate when verified backup/headroom is insufficient.
- [ ] Produce an archive/cleanup dry-run showing every protected referenced payload and active research dependency; ask before deletion/retention changes.

Planned command: `pnpm exec vitest run apps/automation/test/mixed-workload-drainage.test.ts`.
Expected: finite runnable workload drains without source starvation, while external waiting remains honestly visible.

### Task 14: Bounded revision repair and release

**Create:** `scripts/reconcile-data-flow.ts`, `docs/specs/2026-10-01-full-data-lifecycle-acceptance.md`.
**Test:** `scripts/test/reconcile-data-flow.test.ts`.

- [ ] Dry-run suspect temporal facts, affected derived snapshots, exhausted cohort cursors, terminal demands and redundant pending semantic tasks.
- [ ] Preserve originals and audit IDs; invalidate/recompute derived assessments rather than erasing raw evidence.
- [ ] Test dry-run produces zero writes, bounded apply is idempotent and restore uses only this migration's audit scope.
- [ ] Obtain production migration/release approval; verify backup, available capacity, previous release and rollback operations.
- [ ] Apply bounded repair and switch release with Gateway disabled; stop on health, ownership or provenance invariant violations.

Planned command: `pnpm exec vitest run scripts/test/reconcile-data-flow.test.ts`.
Expected: repeated bounded apply makes no duplicate work and rollback does not overwrite unrelated live data.

### Task 15: Full regression and real-world closure acceptance

- [ ] With authorization run targeted tests, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm smoke:packages`, `pnpm check:boundaries` and `pnpm test:e2e` in that order.
- [ ] Record exact counts, failures and logs; no success claim before commands complete.
- [ ] Trace real tokens/traders on all five chains: acquisition → history/milestone → purchase → opportunity → admission → identity → monitoring → fresh buy → aggregation → policy decision.
- [ ] Verify successful no-output cases separately from software/source failures; no synthetic production signal to make acceptance pass.
- [ ] Compare frozen-cohort snapshots across at least the existing two-hour acceptance window, including source freshness, unique facts, arrivals/drainage, locks, restarts and disk.
- [ ] Produce three independent verdicts: engineering acceptance, frozen-cohort data coverage and ongoing production stability.
- [ ] Estimate remaining time only when unique-demand drainage is reliable; list unfillable external ranges separately.

## Coverage and checkpoint mapping

| SPAC concern | Tasks |
| --- | --- |
| Business contracts and provenance | 1–4 |
| Historical/live source acquisition and fallback | 5–8 |
| Raw retention and replay | 2, 6, 8, 13 |
| Trade normalization and economic matching | 3, 8, 11 |
| Recovery closure and terminal restoration | 4, 5, 7, 14 |
| Candidate/identity/manual handoff | 7, 9 |
| Versioned ability and sample bias | 10 |
| Monitoring, aggregation and readiness | 8, 9, 11 |
| Signal tracking and reports | 12 |
| Scheduling, storage and safe migration | 13, 14 |
| Console and full business acceptance | 1, 12, 15 |

Initial implementation batch: Tasks 1–4. Acquisition work proceeds only after observable, trustworthy facts exist. Pending core policy decisions are presented to the user at the corresponding Task 11 checkpoint, not silently invented. Execution remains in the current session.
