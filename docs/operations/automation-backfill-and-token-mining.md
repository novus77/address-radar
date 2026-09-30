# Automation Backfill and Historical Token Mining Operations

## Safety contract

The automation service plans and executes durable trader backfill, historical token mining, candidate evidence, and repeatable-ability work. It shares the production SQLite database with the scanner, wallet monitor, wallet analysis, and developer console.

User delivery must remain disabled throughout shadow acceptance:

```text
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false
```

The service has two independent execution gates:

```text
ADDRESS_RADAR_AUTOMATION_ENABLED=false
ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES=
```

The first switch controls all execution. The second is a comma-separated allowlist. A queued job whose type is not allowed remains pending with an unchanged attempt count; it is not leased, failed, or terminated. An empty allowlist therefore remains safe even if the global switch is accidentally enabled.

Planning and execution use separate cadences. The scheduler polls for an
executable job every second, while the database-wide planning pass runs every
five minutes by default:

```text
ADDRESS_RADAR_AUTOMATION_PLANNING_INTERVAL_MS=300000
```

Keep the planning interval substantially larger than the scheduler poll
interval. This preserves fresh durable plans without rescanning every trader on
every worker poll.

Supported automation job types are:

```text
trader_lightweight_evaluation
initial_wallet_backfill
historical_token_partition
candidate_evidence
ability_evaluation
```

Do not add `identity_resolution` to this allowlist. Identity repair belongs to the recovery handler set and remains controlled separately by `ADDRESS_RADAR_RECOVERY_ENABLED`.

## Initial production configuration

Use conservative defaults for the first shadow release:

```text
ADDRESS_RADAR_AUTOMATION_ENABLED=false
ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES=
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false
ADDRESS_RADAR_RECOVERY_ENABLED=false
ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE=3
ADDRESS_RADAR_BACKFILL_WINDOW_DAYS=60
ADDRESS_RADAR_BACKFILL_MAX_TOKENS=300
ADDRESS_RADAR_EVIDENCE_MINIMUM_BUY_USD=50
```

This state may create additive schema objects and durable plans, but it cannot execute queued work or deliver a user signal.

## Backup gate

Before changing the release link, run the systemd backup unit. It stops every database-accessing service, including the console and historical backfill worker, checkpoints WAL, copies the static database under `ionice`, `nice`, and `timeout`, validates `PRAGMA quick_check`, then atomically publishes the completed snapshot. The kernel copy path is preferred; the bounded page-copy path is retained only as a compatibility fallback.

```bash
sudo systemctl start address-radar-backup.service
sudo systemctl status address-radar-backup.service --no-pager
sudo find /var/lib/address-radar/backups -name address-radar.db -type f -printf '%T@ %p\n' | sort -nr | head -1
```

Do not switch a release if the unit failed, a `.partial` file remains, or the completed database does not return `ok` from `PRAGMA quick_check`.

## Isolated release installation

Install each release into a new immutable directory:

```text
/opt/address-radar/releases/<utc-timestamp>
```

Never copy macOS `node_modules` to Linux. Install Linux dependencies on the server with the locked package manager, build the workspace, and run package smoke checks inside the new release before changing `/opt/address-radar/current`.

Install and enable the service unit while execution is still disabled:

```bash
sudo install -m 0644 deployment/systemd/address-radar-automation.service /etc/systemd/system/address-radar-automation.service
sudo systemctl daemon-reload
sudo systemctl enable address-radar-automation.service
```

After server-side tests pass, atomically replace the `current` symlink and restart these services together:

```text
address-radar-scanner.service
address-radar-wallet-monitor.service
address-radar-wallet-analysis.service
address-radar-automation.service
address-radar-console.service
```

Verify that every unit is active, `NRestarts=0`, and the developer console responds on `127.0.0.1:3214` before enabling work.

## Planning shadow acceptance

Keep the global execution switch disabled and verify the console reports truthfully:

- Observed Fomo handles are distinct from canonical traders.
- Wallet-resolved traders count only actual wallet identities.
- Active wallets have a planned initial backfill or an explicit terminal reason.
- Every observed trader has a lightweight next action.
- Historical partitions cover Solana, Ethereum, BSC, Base, and Robinhood.
- Gateway delivery remains disabled and no user signal has been sent.

## Staged execution

Enable job types cumulatively. Change the protected environment file, restart only `address-radar-automation.service`, and observe queue movement, provider health, SQLite contention, and restart count before adding the next type.

