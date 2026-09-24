# Address Radar Workbench V2 SPAC

**Status:** Approved for implementation planning  
**Date:** 2026-09-24  
**Repository:** `address-radar`  
**Scope:** Address Radar service, developer console, trader discovery, identity resolution, token aggregation, signal inspection, wallet history analysis  

## 1. Goal

Build a coherent Address Radar workbench where every visible record can be traced through a complete lifecycle:

```text
source discovery
  -> candidate evidence
  -> identity resolution
  -> monitored trader
  -> normalized Fomo/on-chain events
  -> token aggregation
  -> signal qualification
  -> local signal retention
  -> optional user delivery
```

The workbench must explain what the system knows, what it does not know, why a record has its current state, and what event will cause the next transition. UI changes alone are insufficient; the backend contracts and lifecycle rules are part of this specification.

## 2. Product principles

1. One row represents one business entity. A trader row cannot contain two traders; a token row cannot contain two contracts.
2. Business dimensions must not be mixed. Source, ability, lifecycle, and evidence are separate fields.
3. Missing data is a diagnosable state, not `unknown`.
4. Fomo and on-chain events are complementary observations of the same trader, not separate traders.
5. A provider failure degrades evidence but does not stop the scanner.
6. Signal qualification and signal delivery are independent. Qualified local signals remain visible while delivery is disabled.
7. Every long-running operation exposes progress, heartbeat, retry state, and a terminal result.
8. Console labels and explanations are Chinese. Stable API and database identifiers remain English.
9. Chain options come from the backend registry and are never hard-coded only in the UI.
10. Existing production data is migrated in place and remains auditable.

## 3. Non-goals

- Rebuilding the full chain indexer in this change.
- Replacing the existing Gateway or plugin delivery protocol.
- Turning delivery on automatically after deployment.
- Requiring a complete backtest before a manually trusted identity can be monitored.
- Deleting historical evidence when a trader changes lifecycle state.
- Making lead-time evidence mandatory for all candidate traders.

## 4. Domain model

### 4.1 Trader source

`TraderSource` records how the trader first entered the system. Multiple sources may be attached over time.

| Identifier | Chinese label | Meaning |
|---|---|---|
| `leaderboard_30d_top100` | 30天TOP100 | Imported from the Fomo 30-day top 100 leaderboard |
| `manual` | 手动添加 | Added by the developer |
| `milestone_reverse_discovery` | 里程碑反查 | Found from an early or high-profit position in a milestone token |
| `shared_holding_discovery` | 共同持仓发现 | Found through repeated co-holdings with trusted traders |
| `runtime_discovery` | 运行时发现 | Found during live scanner operation |

The removed 24-hour leaderboard source may remain as historical provenance, but it must not create new monitored traders.

### 4.2 Trader abilities

`TraderAbility` is a many-to-many classification derived from evidence. It must not be used as lifecycle state.

| Identifier | Chinese label |
|---|---|
| `early_multiplier` | 早期高倍 |
| `large_trend` | 大额趋势 |
| `new_token_hunter` | 新币猎手 |
| `revival_trader` | 老币异动 |
| `high_win_rate` | 高胜率 |
| `high_payoff_ratio` | 高盈亏比 |
| `repeatable_edge` | 稳定复现 |
| `insufficient_samples` | 样本不足 |

Each ability assignment stores `confidence`, `sample_count`, `evidence_window`, `assigned_at`, and `last_evaluated_at`.

### 4.3 Trader lifecycle

`TraderLifecycle` defines how the runtime uses a trader.

| Identifier | Chinese label | Monitoring behavior |
|---|---|---|
| `unresolved` | 待解析 | Monitor Fomo only when a Fomo identity exists |
| `candidate` | 候选 | Retain discovery evidence; wait for identity or admission |
| `observing` | 观察中 | Consume Fomo and available wallet events |
| `active` | 正式监控 | Eligible for full aggregation weight |
| `paused` | 暂停 | Preserve history; exclude from new signal qualification |
| `eliminated` | 淘汰 | Preserve audit history; do not monitor |
| `fomo_only` | 仅Fomo监控 | No wallet is available; consume Fomo events only |

Lifecycle transitions must be recorded in an append-only audit table with `from_state`, `to_state`, `reason_code`, `reason_text`, `actor`, and `occurred_at`.

### 4.4 Candidate evidence

Candidate admission uses milestone evidence. Lead time is a bonus and never the sole mandatory condition.

