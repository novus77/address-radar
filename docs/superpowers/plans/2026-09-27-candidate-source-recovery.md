# Candidate Source Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert source-blocked candidate evaluation into an observable, idempotent recovery pipeline that persists prerequisites and wakes evaluation only after verified data arrives.

**Architecture:** Extend the existing automation job store with structured block records and reuse the existing `recovery_jobs` queue. Candidate evaluation plans recovery work before blocking. Scanner recovery handlers persist facts and then wake matching candidate jobs through the existing automation store.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, systemd.

---

### Task 1: Persist structured source blocks

**Files:**
- Modify: `packages/domain/src/automation-job.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/automation-job-store.ts`
- Test: `packages/database/test/automation-job-store.test.ts`

- [ ] Add `CandidateSourceBlockReason` and structured block record types.
- [ ] Write failing tests for persisting, resolving, and aggregating source blocks.
- [ ] Add `automation_job_blocks` schema and store methods.
- [ ] Run `pnpm exec vitest run packages/database/test/automation-job-store.test.ts` and expect PASS.

### Task 2: Plan recovery before blocking candidate evaluation

**Files:**
- Create: `apps/automation/src/candidate-source-recovery.ts`
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/src/runtime.ts`
- Test: `apps/automation/test/candidate-source-recovery.test.ts`
- Test: `apps/automation/test/candidate-evidence-worker.test.ts`

- [ ] Write failing tests for missing milestone, price history, and early trades.
- [ ] Map each missing prerequisite to an idempotent recovery job.
- [ ] Persist a structured block before returning `waiting_source`.
- [ ] Change the no-buy path from false completion to `missing_early_trades` when historical coverage is absent.
- [ ] Run the two automation test files and expect PASS.

### Task 3: Register executable Scanner recovery handlers

**Files:**
- Create: `apps/scanner/src/source-recovery-handlers.ts`
- Modify: `apps/scanner/src/cli.ts`
- Modify: `apps/scanner/src/config.ts`
- Test: `apps/scanner/test/source-recovery-handlers.test.ts`
- Test: `apps/scanner/test/recovery-runtime.test.ts`

- [ ] Write failing tests proving market facts are persisted and Fomo milestone requests are idempotent.
- [ ] Implement market enrichment without backdating milestones.
- [ ] Implement early-buyer request submission and prerequisite checks.
- [ ] Register non-empty handlers and wake matching candidate jobs on successful recovery.
- [ ] Run Scanner recovery tests and expect PASS.

### Task 4: Expose recovery diagnostics

**Files:**
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/app.ts`
- Test: `apps/console/test/automation-funnel.test.ts`

- [ ] Write a failing API test for stable reason aggregation and recovery status.
- [ ] Return structured block and recovery summaries from `/api/v2/automation/overview`.
- [ ] Render Chinese labels for reasons and recovery states.
- [ ] Run `pnpm exec vitest run apps/console/test/automation-funnel.test.ts` and expect PASS.

### Task 5: Validate and deploy

**Files:**
- Modify: `deployment/address-radar.env.example` only if a new path is required.
- Modify: `docs/operations/automation-backfill-and-token-mining.md`

- [ ] Run `pnpm build` and expect exit code 0.
- [ ] Run `pnpm test` and expect all tests to pass.
- [ ] Commit the implementation with an English commit message.
- [ ] Build and test the release on the production host.
- [ ] Back up the SQLite database, switch the release atomically, and restart only affected services.
- [ ] Verify Gateway remains disabled, services have zero restarts, and recovery jobs begin progressing.

