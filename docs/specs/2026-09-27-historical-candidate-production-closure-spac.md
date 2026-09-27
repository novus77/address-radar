# Historical Candidate Production Closure SPAC

## 1. Objective

Turn the existing historical candidate pipeline into a productive closed loop:

```text
eligible token
-> Fomo verification
-> milestone recovery
-> pre-milestone trades
-> candidate evidence
-> discovered wallet candidate
-> identity and wallet monitoring
```

The pipeline must continue operating when one provider is unavailable. Gateway delivery remains disabled during shadow acceptance.

## 2. Confirmed production diagnosis

The production incident is not a scheduler outage.

- Historical backfill is active and Dune credentials are configured.
- `token_universe` has `200` completed partitions and `91` failed partitions.
- The current global stage gate requires every token-universe partition to complete, so no `milestone_crossings` or `pre_milestone_trades` partitions are created.
- Fomo requests continue to grow, while the result journal has stopped advancing. Thousands of tokens remain `queued` or `deferred`.
- Existing token pages mix verified and unresolved tokens. One unresolved token blocks the whole page.
- Historical evidence creates synthetic `wallet:<chain>:<address>` trader IDs, but the worker discards the returned unresolved-wallet list instead of materializing candidate identities.
- Known quote assets can enter historical research and consume recovery capacity.

## 3. Considered approaches

### A. Progressive reuse of the existing historical service (selected)

Keep Dune queries, Fomo journals, the historical scheduler, and candidate evidence. Replace global stage barriers with verified token batches, quarantine ineligible assets, add Fomo backpressure, and materialize accepted wallet candidates.

Benefits: smallest operational change, preserves existing budgets and idempotency, and supports provider degradation.

Risk: the browser collector remains an external dependency for Fomo-only history. The system must expose this as source staleness rather than retrying without bound.

### B. Fetch all historical data inside Scanner

Scanner would call Dune, RPC, market APIs, and Fomo directly.

Rejected because it duplicates ownership, mixes realtime and historical budgets, and can make Scanner instability stop token discovery.

### C. Replace the pipeline with a commercial indexer

Rejected for the first version because it creates a costly single source and does not remove the need for Fomo identity data.

## 4. Token eligibility boundary

Historical research accepts only Solana, Ethereum, BSC, Base, and Robinhood tokens.

A token is quarantined when any deterministic rule matches:

- unsupported chain;
- empty or invalid canonical address;
- exact match in the canonical quote-asset registry;
- explicit operator exclusion.

Symbol-only matches are diagnostic and do not quarantine a token because meme tokens can reuse symbols. Quarantine is additive and auditable; historical rows are not deleted.

The initial exact registry includes canonical wrapped-native, stablecoin, and major quote assets used by the supported chains. The production incident address `solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` must be rejected.

## 5. Progressive historical stages

The stage planner no longer waits for all token-universe partitions.

### 5.1 Milestone stage

Eligible inputs are tokens with:

- confirmed exact Fomo CA match;
- historical data available;
- no deterministic quarantine reason.

Only these tokens are placed into `milestone_crossings` partitions. Pending Fomo tokens cannot block confirmed tokens.

### 5.2 Early-trade stage

Eligible inputs are verified tokens with at least one usable milestone crossing. Only those tokens are placed into `pre_milestone_trades` partitions.

### 5.3 Stable partition identity

Partition IDs include a deterministic fingerprint of the canonical token-address page. Newly verified tokens create new pages without mutating or invalidating completed partitions. Reprocessing remains safe because milestone and evidence writes are idempotent.

## 6. Fomo backpressure and source freshness

Fomo verification must not generate an unbounded journal while the browser collector is stale.

- Limit active queued lookups to `100` by default.
- Use exponential retry delay based on attempt count: 30 minutes, 2 hours, then 12 hours.
- Expired queued entries do not count as active capacity and may be reconsidered fairly.
- Persist a source-health diagnostic when result freshness exceeds the configured threshold.
- Never treat Fomo staleness as absence, mismatch, or terminal rejection.

The browser collector remains responsible for authenticated Fomo page access. The server remains productive for already verified tokens while that collector is unavailable.

## 7. Discovered wallet materialization

Historical evidence may evaluate an address that is not in the existing address library.

After an unresolved wallet produces accepted candidate evidence:

1. Create or reuse a deterministic entity ID `wallet:<chain>:<canonical-address>`.
2. Create the canonical one-chain wallet identity.
3. Mark lifecycle as `candidate`, source as `milestone`, and monitoring policy as `periodic`.
4. Preserve the evidence under the same entity ID.
5. Do not require a Fomo username.
6. Do not promote wallets that produced no accepted evidence.

Identity conflicts remain terminal and auditable. Candidate admission and later ability evaluation continue to decide whether the wallet becomes realtime monitored.

## 8. Recovery semantics

`historical_research_pending` is a waiting condition, not a generic provider failure.

- Recovery tasks remain retryable with bounded exponential backoff.
- The console displays the missing fact and upstream stage.
- Completion requires a usable milestone or the requested coverage fact.
- Successful milestone or early-trade writes wake matching `candidate_evidence` work.
- Provider outage never blocks Scanner token discovery or Gateway health.

## 9. Observability

The developer console and API expose:

- eligible, quarantined, pending-Fomo, milestone-ready, and early-trade-ready token counts;
- Fomo request/result freshness and active queue size;
- historical partitions by stage and status;
- unresolved accepted wallets and materialized candidate wallets;
- source-block reasons, recovery progress, and blocked-to-woken totals.

All operator-facing diagnostics use Chinese labels. Raw reason codes remain available in technical details.

## 10. Safety and rollout

```text
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false
```

Rollout order:

1. Deploy schema-compatible code with historical and recovery services enabled.
2. Verify token quarantine and Fomo queue cap.
3. Verify milestone partitions appear before all token-universe partitions complete.
4. Verify pre-milestone partitions appear after usable milestones.
5. Verify one accepted unknown wallet becomes a candidate entity.
6. Observe 30 minutes before changing provider budgets.

## 11. Acceptance criteria

- Known quote assets never enter new historical research partitions.
- One failed token-universe partition cannot prevent milestone work for confirmed tokens.
- One pending Fomo token cannot block a page of confirmed tokens.
- Fomo active lookup backlog is bounded.
- Accepted evidence for an unknown wallet creates exactly one candidate identity and one wallet mapping.
- Replays do not duplicate milestones, evidence, identities, or partitions.
- Scanner, wallet monitor, wallet analysis, automation, historical backfill, and console stay active with zero unexpected restarts.
- Gateway delivery remains disabled.

