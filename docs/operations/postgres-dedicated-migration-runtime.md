# Dedicated PostgreSQL migration transaction boundary

## Scope

`packages/database/src/postgres-migration-runtime.ts` is an explicit operator adapter for an already provisioned, dedicated PostgreSQL pool. It is not a service backend selector, an approval issuer, or a production migration executable.

Business services continue to use the separate least-privilege business driver. A business driver rejecting a schema owner is intentional; widening its permissions to accommodate migration would remove the runtime authority boundary.

## Required inputs

- Exact database, migration login, schema, generation, schema version and fingerprint.
- Actual loopback server address, server port and PostgreSQL system identifier. A tunnel does not permit substituting its local port for the actual server port.
- Explicit `schema_install` or `business_import` purpose, plan hash, approval reference and capability expiration.
- An external `assertAuthorized` callback that authenticates the reviewed plan, actor scope and current allowed cutover phase. A plain configuration object is not authorization.
- Explicit connection, operation, statement, lock, query-count, work-memory and shutdown limits.
- A dedicated pool whose connection and queue capacity are separately constrained by the approved resource plan. Do not share it with business services or a bootstrap administrator.

The adapter permits at most one operation at a time, rejects nested migration unit-of-work calls, and rejects an expired capability before connecting. Isolated mode additionally requires both database and schema names to identify a test or acceptance target, or to share the exact 16-hex nonce in strictly formed `radar_rehearsal_<nonce>[_suffix]` names. A generic rehearsal label or two different nonces is rejected; the external approval and physical target checks still apply.

## Authority checks

Every operation checks the actual session login, endpoint and cluster before invoking the supplied operation. The migration role must own the exact target schema but must not be a superuser, create roles or databases, bypass RLS, replicate, inherit another role through membership, create schemas or temporary objects through database privileges, or hold ownership/write privileges over the checked non-system schemas and relations outside the target.

Bootstrap administration is therefore separate. Provision the database and approved schema first; explicitly revoke default public database CREATE/TEMP rights as required; narrowly grant execution of `pg_catalog.pg_control_system()` rather than granting a monitoring or administrator role. The adapter does not perform these changes itself.

For `business_import`, the existing durable business ledger must match the expected generation, version and schema fingerprint. `schema_install` permits installation before that ledger exists; the reviewed schema installer remains responsible for installation identity and idempotency checks. Neither mode allows service startup to install tables implicitly.

## Atomic first write

The formal coordinator must use the dedicated runtime's top-level transaction boundary. Inside that boundary, pass the **same native transaction** to:

1. The reviewed cohort or provider-budget `InTransaction` importer.
2. The coordinator's durable first-write marker and transition journal.
3. Any checks required before acknowledging the import.

The native importer returns `pending_parent_commit`, not a durable completion receipt. Only a successful outer COMMIT permits a committed receipt. Do not call an independent batch importer from inside the first-write callback; those batches could become durable before the marker. Do not acknowledge a stage merely because an inner callback returned.

The standalone cohort batch APIs reject `approved_cutover` and are only appropriate for isolated rehearsals. They are not the formal production import path.

## Failure and recovery

- Authorization, identity, schema or budget rejection prevents the operation from being acknowledged.
- Marker failure rolls back the projection in the same physical transaction.
- A late connection from a timed-out acquisition is discarded, not assigned to a later operation.
- A hanging callback or SQL request is bounded; a failed rollback causes the connection to be discarded.
- A lost COMMIT response raises `PostgresCommitUncertainError`. Inspect the durable plan ledger and first-write state through an independent authorized read before retrying. Do not infer rollback from a lost response.
- After the first PostgreSQL business write, an old SQLite-only release is not a valid rollback. Preserve the same PostgreSQL data and require an independently verified compatible PostgreSQL release, or a verified complete reverse-journal procedure.

## Acceptance boundaries

Local transaction-protocol tests verify rejection, commit acknowledgement, rollback, nesting, timeout and uncertain-COMMIT behavior. They do not certify the actual production role, signed approval, final writer fence, source watermark, real PostgreSQL import, or natural wallet/radar coverage.

The formal entry point must integrate the coordinator, external evidence verifier and exact reviewed import plan. This adapter alone must never be reported as satisfying the complete six-workstream migration gate.

No production configuration, service, release pointer, database, FOMO session or delivery setting is changed by creating this adapter.
