# Historical page resume production acceptance

## Delivered increment

Code commit: `502409a`. Active release: `/opt/address-radar/releases/502409a-page-resume`. Rollback release: `/opt/address-radar/releases/859fdda-page-checkpoints`.

Local validation: 17 targeted tests, all 816 unit tests across 203 files, build, typecheck, package smoke, module boundaries, and 2 desktop/mobile browser tests passed. Deployment applied only the existing additive execution-basis and consumer-demand initializers.

## Read-only production snapshot

2026-10-01 20:38:38 Asia/Shanghai:

- Six services active; all `NRestarts=0` and actual process delivery flags `false`.
- No SQLite lock, missing-table or fatal messages in the preceding five minutes.
- Opportunity-v4 distinct evaluated traders: 304.
- Candidate evidence: 1,439; candidate blocked tasks: 2,025.
- Recovery closure: 2,215 satisfied, 3,111 pending, 532 terminal.
- Early-trade recovery completed facts: 1,712.
- Signal readiness: 8; automatic queue runnable: 163, 15-minute delta +95, not converging.
- Cumulative immediate page checkpoints: 108 attempts and 10,765 newly inserted price observations. These originated from the preceding checkpoint increment; they do not prove a cache hit after this deployment.

Production reuse has not yet been independently observed. Tests prove the resume path and sparse-page fallback; live consumer closure, actual source coverage and identity handoff remain separate gates. A restart-time runnable spike is not evidence of scheduler starvation.

## Approved archived-log maintenance

Disk headroom was 3,018,076,160 bytes at acceptance, only about 18 MB above the 3 GB safety guard. After preserving the most recent 5,000 Radar log lines and up to 5,000 system warnings from the last 24 hours, archived journald files alone were rotated and vacuumed to 32 MiB. No production application configuration, database, WAL, event data, backups or releases were deleted or modified by maintenance.

Audit directory: `/var/log/address-radar/maintenance-20261001T124025Z-page-resume`.

Before maintenance: 3,015,917,568 free bytes. After: 3,057,270,784. Net released: 41,353,216 bytes. Journal usage: 31.5 MiB. This is temporary headroom, not a capacity solution.

## Remaining gates

Strict historical coverage/extrema proof, physical per-request budget attribution, candidate prerequisite recovery, wallet identity handoff, metric version alignment and sustained end-to-end business production are not declared complete by this increment.
