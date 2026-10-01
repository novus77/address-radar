# Partial Historical Price Retention: Production Acceptance

## Release and verification

Release: `b3010e4-partial-history`. Rollback release: `5aeaa55-defillama-pages`.

Passed 22 targeted tests, 799 unit tests across 199 files, build, typecheck, package import smoke checks, module boundaries, and two desktop/mobile browser tests. Integration tests exercise real paginated client errors through recovery runtime into SQLite, including idempotent retries and preservation of existing available facts.

The failed AST-based edit script did not modify the recovery handler. A precise two-location text patch completed the handler integration. All validation was run after that integration.

## Production snapshot

At 2026-10-01T11:21:29Z (19:21 China Standard Time), the current symlink pointed to `/opt/address-radar/releases/b3010e4-partial-history`. All six services were active with NRestarts=0 and ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false. The last five minutes contained zero matching SQLite contention, missing-table, invalid budget, or fatal errors.

The standard deploy script verified existing additive schemas. This checkpoint added no new schema and performed no broad old-data rewrite. Current and rollback releases were retained. Disk available: 3,052,830,720 bytes, only about 53 MB above the existing deployment guard; storage remains a material operational constraint.

## Progress and limitations

- Distinct opportunity-v4 ability entities: 277, versus 275 at the previous hourly snapshot.
- Candidate evidence facts: 1,439, unchanged.
- Candidate evidence blocked: 1,943.
- Early trade recovery completed: 1,706; pending: 411.
- Recovery satisfied: 2,185; pending: 3,058; terminal: 532.
- Runnable: 85; runnableDelta15m: -3; converging=true in this short API window only.
- Oversized active history manifests: zero.
- Shared GeckoTerminal and DefiLlama gate records were present.

No attempt with the new `partial-price:defillama_chart:` audit prefix had yet been observed. Deployment readiness is verified, but production evidence of a genuine later-page failure retaining completed-page prices remains pending. Do not interpret a legacy partial attempt as evidence for this code path.

## Remaining work

This patch retains completed pages on a handled later failure. It does not checkpoint each page before process termination, skip already-fetched pages, attribute logical budgets per physical request, certify full extrema coverage, or resolve source capability gaps. Existing candidate and historical data bottlenecks remain. One negative runnable delta is not proof of sustained closed-loop convergence; no reliable overall completion estimate is available.
