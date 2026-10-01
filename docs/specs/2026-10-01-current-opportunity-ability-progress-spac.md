# Current opportunity ability progress

## Problem and scope

Production acceptance of `fbc88eb-milestone-handoff` found 11,349 legacy/current evaluated traders reported by the closed-loop endpoint against 921 evidence traders, while the data-flow endpoint reported 514 distinct opportunity-v4 traders. Repeat evaluation snapshots also inflated apparent completion-window counts.

Correct read-only measurement only. No scoring, admission, opportunity thresholds, delivery, migrations, source quotas, or historical snapshots change.

## Definitions

- Discovered: existing trader entities.
- Eligible cohort: existing entities with token samples, candidate evidence, admission snapshots, or a valid current-version evaluation.
- Current version: `trader-ability-v4-opportunity`, `30d` only.
- Completed and produced facts: distinct cohort traders with a valid current-version evaluation at or before the request time.
- Pending: eligible minus completed, blocked, and terminal traders. Job retry attempts do not count as additional traders.
- Blocked: unassessed traders with source-waiting ability jobs.
- Terminal: unassessed traders with a terminal ability job and no active retry or source-waiting job. Cancelled duplicate jobs are not terminal traders.
- Completion windows: distinct traders whose first valid current-version evaluation falls in the window, not repeat runs.
- Evaluation activity: `evaluatedTraders1h`, distinct traders evaluated during the last hour, including repeat evaluations.
- Last progress: latest valid current-version evaluation. Future and orphan snapshots are excluded.

Existing response fields remain, with additive unit, strategy version, and activity metadata. Corrected numbers may drop compared with earlier reports; this is a definition correction, not data loss. Other stages remain unchanged and retain their separate known limitations.

## Implementation and acceptance

Use a dedicated bounded SQL aggregation reader and integrate it into the existing closed-loop route. Add isolated regression tests and an API integration assertion. Run targeted tests, the complete suite, typecheck, build, package smoke, boundaries, and browser tests. Deploy only above the disk safety floor; verify the current-version count against independent SQL and the data-flow endpoint with the same measurement timestamp where possible.

This phase does not establish full historical market coverage or new candidate/signal production. Retain those as separate acceptance criteria.

## Local validation results

- Ten targeted regression/integration tests passed.
- 834 unit tests across 206 files passed.
- Typecheck, build, package smoke, repository boundaries, and two desktop/mobile browser tests passed.
- The integration fixture's two non-null metrics were corrected to zero after explicit user approval. Production rows were not changed.

## Persisted lease state correction

Production inspection confirmed `leased` is an active persisted automation state. After explicit user approval, include it when deciding whether an older terminal task is superseded by an active retry. Add a regression test for the terminal-plus-leased combination. This changes diagnostic classification only, not scheduling or admission.
