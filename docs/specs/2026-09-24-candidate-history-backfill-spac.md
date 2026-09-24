# Address Radar Candidate History Backfill SPAC

**Status:** Approved design, pending implementation plan  
**Date:** 2026-09-24  
**Repository:** `address-radar`  
**Target branch:** `codex-workbench-v2`  
**Scope:** Historical token discovery, milestone reconstruction, early-trader evidence, candidate admission, candidate observability, Dune integration  

## 1. Goal

Build a complete and observable candidate-discovery pipeline that:

1. Backfills every supported token that reached at least `1,000,000 USD` market cap from `2026-08-10 00:00:00 Asia/Shanghai` onward.
2. Reconstructs the token's real `100K`, `200K`, `300K`, `500K`, and `1M` milestone crossing times.
3. Finds traders who bought before those milestones and measures their early-entry opportunity.
4. Preserves all historical capability evidence while using a rolling 30-day window for current candidate admission.
5. Continues the same process incrementally for newly observed tokens.
6. Shows the complete candidate funnel even when the final candidate count is zero.

The system must answer all of these questions from the developer console:

```text
How many milestone tokens were discovered?
How many were backfilled?
How many early buys were valid?
How many traders earned evidence?
How many identities remain unresolved?
How many traders satisfy current admission?
Why did each rejected record fail?
What will happen next?
```

## 2. Product principles

1. Candidate evidence and trader lifecycle are independent dimensions.
2. Historical evidence is append-only and never disappears when it ages out of the active window.
3. Current admission is time-bounded; historical reputation is not.
4. Two early-evidence tokens do not need to be consecutive.
5. One token can contribute at most one strongest evidence record to an admission window.
6. A cumulative qualifying buy must be at least `50 USD`.
7. The system distinguishes theoretical opportunity, capturable return, and realized return.
8. Dune failure degrades historical coverage but never stops real-time scanning.
9. A zero-result queue must still expose upstream progress and rejection reasons.
10. Every background job is idempotent, checkpointed, retryable, and cost-bounded.

## 3. Non-goals

- Replacing the real-time RPC and Fomo collectors with Dune.
- Making Dune MCP a production runtime dependency.
- Requiring traders to sell before early-entry evidence can be recorded.
- Treating theoretical opportunity as realized profit.
- Requiring qualifying tokens to be consecutive trades.
- Automatically enabling user delivery after historical backfill.
- Deleting old candidate discoveries or changing existing signal history.

## 4. Definitions

### 4.1 Historical token universe

A token belongs to the initial historical universe when all conditions are true:

| Field | Requirement |
|---|---|
| Time | Reached the target on or after `2026-08-10 00:00:00 Asia/Shanghai` |
| Peak market cap | At least `1,000,000 USD` |
| Market identity | A valid chain and token address are available |
| Trading evidence | At least one verifiable DEX or Fomo trade exists |

The `1M` threshold selects the historical token universe. Once selected, the system reconstructs every supported lower milestone for that token.

### 4.2 Milestone crossing

A milestone crossing is the earliest verified time at which a token reached or exceeded one of these market caps:

```text
100,000 USD
200,000 USD
300,000 USD
500,000 USD
1,000,000 USD
```

The crossing time must come from historical market data. It must not use the time when Address Radar first noticed the token.

If the exact crossing cannot be reconstructed, the milestone is marked `estimated` or `unavailable`; it must not silently use a later observation time as an exact crossing.

### 4.3 Qualifying buy

A trader's buys qualify for one token and one milestone when:

- The side is `buy`.
- The trade occurred no later than the milestone crossing time.
- The amount and entry market cap are both positive and supported by provenance.
- The cumulative buy amount for the trader, token, and milestone is at least `50 USD`.

Multiple buys are combined using an amount-weighted entry market cap:

```text
weighted_entry_market_cap =
  sum(entry_market_cap * buy_amount_usd) / sum(buy_amount_usd)
```

The theoretical opportunity multiple is:

