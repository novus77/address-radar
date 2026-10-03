# Isolated forward capability consumer acceptance

## Scope

This slice adds independent sample, opportunity and observed-100K wake links, a per-entity/generation capability work queue, request/claim generation fencing, a durable bounded cohort scan, and atomic projection/result receipts. It does not consume another downstream worker's transport status. Semantic capability changes retain the existing immutable version/head/outbox contract.

A projection receipt certifies the stored capability decision and its unknown-data counters, not successful price recovery, completed observation, candidate admission, wallet resolution or radar authorization. Sample-budget overflow defers without a success receipt. Unknown coverage remains unknown and does not turn into a failed trading sample.

## Execution

Use an explicit dedicated localhost PostgreSQL acceptance URL supplied through the protected environment file. Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.

```sh
node scripts/verify-postgres-trader-capability-work-acceptance.ts
```

The acceptance driver creates transaction-local temporary tables on one exclusive connection and rolls back all synthetic data. Production acceptance requires no permanent schema privilege. The separate two-connection test uses its own randomly named disposable local test schema, never a production schema.

## Required invariants

- Duplicate wakes do not replace a lease or reopen a completed request.
- New semantic wakes invalidate an older request/claim; old consumers cannot confirm receipts.
- Expiration during computation rolls back the new projection and its outbox together.
- Missing input budget cannot produce a receipt or sampled eligibility decision.
- Retry delays leave execution opportunities for other subjects.
- Observed 100K screening wakes previously stored buyers without historical mining.
- Bounded lexical cursor scans revisit both samples and existing heads to remove aged-out capability.
- Clock-only recomputation creates a work receipt but no new semantic capability version/outbox.
- A receipt is bound to the actual current projection version/head generation.
- Another consumer's source intent status remains untouched.

## Activation gates

The reconciliation interval, page size, maximum samples, retry delay and lease duration are caller-supplied operational budgets. No production timer is enabled by this slice. Runtime wiring, stress/lease-renewal budgets, permanent schema/write-path activation, candidate admission, manual grants, signal receipts and authenticated live-source coverage remain separate dependencies. Legacy admission and Gateway delivery remain unchanged. Fixture totals are not production progress.
