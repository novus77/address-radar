# Cross-window preservation rehearsal

## Authorization and invariants

The user approved retaining the isolated PostgreSQL fixture across resource-maintenance windows and resuming it. This does not authorize production database/release cutover or signal delivery. Each window retains the existing 60-minute limit and independent 55-minute restoration watchdog. Each import invocation remains limited to 15 minutes, with fresh complete source validation and the existing resource/SQL guards.

## Implementation sequence

1. Separate import-only work from independent parity. Yield before opening a transaction when less than a complete transaction plus close reserve remains. A planned yield is neither an acknowledged COMMIT nor completed preservation. Retain existing importer reconciliation on every invocation.
2. Keep a single owner inside the existing pinned lifecycle callback while restoring and reopening maintenance windows. Do not detach the fixture by bypassing the callback's final cleanup or copy production credentials. Bind fixture identity, owner marker, source pins, connection digest, and executable pins for the entire session.
3. Install and verify independent expiration cleanup before retaining the fixture across the first restoration. Cleanup must check the exact nonce, owner, directory identity, and private postmaster identity; it must never target a production service or unrelated process. Retention is not allowed if independent cleanup is unavailable.
4. Retain stage evidence with unique invocation identities and cumulative acknowledged counts. Reconcile uncertain commits, preserve all hashes, and reject zero-progress loops. Before every window, recapture a fresh production baseline and arm its restoration watchdog. Always restore services at window exit, including failed or expired runs.
5. Obtain actual full import, independent parity, and cleanup evidence. Then perform independent same-data rollback acceptance and prepare the final fenced production snapshot/cutover plan for confirmation.

## Current scope

The import-only admission primitive and runner stage are implemented locally. The cross-window lifecycle supervisor, independent expiration cleanup, unique repeated-stage artifact naming, and host integration remain unimplemented. No retained fixture or production maintenance window has been started by this change.

## Acceptance gates

- No new transaction begins inside its reserved transaction/close interval.
- Fresh validation is never replaced by cached validation or a source pin alone.
- Resource pressure and unknown COMMIT remain failures, not planned yields.
- Partial/import-only completion always has parityComplete=false and grants no business eligibility.
- Existing resume and parity behavior remain unchanged.
- Retention and expiration cleanup require separate lifecycle tests and independent review before host execution.
- Full migration remains NO-GO until all real-data acceptance gates pass.