If rollout automation uses an `ERR` trap inside shell functions, start it with
`set -Eeuo pipefail` so failures inside those functions also trigger the safe
disable path. Promote a job type only after the previous queue shows real state
movement; repeated rapid restarts are not a progress mechanism.

1. `trader_lightweight_evaluation`
2. `initial_wallet_backfill`
3. `historical_token_partition`
4. `candidate_evidence`
5. `ability_evaluation`

Example after the first two stages:

```text
ADDRESS_RADAR_AUTOMATION_ENABLED=true
ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES=trader_lightweight_evaluation,initial_wallet_backfill
```

Solana history is isolated inside `initial_wallet_backfill` by provider budgets and `ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE=3`. A Solana rate limit must move only Solana work to `waiting_source`; EVM and Robinhood work must continue.

Repair remains a separate stage. Enable `ADDRESS_RADAR_RECOVERY_ENABLED=true` only after every configured recovery job has a production handler and its provider credentials have passed shadow validation.

## Acceptance criteria

The shadow release is accepted only when all statements below are observable:

- Funnel labels and counts use their real semantics.
- Every active wallet has a completed/current backfill, queued work, or an explicit terminal diagnostic.
- At least one real Fomo event reaches candidate evaluation.
- At least one real wallet partition records either a successful no-change checkpoint or a transaction event.
- Solana rate limiting does not stop another chain.
- No SQLite write is lost after lock contention or process restart.
- Replaying the same source observations does not increase canonical event or evidence counts.
- Gateway delivery remains disabled.

## Rollback

Rollback is reversible and preserves evidence:

1. Set automation, recovery, and Gateway delivery to `false`.
2. Stop all Address Radar database writers.
3. Atomically point `/opt/address-radar/current` to the previous release.
4. Restore the verified pre-deploy database only if the new additive schema caused an incompatible data write.
5. Restart services and verify health, cursors, queue totals, and console access.

Never delete the failed release, the pre-deploy backup, pending jobs, source observations, or audit rows during rollback.

## Source-blocked work and fairness

Jobs missing token metadata, milestone crossings, or price history use `blocked_source`. This state is not polled by the scheduler. A matching prerequisite write wakes the affected candidate-evidence job by moving it back to `pending`.

Each blocked job records a stable reason code in `automation_job_blocks`:

```text
missing_token_identity
missing_market_history
missing_milestone
missing_early_trades
missing_wallet_mapping
insufficient_coverage
```

The candidate worker must enqueue the matching recovery job before it blocks. Missing early trades use `milestone_early_buyers`, missing wallet mappings use `identity_resolution`, and missing market or milestone facts use `market_enrichment` or `historical_research`. Recovery completion resolves the block record and wakes the candidate job atomically; a retryable provider failure leaves the candidate blocked and applies the recovery queue backoff instead of creating repeated candidate attempts.

The scanner owns the production recovery handlers. It writes Fomo milestone lookups to `ADDRESS_RADAR_FOMO_LOOKUP_QUEUE_PATH`, which defaults to `<database path>.fomo-lookups.ndjson`. The browser collector must consume this queue and persist canonical milestone-before trade events. Market enrichment writes provider observations and market snapshots; it must not invent a one-million-dollar crossing when the provider has no historical crossing evidence.

The developer console shows stable blocked-reason counts, the oldest block, active and completed counts by automation job type, recovery counts by type/status, the number of blocks woken after recovery, and source-observation conflict totals. `waiting_source` is retained only as a legacy label and is migrated to `blocked_source` during startup migration.

Before enabling recovery in production, verify all of the following:

- Scanner starts without `handler_unavailable` recovery failures.
- A test `missing_early_trades` block creates one idempotent Fomo milestone lookup.
- Persisting matching canonical buy events wakes the blocked candidate job.
- A missing or rate-limited provider produces bounded retryable work rather than log growth.
- `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` remains unchanged.

Claiming is fair across job types inside each weighted lane. A large lightweight-evaluation backlog therefore cannot permanently starve candidate evidence or ability evaluation. Candidate-evidence dispatch stops at 2,000 active jobs and lightweight planning stops at 5,000 active jobs; both retain their durable cursor or coverage state until capacity is available.

## Final checkpoint report

Record the release path, backup path, service state, restart counts, queue totals by type/status, provider-chain degradation, coverage totals, candidate evidence totals, database/disk usage, and every external blocker. Report disabled job types as intentionally gated rather than failed.