```text
theoretical_opportunity =
  milestone_market_cap / weighted_entry_market_cap
```

### 4.4 Return dimensions

Every evidence record may carry three separate return dimensions:

| Metric | Meaning |
|---|---|
| `theoretical_opportunity` | Milestone market cap divided by weighted entry market cap |
| `capturable_multiple` | Maximum return supported by the post-entry price path and available liquidity |
| `realized_multiple` | Return supported by actual sells plus marked remaining inventory |

Candidate admission may use theoretical opportunity when sell history is unavailable. The console must label it as theoretical and must not present it as realized profit.

## 5. Candidate evidence policy

### 5.1 Evidence tiers

| Milestone | Evidence tiers | Admission class |
|---|---|---|
| `100K` | `3x`, `5x` | Early |
| `200K` | `3x`, `5x` | Early |
| `300K` | `5x` | Strong |
| `500K` | `5x`, `10x` | Strong |
| `1M` | `10x`, `20x` | Strong |

For one trader and one token, only the strongest satisfied tier counts toward admission. Lower tiers remain visible in the evidence history but do not increase the independent-token count.

### 5.2 Current admission window

The current admission window is the rolling 30 days ending at evaluation time.

A trader satisfies current candidate admission when either condition is true:

```text
Condition A:
  at least 2 distinct tokens with Early evidence in the rolling 30-day window

Condition B:
  at least 1 distinct token with Strong evidence in the rolling 30-day window
```

The two Early-evidence tokens:

- Do not need to be consecutive.
- May be on different supported chains.
- Must have different normalized token keys.
- Must each satisfy the `50 USD` cumulative buy minimum.
- Must both have evidence timestamps inside the same rolling 30-day window.

No minimum total number of traded tokens is required in V1 of this policy. Trade-volume denominators and hit rates are retained for scoring and later optimization, not for initial admission.

### 5.3 Historical capability

Evidence outside the rolling 30-day window remains in the permanent capability ledger.

A trader with qualifying historical evidence but no current-window admission receives:

```text
historical_capability = true
current_admission = false
status = awaiting_recent_confirmation
```

This trader remains visible in the console and may be monitored at reduced weight according to existing lifecycle rules.

### 5.4 Lifecycle independence

Candidate evidence must not force a destructive lifecycle transition.

Examples:

| Existing lifecycle | New evidence behavior |
|---|---|
| `suspended` | Create evidence and propose candidate reactivation |
| `candidate` | Update evidence and current admission snapshot |
| `probation` / `observing` | Keep lifecycle; show candidate evidence as satisfied |
| `active` / `elite` | Keep lifecycle; enrich ability and evidence history |

Candidate console queries must use candidate evidence and admission snapshots. They must not filter only by `trader_entities.lifecycle = 'candidate'`.

## 6. Data sources

### 6.1 Dune responsibilities

Dune provides the initial historical universe and chain-history reconstruction where indexed data is available:

- Discover tokens reaching `1M` after the configured start time.
- Reconstruct milestone crossing timestamps.
- Load pre-milestone swaps and trader addresses.
- Supply transaction hashes, block times, amounts, prices, and query provenance.

Dune MCP is a development and operations tool used to:

- Discover appropriate Dune datasets.
- Create and maintain saved queries.
- Validate query results.
- Inspect usage and query cost.

The production service does not call MCP. It calls the Dune Data API using saved query IDs and a server-side `DUNE_API_KEY` secret.

### 6.2 Real-time responsibilities

Existing RPC, Fomo, and market collectors remain responsible for:

- Detecting new tokens and milestone crossings after the historical watermark.
- Capturing Fomo-only buys not visible in wallet transactions.
- Capturing wallet events and canonicalizing duplicate Fomo/on-chain observations.
- Re-evaluating evidence when better market or identity data arrives.

### 6.3 Chain coverage

The first production query set targets Dune-indexed chains already used by Address Radar:

```text
Solana
BNB Chain
Ethereum
Base
```

