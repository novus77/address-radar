# SPAC: Recovery Scheduling Fairness Within Each Chain

## Verified Cause

Production read-only measurement on 2026-10-02 confirmed cross-type rotation exists but attempts within several recovery types were concentrated on Solana. Base, BSC and ETH had ready jobs with no attempt in the measured hour. Historical research included 11 never-attempted Base jobs, 68 BSC jobs and two ETH jobs, while Solana received 24 recent touches. Provider coverage remains a separate limitation.

The claim query ranks task types by their last attempt and oldest due timestamp, then selects jobs by priority and age without a chain-level rotation. A large older backlog can therefore monopolize each task-type turn. A regression reproduces five consecutive Solana selections despite four other ready chains.

## Change

Retain existing cross-type ordering. Within a type, rank chains by their most recent attempt, giving a never-attempted ready chain an opportunity before another turn for an already-attempted chain. Preserve job priority and due age within each chain. Use the existing recovery_jobs transaction and durable timestamps; no new schema or configuration is required.

Only pending or failed jobs whose next_attempt_at is due can be claimed. Running jobs retain their lease. Shared provider limits, retry deadlines, postcondition verification, terminal reasons, cursors, gateway delivery and business thresholds remain unchanged. An execution opportunity does not guarantee an external provider will supply facts.

## Acceptance

- Five ready chains receive a turn despite a dominant same-type backlog.
- Existing cross-type rotation and within-chain priority tests remain valid.
- A future chain retry deadline cannot be bypassed.
- Complete tests, types, build and browser checks precede commit/deployment.
- Production acceptance compares actual attempt timestamps per type and chain, recovery outcomes and fact coverage; it does not count empty results as completion.

## Rollout

Phase 1 deployed c7fb21b successfully after online disk expansion. Database backup was verified at /var/backups/address-radar/c7fb21b-predeploy-1790922179.sql.gz (329212656 bytes, SHA-256 977cf43bade49dc0afa1bb7c95a51138699d2631abf07f0e28f380071039905a). Six services were active with zero automatic restarts and delivery disabled.

The new ability dispatch ledger contains 389 preserved pending obligations in the initial acceptance snapshot. This demonstrates retention, not completed ability evaluation. This phase adds chain fairness; signal/aggregation acknowledgements and milestone state semantics remain separate pending phases.
