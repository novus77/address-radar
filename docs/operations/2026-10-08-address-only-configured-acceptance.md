# Address-only PostgreSQL migration and configured cutover acceptance

## Accepted scope

The address-only database migration and configured production cutover are complete. This is not acceptance of live trade capture, opportunity coverage, or the complete radar loop.

- Migration operation: `20261008-final4`.
- Import: `address-only-20261008-final4`.
- Generation: `production-20261006-v1`.
- Configured transition: `execution-20261008c`, journal phase `COMPLETE`.
- Retained cohort: 216 wallet profiles across 122 entities, including 119 Solana and 97 EVM addresses. Final production read-only cohort count: 216.
- No historical token, trade, market-fact, or automation-job import.
- All six business services are active, with `NRestarts=0` at final observation. Startup readiness validates per-service credentials, actual process identities, cgroups, invocation IDs, launch nonces, and process start times.
- Every managed service environment keeps gateway delivery disabled. No external signal delivery was enabled.

## Production artifacts

Configured release: `/opt/address-radar/releases/address-only-execution-20261008a`.

Inventory SHA256: `96a27d5532419694c9ce0af1b99a04986ea871710113cd59565fee7c7808f038`.

Durable transition receipt: `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/configured-transition-receipt.json`.

Original SQLite and independent backup both remain root-owned, mode `0400`, with size 4,619,636,736 bytes:

- `/var/lib/address-radar/address-radar.db`.
- `/var/backups/address-radar/address-only-20261008-final4/source.sqlite`.

The global release symlink remains `/opt/address-radar/releases/4b48fc2-forward-token-code`; the six business services use explicit configured overrides. FOMO login and collection were not part of this transition.

## Security and recovery

The wallet service uses a separate operating-system identity. Credentials and signing material remain server-local with restricted ownership. PostgreSQL publisher permissions and provider budgets were provisioned independently of consumer roles. Recovery preserved the original request and journal bindings, using separately pinned bounded renewal authorizations; no journal deletion or SQLite write restoration was used.

The transition repaired parent-directory traversal for the wallet identity and the inherited single-account readiness revalidation assumption. Full per-service identity checks remain enforced. Recovery supports interrupted checkpoints, and completion rejects expired native-preflight evidence.

## Validation evidence

- Full JavaScript suite: 354 files passed, 25 skipped; 3,029 tests passed, 107 skipped. Log: `/private/tmp/address-only-final-tests-20261008c.log`.
- Configured controller: 53 Python tests passed.
- Automation and PostgreSQL service TypeScript checks passed at the diagnostic integration checkpoint.
- Native production preflight verified committed import, source epoch, database contracts, authority ports, configuration, and execution producer wiring.
- Startup available RAM: 3,022,626,816 bytes; available disk: 5,876,547,584 bytes. These are startup observations, not steady-state capacity proof.

## Explicitly not accepted

The production receipt reports `sourceMonitoring=configured_pending_observation`, `monitoringCompleted=false`, and `businessEligibilityGranted=false`.

At final observation, capture, purchase, and token-discovery counts were all zero. EVM checkpoints had advanced in an earlier observation, but this does not prove captured buys or complete coverage. Solana collection had failures whose aggregate logs did not retain a specific reason. Structured, bounded, sanitized diagnostics were implemented and tested locally but were not included in this production release.

Execution replay is configured for Solana, BSC, and Base. Ethereum remains disabled because the selected source rejected the genesis-block query. Independent price validation, safety authorities, source-envelope attestation, and complete radar coverage remain separate development and acceptance gates. Missing facts must remain deferred; migration completion does not grant qualification or authorize delivery.