| Market-cap milestone | Accepted multiplier evidence |
|---|---|
| 100K | 3x, 5x |
| 200K | 3x, 5x |
| 300K | 5x |
| 500K | 5x, 10x |
| 1M | 10x, 20x |

`CandidateEvidence` stores:

```ts
interface CandidateEvidence {
  traderId: string;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenImageUrl: string | null;
  entryMarketCapUsd: number | null;
  milestoneMarketCapUsd: number;
  realizedMultiplier: number | null;
  peakMultiplier: number | null;
  leadTimeSeconds: number | null;
  evidenceLevel: string;
  observedAt: string;
  sourceEventIds: string[];
}
```

`evidenceLevel` is derived from milestone and multiplier, not from timing alone. `leadTimeSeconds` increases confidence when available.

### 4.5 Identity model

An identity may have:

- A required `display_name`.
- An optional `fomo_handle`.
- Zero or more EVM wallets.
- Zero or more Solana wallets.
- Source, ability, and lifecycle fields defined above.

At least one of `fomo_handle`, EVM wallet, or Solana wallet is required. A manually added identity with at least one wallet enters `observing` immediately. A Fomo identity without a wallet enters `fomo_only` or `unresolved` according to the operator's selection.

### 4.6 Canonical event identity

Fomo and on-chain observations are normalized into the existing canonical trader-event pipeline. Deduplication uses provider event identity first and semantic identity second:

```text
trader_id + chain + token_address + side + normalized_amount_bucket + event_time_bucket
```

The canonical event retains all source references. A Fomo event and an on-chain event may merge into one logical observation while preserving both evidence sources.

## 5. State machines

### 5.1 Candidate lifecycle

```text
milestone detected
  -> candidate evidence created
  -> candidate visible
  -> identity resolved or manually completed
  -> candidate removed from pending view
  -> trader enters observing
  -> monitoring produces samples
  -> trader may become active, paused, or eliminated
```

Resolving an identity must not delete candidate evidence. It only removes the candidate from the pending queue.

Thirty-day top 100 and manually trusted traders bypass `candidate` and enter `observing`.

### 5.2 Token aggregation lifecycle

```text
collecting
  -> awaiting_traders
  -> awaiting_quality
  -> early_qualified
  -> confirmed_qualified
  -> signal_created
```

Side states:

```text
insufficient_amount
awaiting_identity
insufficient_data
not_qualified
expired
```

Every state transition records a machine-readable reason and a Chinese explanation. The console must show the explanation and may expose the raw reason only inside developer details.

### 5.3 Wallet analysis lifecycle

```text
queued
  -> collecting
  -> normalizing
  -> pricing
  -> evaluating
  -> completed
```

Alternative terminal or recovery states:

```text
retrying
partial
failed
cancelled
blocked
```

Each job stores `processed_transactions`, `discovered_tokens`, `progress_percent`, `heartbeat_at`, `checkpoint`, `provider_statuses`, `last_error`, `next_retry_at`, and `completed_at`.

A non-terminal job with no heartbeat for the configured timeout becomes `blocked`; it must not continue to appear as normally running.

## 6. Diagnostic status contract

The UI must never expose bare `unknown`. Existing unknown values are translated to one of these reason codes during migration or read-time normalization:

| Reason code | Chinese explanation |
|---|---|
| `awaiting_market_data` | 等待市场数据 |
| `missing_entry_price` | 缺少入场价格 |
| `missing_current_price` | 缺少当前价格 |
| `missing_peak_price` | 缺少历史最高价 |
| `unresolved_token_identity` | 代币身份未解析 |
| `unknown_trade_direction` | 交易方向未知 |
| `provider_unavailable` | 数据源暂不可用 |
| `awaiting_reevaluation` | 等待重新评估 |
| `invalid_sample` | 样本无效 |

Each diagnostic contains:

```ts
interface DiagnosticReason {
  code: string;
  labelZh: string;
  detailZh: string;
  provider: string | null;
  retryable: boolean;
  nextRetryAt: string | null;
}
```

## 7. Console information architecture

### 7.1 Compact workbench header

Reduce the current hero height by at least 50 percent. Keep only:

- Address Radar title.
- Overall runtime state.
- Last event time.
- End-to-end delay.
- Provider health summary.
- Manual refresh.

### 7.2 KPI strip

Display a single compact row:

- Address library count.
- Candidate trader count.
- Pending identity count.
- Monitored wallet count.
- Aggregated token count.
- Qualified local signal count.
- Delivered signal count.

Each KPI links to the corresponding pre-filtered view.

### 7.3 Address library

