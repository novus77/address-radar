# Address Radar End-to-End Data Closure Implementation Plan

> **For Codex:** Execute this plan checkpoint by checkpoint. Keep gateway delivery disabled until Phase 11 acceptance is approved.

**Goal:** Build a fact-driven, five-chain pipeline that closes the loop from valuable-token discovery through historical fact recovery, stable high-multiple trader discovery, identity materialization, wallet backfill, live monitoring, replay, and signal evaluation.

**Architecture:** Introduce a canonical fact ledger and a chain-aware coverage orchestrator shared by an isolated hot path and cold path. Providers write validated facts with provenance and coverage boundaries; downstream jobs wake only when dependencies change. Existing data is migrated through compatibility projectors and the new engine runs in shadow mode before cutover.

**Tech Stack:** TypeScript, Node.js, SQLite WAL, systemd, Vitest, existing Address Radar collectors and services.

---

## Phase 0: Production Baseline and Recovery Safety

- [ ] Capture a read-only production funnel baseline by chain and fact type.
- [ ] Record the active release, service configuration, schema version, and delivery-disabled state.
- [ ] Define a fixed five-chain replay corpus.
- [ ] Add disk watermarks, bounded log retention, and database snapshot procedures.
- [ ] Document the rollback pointer and immutable pre-migration snapshot.

## Phase 1: Fact Ledger Contract

**Files:** `packages/database/src/token-fact-store.ts`, `packages/database/src/migrations.ts`, `packages/database/src/index.ts`

- [ ] Add fact status, attempts, dependencies, conflicts, and watermarks tables.
- [ ] Define fact type, status, precision, attempt outcome, and transition contracts.
- [ ] Reject invalid transitions and incomplete terminal or available facts.
- [ ] Make attempt insertion idempotent and separate provider completion from fact completion.
- [ ] Register the schema initializer in database migration.

## Phase 2: Canonical Registries

**Files:** `packages/database/src/canonical-registry-store.ts`, `packages/database/src/migrations.ts`, `packages/domain/src/model.ts`

- [ ] Add canonical chain, token, market, trader, and wallet registries.
- [ ] Restrict downstream analysis to Solana, ETH, BSC, Base, and Robinhood.
- [ ] Represent launchpad curves, migrated pools, and multiple DEX markets.
- [ ] Add time-bounded canonical market selection and legacy projections.

## Phase 3: Coverage Orchestrator

**Files:** `apps/automation/src/token-fact-orchestrator.ts`, `apps/automation/src/provider-route-registry.ts`, `apps/automation/src/runtime.ts`, `apps/automation/src/scheduler.ts`

- [ ] Compute missing facts from explicit dependencies.
- [ ] Route by chain, fact type, capability, quality, and budget.
- [ ] Implement fact-level retry, backoff, circuit breaking, and terminal outcomes.
- [ ] Wake downstream jobs only when a fact revision changes.
- [ ] Add fair lane quotas so history cannot starve real-time work.

## Phase 4: Market History and Milestones

**Files:** `apps/wallet-analysis/src/gecko-milestone-provider.ts`, `apps/wallet-analysis/src/historical-provider-router.ts`, `apps/wallet-analysis/src/historical-milestone-worker.ts`, `apps/wallet-analysis/src/swap-price-reconstruction.ts`, `apps/wallet-analysis/src/supply-history.ts`

- [ ] Project local event prices into the fact ledger.
- [ ] Recover OHLCV across historical markets, not only the current top pool.
- [ ] Separate historical price, supply, FDV, and market-cap facts.
- [ ] Reconstruct milestones with explicit precision.
- [ ] Reject false completion when no usable coverage was written.

## Phase 5: Early Trade Recovery

**Files:** `apps/wallet-analysis/src/gecko-early-trade-provider.ts`, `apps/wallet-analysis/src/indexed-early-trade-providers.ts`, `apps/scanner/src/source-recovery-handlers.ts`, `apps/wallet-analysis/src/fomo-lookup-consumer.ts`

