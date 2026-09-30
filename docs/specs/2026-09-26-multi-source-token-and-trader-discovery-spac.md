# Address Radar Multi-Source Token and Trader Discovery SPAC

**Status:** Approved design, pending implementation plan  
**Date:** 2026-09-26  
**Repository:** `address-radar`  
**Scope:** Five-chain token discovery, trader discovery, source convergence, targeted history recovery, degradation, observability, and candidate evidence  

## 1. Goal

Build a source-independent discovery system that continuously finds tokens and capable traders on:

```text
Solana
Ethereum
BSC
Base
Robinhood
```

The system must continue real-time discovery when Dune, Fomo, one RPC endpoint, or one market provider is unavailable. Dune remains a bounded historical enrichment provider and must never be part of the real-time critical path.

The system must answer these questions from the developer console:

```text
Which source first discovered this token or trader?
Which independent sources observed the same event?
How fresh and complete is each source?
How many raw tokens became market-resolved tokens?
How many reached a configured milestone?
How many produced qualifying early-trader evidence?
Which identities are unresolved?
Why did a token or trader stop progressing?
Which provider or budget is currently limiting coverage?
```

## 2. Product principles

1. No single provider owns truth. Every provider contributes an observation with provenance.
2. Raw observations are append-only. Derived state may be rebuilt without recollecting source data.
3. Real-time discovery, targeted recovery, and broad historical research are separate workloads.
4. Dune failure pauses only Dune-backed history. It cannot stop Fomo, RPC, market resolution, aggregation, or signals.
5. Fomo presence is a product-eligibility fact, not permission to discard raw on-chain evidence.
6. One valid source may create an observation. More sources increase confidence but never duplicate participants or capital.
7. Provider absence is a diagnosable state, not a negative fact.
8. Candidate capability is based on independent token outcomes, not the number of providers reporting the same trade.
9. Coordinated wallets count as one independent participant while retaining complete capital-flow evidence.
10. Every long-running collector is checkpointed, idempotent, rate-limited, and independently degradable.
11. Console labels and explanations are Chinese. Stable database and API identifiers remain English.
12. User delivery remains disabled until separately approved. Qualified local signals are still stored and evaluated.

## 3. Considered approaches

### 3.1 Dune-centric discovery

Use Dune for token universe discovery, milestone reconstruction, and early-buyer extraction.

Advantages:

- Broad historical SQL access.
- Simple cross-chain analytics model.
- Low initial infrastructure cost.

Rejected as the primary architecture because:

- Daily credits can stop all progress.
- Query latency is unsuitable for early discovery.
- Coverage and schema quality differ by chain.
- A provider outage would become a product outage.

### 3.2 Provider mesh with a canonical observation ledger

Use independent Fomo, RPC, market, journal, and Dune adapters. Persist every observation before normalization and derive one canonical event stream.

Advantages:

- Real-time operation does not depend on Dune.
- Existing collectors and data can be reused.
- Provider failures are isolated.
- New providers can be added without changing scoring or signal delivery.
- Every decision remains auditable.

This is the selected architecture.

### 3.3 Full self-hosted chain indexer

Index all five chains from genesis or a fixed historical watermark.

Advantages:

- Maximum control over history and query behavior.
- No third-party query credits.

Deferred because:

- It significantly increases storage, operations, protocol decoding, and reorg handling.
- It does not solve Fomo-only trades or username identity.
- It is unnecessary while targeted RPC recovery plus retained source journals provide sufficient real-time coverage.

The architecture preserves an indexer adapter boundary so a self-hosted indexer can be added later.

## 4. Workload separation

### 4.1 Real-time discovery

Target latency: source event to persisted raw observation within `30 seconds` under healthy conditions.

Responsibilities:

- Read Fomo Follow feed and token pages.
- Monitor known wallets and registered Launchpad/DEX contracts.
- Detect new tradable pairs and token launches.
- Resolve current market facts.
- Update milestone state.
- Normalize trader events.
- Evaluate candidate and token aggregation rules.

Allowed providers:

```text
Fomo network responses and DOM fallback
EVM HTTP/WS RPC pools
Solana HTTP/WS RPC pools
DexScreener
local durable journals
```

Dune is explicitly excluded.

### 4.2 Targeted recovery

