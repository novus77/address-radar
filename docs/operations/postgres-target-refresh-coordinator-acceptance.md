# Durable target refresh coordination

## Runtime contract

Compose the existing bounded identity refresh worker with a PostgreSQL-backed coordinator. FOMO and wallet cursors persist independently. The existing per-channel budget and interleaving remain unchanged.

Each tick claims a generation-scoped lease, runs source checks outside the checkpoint transaction, then atomically stores cursors and an immutable checkpoint audit. Cursor advancement requires matching committed identity refresh receipts, assessment clocks, generation, status counts and next-cursor proof. A missing/unavailable source is a completed source check, not eligible identity or closed-loop completion.

Only the active lease owner may checkpoint. Expired workers cannot overwrite replacement progress. Retries of the same committed checkpoint are idempotent. Source failures, missing receipts and audit failures leave cursors unchanged. Clock regression defers work.

An optional cancellation-aware loop awaits one tick at a time: it does not overlap pages or start work after cancellation. Lease duration, refresh cadence, generation, instance identity and per-channel budget must be explicitly supplied; no unapproved production values are introduced. Bind the real source reader and actual authorization reader at business activation.

## Isolation and proof

Build, then run:

```sh
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false node scripts/verify-postgres-target-refresh-coordinator-acceptance.ts
```

The protected acceptance URL must select the existing loopback test database. One connection and a precise TEMP schema inventory are required. Synthetic source-check receipts test restart recovery, active-lease exclusion, expiry fencing, immutable retries, receipt validation and transactional audit rollback. Cleanup only drops owned session-temporary tables.

This does not prove actual provider coverage, multi-connection throughput or business daemon activation. It does not resume FOMO, open browser pages, follow accounts, modify permanent business data, restart services or deliver signals.

## Activation gates

Permanent schema migration and business runtime composition require a separately approved deployment. Confirm runtime budgets and cadence before enabling the periodic loop. Keep the gateway disabled during real-source acceptance. Record raw source continuity, missing intervals and consumer receipts separately from scheduler health.
