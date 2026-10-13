# Address-only PostgreSQL migration acceptance

## Outcome

The address-only database migration and six-service backend switch completed on 2026-10-08 at approximately 14:52 Asia/Shanghai.

- Operation: `20261008-final4`.
- Import: `address-only-20261008-final4`.
- Generation: `production-20261006-v1`.
- Protocol: `address-only-v1`.
- Imported wallets: 216; distinct entities: 122.
- Import ledger entries: 1.
- Activation state: `COMPLETE`, with no pending action.
- Activation acceptance: `six-services-live-ready-waiting`.
- Gateway delivery remains disabled in all six actual service processes.

This acceptance covers migration and startup, not live monitoring or end-to-end signal production. Sources remain explicitly in `waiting_configuration`; `monitoringCompleted`, `coverageVerified`, and `steadyStateCapacityVerified` are false. No provider coverage or processing throughput is inferred from successful startup.

## Native evidence

Production host: `152.32.185.240`, accessed as `ubuntu` with noninteractive sudo.

- PostgreSQL cluster system identifier: `7693392208475083526`.
- Database/schema: `address_radar` / `address_radar_business`.
- Schema version: 3.
- Schema fingerprint: `b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383`.
- Sealed service release: `/opt/address-radar/releases/address-only-pg-20261008-v3`.
- Release inventory SHA256: `7de60bc5cdac148aad725a5f519e303ee9c6c76ac6406b2339a95b8e8db2c1e2`.
- Plan SHA256: `005bbf2538e953937eb0437bfb3ab7c6e8ebab2ce586a11419c82ec5a3ab7964`.
- Cohort SHA256: `9d4b1b7d6bed04ec14ce8bb562bd1958d65e873f1c9ce69a41f2050f59ef33f3`.
- Backup SHA256: `ab283938117957274287f6df59f53f459809ff6d85a4c777f289698bfee28cd8`.
- Controller configuration SHA256: `9d259e322ce54591b92b7a3a1428138c4e31e8d61af013ddb2c05dec0b24f14c`.

Root-private receipts are retained on the server under `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/`: `controller-receipt.json`, `import-receipt.json`, `address-only-manifest.json`, `activation-state.json`, and `activation-receipt.json`.

## Scope and preservation

Confirmed address identities, entity associations, profile versions, and monitoring authorization/channel settings were retained. Historical tokens, trades, prices, evidence, ability evaluations, and old automation jobs were not imported. A read-only scan of all target-schema tables found nonempty address/configuration tables and schema/generation metadata only.

The original SQLite database remains on disk, owned by root with mode `0400`. Its independent verified backup is `/var/backups/address-radar/address-only-20261008-final4/source.sqlite`. Older migration backups and audit records remain available. Only unused disposable staging copies from the two restored attempts were removed, reclaiming 9,233,707,008 bytes.

The global `/opt/address-radar/current` link remains `/opt/address-radar/releases/4b48fc2-forward-token-code`. FOMO collector, login, and noVNC identities were protected during migration; their release path was not switched.

## Service and HTTP acceptance

`scanner`, `automation`, `wallet-monitor`, `wallet-analysis`, `historical-backfill`, and `console` passed actual process-bound IPC readiness. Subsequent systemd inspection found all six active with `NRestarts=0`.

Each service has `MemoryMax=268435456` bytes and `TasksMax=64`. These limits are startup protections for waiting mode, not demonstrated steady-state ingestion capacity.

Both production-local endpoints returned HTTP 200:

- `http://127.0.0.1:3214/healthz`: PostgreSQL backend, expected generation, gateway delivery false.
- `http://127.0.0.1:3214/api/v2/operations/closed-loop`: PostgreSQL backend, no legacy totals; capture, purchase, and token-discovery counts zero, coverage unverified.

Disk availability at acceptance was 5,897,302,016 bytes, above the 3 GiB safety floor.

## Issues resolved

1. The migrator owned the whole database, conflicting with the runtime's restricted-authority contract. Database ownership was moved to `postgres`; the migrator retains CONNECT and ownership of the target business schema, without database CREATE/TEMP rights. Six service connection grants were retained.
2. Startup identity SQL compared `inet_server_addr()::text`, returning `127.0.0.1/32`, against the configured host `127.0.0.1`. It now uses `pg_catalog.host(inet_server_addr())`, while retaining exact port, cluster, database, schema, and generation validation.
3. Child failures previously discarded their diagnostic cause. Bounded, allowlisted diagnostic records now retain failure category and stage without persisting raw SQL, credentials, wallet values, or arbitrary exception text.

Before the successful formal import, a genuine PostgreSQL transaction exercised the captured cohort and startup verification, intercepted COMMIT, and confirmed ROLLBACK. That diagnostic was explicitly synthetic and was not treated as import proof. The final acceptance uses the separate committed final4 import and activation receipts.

## Validation

The final full test run passed 346 test files and 2,861 tests; 25 files and 107 tests were skipped. Automation and PostgreSQL-service TypeScript checks passed. Targeted launcher, controller, native-fence, and activation regressions were also exercised during this migration.

## Next boundary

Configure and independently accept the address monitoring data sources and their budgets before enabling ingestion. FOMO login/bridge acceptance remains separate. Gateway delivery must remain disabled until explicitly authorized. Do not restart legacy SQLite writers or treat startup readiness as evidence of live data coverage.
