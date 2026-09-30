# Multi-Source Token and Trader Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace provider-specific discovery dependencies with an immutable multi-source observation ledger, canonical convergence, independently degradable recovery jobs, and observable five-chain token and trader funnels.

**Architecture:** Fomo, RPC, DexScreener, local journals, manual input, and Dune emit versioned source observations. Durable projectors normalize these observations into the existing canonical trader-event, milestone, candidate, aggregation, and signal pipeline. Real-time collection, targeted recovery, and broad history have independent queues, budgets, and health states.

**Tech Stack:** TypeScript, Node.js 24, Node SQLite, Vitest, existing Fomo/RPC/DexScreener/Dune adapters, systemd, static TypeScript developer console.

---

## File structure

New focused units:

```text
packages/domain/src/source-observation.ts
packages/database/src/source-ledger-store.ts
packages/collectors/src/source-observation-ingestor.ts
apps/scanner/src/source-health.ts
apps/scanner/src/recovery-runtime.ts
apps/wallet-analysis/src/multi-source-candidate-discovery.ts
```

Existing files are modified only at their integration boundaries:

```text
packages/domain/src/index.ts
packages/database/src/index.ts
packages/database/src/migrations.ts
packages/database/src/repository.ts
packages/collectors/src/index.ts
apps/scanner/src/collectors.ts
apps/scanner/src/runtime.ts
apps/scanner/src/cli.ts
apps/console/src/application.ts
apps/console/public/index.html
apps/console/public/app.ts
```

## Task 1: Versioned source-observation contracts

**Files:**
- Create: `packages/domain/src/source-observation.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/source-observation.test.ts`

- [ ] Write failing tests for supported source IDs, five-chain normalization, EVM lowercase normalization, Solana case preservation, deterministic observation IDs, health-state validation, and invalid confidence rejection.
- [ ] Run `corepack pnpm --filter @address-radar/domain exec vitest run test/source-observation.test.ts` and verify the missing-module failure.
- [ ] Implement immutable contracts:

```ts
export type SourceId =
  | "fomo_feed" | "fomo_token_page" | "fomo_leaderboard"
  | "rpc_evm" | "rpc_solana" | "dexscreener" | "dune"
  | "manual" | "journal_replay";

export type SourceHealthState =
  | "healthy" | "degraded" | "rate_limited"
  | "stale" | "unavailable" | "misconfigured";

export interface SourceObservation<TPayload = unknown> {
  readonly observationId: string;
  readonly source: SourceId;
  readonly sourceEventId: string;
  readonly chain: "solana" | "eth" | "bsc" | "base" | "robinhood";
  readonly observedAt: number;
  readonly collectedAt: number;
  readonly payloadVersion: number;
  readonly payload: TPayload;
  readonly confidence: number;
  readonly extractionMode: "network" | "dom" | "rpc" | "api" | "manual" | "replay";
  readonly provenance: Readonly<Record<string, unknown>>;
}
```

- [ ] Export `normalizeDiscoveryChain`, `normalizeDiscoveryAddress`, `sourceObservationId`, and `createSourceObservation` with strict validation.
- [ ] Run the targeted test and package build.

## Task 2: Immutable source ledger and additive migration

**Files:**
- Create: `packages/database/src/source-ledger-store.ts`
- Modify: `packages/database/src/migrations.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/test/source-ledger-store.test.ts`

- [ ] Write failing tests for idempotent observation insertion, payload/provenance round-trip, per-source cursor monotonicity, provider-chain health, independent budgets, durable recovery leases, retry, and restart recovery.
- [ ] Add additive tables and indexes:

```text
source_observations
source_cursors
source_health
provider_budget_usage
recovery_jobs
```

- [ ] Store payload and provenance as JSON and reject an existing observation ID with conflicting content.
- [ ] Implement atomic recovery-job claim, checkpoint, completion, retry, and expired-lease recovery.
- [ ] Keep WAL, busy timeout, and foreign-key configuration through `openAddressRadarDatabase`.
- [ ] Run database tests and build.

## Task 3: Collector dual-write without behavior changes

**Files:**
- Create: `packages/collectors/src/source-observation-ingestor.ts`
- Modify: `packages/collectors/src/ingestion.ts`
- Modify: `packages/collectors/src/index.ts`
- Modify: `apps/scanner/src/collectors.ts`
- Test: `packages/collectors/test/source-observation-ingestor.test.ts`
- Test: `apps/scanner/test/production-boundaries.test.ts`

- [ ] Write failing tests proving Fomo, on-chain, and replay records first persist a source observation and then preserve the current `TraderEvent` behavior.
- [ ] Implement a dual-write ingestor that returns `observationInserted`, `eventInserted`, and `canonicalEventId` without allowing duplicate source rows to duplicate events.
- [ ] Map current source names to stable `SourceId` values and retain the original event ID in provenance.
- [ ] Keep unsupported or malformed observations auditable with explicit rejection reason rather than inserting an invalid trader event.
- [ ] Run collector and scanner tests.

## Task 4: Provider health, cursors, and independent degradation

**Files:**
- Create: `apps/scanner/src/source-health.ts`
- Modify: `apps/scanner/src/runtime.ts`
- Modify: `apps/scanner/src/cli.ts`
- Test: `apps/scanner/test/source-health.test.ts`
- Test: `apps/scanner/test/runtime.test.ts`

