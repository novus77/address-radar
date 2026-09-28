# Token Evidence Pipeline Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coalesce candidate evaluation by token, materialize early-trade recovery state for every milestone token, and expose truthful processing-time convergence metrics.

**Architecture:** Add a durable token-level request state beside the append-only automation queue. Source events advance a requested revision, one execution job evaluates the latest token state, and completion schedules one follow-up only when the revision changed during execution. A separate reconciliation materializes canonical token identity, early-trade facts, recovery jobs, and fact links for every milestone token.

**Tech Stack:** TypeScript, Node.js 24 `node:sqlite`, Vitest, SQLite WAL, systemd services.

---

### Task 1: Durable Candidate Evaluation Requests

**Files:**
- Create: `packages/database/src/candidate-evaluation-request-store.ts`
- Create: `packages/database/test/candidate-evaluation-request-store.test.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/src/migrations.ts`

- [ ] **Step 1: Write failing store tests**

Cover repeated requests, one active job, a request arriving while running, idempotent completion, and one follow-up revision.

```ts
const first = store.request("base:0xabc", "candidate-evidence-v2", "event:1", 100);
const duplicate = store.request("base:0xabc", "candidate-evidence-v2", "event:1", 101);
expect(first.requestedRevision).toBe(1);
expect(duplicate.requestedRevision).toBe(1);

store.bindJob(first.key, "job-1", 1, 110);
store.request("base:0xabc", "candidate-evidence-v2", "event:2", 120);
expect(store.complete(first.key, "job-1", 1, "produced", 130).needsFollowUp).toBe(true);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/database/test/candidate-evaluation-request-store.test.ts`

Expected: FAIL because the store export does not exist.

- [ ] **Step 3: Implement schema and store**

Create `candidate_evaluation_requests` and `candidate_evaluation_triggers`. Use `(token_id, strategy_version)` as the request key and `(request_key, source_key)` as the trigger uniqueness boundary. All request, bind, and completion operations use `withAddressRadarWriteTransaction`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run packages/database/test/candidate-evaluation-request-store.test.ts`

Expected: PASS.

### Task 2: Token-Level Candidate Dispatcher and Worker Completion

**Files:**
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `apps/automation/test/candidate-evidence-worker.test.ts`

- [ ] **Step 1: Write failing worker tests**

Assert that multiple canonical events for one token create one active job, sell events do not create independent token evaluations, and a source update during execution creates exactly one follow-up job.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run apps/automation/test/candidate-evidence-worker.test.ts`

Expected: FAIL with multiple candidate jobs for one token.

- [ ] **Step 3: Replace event-level enqueueing with request coalescing**

The dispatcher records source keys in the request store and enqueues only through the coordinator. Candidate jobs carry `requestKey` and `targetRevision`. Completion advances the processed revision and enqueues one follow-up when needed.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run apps/automation/test/candidate-evidence-worker.test.ts`

Expected: PASS.

### Task 3: Milestone Fact Coverage and Recovery Planning

**Files:**
- Create: `apps/automation/src/milestone-fact-reconciler.ts`
- Create: `apps/automation/test/milestone-fact-reconciler.test.ts`
- Modify: `apps/automation/src/runtime.ts`
- Modify: `apps/scanner/src/source-recovery-handlers.ts`
- Modify: `apps/wallet-analysis/src/fomo-token-verification.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Cover milestone tokens missing `historical_tokens`, missing early-trade facts, existing canonical early buys, complete empty results, pending Fomo lookups, and terminal provider exhaustion.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run apps/automation/test/milestone-fact-reconciler.test.ts apps/scanner/test/source-recovery-handlers.test.ts`

Expected: FAIL because untracked milestones are not materialized.

- [ ] **Step 3: Implement exhaustive materialization**

For each milestone token, project minimal token identity, ensure `early_trades`, mark canonical coverage available, or transition to scheduled and create one `milestone_early_buyers` recovery job with one fact link.

- [ ] **Step 4: Implement explicit asynchronous outcomes**

Treat accepted Fomo lookup as pending external work, persist complete-empty lookup as an available fact with an empty attempt outcome, and reserve terminal state for exhausted providers.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run apps/automation/test/milestone-fact-reconciler.test.ts apps/scanner/test/source-recovery-handlers.test.ts apps/wallet-analysis/test/fomo-token-verification.test.ts`

Expected: PASS.

### Task 4: Restart-Safe Production Reconciliation

**Files:**
- Create: `apps/automation/src/migrations/reconcile-token-evidence-pipeline-v1.ts`
- Create: `apps/automation/test/reconcile-token-evidence-pipeline-v1.test.ts`
- Modify: `apps/automation/src/index.ts`

- [ ] **Step 1: Write failing dry-run and apply tests**

Seed duplicate active candidate jobs and untracked milestones. Assert dry-run counts, chunked cancellation, one dirty request per token, complete fact materialization, and restart-safe cursors.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run apps/automation/test/reconcile-token-evidence-pipeline-v1.test.ts`

Expected: FAIL because the reconciliation does not exist.

- [ ] **Step 3: Implement chunked reconciliation**

Cancel duplicate active rows without deleting audit history, bootstrap request revisions, project missing token identities, and materialize early-trade facts in batches of at most 250 subjects.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run apps/automation/test/reconcile-token-evidence-pipeline-v1.test.ts`

Expected: PASS.

### Task 5: Truthful Closed-Loop Metrics

**Files:**
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/test/closed-loop-operations.test.ts`
- Modify: `apps/console/public/app.ts`

- [ ] **Step 1: Write failing metric tests**

Assert that missing fact rows appear as `untracked`, stage totals conserve eligible subjects, and recent candidate progress comes from automation outcomes rather than historical `evidence_at`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run apps/console/test/closed-loop-operations.test.ts`

Expected: FAIL because untracked and processing-time counters are absent.

- [ ] **Step 3: Implement conserved stage metrics**

Add subject-level completed, pending, blocked, terminal, and untracked counts. Add processed and outcome counters for 15-minute, one-hour, and 24-hour windows.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run apps/console/test/closed-loop-operations.test.ts`

Expected: PASS.

### Task 6: Integrated Verification and Deployment Readiness

**Files:**
- Modify: `docs/specs/2026-09-28-token-evidence-pipeline-convergence-spac.md` only if implementation decisions require clarification

- [ ] **Step 1: Run all targeted tests**

Run the five focused suites from Tasks 1-5.

- [ ] **Step 2: Run type checking**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run the complete test suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 4: Prepare production dry-run commands**

The dry run must report duplicate jobs, distinct dirty tokens, cancelled candidates, projected identities, initialized facts, and recovery jobs without writing production data.

- [ ] **Step 5: Stop before production mutation**

Production backup, reconciliation apply, service restart, and deployment require explicit production authorization.

