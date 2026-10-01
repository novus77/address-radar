# Audited execution revision handoff acceptance

## Status

Implementation and validation are in progress. This document does not assert deployment or full lifecycle completion.

## Validation evidence

- The first targeted run passed all eight wallet revision regressions.
- The ability-consumer regression exposed a missing execution head when the applier was called directly; the fix is authorized and under validation.
- Full workspace type checking exposed two new typing defects; correcting them requires the requested approval.
- The complete unit suite is running after the execution-head fix.

## Required production evidence

Record the release, backup reference, additive schema migration, disk headroom, six service states and restart counts, actual delivery-disabled flags, SQLite error count, revision heads and immutable audit counts, conflicts by reason, consumer requests by outcome, and proof revision counts. Do not equate an ability acknowledgment with a positive proof. Keep all non-acknowledged consumers visible as pending.

## Remaining gates

The full development plan remains open. Candidate entry-price propagation, bounded post-entry proof coverage, acknowledgments for every downstream consumer, reorganization handling, bounded historical repairs, and real new-token-to-monitored-wallet-to-signal acceptance are not established by this slice.

## Final local validation

- All 858 unit tests across 209 test files passed.
- Complete workspace type checking and build passed.
- Built-package imports and repository boundaries passed.
- Both desktop and mobile browser regressions passed.
- The wrapper now uses the original payload trader identity and bypasses dispatcher jobs, preserving existing entry-point behavior.
- The missing-head regression now passes; revision application creates its head only after checking the persisted wallet event.

Production migration and deployment are not yet asserted by this local validation.

## Production deployment and read-only acceptance

Deployment release: `b39fce7-execution-revision-handoff` (code commit `b39fce7`). Previous release `4ce4d47-execution-proof-fence` remains available for rollback. Four additive audit tables were premigrated before switching the release. No bulk legacy rewrite, identity merge, scoring change, or delivery enablement was performed.

The attempted local database export was blocked by the security policy. Instead, a consistent compressed SQL backup was created and retained on the production server, with a 3.1 GB disk guard and gzip integrity verification:

- Backup: `/var/backups/address-radar/b39fce7-predeploy-1790867462.sql.gz`.
- Compressed bytes: 301534513.
- SHA-256: `4bb6dc7695056ed75068541a9d042a92135e0d1d2c4d9c683061ed821e59508c`.

All six services were active in both postdeployment snapshots, with NRestarts=0 and delivery disabled in their actual process environments. No SQLite busy/locked, contention, missing-table, TypeError, or fatal message was counted in the second startup-window check. Remaining disk space was 4162285568 bytes.

At 2026-10-01 23:14:51 Asia/Shanghai, current-version ability coverage was 1533 distinct traders, compared with 1,513 before deployment; this interval includes work by the previous release and must not be attributed entirely to the new code. At 23:16:11 the distinct count was 1533, while the latest evaluation timestamp had advanced. Candidate evidence increased from 1439 to 1444 between the two postdeployment snapshots.

One legacy observation had an execution head at revision zero. No audited execution revisions, revision consumer requests, or versioned proofs had yet been observed. Zero audited economic mismatches is vacuous while there are no applied audited heads. This is deployment and continued-processing acceptance, not real execution-revision closure or complete lifecycle acceptance. Real revised transactions, downstream version acknowledgments, bounded history coverage, and all remaining plan gates still require evidence.