- [ ] Write failing tests for healthy progress, quiet-but-advancing cursors, stale detection, rate-limit reset, provider isolation, and one-chain failure.
- [ ] Record one health row per provider-chain pair after every collection attempt.
- [ ] Use stream-specific freshness thresholds from the SPAC.
- [ ] Persist cursors before acknowledging collected records.
- [ ] Ensure collector failure cannot abort another collector or erase the last successful cursor.
- [ ] Run scanner tests and build.

## Task 5: Durable targeted recovery runtime

**Files:**
- Create: `apps/scanner/src/recovery-runtime.ts`
- Modify: `apps/scanner/src/config.ts`
- Modify: `apps/scanner/src/cli.ts`
- Test: `apps/scanner/test/recovery-runtime.test.ts`

- [ ] Write failing tests for recovery priority, retryable provider failure, terminal identity conflict, lease expiry, restart resume, and provider-specific budgets.
- [ ] Implement job types:

```text
rpc_gap
fomo_token_history
market_enrichment
identity_resolution
milestone_early_buyers
historical_research
```

- [ ] Enforce priority: real-time persistence, RPC gaps, market enrichment, milestone buyers, identity, broad history.
- [ ] Route Dune budget exhaustion only to `historical_research` jobs.
- [ ] Trigger token or trader re-evaluation after successful enrichment.
- [ ] Run scanner tests and build.

## Task 6: Token progression and multi-source market facts

**Files:**
- Modify: `packages/database/src/source-ledger-store.ts`
- Modify: `apps/scanner/src/runtime.ts`
- Modify: `apps/scanner/src/cli.ts`
- Test: `apps/scanner/test/token-progression.test.ts`

- [ ] Write failing tests for orthogonal identity, market, Fomo, milestone, and evidence dimensions.
- [ ] Persist raw tokens immediately, including missing symbol, image, market cap, launch time, or Fomo state.
- [ ] Keep observed milestone time separate from exact and estimated historical crossing time.
- [ ] Queue market enrichment instead of dropping DexScreener failures.
- [ ] Queue Fomo lookup without blocking RPC monitoring or candidate research.
- [ ] Apply the five-chain registry and quarantine unsupported chains without deleting observations.

## Task 7: Multi-path trader discovery and candidate convergence

**Files:**
- Create: `apps/wallet-analysis/src/multi-source-candidate-discovery.ts`
- Modify: `apps/wallet-analysis/src/candidate-discovery.ts`
- Modify: `apps/wallet-analysis/src/historical-evidence.ts`
- Modify: `packages/identity/src/candidate-admission-service.ts`
- Test: `apps/wallet-analysis/test/multi-source-candidate-discovery.test.ts`
- Test: `packages/identity/test/trader-identity-workflow.test.ts`

- [ ] Write failing tests for 30D Top 100 seeds, manual identities, wallet-only prospects, Fomo-only prospects, milestone reverse discovery, runtime repeatability, and shared-holding discovery.
- [ ] Preserve the approved `50 USD`, milestone-tier, one-Strong-or-two-Early, rolling-30-day policy.
- [ ] Ensure one token contributes only its strongest tier regardless of source count.
- [ ] Require shared-holding prospects to have two-token co-occurrence and one independently positive outcome.
- [ ] Apply canonical deduplication and bundle independence before candidate counting.
- [ ] Trigger identity resolution as enrichment rather than an evidence prerequisite.

## Task 8: Multi-source console and operator APIs

**Files:**
- Modify: `apps/console/src/application.ts`
- Modify: `apps/console/public/index.html`
- Modify: `apps/console/public/app.ts`
- Test: `apps/console/test/workbench-v2.test.ts`
- Test: `apps/console/test/application.test.ts`

- [ ] Write failing API tests for source health, cursors, token funnel, trader funnel, recovery jobs, retry, and re-evaluation.
- [ ] Add Chinese provider-chain diagnostics and retain English stable identifiers in expandable details.
- [ ] Extend the token funnel to raw, identity-resolved, market-resolved, Fomo-confirmed, milestone, early-buyer, candidate-evidence, aggregation, and qualified-signal stages.
- [ ] Add trader-source funnel and wallet-only/Fomo-only diagnostics.
- [ ] Keep one business entity per row and preserve existing chain, status, and search filters.

## Task 9: End-to-end replay, failure drills, and production rollout

**Files:**
- Create: `apps/scanner/test/multi-source-replay.test.ts`
- Modify: `deployment/address-radar.env.example`
- Modify: `docs/operations/dune-candidate-backfill.md`
- Create: `docs/operations/multi-source-discovery.md`

- [ ] Prove identical Fomo, RPC, and Dune representations converge into one canonical event and one candidate evidence row.
- [ ] Prove replay is idempotent and restart resumes every cursor and lease.
- [ ] Prove Dune unavailable for 24 hours does not change real-time aggregation or local signal production.
- [ ] Prove primary RPC failure rotates to fallback and records a recoverable gap.
- [ ] Run `corepack pnpm test` and `corepack pnpm build`.
- [ ] Deploy to a timestamped release, keep Gateway delivery disabled, restart services, and verify health, restart counts, source freshness, queue progress, and absence of SQLite lock errors.
- [ ] Retain the previous release and database backup as rollback points.

## Completion gate

Implementation is complete only when all 18 acceptance criteria in `docs/specs/2026-09-26-multi-source-token-and-trader-discovery-spac.md` pass and production shows independent progress from at least Fomo, RPC, and market paths while Dune is paused or budget exhausted.