One row per canonical trader. Columns:

- Display name and optional Fomo handle.
- Solana wallets.
- EVM wallets.
- Source labels.
- Ability labels.
- Lifecycle.
- Quality score.
- Sample count.
- Updated time.

Filters:

- Search name, handle, or wallet.
- Source.
- Ability.
- Lifecycle.
- Address completeness.
- Chain.
- Sample-count range.
- Quality band.

Trader details open from the row. Leaderboard history is collapsed to the same initial height as wallet identity and shows only best rank, latest rank, appearance count, and last appearance. Full history expands on demand.

### 7.4 Candidate queue

One row per trader. Columns:

- Trader identity.
- Resolved wallets.
- Discovery source.
- Highest milestone.
- Highest multiplier tier.
- Lead-time evidence.
- Evidence count.
- Lifecycle.
- First and latest evidence time.

Filters:

- Source.
- Chain.
- Market-cap tier.
- Multiplier tier.
- Identity resolution state.
- Lifecycle.
- Discovery time.
- Name or wallet search.

Candidate counts and empty-state explanations are mandatory. An empty queue must state whether no milestones were observed, no traders met evidence tiers, identity processing consumed all pending candidates, or collection is stale.

### 7.5 Historical samples and coverage

One row per trader sample. Display a total count and counts grouped by diagnostic status. Filters include chain, result, diagnostic reason, multiplier tier, data provider, and evaluation time.

The page displays:

- Total samples.
- Completed samples.
- Waiting samples.
- Invalid samples.
- Failed samples.
- Counts by diagnostic reason.
- Last processed time.
- Next retry time.

### 7.6 Token aggregation

The aggregation key is always `chain + token_address`. One row represents one contract.

Columns:

- Token image.
- Name and symbol.
- Chain.
- Contract address with copy action.
- Token lifecycle stage.
- Total participating traders.
- Qualified participating traders.
- Total normalized buy amount.
- Largest single buy.
- Last buy time.
- Aggregation state.
- Exact missing condition.
- Evidence sources.

Filters:

- Token name or contract.
- Chain from backend registry.
- Token lifecycle.
- Aggregation state.
- Trader ability.
- Minimum buy amount.
- Participating trader count.
- Signal qualification state.
- Time range.

The view displays stream freshness, latest event time, and next scheduled evaluation. Raw database codes are never presented as primary text.

### 7.7 Signal results

One row per token signal. Signal qualification and delivery are separate columns.

Columns:

- Token identity and chain.
- Signal type.
- First or repeat broadcast number.
- Qualification time.
- Market cap at qualification.
- Current market cap.
- Peak market cap.
- Current multiplier.
- Peak multiplier.
- Participating trader count.
- Local qualification status.
- Delivery status.

Signals remain for at least seven days. Filters include chain, signal type, token lifecycle strategy, broadcast number, delivery status, and time range.

### 7.8 Identity resolution

The form supports two modes:

1. Fomo identity: `fomo_handle` required, `display_name` optional, at least one wallet optional when selecting `fomo_only`.
2. Independent wallet identity: `display_name` required, `fomo_handle` optional, at least one wallet required.

The operator can assign source and ability labels. Manually trusted wallet identities enter `observing` immediately. Unresolvable identities can be changed to `fomo_only`, deferred, or deleted after confirmation. Historical events are retained after deletion.

### 7.9 Wallet analysis

The page shows job progress, current phase, processed transaction count, discovered token count, heartbeat, provider states, last error, next retry, and completion summary. It supports cancel and retry. A 60-day and maximum-300-token boundary remains the default production policy.

## 8. API contracts

