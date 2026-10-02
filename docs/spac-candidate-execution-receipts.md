# SPAC: Candidate Execution Revision Receipts

## Scope

Recompute candidate evidence from verified execution revisions without changing candidate admission thresholds, merging identities, or deleting raw trade observations.

## Contract

- Bind execution heads to canonical observations for the same event and trader.
- Use verified execution prices when available; never guess missing prices.
- Archive superseded evidence before recomputation or retirement.
- Preserve existing evidence when required entry or milestone price coverage is incomplete.
- Defer incomplete evaluations to market-history recovery. Do not acknowledge execution revisions or complete evaluation requests while required coverage is missing.
- Allow complete trader evaluations to persist while other traders wait for recovery.
- Acknowledge only the revision actually consumed, under the same synchronous database write transaction.
- Include execution revisions in admission snapshot identities so corrected and restored evidence remains distinguishable.

## Storage and Rollout

The additive candidate_evidence_execution_audits table stores immutable evidence and execution snapshots. Production runtime migrations remain disabled; explicitly apply the exported audit schema before switching releases. Preserve raw observations and existing backups. No bulk historical repair is included.

Deployment requires a verified server-local backup, sufficient disk space, disabled gateway delivery, service health checks, and rollback to the prior release on failed activation. Do not deploy below the 3 GB free-space safety floor; the backup guard requires additional headroom.

## Acceptance

Verified on 2026-10-02:

- Candidate worker regression: 14 tests passed.
- Complete suite: 870 tests across 210 files passed.
- Type checks and build passed.
- Built package import smoke checks and repository boundary checks passed.
- Browser regression: 2 tests passed, desktop and mobile.

Regression coverage includes real-price threshold changes, stale revision rejection, missing canonical basis, audited evidence retirement and restoration, and incomplete-price deferral without receipt acknowledgement.

## Production Status

Deployment was blocked before production writes: 2,209,587,200 bytes free (95% filesystem usage), below the deployment safety floor. Current production release remains 15dc8c4-projection-input-attestation. No production migration, release switch, service restart, or signal delivery was performed for this phase. Real production consumer receipts and end-to-end closure remain pending acceptance after safe deployment.

## Deployment Acceptance: 2026-10-02

The prior deployment block was resolved through explicitly authorized cleanup of unused old release code and regenerable package caches. Current release and three rollback versions, business databases, events, logs, installed dependencies, and existing backups were retained.

- Deployed code commit: 08d0955.
- Production release: /opt/address-radar/releases/08d0955-candidate-execution-receipts.
- Verified server-local backup: /var/backups/address-radar/08d0955-predeploy-1790918061.sql.gz.
- Backup size: 328,021,094 bytes.
- Backup SHA-256: b2542792d05d90c91c49a8083918edef75ef7648a78dffe7008cc2f25ddd6f04.
- Additive audit schema applied; release switch and six-service restart passed.
- All six services active, automatic restart counters zero, gateway delivery disabled.
- Closed-loop API responded successfully; recent-hour SQLite lock and fatal error counts zero.
- Read-only acceptance at 05:17 UTC (13:17 Asia/Shanghai): 3,120,308,224 bytes free; duplicate active tasks zero; candidate evidence 1,454; candidate blocked tasks 2,126; resolved wallet identities 122; ready signals 8.

Business acceptance is not complete. The candidate evidence consumer has 910 revision requests awaiting acknowledgement, zero acknowledged revisions, and zero execution audit rows at this snapshot. Event projection has acknowledged 113 of 910 revision requests; ability evaluation, token aggregation, and signal projection have not acknowledged their 910 requests. These are consumer revision counts, not discovered-wallet counts. Continue tracing actual dispatch, missing prerequisites, and consumer receipts without synthesizing trade data or changing admission rules. Disk headroom remains tight and requires continued monitoring.