Target latency: recover a known token or wallet gap within `30 minutes` when at least one recovery provider is healthy.

Responsibilities:

- Fill missing blocks after RPC disconnects.
- Re-read Fomo token history for a known CA.
- Fetch known wallet signatures, receipts, and transaction details.
- Re-resolve missing market identity or launch time.
- Re-evaluate evidence after identity or market facts arrive.

Targeted recovery operates only on known tokens, wallets, blocks, or time gaps. It is not a full-chain scan.

### 4.3 Broad historical research

Target latency: best effort, budget bounded.

Responsibilities:

- Discover historical milestone tokens outside retained local journals.
- Reconstruct exact or estimated milestone crossing times.
- Load pre-milestone buyers for candidate research.

Providers:

```text
Dune Data API
retained Fomo history
retained local event journals
optional future explorer or indexer adapters
```

History failure never blocks the other workloads.

## 5. Provider responsibilities

| Provider | Primary responsibilities | Must not be used for |
| --- | --- | --- |
| Fomo Follow feed | Live platform activity, usernames, Fomo-only buys, token mentions | Exact chain history when the page does not expose it |
| Fomo token page | CA verification, holder/trader lists, token-specific trade history, identity clues | Treating an empty page during provider failure as `not_found` |
| Fomo 30D Top 100 | Trusted seed identities entering observation | 24-hour leaderboard admission |
| EVM RPC pools | Contract events, wallet transactions, receipts, transfer and swap evidence, block recovery | Broad arbitrary wallet history without an index |
| Solana RPC pools | Program logs, signatures for known addresses, transaction details, slot recovery | Unbounded historical scans through a public endpoint |
| DexScreener | Current pair identity, price, liquidity, market cap, launch and pair metadata | Exact historical milestone time unless timestamped historical evidence exists |
| Local journals | Replay, crash recovery, source audit, deterministic reprocessing | Inventing facts absent from the original record |
| Dune | Broad historical universe and exact/estimated history reconstruction | Real-time token discovery or signal availability |
| Manual operator input | Trusted identity, labels, explicit overrides with audit | Silent replacement of source evidence |

## 6. Chain source matrix

| Chain | Real-time token discovery | Wallet monitoring | Current market | Targeted history | Broad history |
| --- | --- | --- | --- | --- | --- |
| Solana | Fomo, registered programs, RPC logs | signatures and transaction details for known wallets | DexScreener | Fomo history, RPC signatures, local journal | Dune when bounded supply reconstruction is available |
| Ethereum | Fomo, registered Launchpad/DEX contracts, RPC logs | HTTP/WS RPC pool | DexScreener | logs, receipts, local journal | Dune |
| BSC | Fomo, Flap and other registered Launchpad/DEX contracts, RPC logs | HTTP/WS RPC pool | DexScreener | logs, receipts, local journal | Dune |
| Base | Fomo, registered Launchpad/DEX contracts, RPC logs | HTTP/WS RPC pool | DexScreener | logs, receipts, local journal | Dune |
| Robinhood | Fomo, registered Launchpad/DEX contracts, RPC logs | shared EVM adapter with chain-specific registry | DexScreener | logs, receipts, local journal | Dune when dataset quality is verified |

Every EVM chain must have at least two HTTP endpoints and one WS endpoint in its provider pool. The runtime rotates on timeout, rate limit, transport failure, or stale head detection. Missing fallback configuration is visible in the console and does not disable other chains.

## 7. Canonical data flow

```text
source adapter
  -> immutable source observation
  -> validation and chain normalization
  -> token and identity resolution
  -> canonical event matcher
  -> market and lifecycle enrichment
  -> milestone evaluator
  -> trader candidate evaluator
  -> monitoring registry
  -> token aggregation
  -> local qualified signal
  -> optional Gateway delivery
```

No adapter writes directly to candidate, aggregation, or signal tables. Adapters only write source observations and durable cursors. All downstream decisions are reproducible from the ledger.

## 8. Observation contracts

### 8.1 Source observation envelope

```ts
interface SourceObservation<TPayload> {
  observationId: string;
  source: SourceId;
  sourceEventId: string;
  chain: "solana" | "eth" | "bsc" | "base" | "robinhood";
  observedAt: number;
  collectedAt: number;
  payloadVersion: number;
  payload: TPayload;
  confidence: number;
  extractionMode: "network" | "dom" | "rpc" | "api" | "manual" | "replay";
  provenance: Record<string, unknown>;
}
```