Robinhood coverage is enabled only if an indexed Dune dataset can be verified. Until then, Robinhood remains real-time/Fomo-only and is reported as `historical_provider_unavailable`, not silently omitted.

## 7. Historical backfill architecture

### 7.1 Pipeline

```text
Dune token-universe query
  -> historical token inventory
  -> milestone reconstruction query
  -> milestone crossing records
  -> pre-milestone trade query
  -> normalized trader events
  -> candidate evidence evaluation
  -> identity matching
  -> admission snapshot
  -> console funnel
```

### 7.2 Incremental partitions

Backfill work is partitioned by:

```text
chain + UTC day + token page
```

Each partition stores a durable cursor, query execution ID, result offset, row count, credit estimate, retry count, and watermark. A completed partition is never executed again unless its strategy version changes or an operator explicitly requests re-evaluation.

### 7.3 Idempotency

Suggested stable keys:

```text
historical_token_id = hash(chain, token_address)
milestone_id = hash(chain, token_address, milestone_market_cap)
trade_event_id = hash(chain, tx_hash, event_index, trader_address, token_address)
evidence_id = hash(strategy_version, trader_id, token_id, strongest_tier)
admission_snapshot_id = hash(strategy_version, trader_id, window_end)
```

Repeated Dune rows, retries, and overlapping real-time events must converge into the same canonical records.

### 7.4 Cost controls

- Estimate scanned data before executing a new saved query.
- Query one chain and bounded date partition at a time.
- Use saved queries or materialized views for reusable token-universe results.
- Limit concurrent Dune executions to one during initial backfill.
- Apply exponential retry only to retryable errors.
- Stop scheduling new Dune partitions when the configured daily credit budget is reached.
- Expose consumed credits, estimated remaining credits, and pending partitions in the console.

## 8. Data model changes

### 8.1 Historical token inventory

```ts
interface HistoricalToken {
  tokenId: string;
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  imageUrl: string | null;
  firstTradeAt: number | null;
  firstReached1mAt: number;
  peakMarketCapUsd: number;
  source: string;
  sourceQueryId: string | null;
  provenance: unknown;
}
```

### 8.2 Milestone crossing

```ts
interface TokenMilestoneCrossing {
  milestoneId: string;
  tokenId: string;
  marketCapUsd: number;
  crossedAt: number | null;
  precision: "exact" | "estimated" | "unavailable";
  source: string;
  sourceEventIds: string[];
  strategyVersion: string;
}
```

### 8.3 Candidate evidence V3

```ts
interface CandidateEvidenceV3 {
  evidenceId: string;
  traderId: string;
  tokenId: string;
  milestoneId: string;
  evidenceType: string;
  admissionClass: "early" | "strong";
  cumulativeBuyUsd: number;
  weightedEntryMarketCapUsd: number;
  theoreticalOpportunity: number;
  capturableMultiple: number | null;
  realizedMultiple: number | null;
  evidenceAt: number;
  sourceEventIds: string[];
  strategyVersion: string;
}
```

### 8.4 Admission snapshot

```ts
interface CandidateAdmissionSnapshot {
  snapshotId: string;
  traderId: string;
  windowStart: number;
  windowEnd: number;
  earlyDistinctTokenCount: number;
  strongDistinctTokenCount: number;
  historicalDistinctTokenCount: number;
  currentAdmission: boolean;
  historicalCapability: boolean;
  status: string;
  reasonCodes: string[];
  strategyVersion: string;
  evaluatedAt: number;
}
```

## 9. Candidate funnel

The funnel is a persisted operational projection, not a UI-only calculation.

### 9.1 Funnel stages

| Stage | Meaning |
|---|---|
| `token_discovered` | Token entered historical or real-time inventory |
| `milestones_reconstructed` | At least one real crossing was resolved |
| `trade_backfill_completed` | Pre-milestone trades were loaded |
| `eligible_buy_found` | At least one trader passed the `50 USD` minimum |
| `evidence_created` | At least one evidence tier was satisfied |
| `identity_unresolved` | Evidence exists but trader identity needs resolution |
| `historical_only` | Capability exists but not in the rolling 30-day window |
| `current_admitted` | Current 30-day admission is satisfied |
| `monitoring` | Trader is monitored by Fomo, wallet, or both |

