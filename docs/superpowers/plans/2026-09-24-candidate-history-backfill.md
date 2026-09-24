# Candidate History Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a historical and real-time candidate-discovery pipeline that backfills milestone tokens from 2026-08-10, extracts high-multiple traders, applies a rolling 30-day admission policy, and exposes the complete funnel in the developer console.

**Architecture:** Keep historical evidence append-only and separate it from trader lifecycle. Dune MCP is used only to design saved queries; production uses the Dune Data API through checkpointed jobs. Historical and real-time events converge into the existing canonical trader-event pipeline before one shared evidence evaluator creates admission snapshots.

**Tech Stack:** TypeScript, Node.js 24, Node SQLite, Vitest, Playwright, Dune MCP, Dune Data API, systemd.

---

### Task 1: Candidate policy V3

**Files:**
- Create: `packages/scoring/src/candidate-admission-policy.ts`
- Modify: `packages/scoring/src/index.ts`
- Modify: `packages/identity/src/candidate-admission-service.ts`
- Modify: `apps/wallet-analysis/src/candidate-discovery.ts`
- Test: `packages/scoring/test/candidate-admission-policy.test.ts`
- Test: `packages/identity/test/candidate-admission-service.test.ts`
- Test: `apps/wallet-analysis/test/candidate-discovery-threshold.test.ts`

- [ ] Define `CandidateEvidenceFact`, `CandidateAdmissionSnapshot`, `CANDIDATE_ADMISSION_WINDOW_MS`, and `evaluateCandidateAdmission`.
- [ ] Add failing tests proving that two non-consecutive Early tokens inside 30 days admit, one Early token does not admit, one Strong token admits, expired evidence becomes historical-only, and one token contributes once.
- [ ] Run `pnpm vitest run packages/scoring/test/candidate-admission-policy.test.ts` and verify the missing API failures.
- [ ] Implement the minimal pure policy and export it from scoring.
- [ ] Keep cumulative qualifying buy threshold at `50 USD` and use the pure policy from candidate discovery.
- [ ] Run targeted tests, `pnpm test`, and `pnpm build`.
- [ ] Commit with `feat: add rolling candidate admission policy`.

### Task 2: Evidence V3 and admission persistence

**Files:**
- Create: `packages/domain/src/candidate-history.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/repository.ts`
- Test: `packages/database/test/candidate-history.test.ts`

- [ ] Define domain records for historical tokens, milestone crossings, evidence V3, admission snapshots, and funnel diagnostics.
- [ ] Add failing migration and repository tests for idempotent evidence, strongest-per-token reads, 30-day windows, append-only history, and lifecycle-independent snapshots.
- [ ] Add additive tables and indexes without deleting legacy milestone or discovery records.
- [ ] Implement repository methods for upsert, list, latest snapshot, and funnel aggregation.
- [ ] Migrate valid legacy discoveries into V3 records with a legacy provenance marker.
- [ ] Run database tests, full tests, and build.
- [ ] Commit with `feat: persist candidate history and admission snapshots`.

### Task 3: Candidate funnel APIs and console

