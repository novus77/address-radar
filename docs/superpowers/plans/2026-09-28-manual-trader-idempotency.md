# Manual Trader Identity Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual trader admission and wallet analysis creation idempotent while preserving real identity conflicts.

**Architecture:** Resolve identity ownership before writes, reuse one existing account/entity when ownership is unambiguous, and reject cross-owner submissions. Deduplicate active analysis jobs during migration and enforce one active job with a partial unique index.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, systemd

---

### Task 1: Specify manual admission behavior

**Files:**
- Modify: `apps/console/test/application.test.ts`

- [ ] Add a test that creates a wallet-only trader and repeats the request with updated metadata.
- [ ] Assert HTTP 201 then HTTP 200 with stable entity/account IDs.
- [ ] Assert one entity, one wallet identity, and additive tags.
- [ ] Add a test that preserves HTTP 409 when a known handle belongs to another wallet owner.

### Task 2: Implement identity-aware manual upsert

**Files:**
- Modify: `apps/console/src/application.ts`

- [ ] Normalize wallets and resolve all wallet owners.
- [ ] Resolve handle owner, explicit account, and existing entity.
- [ ] Reuse one unambiguous owner and reject multiple/cross-owner requests.
- [ ] Preserve monitoring and locked flags during profile/entity upsert.
- [ ] Return structured created/updated responses and conflict diagnostics.
- [ ] Publish `identity.created` or `identity.updated` and record the matching audit action.

### Task 3: Specify and implement wallet-analysis idempotency

**Files:**
- Modify: `apps/console/test/application.test.ts`
- Modify: `apps/console/src/application.ts`
- Modify: `packages/database/src/migrations.ts`

- [ ] Add a test that repeats the same active analysis request.
- [ ] Return the existing job with HTTP 200 and `reused: true`.
- [ ] Rank existing duplicate active jobs and mark non-winners as superseded.
- [ ] Create a partial unique index for active analysis jobs.

### Task 4: Improve console completion semantics

**Files:**
- Modify: `apps/console/public/app.ts`

- [ ] Capture the form before asynchronous work.
- [ ] Translate real wallet conflicts into Chinese.
- [ ] Distinguish created and updated outcomes.
- [ ] Treat analysis association and list refresh failures as post-save warnings.

### Task 5: Production repair

**Files:**
- Reference: `docs/specs/2026-09-28-manual-trader-idempotency-spac.md`

- [ ] Back up the production database and environment.
- [ ] Stop database writers and run migrations once.
- [ ] Deploy an immutable release and restart services in dependency order.
- [ ] Idempotently update `高倍巨鲸` with `style.early_launch`.
- [ ] Confirm stable identity ownership, tag state, monitoring registration, and one active analysis.
- [ ] Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