`observationId` is deterministic for retry safety:

```text
hash(source, source_event_id, payload_version)
```

### 8.2 Token identity

```text
token_id = canonical_chain + ":" + normalized_contract_address
```

- EVM addresses are lowercase.
- Solana addresses preserve case.
- Name and symbol are never identity keys.
- Conflicting chain or CA facts produce an identity conflict; they never merge automatically.

### 8.3 Canonical trader event

```ts
interface CanonicalTraderEvent {
  canonicalEventId: string;
  traderId: string;
  chain: string;
  tokenAddress: string;
  side: "buy" | "sell";
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  occurredAt: number;
  sourceState: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN";
  sourceObservationIds: string[];
  confidence: number;
}
```

Provider count never changes participant count. It only improves event confidence and data completeness.

## 9. Event convergence and deduplication

Deduplication has three levels:

### 9.1 Provider identity

The same source event ID is idempotent.

Examples:

```text
EVM: chain + tx_hash + log_index
Solana: signature + instruction_index + inner_instruction_index
Fomo: stable response event ID; otherwise account + token + side + timestamp + amount fingerprint
Dune: query_version + chain + tx_hash + event_index
```

### 9.2 Semantic matching

Fomo and chain observations may merge when all available facts agree:

```text
same trader identity
same chain and normalized token
same side
occurred within 30 seconds
amount difference within configured tolerance when both amounts exist
```

The merged event retains every source reference.

### 9.3 Bundle independence

Canonical event deduplication happens before wallet-bundle detection. The existing bundle policy remains authoritative:

- Purchases within `10 seconds` are suspected bundle evidence.
- Purchases within `5 seconds` are strong timing evidence.
- Repeated co-occurrence on two tokens confirms a recurring relation.
- A bundle contributes one independent participant and its strongest member score.
- All wallet events and USD amounts remain auditable.

## 10. Token discovery

### 10.1 Discovery paths

A token enters the raw inventory through any of these paths:

1. Fomo Follow or token-page observation.
2. Registered Launchpad launch event.
3. Registered DEX pair creation or first real swap.
4. Buy or sell by a monitored wallet.
5. DexScreener resolution of a previously unknown CA.
6. Historical provider discovery.
7. Manual operator submission.

The token is stored immediately even when symbol, image, market cap, Fomo status, or launch time is missing.

### 10.2 Token progression

```text
raw_observed
  -> identity_resolved
  -> market_resolved
  -> fomo_pending | fomo_confirmed | fomo_not_found | fomo_deferred
  -> milestone_observed
  -> early_buyer_recovery
  -> evidence_evaluated
```

These are orthogonal dimensions, not one destructive status field. For example, an on-chain token may be `market_resolved`, `fomo_deferred`, and `milestone_observed` simultaneously.

### 10.3 Launch definition

Token creation or minting is not launch. A token is launched only after it becomes tradable through a real market or completes the Launchpad migration condition defined in the chain protocol registry.

The lifecycle classifier retains the existing signal families:

```text
created or pre-launch
launched 0-2h
launched 2-12h
launched 12-24h
older 1-7d
older 7d+
```

### 10.4 Milestones

The active milestone set remains:

```text
100K
200K
300K
500K
1M
```

Current market observations may create an `observed` milestone with observation time. They cannot claim an exact historical crossing time. Historical reconstruction may later replace precision with `exact` or `estimated` while preserving the original real-time observation.

### 10.5 Fomo eligibility

Fomo verification no longer blocks raw storage, market resolution, RPC monitoring, or candidate research.

It affects product eligibility as follows:

| Fomo state | Candidate research | Local signal qualification | User delivery |
| --- | --- | --- | --- |
| `confirmed` | Yes | Yes | Eligible when delivery is enabled |
| `pending` / `queued` / `deferred` | Yes, with incomplete coverage | Yes, labelled incomplete | Held unless developer override exists |
| `not_found` | Preserve and analyze chain facts | No Fomo-radar signal | No |
| `mismatch` | Quarantine conflicting identity | No | No |
| `unsupported` | Preserve raw audit only | No | No |

A provider outage never becomes `not_found`. Two healthy exact-CA lookup failures are still required.

