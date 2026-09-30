# Historical Candidate Production Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a productive historical candidate loop that progressively recovers milestones and early buyers, bounds Fomo backlog, filters quote assets, and persists newly discovered high-quality wallets.

**Architecture:** Keep historical acquisition in `apps/wallet-analysis` and realtime recovery in Scanner. Introduce a pure eligibility policy, content-addressed token partitions, bounded Fomo scheduling, and a repository transaction for discovered wallet candidates. Existing Dune, Fomo journal, evidence, and automation stores remain the source of truth.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, systemd, Dune Data API, Fomo file journals.

---

### Task 1: Historical token eligibility

**Files:**
- Create: `apps/wallet-analysis/src/historical-token-eligibility.ts`
- Create: `apps/wallet-analysis/test/historical-token-eligibility.test.ts`
- Modify: `apps/wallet-analysis/src/dune-historical-worker.ts`
- Modify: `apps/wallet-analysis/src/index.ts`

- [ ] Write failing tests proving supported meme tokens pass, unsupported chains fail, Solana USDC fails by exact address, and a token reusing `USDC` as a symbol is not rejected by symbol alone.
- [ ] Run `pnpm exec vitest run apps/wallet-analysis/test/historical-token-eligibility.test.ts` and confirm RED.
- [ ] Implement `classifyHistoricalTokenEligibility` with canonical chain/address handling and an exact quote-asset registry.
- [ ] Apply the policy before `saveHistoricalToken` and expose rejection counts through worker results without deleting existing rows.
- [ ] Run the focused tests and Dune worker tests until GREEN.

### Task 2: Progressive content-addressed partitions

**Files:**
- Modify: `apps/wallet-analysis/src/historical-partitions.ts`
- Modify: `apps/wallet-analysis/src/historical-cli.ts`
- Create: `apps/wallet-analysis/test/historical-stage-planner.test.ts`
- Modify: `apps/wallet-analysis/test/historical-backfill.test.ts`

- [ ] Write failing tests proving token page content participates in partition identity and confirmed tokens advance independently from failed universe partitions.
- [ ] Run focused tests and confirm RED.
- [ ] Add deterministic token-page fingerprints to non-universe partition IDs.
- [ ] Replace global `every(completed)` gates with database selectors for Fomo-confirmed eligible milestone inputs and milestone-ready early-trade inputs.
- [ ] Preserve `INSERT OR IGNORE` idempotency and verify newly verified tokens create new partitions without mutating completed work.
- [ ] Run focused tests until GREEN.

### Task 3: Bounded Fomo lookup scheduling

**Files:**
- Modify: `apps/wallet-analysis/src/fomo-token-verification.ts`
- Modify: `apps/wallet-analysis/test/fomo-token-verification.test.ts`
- Modify: `apps/wallet-analysis/src/config.ts`
- Modify: `deployment/address-radar.env.example`

- [ ] Write failing tests for a `100` active-lookup cap, expired lease fairness, and exponential retry delays.
- [ ] Run the focused test and confirm RED.
- [ ] Add `maximumActiveLookups` and retry-delay policy to the service.
- [ ] Count only unexpired queued lookups as active.
- [ ] Keep stale or deferred results non-terminal.
- [ ] Run focused tests until GREEN.

### Task 4: Materialize accepted unknown wallets

**Files:**
- Modify: `packages/database/src/repository.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `apps/wallet-analysis/src/historical-evidence.ts`
- Modify: `apps/wallet-analysis/src/dune-historical-worker.ts`
- Modify: `apps/wallet-analysis/src/historical-cli.ts`
- Modify: `apps/wallet-analysis/test/historical-evidence.test.ts`
- Create: `packages/database/test/discovered-wallet-candidate.test.ts`

- [ ] Write failing tests proving unresolved wallets are returned only after accepted evidence and candidate materialization is idempotent.
- [ ] Run focused tests and confirm RED.
- [ ] Add repository API `admitDiscoveredWalletCandidate` using the existing canonical wallet transaction helper.
- [ ] Create lifecycle/source/tag/monitoring records without requiring a Fomo account.
- [ ] Invoke the callback for accepted unresolved wallets after Dune evidence ingestion.
- [ ] Run focused tests until GREEN.

### Task 5: Recovery and console diagnostics

**Files:**
- Modify: `apps/scanner/src/source-recovery-handlers.ts`
- Modify: `apps/scanner/test/source-recovery-handlers.test.ts`
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/app.ts`
- Modify: `apps/console/test/automation-funnel.test.ts`
- Modify: `docs/operations/automation-backfill-and-token-mining.md`
- Modify: `docs/operations/dune-candidate-backfill.md`

- [ ] Write failing tests proving quote assets terminate safely and waiting historical research remains distinguishable from provider failure.
- [ ] Run focused tests and confirm RED.
- [ ] Surface stage counts, Fomo freshness, accepted unresolved wallets, and Chinese diagnostics.
- [ ] Document backpressure, partial-stage advancement, and rollback behavior.
- [ ] Run focused tests until GREEN.

### Task 6: Integrated verification and production rollout

**Files:**
- Modify only files required by failures found during verification.

- [ ] Run `pnpm build` and fix compile errors.
- [ ] Run `pnpm test` and fix regressions.
- [ ] Commit the complete change as one reviewable feature commit.
- [ ] Run the production backup gate.
- [ ] Install and test an isolated release on the server.
- [ ] Atomically switch the release and restart Scanner, wallet monitor, wallet analysis, historical backfill, automation, and console.
- [ ] Confirm Gateway delivery remains disabled, services are active with zero unexpected restarts, Fomo backlog is bounded, milestone partitions advance, and at least one accepted unknown wallet can be materialized.

