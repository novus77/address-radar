# Opportunity Discovery: Checkpoint 2 Implementation Notes

Status: source changes prepared; tests, commit and production rollout pending.

## Scope

This checkpoint follows the approved opportunity-discovery SPAC. No new
admission thresholds, scoring weights, identity merging rules or signal
aggregation policies are introduced. Gateway delivery remains unchanged.

## Monitoring handoff

Repeated wallet-resolution notifications previously returned before repairing
a missing monitoring policy. They now reconcile that policy even when the
outbox event already exists. Explicit `off` policies remain disabled. Registry
versions change when the effective monitoring policy changes, so consumers can
reload instead of retaining a stale wallet set.

Bounded reconciliation previously revisited the first 250 wallets regardless
of whether their handoffs were already complete. It now selects only wallets
missing the versioned initial-backfill job or an effective monitoring policy.
Selection and repair occur in the same write transaction. Completed, blocked
and failed existing jobs are not duplicated or automatically reopened.

## Operator presentation

The address-library API exposes the latest 30-day opportunity metrics as an
additive field. Verified recurrence labels are derived from these metrics,
separately from manually assigned or legacy source tags.

The backtest view displays one latest 30-day record per trader, with distinct
token counts, 3x/5x/10x hits, observing entries, missing-data entries and verified
misses. Legacy records are explicitly marked as awaiting recalculation rather
than interpreted as high-multiple recurrence. The module no longer describes
missing data or inactivity as automatic elimination.

## Regression coverage prepared

- Repeated resolution repairs missing monitoring without duplicating an event.
- Repeated resolution preserves an explicit monitoring opt-out.
- Bounded reconciliation advances beyond already repaired wallets.
- Policy repair increments the monitoring-registry version without duplicating
  initial-backfill jobs.

These tests have not been executed for this checkpoint. The previous
checkpoint's 689 passing tests do not validate these new changes.

## Remaining acceptance work

Run focused identity and console tests, then the full suite and type checking
when authorized. Verify console field rendering and registry reload behavior.
Continue auditing canonical-wallet visibility, admission-to-library handoff,
historical capability retention and complete observation-range recovery.
Production data reconciliation, deployment and collector cutover remain
separate acceptance steps; this checkpoint performs no production writes.