## 11. Trader and address discovery

### 11.1 Seed sources

#### Fomo 30D Top 100

- Import only the 30-day Top 100.
- Seed traders bypass candidate admission and enter `observing`.
- Missing wallets produce `fomo_only` monitoring and an identity-resolution item.
- Ranking changes update provenance but do not delete the trader.

#### Manual identities

- Require a display name and at least one Fomo handle, EVM wallet, or Solana wallet.
- Manually trusted identities enter `observing` immediately.
- Every label and lifecycle override is audited.

### 11.2 Milestone reverse discovery

When a token reaches a configured milestone:

1. Read retained Fomo and on-chain events first.
2. Request Fomo token history when local coverage is incomplete.
3. Perform targeted RPC recovery for known transaction or block gaps.
4. Use Dune only for unresolved broad historical gaps.
5. Aggregate each trader's qualifying buys before the crossing.
6. Emit only the strongest evidence tier per trader and token.

The existing candidate tiers remain:

| Milestone | Accepted opportunity | Admission class |
| --- | --- | --- |
| `100K` | `3x`, `5x` | Early |
| `200K` | `3x`, `5x` | Early |
| `300K` | `5x` | Strong |
| `500K` | `5x`, `10x` | Strong |
| `1M` | `10x`, `20x` | Strong |

The cumulative qualifying buy minimum remains `50 USD`.

### 11.3 Repeatable runtime discovery

An unknown wallet or Fomo user becomes a candidate when either rule is satisfied inside the rolling 30-day window:

```text
at least two distinct tokens with Early evidence
or
at least one distinct token with Strong evidence
```

The two Early tokens do not need to be consecutive. One token contributes only its strongest tier.

### 11.4 Shared-holding and co-trade discovery

Unknown traders appearing with trusted traders are retained as prospects. They become candidates only when:

- They independently satisfy milestone evidence; or
- They co-occur with trusted traders on at least two distinct tokens and have at least one independently verified positive outcome.

Bundle members, funding-linked wallets, and repeated sub-10-second groups are not promoted merely because they co-occur.

### 11.5 Identity progression

```text
wallet-only prospect
  -> candidate evidence
  -> optional Fomo username resolution
  -> monitored identity

Fomo-only prospect
  -> candidate evidence
  -> optional wallet resolution
  -> monitored identity
```

A Fomo username is not mandatory for a wallet-derived candidate. A wallet is not mandatory for Fomo-only monitoring. Resolution enriches identity; it does not decide whether historical evidence exists.

## 12. Source confidence

Confidence is explicit and never inferred from a provider name alone.

Initial observation confidence defaults:

| Observation | Default confidence |
| --- | ---: |
| Matched Fomo and on-chain event | `1.00` |
| Decoded on-chain swap with confirmed wallet | `0.90` |
| Structured Fomo network response | `0.85` |
| Dune row with transaction identity | `0.85` |
| Fomo DOM extraction | `0.65` |
| Estimated historical market crossing | `0.60` |
| Manual fact without external confirmation | `0.55` |

Confidence may decrease for stale collection, incomplete identity, missing amount, estimated market cap, or conflicting timestamps. It may increase when independent observations converge. It is capped at `1.00`.

Source confidence affects evidence confidence and diagnostics. It does not multiply the trader's vote or create extra token samples.

## 13. Provider health and degradation

### 13.1 Health states

```text
healthy
degraded
rate_limited
stale
unavailable
misconfigured
```

Each provider-chain pair records:

```text
last_attempt_at
last_success_at
last_event_at
consecutive_failures
latency_ms
rate_limit_reset_at
cursor_or_block_height
last_error_code
```

### 13.2 Initial freshness thresholds

| Stream | Degraded | Stale |
| --- | ---: | ---: |
| Fomo live feed | `60s` without progress | `5m` |
| RPC head | `30s` behind expected head | `2m` |
| Wallet observation | `2m` behind source cursor | `10m` |
| Active-token market snapshot | `2m` | `10m` |
| Historical worker heartbeat | `10m` | `30m` |

Quiet markets do not count as stale when the source cursor or heartbeat advances.

### 13.3 Failure behavior