### 9.2 Rejection and waiting reasons

```text
milestone_time_unavailable
historical_provider_unavailable
trade_history_empty
buy_amount_below_50_usd
entry_market_cap_unavailable
opportunity_multiple_insufficient
only_one_early_token
evidence_outside_30d_window
identity_unresolved
awaiting_reevaluation
daily_credit_budget_reached
```

Every reason has a precise Chinese label and explanation in the console.

## 10. Console requirements

### 10.1 Candidate status header

The candidate module must remain informative when no current trader is admitted. It displays:

```text
Historical tokens discovered
Tokens with reconstructed milestones
Completed / pending / unavailable backfills
Eligible early buyers
Evidence-bearing traders
Unresolved identities
Historical-only traders
Currently admitted traders
Last successful historical sync
Last successful real-time evaluation
```

### 10.2 Candidate rows

One row represents one trader. Required columns:

```text
Display name or Fomo handle
Wallet identity state
Strongest evidence
Early distinct-token count in 30 days
Strong distinct-token count in 30 days
Historical evidence count
Current admission state
Most recent evidence time
Primary waiting or rejection reason
```

The row remains visible after identity resolution. Resolution changes its state; it does not delete its evidence.

### 10.3 Historical token rows

One row represents one chain and contract address. Required columns:

```text
Token image and symbol
Chain
Copyable contract address
First reached 1M time
Peak market cap
Milestone reconstruction status
Trade backfill status
Eligible buyer count
Evidence trader count
Last update
Failure or waiting reason
```

### 10.4 Filters

Candidate filters:

```text
chain
evidence tier
admission class
current admission state
identity state
evidence age
source
```

Historical token filters:

```text
chain
milestone status
backfill status
has eligible buyers
has evidence traders
date range
```

## 11. API contracts

Suggested endpoints:

```text
GET  /api/v2/candidate-funnel
GET  /api/v2/candidates
GET  /api/v2/candidates/:traderId/evidence
GET  /api/v2/historical-tokens
GET  /api/v2/historical-backfills
POST /api/v2/historical-backfills/start
POST /api/v2/historical-backfills/:partitionId/retry
POST /api/v2/candidates/:traderId/reevaluate
```

Read endpoints support cursor pagination and server-side filters. Mutation endpoints remain developer-only and require the existing local developer authorization boundary.

## 12. Failure and degradation behavior

| Failure | Required behavior |
|---|---|
| Dune unavailable | Pause historical partitions; continue real-time scanning |
| Dune rate or credit limit | Mark budget wait with next eligible time |
| One chain query fails | Continue other chain partitions |
| Crossing time unavailable | Preserve token; block only affected evidence evaluation |
| Partial trade page | Save checkpoint and resume from cursor |
| Identity unresolved | Preserve evidence and show manual-resolution action |
| Duplicate Fomo/on-chain event | Merge into canonical event with both provenance sources |
| Database busy | Retry bounded writes; do not crash the entire scanner |

No provider failure may clear existing evidence or remove a trader from the historical ledger.

## 13. Migration

1. Preserve existing `token_milestones`, `milestone_backfill_jobs`, `milestone_evaluations`, and `candidate_discoveries`.
2. Assign existing evidence to the new strategy version only after provenance validation.
3. Convert valid existing discoveries into V3 evidence records.
4. Build admission snapshots independently of the legacy trader lifecycle.
5. Keep legacy reads available until V2 candidate APIs match production counts.
6. Do not delete the three existing discovery records.

## 14. Delivery phases

### Phase 1: Policy and observability

- Finalize the `50 USD` minimum.
- Add rolling 30-day admission snapshots.
- Decouple candidate evidence from trader lifecycle.
- Add persisted funnel counters and rejection reasons.
- Make the empty candidate console explain current progress.

