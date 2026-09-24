# Dune Candidate Backfill Operations

## Purpose

Dune supplies the historical token universe, milestone crossings, and pre-milestone trades used to discover repeatable early traders. It is a historical enrichment provider only. Dune degradation must never stop real-time Fomo or RPC collection.

The production runtime uses the Dune Data API. Dune MCP is restricted to dataset discovery, saved-query development, manual validation, and usage inspection.

## Connection state

- MCP endpoint: `https://api.dune.com/mcp/v1`
- Authentication: OAuth in the local Codex profile; no credential is stored in this repository.
- Tool timeout: `300` seconds.
- Production authentication: service-only `DUNE_API_KEY` environment variable.
- Current account usage and saved-query execution must be verified from a fresh Codex process because MCP servers are loaded when the process starts.

## Dataset coverage

| Internal chain | Dune chain | Historical status | Initial sources |
| --- | --- | --- | --- |
| `solana` | `solana` | catalog available, saved query pending validation | curated DEX trades, token metadata, prices, token supply/balances |
| `bsc` | `bnb` | catalog available, saved query pending validation | `dex.trades`, token metadata, prices, token supply/balances |
| `eth` | `ethereum` | catalog available, saved query pending validation | `dex.trades`, token metadata, prices, token supply/balances |
| `base` | `base` | catalog available, saved query pending validation | `dex.trades`, token metadata, prices, token supply/balances |
| `robinhood` | none verified | `historical_provider_unavailable` | real-time Fomo/RPC only until an indexed dataset is proven |

Market cap is reconstructed from a timestamp-aligned price and circulating/available supply. It must not be inferred from current supply without recording `precision = estimated`. A milestone crossing is the earliest qualifying observation, not the token creation time.

Official references:

- Dune Data API: <https://docs.dune.com/api-reference/api-overview>
- Execute saved query: <https://docs.dune.com/api-reference/executions/endpoint/execute-query>
- Execution result and pagination: <https://docs.dune.com/api-reference/executions/endpoint/get-execution-result>
- Account usage: <https://docs.dune.com/api-reference/usage/endpoint/get-usage>
- Rate limits: <https://docs.dune.com/api-reference/overview/rate-limits>
- Data catalog: <https://docs.dune.com/_llms/data-catalog.md>

## Saved query ownership

Create all three queries under the production Dune account or production team, never a personal disposable workspace:

1. `address_radar_token_universe_v1`
2. `address_radar_milestone_crossings_v1`
3. `address_radar_pre_milestone_trades_v1`

Record their numeric IDs in the server environment only. Query SQL and expected output schemas belong in repository documentation; credentials and OAuth artifacts do not.

Required output contracts:

| Query | Required columns |
| --- | --- |
| token universe | `chain`, `token_address`, `symbol`, `first_trade_at`, `first_reached_1m_at`, `peak_market_cap_usd` |
| milestone crossings | `chain`, `token_address`, `milestone_market_cap_usd`, `crossed_at`, `precision`, `source_reference` |
| pre-milestone trades | `chain`, `token_address`, `trader_address`, `side`, `amount_usd`, `price_usd`, `market_cap_usd`, `block_time`, `tx_hash`, `event_index` |

## Production environment

Use the variables in `.env.example`. The systemd environment file must be readable only by the service user. `DUNE_API_KEY` must never appear in unit files, command arguments, logs, API responses, browser payloads, or the developer console.

Rotate the API key after initial setup because it was handled during interactive configuration. Rotation procedure:

1. Create a replacement key under the production Dune account.
2. Update the protected systemd environment file.
3. Restart only the historical backfill worker.
4. Verify one small saved query and the usage endpoint.
5. Revoke the previous key.

## Credit and failure controls

- Initial historical concurrency: `1` execution.
- Default daily budget: `DUNE_DAILY_CREDIT_BUDGET=1000`; tune only after observing real query cost.
- Stop scheduling new partitions when the local daily budget is exhausted.
- HTTP `402` is `credit_limit`; pause historical work until the next budget window.
- HTTP `429` and `5xx` are retryable with bounded backoff.
- Authentication, permission, malformed result, and terminal query errors require operator review.
- Persist cursors after every accepted page; retries must be idempotent.
- Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` throughout historical replay and shadow acceptance.

## MCP verification after process restart

1. Confirm the `dune` MCP server is enabled and its tool timeout is `300` seconds.
2. Read account usage without executing a large query.
3. Inspect the exact schemas for all four primary chains.
4. Create the three saved queries with a one-day test interval.
5. Validate row uniqueness, timestamp precision, chain address normalization, and result pagination.
6. Expand to the `2026-08-09T16:00:00.000Z` UTC historical watermark only after the sample passes.