| Failure | Behavior |
| --- | --- |
| Dune budget exhausted | Pause broad history until the next budget window |
| Dune query failure | Retry that partition; continue all real-time paths |
| Fomo login expired | Continue RPC and market collection; queue Fomo lookups |
| Fomo page changed | Switch network parser to DOM fallback; mark degraded |
| One RPC endpoint fails | Rotate to the next endpoint and retain the recovery gap |
| All RPC endpoints for one chain fail | Continue other chains and Fomo; retry missing block range later |
| DexScreener fails | Persist token and event; queue market enrichment |
| Identity missing | Preserve evidence under wallet or Fomo account identity |
| SQLite busy | WAL and bounded busy timeout; retry the transaction without dropping the observation |

No provider failure clears evidence, removes a trader, or changes a missing fact into a negative fact.

## 14. Durable jobs and budgets

Every background job stores:

```text
job_id
job_type
chain
subject_key
status
priority
cursor
attempt_count
next_attempt_at
lease_expires_at
last_error
created_at
updated_at
completed_at
```

Priority order:

1. Persist incoming real-time observations.
2. Recover RPC block and cursor gaps.
3. Resolve market facts for active tokens.
4. Recover early buyers for a newly reached milestone.
5. Resolve candidate identity.
6. Execute broad historical research.

Dune keeps its independent daily budget. Historical scheduling uses least-recently-completed chain fairness before date ordering. A chain with no completed partition receives priority in the next available budget window.

Provider budgets are independent. Exhausting one budget cannot consume or pause another provider's queue.

## 15. Persistence model

### 15.1 New or generalized records

```text
source_observations
source_cursors
source_health
token_observation_state
token_market_snapshots
recovery_jobs
provider_budget_usage
```

### 15.2 Existing authoritative records

```text
trader_events
raw_trader_observations
canonical_trader_events
canonical_trader_event_observations
token_milestones
historical_tokens
candidate_evidence_v3
candidate_admission_snapshots
wallet_bundle_pair_tokens
token_evaluation_state
token_aggregation_state
broadcast_records
```

Existing records are extended through additive migrations. No historical table is renamed or destructively rewritten in this project.

### 15.3 Retention

| Data | Retention |
| --- | --- |
| Canonical trader events and candidate evidence | Permanent |
| Provider cursors, milestones, identities, lifecycle audit | Permanent |
| Raw compact source observations | At least `180 days` |
| Raw large response bodies | `30 days`, then compressed or removed after hash verification |
| Market snapshots for active tokens | Full resolution for `30 days`, hourly rollup afterward |
| Provider health samples | `90 days`, daily rollup afterward |
| Qualified signal outcomes | Permanent; console default window remains `7 days` |

## 16. Re-evaluation triggers

Derived state is re-evaluated when any of these events occurs:

```text
new canonical buy or sell
market snapshot crosses a milestone
historical crossing precision improves
identity resolves or merges
bundle relation becomes recurring
missing amount or market cap is enriched
Fomo verification changes state
provider replay adds previously missing events
strategy version changes
```

Re-evaluation is idempotent. It creates versioned evidence or snapshots and never overwrites the provenance of an earlier decision.

## 17. Developer console

### 17.1 Multi-source operations panel

Display one row per provider-chain pair:

```text
provider
chain
health state
last success
last source event
cursor or block height
latency
pending recovery jobs
budget usage
last Chinese diagnostic
```

### 17.2 Token discovery funnel

Display per chain:

```text
raw observed tokens
identity-resolved tokens
market-resolved tokens
Fomo-confirmed tokens
milestone tokens
tokens with recovered early buyers
tokens producing candidate evidence
tokens entering aggregation
qualified local signals
```

The existing `observed -> milestone -> historical admitted -> aggregation` panel remains, but receives source and freshness drill-down.

### 17.3 Trader discovery funnel

Display:

```text
30D Top 100 seeds
manual identities
wallet-only prospects
Fomo-only prospects
milestone evidence traders
shared-holding prospects
identity pending
current candidate admission
observing traders
active traders
```

### 17.4 Diagnostics

Every blocked or incomplete record uses a Chinese explanation selected from stable reason codes. Raw database identifiers are available only in an expandable developer detail.

Examples:

