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
