# Dune-Independent Historical Data Providers SPAC

## Status

- Date: 2026-09-27
- Stage: Implemented and locally verified
- Scope: Address Radar historical market reconstruction and candidate discovery

## Problem

The historical candidate pipeline currently depends too heavily on Dune. When Dune credits are exhausted, historical milestone reconstruction and early-buyer discovery stop even though the scanner, scheduler, and database remain healthy.

The system must continue producing useful evidence without Dune. Dune remains an optional bulk backfill accelerator, not a production availability dependency.

## Goals

1. Reconstruct token market-cap milestones without consuming Dune credits.
2. Recover wallet transaction facts from chain RPC or public indexers.
3. Preserve provenance, confidence, and precision for every derived fact.
4. Degrade per provider and per chain without blocking unrelated work.
5. Keep disk usage bounded on the current single-server deployment.

## Provider Responsibilities

| Capability | Primary | Fallback | Notes |
| --- | --- | --- | --- |
| Token discovery | DexScreener | Launchpad/DEX listeners | Existing path remains unchanged |
| Current market facts | DexScreener | GeckoTerminal | Cache aggressively |
| Historical OHLCV | GeckoTerminal | Public indexer/RPC-derived trades | First Dune-free milestone source |
| EVM wallet history | RPC logs and receipts | Blockscout/Subsquid | Address-scoped jobs only |
| Solana wallet history | RPC signatures and transactions | Enhanced RPC | Address-scoped jobs only |
| Identity and platform actions | Fomo collector | Manual identity resolution | Independent from chain history |
| Bulk historical acceleration | Dune | None | Optional and quota-aware |

## Milestone Reconstruction

The provider resolves the token's deepest pool and token side. It estimates supply from current token price and current market cap. If market cap is unavailable, FDV is used and the result remains explicitly estimated.

Historical OHLCV candles are converted into market-cap observations. The first candle whose high crosses 100K, 200K, 300K, 500K, or 1M USD is retained with provider, pool, resolution, timestamp, market cap, and precision metadata.

Estimated milestones may create candidate evidence, but they must not silently replace exact on-chain observations.

## Failure and Degradation Model

- `not_found`: no usable pool or history; long retry delay
- `rate_limited`: exponential backoff with jitter
- `temporary`: bounded retry
- `unsupported_chain`: skip only this provider and chain
- `invalid_response`: quarantine response and retain diagnostics

No provider failure may block scanner ingestion, Fomo activity collection, wallet monitoring, or unrelated chains.

## Cache Policy

- Pool metadata: 15 minutes
- Recent hourly OHLCV: 10 minutes
- Historical closed candles: 24 hours
- Completed milestone crossings: immutable unless superseded by higher-precision evidence
- Negative pool lookup: 30 minutes

## Rollout

### Phase 1: Historical Market Foundation

- GeckoTerminal typed client
- Pool selection and token-side resolution
- Paginated OHLCV retrieval
- Milestone reconstruction with provenance
- Unit tests for parsing, pagination, and threshold crossing

### Phase 2: Worker Integration

- Dispatch milestone partitions to GeckoTerminal first
- Persist crossings through the existing history store
- Fall back to Dune only when configured and quota is available
- Add provider health, cache hit rate, and reconstruction coverage metrics

### Phase 3: Early Buyer Recovery

- EVM bounded RPC log recovery
- Solana bounded address-history recovery
- Blockscout/Subsquid fallback adapters where coverage is verified
- Fair scheduling and independent provider budgets

## Acceptance Criteria

1. Historical milestone jobs can complete with no Dune API key.
2. A Dune quota error does not stall milestone, ability evaluation, or Fomo pipelines.
3. Provider responses are cached and rate-limited.
4. Every reconstructed crossing exposes source and precision.
5. Unsupported chains degrade explicitly rather than crashing a worker.
6. Gateway delivery remains disabled during shadow validation.

## Implementation Result

- GeckoTerminal now reconstructs market-cap milestones and recent pool trades.
- ETH, Base, and BSC historical pool transfers fall back to Blockscout.
- Solana historical pool activity falls back to bounded RPC signature and transaction recovery.
- Robinhood remains an explicit unsupported historical-indexer path and does not block other chains.
- Dune is optional, quota-aware, and disabled by default as a fallback in the example configuration.
- Public provider requests are serialized, cached, and isolated by retry and circuit-breaker behavior.
- Full repository verification passed with 525 tests and a successful TypeScript build.
- A live read-only GeckoTerminal smoke check confirmed the production response shape.

Production shadow acceptance and deployment remain operational steps and require explicit approval.
