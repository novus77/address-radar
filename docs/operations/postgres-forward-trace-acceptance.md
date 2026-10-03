# Read-only forward trace acceptance

## Scope

Task 12 gains a separate, explicitly configured loopback-only reader. It does not replace or activate the legacy console. The operator token is memory-only, and all HTTP commands except authenticated GET are rejected. The server fixes the strategy generation and assessment clock; clients cannot select another generation or submit permission facts.

The reader executes one bounded SELECT for purchases, opportunity versions, capability versions, identity refresh records and signal receipts, using a shared MVCC snapshot without business row locks. Purchase keyset pagination is stable for a fixed clock. Counts refer to the displayed page, not global data coverage. Identity and signal sections explicitly report truncation.

## Labels and provenance

- Preserve execution fingerprints, ownership references, assessment versions and refresh receipt IDs.
- Nominal stablecoin dollar amounts remain labeled estimates.
- A verified 3x/5x opportunity is not realized profit and does not require selling.
- Missing execution or price coverage is not a failed trade.
- A projection for an older execution fingerprint requires recomputation.
- Recorded capability does not imply fresh identity eligibility.
- Pending, validated, deferred and cancelled signals are never labeled delivered.

## Isolated acceptance

Build first, then run:

```sh
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false node scripts/verify-postgres-forward-trace-acceptance.ts
```

Supply the isolated PostgreSQL URL through the existing protected acceptance environment. The script uses one connection, a precise session-temporary schema inventory, synthetic capability fixtures, real HTTP reads, authorization checks, keyset pagination checks and no-mutation checks. Cleanup drops only its own session-temporary tables.

This verifies the HTTP read path and operator labels, not real browser interaction, actual FOMO coverage, live signal joins or permanent business activation. Runtime budgets, port and generation must be explicit at activation. Permanent schema installation, legacy-console replacement, service restarts, FOMO resume and signal delivery remain separate approval gates.

## Remaining work

Durable identity refresh cursors and business runtime composition remain pending. Real market/trade/risk source adapters and end-to-end live-source acceptance cannot be replaced by synthetic fixture receipts. Before activating this reader, verify its SQL against the complete production forward schema and authorization policy.
