# Multi-Source Discovery Operations

## Purpose

Address Radar treats Fomo, chain RPC, DexScreener, local journals, and Dune as independent evidence providers. No provider is a global prerequisite. A provider failure changes only that provider-chain health row and queues targeted recovery work; it must not stop real-time persistence, aggregation, or local signal qualification from healthy paths.

Gateway delivery remains disabled throughout shadow validation:

```text
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false
```

## Supported chains

Production discovery accepts exactly these chains:

```text
solana
eth
bsc
base
robinhood
```

Unsupported-chain tokens are retained in `token_observation_state` with `quarantined = 1` and `quarantine_reason = unsupported_chain`. They do not enter production aggregation.

## Data flow

```text
provider adapter
  -> immutable source_observations
  -> canonical trader_events
  -> token_observation_state dimensions
  -> candidate evidence
  -> token aggregation
  -> local qualified signal
  -> optional Gateway delivery
```

The immutable observation must be written before the canonical event. Replaying the same observation is idempotent. Fomo, RPC, and Dune representations may retain separate provenance while converging on one canonical event or economic key.

## Provider isolation

Each provider-chain pair has an independent row in `source_health` and `source_cursors`.

| State | Operator meaning |
| --- | --- |
| `healthy` | Cursor or event time is progressing within its freshness window. |
| `degraded` | Progress is slower than expected, but the source remains usable. |
| `rate_limited` | The provider has supplied a reset boundary; targeted work waits. |
| `stale` | Neither cursor nor event time has progressed before the stale threshold. |
| `unavailable` | The last collection attempt failed. |
| `misconfigured` | Required provider configuration is absent or invalid. |

Quiet markets are healthy when their cursor or head continues to advance. Do not use trade count alone as a liveness signal.

Initial thresholds:

| Stream | Degraded | Stale |
| --- | ---: | ---: |
| Fomo live feed | 60 seconds | 5 minutes |
| RPC head | 30 seconds | 2 minutes |
| Wallet observations | 2 minutes | 10 minutes |
| Active-token market snapshots | 2 minutes | 10 minutes |
| Historical worker heartbeat | 10 minutes | 30 minutes |

## RPC failover

Configure a primary and fallback endpoint. The JSON-RPC client rotates on retryable transport, rate-limit, timeout, and provider-capacity failures. Non-retryable request errors are not sent to the fallback.

```text
ADDRESS_RADAR_ONCHAIN_RPC_ENDPOINT=https://primary-rpc.example
ADDRESS_RADAR_ONCHAIN_RPC_FALLBACK_ENDPOINT=https://fallback-rpc.example
```

When both endpoints fail, the collector records an unavailable health row and enqueues a deterministic `rpc_gap` job. The failed chain does not stop other collectors or chains.

## Durable recovery

Recovery priority uses lower numbers first:

| Priority | Job |
| ---: | --- |
| 10 | `rpc_gap` |
| 20 | `market_enrichment` |
| 30 | `fomo_token_history` |
| 35 | `milestone_early_buyers` |
| 40 | `identity_resolution` |
| 60 | `historical_research` |

Jobs use leases, exponential retry, durable checkpoints, and deterministic subject keys. Expired leases return to pending after restart. Terminal identity conflicts enter `dead_letter`; operators can explicitly retry them from the console after correcting the identity.

Dune budget consumption is permitted only for `historical_research`. Exhausting Dune credits must not delay RPC gaps, market enrichment, Fomo lookups, identity resolution, or real-time scanning.

Keep `ADDRESS_RADAR_RECOVERY_ENABLED=false` until the production handler set and provider credentials have passed shadow verification. Enabling the scheduler with a missing handler is safe but will place the task into bounded retry rather than complete it.

## Console checks

The developer console exposes:

```text
GET  /api/v2/sources/health
GET  /api/v2/sources/cursors
GET  /api/v2/discovery/token-funnel
GET  /api/v2/discovery/trader-funnel
GET  /api/v2/recovery/jobs
POST /api/v2/recovery/jobs/:jobId/retry
POST /api/v2/tokens/:tokenId/re-evaluate
```

Use the `数据源与恢复` module for Chinese diagnostics. Stable English identifiers remain available in expandable technical details.

## Shadow rollout

1. Stop scanner and wallet-analysis writers.
2. Create a verified SQLite backup under `/var/lib/address-radar/backups`.
3. Restore the backup to a temporary database and run the existing audits.
4. Install the release under `/opt/address-radar/releases/<timestamp>`.
5. Keep the current release directory and database backup unchanged as rollback points.
6. Populate the protected environment file from `deployment/address-radar.env.example`.
7. Confirm `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` and `ADDRESS_RADAR_RECOVERY_ENABLED=false`.
8. Atomically update `/opt/address-radar/current` and restart scanner, wallet-monitor, wallet-analysis, automation, and console services.
9. Verify service health and `NRestarts=0` before enabling any additional worker.
10. Confirm Fomo, RPC, and market paths advance independently while Dune is paused or budget-exhausted.
11. Confirm the recovery queue is durable by restarting during a leased test job and observing resume after lease expiry.
12. Inspect logs for SQLite lock errors, repeated observation conflicts, cursor regression, or unbounded retries.

The automation service has an additional job-type allowlist and staged rollout procedure. Follow [Automation Backfill and Historical Token Mining Operations](./automation-backfill-and-token-mining.md) before enabling any production job execution.

## Rollback

Rollback is an atomic release-link change plus database restore only when a schema/data incompatibility requires it. Do not delete the failed release or overwrite the pre-deploy database.

1. Stop all Address Radar writers.
2. Point `/opt/address-radar/current` to the previous release.
3. Restore the verified pre-deploy database if the new release wrote incompatible state.
4. Start services with Gateway and recovery disabled.
5. Verify health, restart counts, cursor positions, queue counts, and local console access.

The migrations in this release are additive. Under normal rollback, the previous release may continue reading its existing tables without deleting the new source-ledger tables.

## Acceptance checklist

- Identical Fomo, RPC, and Dune data converges to one canonical event and one candidate evidence row.
- Replaying the same batch does not increase canonical or evidence counts.
- Every provider-chain pair reports health independently.
- Cursor persistence happens before file or stream acknowledgement.
- A primary RPC failure uses the fallback; dual failure queues `rpc_gap`.
- Dune can remain unavailable for 24 hours without changing real-time collection or local signal qualification.
- Missing market or Fomo facts create recovery jobs instead of dropping tokens.
- Unsupported chains are quarantined, not deleted.
- Gateway delivery remains disabled until a separate audited production decision.