### Phase 2: Dune historical foundation

- Configure Dune MCP for query development without committing the API key.
- Discover and validate chain datasets.
- Create saved token-universe, milestone, and pre-milestone trade queries.
- Add Data API client, secret configuration, credit controls, and checkpoints.

### Phase 3: Historical backfill

- Backfill from `2026-08-10` by chain and day.
- Reconstruct milestones and canonical trader events.
- Generate evidence, identity-resolution work, and admission snapshots.
- Reconcile Dune rows with existing Fomo and on-chain events.

### Phase 4: Real-time convergence

- Route new milestones through the same evidence evaluator.
- Maintain one historical watermark per chain.
- Re-evaluate when identities, prices, or sells arrive.
- Verify historical and real-time paths produce identical results for the same fixture.

### Phase 5: Production review

- Run shadow mode without user delivery.
- Review funnel volume, false positives, Dune credits, and provider gaps.
- Keep signal delivery disabled until separately approved.

## 15. Testing requirements

### 15.1 Policy tests

- `50.00 USD` is accepted and `49.99 USD` is rejected.
- Two Early tokens inside 30 days admit the trader.
- Two Early tokens outside the shared 30-day window do not admit the trader.
- Early tokens do not need to be consecutive.
- One Strong token inside 30 days admits the trader.
- Multiple tiers on one token count as one independent token.
- Historical evidence remains after it leaves the active window.

### 15.2 Historical tests

- Milestone crossing uses real historical time, not ingestion time.
- Duplicate Dune pages are idempotent.
- Interrupted pages resume from the saved cursor.
- Dune and real-time observations converge into one canonical event.
- Unsupported chains produce explicit provider status.

### 15.3 Console tests

- Zero candidates still shows non-zero upstream funnel counters.
- Every candidate and token occupies one row.
- Chinese reason labels replace raw status identifiers.
- Chain and status filters are server-backed.
- Desktop and mobile layouts expose the same operational facts.

## 16. Acceptance criteria

The feature is accepted when all conditions are true:

1. The historical job can start at `2026-08-10 00:00:00 Asia/Shanghai` and resume after restart.
2. Every indexed supported-chain token reaching `1M` appears in the historical inventory or has an explicit exclusion reason.
3. Real milestone crossing times are stored with precision metadata.
4. Candidate evidence accepts cumulative buys of at least `50 USD`.
5. Current admission uses a rolling 30-day window and does not require consecutive tokens.
6. Historical evidence remains visible after aging out of current admission.
7. Candidate evidence is visible regardless of the trader's lifecycle.
8. The console exposes every candidate-funnel stage and its count.
9. A zero current-candidate count is accompanied by quantified upstream state and rejection reasons.
10. Dune or one-chain failure does not stop real-time scanning or other historical partitions.
11. Dune credentials are stored only in secret configuration and never in source, logs, API responses, or the console.
12. Existing local signal generation and user delivery settings remain unchanged.

## 17. Security and operations

- Store the production credential in `DUNE_API_KEY` with service-user-only permissions.
- Never place the key in a saved query, URL log, source file, test fixture, or Git history.
- Configure the Dune MCP timeout to `300` seconds for long query polling.
- Record query IDs and execution IDs, not authentication material.
- Rotate the API key after initial setup because it has been shared through an interactive conversation.
- Back up the production database before schema migration and before starting the initial backfill.

## 18. Implementation checkpoint order

```text
1. Candidate policy V3 and admission snapshots
2. Candidate funnel persistence and APIs
3. Candidate and historical-token console modules
4. Dune MCP setup and dataset validation
5. Dune saved queries and production Data API client
6. Historical partition scheduler and checkpoints
7. Evidence generation and identity reconciliation
8. Real-time and historical convergence
9. Full replay, quality audit, deployment, and shadow acceptance
```

Each checkpoint requires targeted tests, full regression tests, a focused commit, and production migration notes before the next checkpoint starts.
