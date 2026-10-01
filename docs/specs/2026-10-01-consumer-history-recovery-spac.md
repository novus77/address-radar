# Consumer History Recovery Dispatch SPAC

## Scope and verified problem

Task 4 increment: connect persisted opportunity consumers to source recovery without changing admission or scoring policy.

Ability evaluation records consumer-specific missing history. Previously recovery scheduling was driven by candidate blocks, and range derivation required a canonical buy. Wallet-history-only purchases could therefore have valid demands but no source job, or fail with `historical_market_range_unavailable`.

Production diagnosis found `market_range_missing`, `entry_price_missing`, and `purchase_amount_missing` demands. They require different upstream facts; market history must not be substituted for execution price or amount.

## Implementation

- Read only pending positive-hit or complete-range demands whose reason is `market_range_missing`.
- Require a supported chain, integer nonnegative interval, maximum 30-day individual purchase window, and no future knowledge.
- Preserve Solana address case; normalize EVM token keys.
- Coalesce consumers by token, and schedule at most 25 previously unscheduled tokens per planning tick.
- Use the existing stable recovery job ID: market history for Solana/ETH/BSC/Base, Fomo history for Robinhood.
- Preserve existing leases, retries, cursors, completed jobs and terminal diagnoses. No mass recovery rewrite or automatic dead-letter reopening.
- Expand source request bounds to include eligible consumer windows as well as existing candidate ranges. Wallet-only demands no longer require a canonical buy merely to request historical prices.
- A fetch envelope can contain gaps between consumers. It is not a continuous coverage certificate.
- Source task completion and consumer satisfaction remain separate. Hourly recovery coverage must not satisfy a strict opportunity complete-range demand.

## Acceptance

Regression tests cover shared-token deduplication, bounded batches, Solana case, Robinhood routing, invalid/future windows, execution-data exclusions, existing-job preservation, and a wallet-only source recovery with canonical persisted price facts.

Run targeted tests, full unit tests, build, type checks, package import smoke, module boundaries and browser tests before commit and deployment. Production acceptance checks release, six services, gateway delivery disabled, disk above 3 GB, demand/job linkage and real recent canonical price writes.

## Remaining Task 4 work

- Durable per-consumer semantic revision wakeups, including wallet-only consumers and active evaluation ownership.
- Bounded re-dispatch for newly extended windows after a completed shared source job.
- Safe recovery of old range-unavailable terminal tasks with audited preconditions.
- Provider-specific continuous/extrema precision certificates and strict complete-range proofs.
- Avoid broad historical envelopes by scheduling disjoint intervals independently.

This increment does not certify all historical consumers, all chains, or the complete system lifecycle.
