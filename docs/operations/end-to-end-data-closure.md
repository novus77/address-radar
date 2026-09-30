# End-to-End Data Closure Operations

## Purpose

This runbook validates the production path from monitored wallet identity to a locally qualified radar signal. It deliberately separates provider availability from business-event progress and keeps user delivery disabled during shadow acceptance.

## Runtime invariants

- Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` until a separate delivery approval.
- A provider health check is not evidence that wallet observations are being produced.
- Missing data degrades one fact or one chain; it must not stop unrelated chains or the scanner.
- Historical wallet analysis covers the latest 60 days and at most 300 token positions per wallet.
- A stable repeatable ability requires at least 70% outcome coverage in addition to sample, token diversity, time-span, and concentration requirements.
- Tokens that are created but not launched can be observed but cannot become formal signals.

## EVM indexed wallet history

The block scanner remains the low-latency path. A Blockscout-compatible address indexer is an optional compensation path for router transactions and bounded historical catch-up.

Wallet addresses are sent to the configured indexer. Configure only an approved provider or a self-hosted endpoint:

```dotenv
ADDRESS_RADAR_BLOCKSCOUT_ETH_URL=
ADDRESS_RADAR_BLOCKSCOUT_BASE_URL=
ADDRESS_RADAR_BLOCKSCOUT_BSC_URL=
ADDRESS_RADAR_BLOCKSCOUT_ROBINHOOD_URL=
ADDRESS_RADAR_INDEXED_WALLET_BATCH_SIZE=5
ADDRESS_RADAR_INDEXED_WALLET_MAX_PAGES=2
ADDRESS_RADAR_INDEXED_WALLET_LOOKBACK_DAYS=60
```

If an endpoint is absent, that indexed path is disabled. The RPC block collector and every other configured chain continue running.

## Performance refresh

```dotenv
ADDRESS_RADAR_PERFORMANCE_INTERVAL_MS=300000
ADDRESS_RADAR_PERFORMANCE_DUST_THRESHOLD_USD=50
ADDRESS_RADAR_OUTCOME_MAXIMUM_DELAY_MS=900000
```

The wallet-analysis service periodically projects canonical trader events into token samples and matures scheduled outcomes. Completed historical wallet positions are consumed independently by the repeatable-ability worker and are not mislabeled as fixed 24-hour outcomes.

## Read-only acceptance audit

```bash
pnpm audit:data-closure /var/lib/address-radar/address-radar.db
```

Use strict mode only after real traffic has had time to produce samples:

```bash
pnpm audit:data-closure /var/lib/address-radar/address-radar.db --strict
```

Possible top-level states:

- `structural_failure`: schema or safety invariant is broken.
- `waiting_for_data`: code path exists, but one or more production stages have no real evidence yet.
- `ready_for_shadow_acceptance`: every stage has produced durable data; this does not enable delivery.

## Console acceptance

Open **数据源与恢复** and inspect:

1. **事实闭环**: available, partial, unresolved dependency, and conflict counts.
2. **钱包业务链路**: provider status, observation count, observed wallet count, and last business event.
3. **交易员自动化漏斗**: initial backfill, candidate evidence, and admission progress.
4. **代币聚合**: one contract per row, Chinese missing-condition diagnostics, lifecycle stage, source state, and broadcast count.

## Shadow rollout order

1. Back up the database and event files.
2. Deploy with delivery disabled.
3. Confirm scanner, wallet monitor, wallet analysis, automation, and console remain active.
4. Run the non-strict audit and resolve structural failures.
5. Observe at least one complete path on every configured chain that has real market activity.
6. Run strict audit and review local signal decisions.
7. Keep delivery disabled until signal quality is explicitly approved.
