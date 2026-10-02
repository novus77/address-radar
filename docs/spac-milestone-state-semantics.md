# SPAC: Milestone Confirmation Versus Historical Data Gaps

## Objective

Give operators an evidence-backed distinction between waiting for live confirmation, historical prerequisites still missing, a verified milestone and limits of currently configured sources. Do not lower admission thresholds, infer token legitimacy, use launch time as a historical gate or claim a lack of history proves a token never reached a milestone.

## Classification

- milestone_confirmed: a non-future, sourced, non-FDV crossing at or above an existing candidate milestone is stored and not contradicted by a conflicted milestone fact.
- historical_missing: historical inventory or an explicit historical recovery obligation exists but no valid crossing is available. Current low capitalization and partial price history are not negative historical evidence.
- waiting_confirmation: there is no historical obligation, market identity is available with an explicit unexpired freshness stamp, and a valid recent observation is below the first existing milestone. This means continue monitoring, not that the token never crossed previously.
- source_unavailable: the milestone fact has terminal_unavailable with its original reason retained. This describes the current source set, not every possible provider and not token failure.
- unverified: stale, missing, contradictory or otherwise insufficient proof. It cannot cause admission failure or elimination.

The first milestone is imported from CANDIDATE_MILESTONES; no second copy of scoring thresholds is introduced. No launch date is required.

## API and Console

GET /api/v2/discovery/milestone-assessments is read-only. It returns at most 200 recently known tokens with state, Chinese label, diagnostic, observed timestamp/capitalization, verified crossing and source reason. Classification counts describe only those returned rows; they are not global coverage percentages.

Use batched reads rather than per-row database queries. Add a dedicated console section with one token per table row. Show plain-language diagnoses first and technical reasons in expandable detail. Rename waiting_source to waiting for prerequisites and terminal_unavailable to limits of current sources, avoiding false finality.

## Acceptance

A real console/database test verifies live confirmation, explicit historical demand despite low current cap, terminal source limitation, verified crossing and expired freshness. Existing operator API tests remain valid. Complete tests, types, build, imports, boundaries and desktop/mobile browser checks precede commit/deployment.

## Deployment

This phase changes read-only semantics and presentation only; no production data migration or bulk rewrite is required. The console now declares its existing workspace scoring dependency explicitly. Ship the corresponding relative workspace symlink with the release so the compiled console can resolve scoring at runtime without a production dependency installation.

Retain the current release and rollback versions, validate backup and archive checksums, keep gateway delivery disabled and roll back on service health failure.

## Remaining Business Acceptance

Consumer wake-up retention, actual chain execution, real revision receipts, distinct ability coverage and identity resolution must still be measured over time. Historical/out-of-window execution requests are not falsely acknowledged as consumed. The four implementation phases do not by themselves prove the entire data backlog has drained or every real-token discovery-to-signal path is covered.