Existing console endpoints remain backward-compatible during migration. Add versioned workbench endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v2/workbench/summary` | Compact runtime and KPI summary |
| `GET` | `/api/v2/traders` | Paginated address library with filters |
| `GET` | `/api/v2/traders/:id` | Trader details and evidence |
| `GET` | `/api/v2/candidates` | Pending candidate traders |
| `GET` | `/api/v2/samples` | Historical samples and diagnostics |
| `GET` | `/api/v2/token-aggregates` | One-row-per-contract aggregation |
| `GET` | `/api/v2/signals` | Qualified and delivered signals |
| `GET` | `/api/v2/identity-resolution` | Pending identity work |
| `POST` | `/api/v2/identities` | Create Fomo or independent-wallet identity |
| `PATCH` | `/api/v2/identities/:id` | Resolve, label, pause, or mark Fomo-only |
| `DELETE` | `/api/v2/identities/:id` | Soft-delete identity after confirmation |
| `POST` | `/api/v2/wallet-analyses` | Start wallet history analysis |
| `GET` | `/api/v2/wallet-analyses/:id` | Read job progress and result |
| `POST` | `/api/v2/wallet-analyses/:id/retry` | Retry failed or blocked job |
| `POST` | `/api/v2/wallet-analyses/:id/cancel` | Cancel a non-terminal job |
| `GET` | `/api/v2/chains` | Supported chain registry for all filters |

List endpoints use server-side pagination and return `total`, `items`, `page`, `pageSize`, `updatedAt`, and `freshness`. Filter values are validated server-side.

## 9. Persistence and migration

Add normalized persistence for:

- Trader sources.
- Trader abilities.
- Lifecycle transition audit.
- Candidate evidence.
- Diagnostic reasons.
- Wallet-analysis heartbeat and progress.

Migration rules:

1. Existing `30D TOP100` labels become source `leaderboard_30d_top100`.
2. Existing manual labels become source `manual`.
3. Existing milestone or early-high-multiple labels become candidate evidence and derived abilities.
4. Existing timing-hit labels become lead-time evidence only.
5. Existing `unknown` sample states are mapped to a diagnostic reason using available fields; ambiguous rows become `awaiting_reevaluation` rather than remaining `unknown`.
6. Existing resolved candidates enter `observing` and disappear from the pending candidate query.
7. Existing signal and event history is retained unchanged.
8. Migration is idempotent and records its version.

The old columns remain readable for one release. V2 writes only the normalized model. A rollback can continue using old read paths without deleting V2 data.

## 10. File and module plan

### Domain and policy

- Modify `packages/domain/src/identity.ts` for source, ability, and lifecycle contracts.
- Modify `packages/domain/src/lifecycle.ts` for transition rules.
- Modify `packages/domain/src/outcomes.ts` for diagnostic reasons.
- Modify `packages/domain/src/wallet-analysis.ts` for explicit job progress.
- Modify `packages/scoring/src/candidate-tier-policy.ts` for milestone and multiplier tiers.
- Modify `packages/scoring/src/candidate-promotion.ts` so timing is optional evidence.
- Modify `packages/scoring/src/trader-ability-evaluator.ts` for normalized ability assignments.

### Persistence and identity workflow

- Modify `packages/database/src/schema.ts` for normalized tables and columns.
- Modify `packages/database/src/migrations.ts` for idempotent V2 migration.
- Modify `packages/database/src/repository.ts` for paginated filtered queries.
- Modify `packages/identity/src/candidate-admission-service.ts` for candidate closure after resolution.
- Modify `packages/identity/src/manual-resolution-service.ts` for optional Fomo handle and immediate observation.
- Modify `packages/identity/src/monitoring-registry.ts` for manual wallet enrollment.

### Discovery, aggregation, and signals

- Modify `apps/wallet-analysis/src/candidate-discovery.ts` to emit all configured milestone tiers.
- Modify `apps/wallet-analysis/src/store.ts` for progress and heartbeat persistence.
- Modify `apps/wallet-analysis/src/service.ts` for retry, blocked, partial, and cancellation behavior.
- Modify `packages/aggregation/src/repository.ts` for one-contract aggregation queries.
- Modify `packages/aggregation/src/service.ts` for event-driven reassessment and exact missing conditions.
- Modify `packages/signal-engine/src/policy.ts` only where normalized ability or lifecycle fields replace legacy labels.

### Console

- Modify `apps/console/src/application.ts` for V2 query and mutation handlers.
- Modify `apps/console/src/server.ts` for V2 routes.
- Modify `apps/console/public/index.html` for compact information architecture.
- Modify `apps/console/public/app.ts` for pagination, filtering, expandable details, progress polling, and Chinese status rendering.
- Modify `apps/console/public/styles.css` for compact header and one-row-per-entity tables.

### Tests

- Extend `packages/domain/test/*` for lifecycle and diagnostic invariants.
- Extend `packages/scoring/test/candidate-tier-policy.test.ts` for every milestone tier.
- Extend `packages/identity/test/trader-identity-workflow.test.ts` for candidate closure and manual observation.
- Extend `packages/database/test/repository.test.ts` for migration and filtered pagination.
- Extend `packages/aggregation/test/*` for one-contract aggregation and precise reasons.
- Extend `apps/wallet-analysis/test/*` for heartbeat, blocked jobs, partial results, retry, and cancellation.
- Extend `apps/console/test/application.test.ts` for V2 endpoint contracts.
- Extend `tests/e2e/address-radar-console.spec.ts` for layout, filters, one-row invariants, manual identity, and wallet-analysis progress.

## 11. Implementation checkpoints

### Checkpoint 1: Contracts and migration

- Introduce normalized domain types.
- Add idempotent database migration.
- Map legacy labels and unknown states.
- Prove existing data remains readable.
- Commit independently.

### Checkpoint 2: Candidate and identity lifecycle

- Implement all milestone tiers.
- Make timing bonus-only.
- Close pending candidates after resolution.
- Support manual identities without Fomo handles.
- Enroll manual wallets into observation.
- Commit independently.

### Checkpoint 3: Aggregation and signal inspection

- Normalize Fomo and on-chain observations.
- Enforce one aggregation per chain and contract.
- Persist exact missing conditions.
- Separate local qualification from delivery.
- Commit independently.

### Checkpoint 4: Wallet-analysis reliability

- Persist progress and heartbeat.
- Detect blocked jobs.
- Add retry, partial, cancellation, and resume behavior.
- Keep the 60-day and 300-token bounds.
- Commit independently.

### Checkpoint 5: Console V2

- Build compact header and KPI strip.
- Rebuild address, candidate, sample, aggregation, signal, identity, and analysis views.
- Add server-side pagination and filters.
- Render Chinese labels and diagnostic explanations.
- Enforce one row per trader or contract.
- Commit independently.

### Checkpoint 6: Production migration and acceptance

- Back up the production database.
- Deploy with delivery disabled.
- Run migration once and verify counts.
- Confirm live events continue during V2 reads.
- Validate each acceptance scenario.
- Keep the previous release and database snapshot as rollback points.

## 12. Test matrix

| Scenario | Expected result |
|---|---|
| 100K token with a trader reaching 3x | Candidate evidence is created without timing evidence |
| 500K token with a trader reaching 10x | Candidate receives the 500K/10x tier |
| Trader has only lead-time evidence | Lead time raises confidence but does not fabricate a multiplier tier |
| 30-day top 100 trader imported | Trader enters `observing`, not `candidate` |
| Manually added EVM-only trader | Identity is valid and enters `observing` |
| Manually added Solana-only trader | Identity is valid and enters `observing` |
| Fomo-only trader has no wallet | Identity enters `fomo_only` and remains monitorable |
| Candidate receives a wallet | Candidate disappears from pending view; evidence remains in details |
| Fomo and chain report the same purchase | One logical observation retains two sources |
| Provider is unavailable | Aggregation continues with a retryable diagnostic |
| Two traders buy one contract | One token row shows two participants |
| One trader buys two contracts | Two token rows are displayed |
| Delivery is disabled | Qualified signal is retained locally and marked not delivered |
| Wallet analysis stops heartbeating | Job becomes `blocked` and exposes retry |
| One chain fails during analysis | Completed chain data is retained and job becomes `partial` |
| Legacy sample is `unknown` | V2 API returns a precise diagnostic reason |

## 13. Acceptance criteria

1. The top workbench area is at least 50 percent shorter and all KPIs remain visible.
2. Address library, candidates, historical samples, token aggregates, and signals display one entity per row.
3. Thirty-day top 100 and manually trusted traders bypass the candidate queue.
4. Candidate discovery supports all specified market-cap and multiplier tiers.
5. Timing evidence is optional and cannot be the only displayed evidence classification.
6. Resolved candidates leave the pending queue without losing audit evidence.
7. Manual identities can omit the Fomo handle and use either one EVM or one Solana wallet.
8. Manually trusted identities enter observation immediately.
9. Every displayed `unknown` is replaced with a precise Chinese diagnostic.
10. Token aggregation supports chain, lifecycle, state, ability, amount, trader-count, qualification, and time filters.
11. Chain filters include every chain returned by the server registry, including Robinhood when configured.
12. Qualified local signals are visible while user delivery remains disabled.
13. Wallet analysis exposes live progress and cannot remain silently stuck.
14. Existing production event and signal history remains queryable after migration.
15. Scanner, wallet monitor, wallet analysis, and console restart without manual database repair.

## 14. Release and rollback

Deployment remains delivery-off by default. Before migration, create a production database snapshot and record the active release. Deploy the new release, run the idempotent migration, then validate read paths before enabling new writes. If acceptance fails, stop V2 services, restore the prior release pointer and database snapshot, and retain V2 logs for diagnosis. No destructive schema cleanup is included in this release.

