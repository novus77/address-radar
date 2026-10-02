# SPAC: Verified Signal and Aggregation Execution Receipts

## Scope

Implement real consumer receipts for signal_projection and token_aggregation after evaluation of verified execution inputs. Do not change admission, scoring, identity merge rules or gateway delivery. Phase 1 (c7fb21b) and phase 2 (ed5864f) are deployed; complete business closure is still not claimed.

## Verified Gap

The signal worker previously completed its token projection request without acknowledging execution revision requests for either downstream consumer. A dispatched request, an unrelated completed projection and an empty evaluation do not prove the revised trade was consumed.

## Input Proof

A receipt requires the exact requested execution head to be applied and its upstream event_projection request to have the same acknowledged revision with projection_recomputed outcome. The trader identity, chain, contract, side, amount and occurrence time must match both the source trade and stored address signal evidence. Contribution, lifecycle, source, tags and dedupe identity must match the evidence read by the worker. Only monitored, mapped, source-enabled traders passed to the evaluation are considered.

Out-of-window or filtered events are not claimed as consumed. Their pending revision disposition is intentionally not synthesized in this phase. Missing or stale event projection prerequisites defer the job. Unknown lifecycle also defers evaluation completion; thresholds not met with valid inputs are an evaluated observe decision, not missing data.

## Atomic Acknowledgement

- Capture eligible execution revisions before evaluation.
- Persist the actual aggregation/signal decision through the existing service.
- In one write transaction, advance the token projection request and acknowledge only still-matching captured execution inputs.
- Revalidate heads, event projection acknowledgements and stored evidence under the write lock. A newer or changed input remains pending.
- Persist signal_projection_execution_receipts with consumer, execution revision, execution fingerprint, evidence fingerprint, token projection revision, decision and completion time.
- Do not open a write transaction around the signal service: its repository uses a separate database connection. If the later receipt transaction fails, no receipt is confirmed and existing evaluation idempotency handles replay.

A receipt records a verified evaluated revision; it does not assert a broadcast, a delivery, profitability or completed historical coverage.

## Wake-up Fingerprint

Include completed address-signal event projection timestamps in the reconciliation fingerprint. This allows a corrected projection to trigger reevaluation even if event count and execution head revision have not changed. Keep exact timestamp interpolation and SQLite single-quoted string literals; regression covers both.

## Schema and Rollout

Add signal_projection_execution_receipts before production activation. No legacy receipt is backfilled or guessed. Use a verified database backup, release checksum, atomic release switch, six-service health checks and rollback. Delivery remains false.

## Acceptance

Five targeted tests passed:

- Verified below-threshold evaluation acknowledges both consumers without broadcasting.
- Replay does not duplicate receipts.
- Missing lifecycle defers without acknowledgement.
- Unverified event projection defers without acknowledgement.
- A newer execution revision during evaluation remains pending.
- Repeated event projection completion changes the projection fingerprint, while an unchanged scan does not.

Complete tests, types, build, imports, boundaries and browser regression are required before commit/deployment. Production acceptance must inspect exact receipt rows and outstanding upstream prerequisites, not only service health. Pending historical/out-of-window requests, identity resolution, sustained recovery coverage and milestone-state semantics remain separate acceptance work.
