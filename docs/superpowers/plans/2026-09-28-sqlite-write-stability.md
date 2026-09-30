# SQLite Write Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize SQLite writes and candidate replay while preserving a clean adapter boundary for a future single-writer architecture.

**Architecture:** Keep WAL-backed SQLite and route high-contention domain writes through `AddressRadarWritePort`. Separate migration ownership from runtime workers, make replay semantics observable and idempotent, and report queue flow independently from backlog size.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Vitest, systemd, SQLite WAL.

---

### Task 1: Candidate evidence write semantics

**Files:**
- Modify: `packages/database/src/candidate-history-store.ts`
- Modify: `packages/database/test/candidate-history.test.ts`

- [ ] Add tests for inserted, unchanged, updated, and identity-conflict outcomes.
- [ ] Replace `INSERT OR REPLACE` with conflict-aware update semantics.
- [ ] Reject trader or token ownership changes for an existing evidence ID.
- [ ] Run `pnpm vitest run packages/database/test/candidate-history.test.ts`.

### Task 2: Unified write boundary

**Files:**
- Create: `packages/database/src/write-port.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `apps/automation/src/candidate-evidence-worker.ts`

- [ ] Define `AddressRadarWritePort` without leaking SQLite APIs.
- [ ] Add the local SQLite adapter.
- [ ] Route candidate evidence persistence through the port.
- [ ] Count only inserted or updated facts as produced output.

### Task 3: Candidate replay and retry correctness

**Files:**
- Modify: `apps/automation/src/candidate-evidence-worker.ts`
- Modify: `apps/automation/test/candidate-evidence-worker.test.ts`

- [ ] Build event job idempotency from business fields rather than `updated_at`.
- [ ] Base source retry deadlines on processing time.
- [ ] Verify identical replay returns `no_output`.
- [ ] Run `pnpm vitest run apps/automation/test/candidate-evidence-worker.test.ts`.

### Task 4: Truthful closed-loop metrics

**Files:**
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/test/closed-loop-operations.test.ts`

- [ ] Use productive job outcome time for candidate progress.
- [ ] Mark negative queue flow as converging even while backlog remains.
- [ ] Keep backlog age visible as an independent risk metric.
- [ ] Run `pnpm vitest run apps/console/test/closed-loop-operations.test.ts`.

### Task 5: Migration barrier and runtime startup

**Files:**
- Create: `apps/migrator/src/cli.ts`
- Create: `deploy/systemd/address-radar-migrate.service`
- Modify: Address Radar worker service units

- [ ] Add a one-shot migration command with bounded lock retry.
- [ ] Make runtime units require the successful migration unit.
- [ ] Remove structural migration from runtime startup after compatibility verification.
- [ ] Exercise a cold boot against a copied production database.

### Task 6: Production acceptance

**Files:**
- Modify: `docs/operations/closed-loop-production-acceptance.md`

- [ ] Run targeted tests, full tests, typecheck, and build.
- [ ] Back up the production database and verify free disk headroom.
- [ ] Deploy with Gateway delivery disabled.
- [ ] Observe two hours of queue delta, candidate facts, lock retries, restarts, and disk usage.
- [ ] Roll back if lock loops, false production counts, or unbounded backlog growth recur.
