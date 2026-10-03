# Isolated Opportunity Consumer Acceptance

## Transaction boundary

A purchase sample's durable intent creates version-bound opportunity work. A stored, available, related market peak revision can request reevaluation of that sample. The request identity excludes delivery/evaluation timestamps. Repeated revisions do not reopen completed jobs or renew leases. New factual requests invalidate older claims; request and claim generations, owner, exact expiry, execution fingerprint and strategy version fence completion.

The consumer locks the sample before its work row, reads persisted market facts and evaluates without external network I/O in the transaction. Evaluation ledger, current head, semantic downstream intent and successful receipt share the caller's transaction. The caller must wait for the outer unit-of-work commit before reporting success. Missing verification/coverage writes a waiting assessment and a deferred job, not a success receipt. An `observing` receipt proves that input snapshot was evaluated, not that the 30-day opportunity window ended or admission passed.

Initial sample admission is bounded and marks its producer intent dispatched only after work was staged. Dispatch is not completion. Expired claims may be reclaimed; superseded executions do not earn receipts. This stage does not accept arbitrary clock-trigger keys, automatically approve execution revisions or downgrade established opportunity evidence.

## Verification and isolation

Run the standalone `scripts/verify-postgres-opportunity-worker-acceptance.ts` after building, with the explicit loopback `_test` URL supplied only through `ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL`, and delivery explicitly false. Synthetic temporary tables and all fixture writes are rolled back. Tests cover missing-market deferral, actual 3x/5x progression, duplicate trigger rejection, replaced and expired claims, reclaim, result/receipt interruption and cleanup.

No permanent schema is applied. No business release switch, service restart, source resume, candidate grant or radar delivery is performed. Actual simultaneous-connection work-claim stress, token-wide bounded market-revision fanout, recurring reconciliation, production runtime wiring, real-source coverage, authorized execution revision application, capability/admission consumers and cutover remain separate tasks. Lease and retry budgets are supplied explicitly by the caller; no unapproved provider budget or coverage threshold is introduced.

## Admission lock-order regression

The local actual-driver suite uses two connections: a producer holds the sample row while batch admission must skip it without acquiring its outbox row first. After release, direct sample admission produces exactly one request and job. The regression failed with a lock timeout before the correction. Its disposable local schema is always removed; production acceptance still uses only rolled-back temporary tables and does not require schema-creation privileges.
