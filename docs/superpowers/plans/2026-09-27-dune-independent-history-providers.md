# Dune-Independent Historical Data Providers Implementation Plan

Status: implementation and local verification complete; production deployment pending approval.

## Checkpoint 1: Market History Foundation

- Add a typed GeckoTerminal client under `packages/collectors`.
- Parse token pools and resolve whether the requested token is base or quote.
- Add paginated OHLCV retrieval with explicit retryable errors.
- Add a pure milestone reconstruction service under `apps/wallet-analysis`.
- Cover response parsing, pagination, estimated supply, and threshold crossings.

## Checkpoint 2: Historical Worker Integration

- Add provider routing by historical query kind.
- Route milestone partitions to GeckoTerminal before optional Dune fallback.
- Persist provider provenance and reconstruction precision.
- Add bounded caching and provider-level circuit breaking.
- Expose provider coverage and backlog in the developer console.

## Checkpoint 3: Early Buyer Recovery

- Add EVM RPC log-range jobs for supported DEX contracts.
- Add Solana address-history jobs for supported launchpads and pools.
- Add Blockscout/Subsquid fallback adapters where coverage is verified.
- Apply per-provider quotas and fair scheduling.
- Run shadow production acceptance with delivery disabled.

## Verification

Each checkpoint requires focused tests, the repository test suite, and a production-safe dry run. Deployment occurs only after explicit approval and must preserve `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