```text
等待 Fomo 精确 CA 验证
市场数据暂不可用，已进入补齐队列
已发现链上交易，尚未解析 Fomo 身份
已达到 50 万市值，正在回补早期买家
已有一个早期证据，还需另一个独立代币证据
Dune 今日额度已用完，实时扫描不受影响
RPC 已切换备用节点，正在补齐缺失区块
疑似捆绑钱包，独立参与者按一人计算
```

## 18. API boundaries

Initial operator APIs:

```text
GET  /api/v2/sources/health
GET  /api/v2/sources/cursors
GET  /api/v2/discovery/token-funnel
GET  /api/v2/discovery/trader-funnel
GET  /api/v2/recovery/jobs
POST /api/v2/recovery/jobs/:jobId/retry
POST /api/v2/tokens/:tokenId/re-evaluate
POST /api/v2/traders/:traderId/re-evaluate
```

The existing Gateway and public `RadarSignal` contract remain unchanged. Source detail, trader names, wallet addresses, and internal scores are developer-only and are never added to the user signal payload.

## 19. Security and compliance

- Provider keys remain in protected server environment files.
- Keys, browser cookies, and Fomo session data never enter SQLite payloads, logs, APIs, or the console.
- The Fomo browser profile runs under a dedicated service account with restricted filesystem permissions.
- Collectors respect provider rate limits and do not bypass authentication or access controls.
- Manual corrections record actor, timestamp, previous value, new value, and reason.
- Raw external text is data, never executable instructions.
- Developer endpoints remain loopback-only until a separately approved HTTPS and authentication design is deployed.

## 20. Implementation phases

### Phase 1: Source contracts and observability

- Add source observation, cursor, health, budget, and recovery-job contracts.
- Preserve current collector behavior while dual-writing immutable observations.
- Add source health and five-chain token-funnel APIs.
- Prove replay creates the same canonical event IDs.

### Phase 2: Real-time provider isolation

- Run Fomo, EVM RPC, Solana RPC, and market enrichment as independent jobs.
- Configure HTTP/WS RPC pools for every EVM chain.
- Persist gaps and cursors before failover.
- Ensure one collector failure cannot abort the scanner cycle.

### Phase 3: Targeted token and wallet recovery

- Recover known Fomo token history.
- Recover known wallet and block gaps through RPC.
- Add market enrichment retry queues.
- Trigger idempotent re-evaluation after facts arrive.

### Phase 4: Multi-path trader discovery

- Connect 30D Top 100, manual, milestone, runtime, and shared-holding sources.
- Admit wallet-only and Fomo-only candidates without manufacturing missing identities.
- Apply milestone evidence and bundle independence consistently across sources.

### Phase 5: Historical-provider mesh

- Keep Dune as one broad-history adapter.
- Replay retained local and Fomo journals before spending Dune credits.
- Add an optional explorer/indexer interface without enabling an unverified provider.
- Reconcile provider overlap through canonical event identities.

### Phase 6: Console and operations

- Add provider-chain health, source contribution, recovery queues, and freshness diagnostics.
- Add Chinese explanations and drill-down provenance.
- Add controlled retry and re-evaluation operations.

### Phase 7: Shadow production validation

- Keep user delivery disabled.
- Run source-failure drills.
- Replay identical fixtures through each provider path.
- Compare candidate evidence, aggregation, and signal decisions.
- Approve delivery only through a separate production-readiness decision.

## 21. Test strategy

### 21.1 Contract tests

- Every adapter emits the same versioned observation envelope.
- EVM and Solana normalization follow chain-specific identity rules.
- Invalid or unsupported observations are retained with explicit rejection reasons.

### 21.2 Deduplication tests

- Duplicate provider events remain one observation.
- Matching Fomo and chain trades become one canonical event.
- Provider overlap does not double participant count or USD amount.
- Solana case sensitivity and EVM lowercase normalization are preserved.

### 21.3 Degradation tests

- Dune can be unavailable for `24 hours` while real-time discovery and signals continue.
- Fomo login expiry queues work without stopping RPC ingestion.
- Primary RPC failure rotates to fallback and records a recovery gap.
- DexScreener failure retains tokens and later enriches them.
- SQLite contention retries without losing observations.

### 21.4 Candidate tests

- One Strong token admits a candidate.
- Two non-consecutive Early tokens inside 30 days admit a candidate.
- One token reported by three providers still counts once.
- Bundle wallets count as one independent participant.
- Wallet-only and Fomo-only candidates remain visible and diagnosable.

