# Closed-Loop Production Acceptance

## Scope

This runbook validates the path from token discovery through market and milestone facts, early-trade recovery, trader identity, candidate evidence, ability evaluation, admission, wallet monitoring, aggregation, and local signal readiness.

Gateway delivery must remain disabled during reconciliation and read-only acceptance.

## Pre-deployment evidence

- Record the release commit and previous release target.
- Confirm `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.
- Back up the SQLite database, WAL, SHM, environment files, and systemd units.
- Run the reconciliation in dry-run mode and retain its summary.
- Confirm the dry-run reports no destructive operation.

## Reconciliation procedure

1. Run bounded batches with a batch size no greater than `500`.
2. Record each cursor and summary before starting the next batch.
3. Stop when `hasMore=false`.
4. Re-run the final batch and confirm all mutation counters are zero.
5. Never delete raw observations, canonical events, candidate evidence, or historical job records.

## Immediate checks

- All required services are active without restart loops.
- Recovery jobs cannot complete without a satisfied or terminal recovery fact link.
- Eligible source observations create canonical events and early-trade facts.
- Wallet coverage has an explicit state for every resolved identity and configured chain.
- Manual identity work is absent from automated runnable backlog.
- SQLite lock retries are bounded and source conflicts do not grow continuously.

## Two-hour acceptance window

Capture the following every ten minutes:

- Stage totals and 15-minute deltas from `/api/v2/operations/closed-loop`.
- Productive-job rate and zero-output reasons.
- Recovery-to-fact closure rate and unresolved reason codes.
- Runnable, deferred, blocked, terminal, and manual queue counts.
- Admission and completion rates, runnable delta, and oldest runnable age.
- Wallet coverage by chain, provider, and status.
- Candidate evidence, ability evaluation, and admission deltas.
- SQLite lock failures, service restarts, disk usage, and source-conflict writes.

## Acceptance criteria

- Live discovery and signal-readiness work remain responsive while historical work drains.
- A fixed historical workload reaches zero runnable jobs.
- Completed recovery work has matching canonical facts.
- Candidate and ability jobs either produce facts or retain explicit zero-output/deferred reasons.
- Oldest runnable age decreases and runnable backlog has a non-positive trend after initial admission.
- No wallet is represented as historically covered by plain RPC without supporting evidence.
- Console totals reconcile with direct read-only SQL queries.

## Rollback triggers

- Integrity-check failure or unexpected data loss.
- Repeated service crashes or sustained SQLite lock failures.
- Recovery completion without fact closure.
- Material loss of canonical observations or candidate evidence.
- Unexpected Gateway enablement.

Preserve the failed release, logs, reconciliation summaries, and database backup for diagnosis before rollback.