**Files:**
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/index.html`
- Modify: `apps/console/public/app.ts`
- Modify: `apps/console/public/styles.css`
- Test: `apps/console/test/application.test.ts`
- Test: `tests/e2e/address-radar-console.spec.ts`

- [ ] Add failing API tests for `/api/v2/candidate-funnel`, `/api/v2/candidates`, and candidate evidence detail.
- [ ] Implement server-side filters for chain, evidence tier, admission class, current state, identity state, evidence age, and source.
- [ ] Replace lifecycle-only candidate queries with evidence and admission snapshot queries.
- [ ] Add upstream funnel counters, last successful sync times, and Chinese waiting/rejection reasons.
- [ ] Render one trader per row and keep historical-only or already-observing traders visible.
- [ ] Add desktop and mobile E2E coverage for a zero-current-candidate but non-zero-upstream funnel.
- [ ] Run console tests, E2E, full tests, and build.
- [ ] Commit with `feat: expose the candidate discovery funnel`.

### Task 4: Dune connection and dataset validation

**Files:**
- Create: `docs/operations/dune-candidate-backfill.md`
- Modify: `.env.example`
- Modify: deployment environment documentation used by the server

- [ ] Add Dune MCP using API-key authentication without writing the key into the repository.
- [ ] Set the MCP tool timeout to 300 seconds.
- [ ] Verify account usage and indexed chain availability.
- [ ] Identify token, DEX trade, price, supply, and market-cap datasets for Solana, BNB Chain, Ethereum, and Base.
- [ ] Record Robinhood as supported or `historical_provider_unavailable` based on dataset evidence.
- [ ] Document query ownership, credential rotation, production environment names, and credit budget controls.
- [ ] Commit with `docs: define Dune historical backfill operations`.

### Task 5: Saved Dune queries and Data API client

**Files:**
- Create: `packages/collectors/src/dune/data-api-client.ts`
- Create: `packages/collectors/src/dune/types.ts`
- Create: `packages/collectors/src/dune/index.ts`
- Modify: `packages/collectors/src/index.ts`
- Test: `packages/collectors/test/dune-data-api-client.test.ts`

- [ ] Create and validate saved Dune queries for token universe, milestone crossings, and pre-milestone trades.
- [ ] Add failing tests for authentication headers, execution polling, pagination, timeout, retryable errors, terminal errors, and credit-limit responses.
- [ ] Implement a production Data API client that receives the key through dependency injection.
- [ ] Return query and execution IDs as provenance while redacting authentication material.
- [ ] Add bounded polling and cancellation support.
- [ ] Run collector tests, full tests, and build.
- [ ] Commit with `feat: add Dune historical data client`.

### Task 6: Historical partition scheduler

**Files:**
- Create: `apps/wallet-analysis/src/historical-backfill.ts`
- Create: `apps/wallet-analysis/src/historical-partitions.ts`
- Modify: `apps/wallet-analysis/src/main.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/repository.ts`
- Test: `apps/wallet-analysis/test/historical-backfill.test.ts`

- [ ] Add failing tests for chain-day-token-page partitioning, durable cursors, idempotent completion, restart recovery, daily credit budget, and independent chain failure.
- [ ] Persist partition execution ID, offset, row count, attempts, watermark, next retry, and terminal status.
- [ ] Implement one-concurrent-execution scheduling with bounded retries.
- [ ] Start at `2026-08-10 00:00:00 Asia/Shanghai` and advance durable per-chain watermarks.
- [ ] Keep real-time wallet analysis running when historical work pauses or fails.
- [ ] Run targeted tests, full tests, and build.
- [ ] Commit with `feat: schedule checkpointed historical backfills`.

### Task 7: Historical normalization and evidence generation

**Files:**
- Create: `apps/wallet-analysis/src/historical-evidence.ts`
- Modify: `apps/wallet-analysis/src/candidate-discovery.ts`
- Modify: `packages/database/src/repository.ts`
- Test: `apps/wallet-analysis/test/historical-evidence.test.ts`

- [ ] Add failing fixtures for exact and estimated milestone crossings, `50 USD` aggregation, amount-weighted entry market cap, strongest tier per token, duplicate Dune pages, and Fomo/on-chain deduplication.
- [ ] Normalize Dune trades into canonical trader events with query provenance.
- [ ] Route historical and real-time milestone events through the same evaluator.
- [ ] Generate identity-resolution work for unknown wallets without discarding evidence.
- [ ] Persist theoretical, capturable, and realized multiples as separate fields.
- [ ] Run targeted tests, full tests, build, and deterministic replay.
- [ ] Commit with `feat: generate candidate evidence from historical trades`.

### Task 8: Historical token operations UI

**Files:**
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/index.html`
- Modify: `apps/console/public/app.ts`
- Modify: `apps/console/public/styles.css`
- Test: `apps/console/test/application.test.ts`
- Test: `tests/e2e/address-radar-console.spec.ts`

- [ ] Add failing API tests for historical token inventory, partition status, retry, and re-evaluation endpoints.
- [ ] Add one-token-per-row inventory with image, symbol, chain, copyable CA, 1M time, peak market cap, milestone status, backfill status, eligible buyers, evidence traders, and Chinese diagnostics.
- [ ] Add chain, date, milestone, backfill, eligible-buyer, and evidence filters.
- [ ] Add Dune credit use, pending partition count, and historical/real-time watermarks.
- [ ] Run API tests, E2E, full tests, and build.
- [ ] Commit with `feat: add historical candidate operations console`.

### Task 9: Production migration and shadow acceptance

**Files:**
- Create: `scripts/audit-candidate-history.ts`
- Modify: deployment runbook and systemd environment template
- Test: `tests/integration/candidate-history-replay.test.ts`

- [ ] Back up the production database and verify rollback restoration.
- [ ] Add failing integration replay proving historical and real-time inputs converge to identical evidence and snapshots.
- [ ] Run schema migration and legacy evidence conversion against a production copy.
- [ ] Configure the rotated `DUNE_API_KEY`, saved query IDs, daily credit budget, and delivery-disabled shadow mode.
- [ ] Deploy atomically and verify services, APIs, schema version, watermarks, funnel counters, and logs.
- [ ] Start the 2026-08-10 historical backfill and verify checkpoint progress survives a controlled service restart.
- [ ] Keep user delivery disabled and collect shadow acceptance metrics.
- [ ] Run `pnpm test`, `pnpm build`, `pnpm test:e2e`, and the production audit script.
- [ ] Commit with `chore: complete candidate history production rollout`.