### 21.5 Replay tests

- Replaying the same journal is idempotent.
- Real-time and historical representations of the same trade converge.
- Improved milestone precision re-evaluates evidence without deleting the prior audit record.
- Restarting each worker resumes from its durable cursor.

## 22. Acceptance criteria

1. Disabling Dune does not change real-time Fomo, RPC, market, aggregation, or local-signal availability.
2. Each supported chain has an explicit real-time source path and an independently reported health state.
3. Every raw token and trader observation has source provenance and a deterministic identity.
4. Provider overlap never duplicates a trader vote, token sample, capital amount, or candidate evidence.
5. RPC disconnects create recoverable gaps and do not silently skip blocks.
6. Fomo network parsing automatically degrades to DOM parsing with a visible health warning.
7. Tokens progress independently through identity, market, Fomo, milestone, and evidence dimensions.
8. Reaching a milestone triggers local/Fomo/RPC recovery before spending Dune credits.
9. Candidate admission continues to use the approved milestone tiers and `50 USD` cumulative minimum.
10. 30D Top 100 and manually trusted identities enter observation without candidate delay.
11. Wallet-only and Fomo-only candidates can be monitored without fake placeholder identities.
12. Bundle policy is applied before participant-based aggregation and signal scoring.
13. Dune daily budget exhaustion is visible and affects only broad history.
14. Historical scheduling is fair across the five supported chains.
15. The console exposes token and trader discovery funnels with freshness and Chinese diagnostics.
16. Every recovery and backfill worker survives restart without duplicate derived records.
17. Existing production history remains readable and no destructive migration is required.
18. Gateway delivery remains disabled unless separately enabled through an audited configuration change.

## 23. Migration from the current system

1. Keep current tables and services running.
2. Add immutable observation and provider-state tables through additive migrations.
3. Dual-write current Fomo and RPC events to the observation ledger and existing event pipeline.
4. Replay a bounded production journal into a shadow database and compare canonical events.
5. Move market and milestone enrichment behind durable jobs.
6. Route candidate discovery through the canonical event ledger.
7. Add console source and recovery views.
8. Stop direct adapter writes only after shadow equality passes.
9. Retain the pre-migration database and release as a read-only rollback point.

Rollback switches workers back to the existing direct path. New observation tables remain inert and are not deleted.

## 24. Explicit non-goals

- Building a full block explorer or indexing every transaction on every chain.
- Adding Monad or chains outside the five-chain registry.
- Treating current market cap as an exact historical crossing.
- Assuming Fomo performs all safety validation.
- Requiring every candidate to have both an EVM and a Solana wallet.
- Requiring a Fomo username for wallet-derived candidates.
- Automatically purchasing tokens or executing user trades.
- Enabling user delivery as part of this implementation.
- Adding an unverified paid provider merely to increase provider count.

## 25. Compatibility and rule precedence

This SPAC extends the existing workbench, candidate-history, Fomo-verification, and wallet-bundle specifications. When requirements conflict, the following precedence applies:

1. Raw observations are always retained. The earlier Fomo gate must not block raw storage, market resolution, RPC monitoring, or candidate research.
2. Fomo verification still governs Fomo-radar user-delivery eligibility exactly as defined in this document.
3. The approved candidate tiers, rolling 30-day admission window, `50 USD` cumulative minimum, and one-strong-or-two-early rule remain unchanged.
4. The approved wallet-bundle rules remain unchanged and are applied after canonical event convergence.
5. Dune remains the broad-history provider defined by the historical-backfill specification, but local journals, Fomo history, and targeted RPC recovery run before Dune for already known subjects.
6. The active chain registry is exactly Solana, Ethereum, BSC, Base, and Robinhood. Earlier four-chain wording is obsolete; Monad remains excluded.

## 26. Final architecture decision

Address Radar adopts a provider mesh backed by one immutable observation ledger and one canonical event pipeline.

```text
Fomo + RPC + DexScreener + local journals + bounded Dune history
  -> source observations
  -> canonical tokens, identities, and trader events
  -> milestones and early-trader evidence
  -> monitored address library
  -> token aggregation
  -> local radar signals
  -> optional existing Gateway delivery
```

Dune extends historical reach. It does not determine whether Address Radar can operate.