- [ ] Close the Fomo request-to-ingestion-to-reevaluation loop.
- [ ] Recover bounded Solana launchpad and pool transaction history.
- [ ] Recover EVM launchpad events, DEX swaps, and address history.
- [ ] Persist coverage boundaries and result caps.
- [ ] Deduplicate economic events across all sources.

## Phase 6: Identity and Candidate Lifecycle

**Files:** `packages/database/src/identity-automation.ts`, `packages/database/src/trader-automation-store.ts`, `apps/automation/src/candidate-evidence-worker.ts`, `apps/automation/src/trader-backfill-planner.ts`

- [ ] Project legacy wallets into canonical entity-wallet relationships.
- [ ] Support wallet-only candidates and later identity merging.
- [ ] Move resolved identities out of manual resolution.
- [ ] Implement candidate, observed, promoted, suspended, and retired states.

## Phase 7: Wallet Backfill and Ability

**Files:** `apps/automation/src/initial-wallet-backfill-worker.ts`, `apps/automation/src/trader-ability-worker.ts`, `packages/scoring/src/trader-ability-evaluator.ts`, `apps/wallet-analysis/src/historical-backfill.ts`

- [ ] Backfill 60 days and at most 300 tokens per wallet.
- [ ] Resume from per-chain and per-time cursors.
- [ ] Compute weighted entry, realized, captured, MFE, and MAE outcomes.
- [ ] Add coverage, source, and sample confidence.
- [ ] Treat unknown outcomes as missing coverage rather than losses.

## Phase 8: Five-Chain Live Monitoring

**Files:** `apps/wallet-monitor/src/runtime.ts`, `apps/wallet-monitor/src/store.ts`, `apps/wallet-monitor/src/service.ts`, `packages/aggregation/src/canonical-trader-events.ts`

- [ ] Materialize Solana and EVM monitor partitions from canonical identities.
- [ ] Require cursor progress and business observations for health.
- [ ] Produce normalized observations on all five chains.
- [ ] Attribute events to canonical traders without cross-chain blocking.

## Phase 9: Signal Engine

**Files:** `packages/scoring/src/address-radar-policy.ts`, `packages/signal-engine/src/address-radar-signal.ts`, `packages/aggregation/src/address-token-aggregation.ts`

- [ ] Separate new-token discovery and old-token reactivation windows.
- [ ] Produce provisional and confirmed signals.
- [ ] Use independent trader quality, amount, clustering, stage, and bundle risk.
- [ ] Increment repeat broadcasts on the original signal lifecycle.

## Phase 10: Console and Point-in-Time Replay

**Files:** `apps/control-plane/src/runtime-quality.ts`, `apps/control-plane/src/workbench-data.ts`, `apps/control-plane/public/workbench.html`, `packages/evaluation/src/point-in-time-replay.ts`

- [ ] Display the five-chain funnel from discovery through signals.
- [ ] Separate provider call success from fact yield.
- [ ] Explain waits, partial coverage, terminal outcomes, and failures in Chinese.
- [ ] Replay using only facts where `known_at <= replay_timestamp`.

## Phase 11: Shadow Validation and Cutover

- [ ] Import legacy facts with `legacy_import` provenance.
- [ ] Run old and new engines in parallel with delivery disabled.
- [ ] Compare fixed-corpus and live decisions by chain.
- [ ] Verify no unexplained waits, infinite retries, or unsupported-chain work.
- [ ] Verify actual wallet observations on all five chains.
- [ ] Exercise release and database rollback.
- [ ] Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` until separately approved.

## Acceptance Metrics

| Metric | Initial target |
|---|---:|
| Valuable-token identity confirmation | >= 90% |
| Historical price availability | >= 80% |
| Milestone availability | >= 80% |
| Early-trade recovery for milestone-ready tokens | >= 70% |
| Explainable candidate evidence | 100% |
| Five-chain monitoring coverage | >= 90% |
| Unexplained waiting jobs | 0 |
| Infinite retry jobs | 0 |
| Fact-change to reevaluation latency | <= 10 minutes |

