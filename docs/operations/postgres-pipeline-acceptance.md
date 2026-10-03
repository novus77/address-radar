# PostgreSQL synthetic pipeline acceptance

## Scope

This verifier uses the project's actual PostgreSQL driver, source adapter, normalizer, independent token and purchase consumers, and the approved forward policy. It never connects a browser, creates a subscription, enables delivery, migrates SQLite, switches a release, or starts a business worker.

All fixture tables reuse the exported repository schemas with `CREATE TEMP TABLE`. The transaction-local search path is restricted to `pg_temp, pg_catalog`, so unqualified business-table access cannot fall through to the public schema. The complete fixture transaction is deliberately rolled back. The verifier checks that its temporary capture table no longer resolves before reporting success. An acceptance failure also propagates through the unit of work and rolls back partial writes. Use a freshly constructed, exclusively owned, single-connection acceptance runtime.

## Proven fixture contracts

- Source replay retains one normalization job and immutable raw revision.
- Normalization schedules independent token and purchase consumers.
- Token discovery begins before 100K; the first validated 100K milestone enables screening and extends the seven-day capture window.
- A verified nominal-USDC purchase of USD 50 produces one independent 30-day sample with the estimation flag retained.
- Missing execution evidence defers only purchase matching and creates no success receipt, trade, or sample.
- A semantic source revision defers both consumers for review and does not overwrite the original execution price or merge identities.
- Reconciled totals are two source identities, three raw revisions, three normalized events, three consumer receipts, three deferred consumer jobs, one economic trade, one purchase sample, and one token watch.
- Credential-bearing fixture fields are scrubbed; successful and failed fixture runs leave no temporary tables.

These are synthetic transaction contracts, not real platform coverage, committed acquisition durability, persisted opportunity evidence, stable capability, admission, radar delivery, or completed business cutover. Those acceptance gates remain separate.

## Commands

```bash
pnpm exec vitest run apps/scanner/test/postgres-pipeline-acceptance.test.ts
ADDRESS_RADAR_POSTGRES_TEST_URL="$ISOLATED_TEST_URL" pnpm exec vitest run apps/scanner/test/postgres-pipeline-acceptance.integration.test.ts
pnpm run build
ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false node scripts/verify-postgres-pipeline-acceptance.ts
```

The standalone command also requires `ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL` from an operator-managed secret file. Never print this URL or place credentials in command arguments. Only explicit loopback `_test` targets are accepted. On the server, use the previously approved acceptance instance and restricted role; no additional schema-creation privilege is needed.

For a scanner-package-only deployment, place its built `dist` directory at `apps/scanner/dist` beside the standalone script's parent directory. Preserve the production dependency tree produced by the package manager. Keep this artifact in the operations acceptance directory, separate from `/opt/address-radar/current`.
