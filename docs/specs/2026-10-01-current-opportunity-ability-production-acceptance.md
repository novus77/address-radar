# Current opportunity ability production acceptance

## Release and validation

- Checked at 2026-10-01T13:50:16Z.
- Release: `617f7a1-current-ability`; previous release retained.
- Ten targeted tests and 834 unit tests across 206 files passed. Typecheck, build, smoke, boundaries, and two browser tests passed.
- All six services were active, with zero automatic restarts and delivery disabled.

## Metric verification

The closed-loop ability stage, independent SQL, and the data-flow endpoint all reported 514 distinct current opportunity-v4 traders. The closed-loop cohort contained 11,351 eligible traders and 10,837 awaiting a valid current-version assessment. There were 141 first current-version completions in the preceding hour, versus 221 distinct traders evaluated during that hour, including repeats. The old 11,349 completed value is no longer presented as current-version coverage.

Task queue accounting matched independent SQL. Other stage definitions were not changed. The task queue contains a `leased` state; future task-state classification work must include actual persisted states rather than treating `running` as the only active lease state.

## Data progress, not completion

Snapshot-less price facts now had 1,250 scheduled milestone facts, up from 500 at 13:38:40Z. Recovery pending links increased from 4,657 to 6,915 as previously disconnected inventory entered recovery. This is intake progress, not proof of fulfilled data requests or backlog convergence.

- Early-trade available facts: 1,718, up one during the interval.
- Candidate evidence facts: 1,439, unchanged; 2,088 candidate tasks blocked.
- Readiness signals: eight, unchanged.
- Current-v4 stable traders: 80; candidate: 217; discovered: 217.
- Retained DefiLlama page facts: 15,918 cumulative, up 529 during the interval; these are price rows, not new tokens or completed coverage ranges.

No reliable end-to-end completion estimate can be derived from task-run counts or this short observation interval.

## Operational risk

There were no raw SQLite busy/locked, file lock timeout, invalid budget, missing-table, or fatal matches in the preceding five minutes. One `sqlite_contention` diagnostic was present; do not describe this interval as contention-free or assume persistent failure without inspecting it.

Available disk space was 3,006,644,224 bytes, close to the 3 GB deployment floor. Approved archive-only journal cleanup preserved recent radar logs and warnings under `/var/log/address-radar/maintenance-20261001T134808Z-ability-progress`; business data, WAL, backups, and rollback releases were not removed. Capacity expansion or explicitly approved non-business retention management is still needed for sustained operation.

## Verdict

Current-version distinct-trader accounting passed production verification. Sustained candidate discovery, identity resolution, execution-price provenance, complete range coverage, and new business signal production remain open. This is not full lifecycle acceptance.
