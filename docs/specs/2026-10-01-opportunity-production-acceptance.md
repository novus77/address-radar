# Opportunity Discovery Production Acceptance

## Result

Deployment succeeded. End-to-end business acceptance is **partial**, not complete.

- Source release: `eb0151b`, branch `codex-workbench-v2`.
- Production target: `/opt/address-radar/releases/eb0151b-opportunity`.
- Previous release: `/opt/address-radar/releases/a1ea579-shared-provider-gate`.
- All six services were active with `NRestarts=0` after deployment.
- Gateway delivery remained `false` in configuration and all six running processes.

## Verification and rollback protection

- Full test suite: 171 files, 697 passing tests, zero failures.
- Build, type checking, package import smoke checks, and boundary checks passed.
- Desktop and mobile end-to-end tests: two passed.
- Final staged release: five targeted test files, 29 passing tests.
- The checkpointed pre-deployment database and configuration archive was exported to the explicitly authorized local path with restricted permissions.
- Local and server SHA256 matched; gzip validation passed; the extracted offline database returned `PRAGMA quick_check = ok`.
- The temporary server archive created for this deployment was removed only after successful local verification. Historical business data and previous backups were not removed.
- No schema migration was necessary. The bounded reconciliation preserved entity lifecycles and recorded an audit file.

## Reconciliation outcome

- Entities reconciled: 1.
- Signal-monitoring profiles enabled before and after: 1.
- Wallet jobs created: 0; outbox items published: 0.
- Ability reevaluation jobs created: 1, subsequently completed.
- Destructive business operations: 0.

## Observed progression

The automation worker writes its opportunity evaluations to `trader_repeatable_ability_snapshots`, not the legacy numeric-score table `trader_ability_snapshots`.

- New `trader-ability-v4-opportunity` snapshots: 24 at the later check.
- Wallet observations increased from 119,704 to 119,778 between the two post-deployment checks.
- Real-time monitoring policies: 122.
- Duplicate active automation jobs by type and subject: 0 at the initial acceptance check.
- Pending signal projections: 0 at that check.
- SQLite lock matches in the inspected latest 1,500 journal lines: 0. This bounded observation is not proof of zero historical lock events.
- Disk available after removing the temporary server archive: approximately 3.13 decimal GB, or 2.91 GiB. Capacity remains tight.

## Remaining blockers

### Legacy manual identity confidence mismatch

Production has 215 canonical wallet records from `legacy:fomolens_manual` with confidence `high`, and one legacy manual record with confidence `confirmed`.

The corresponding entity distribution is:

- 107 observing (`probation`) entities with legacy manual `high` identities.
- 14 suspended entities with legacy manual `high` identities.
- 1 observing entity with confirmed manual identity.

Wallet collection is running for 122 real-time policies, but signal-profile synchronization requires confirmed identity links. Consequently, the 107 observing entities are not enabled for signal participation. This is a collection-to-signal eligibility discontinuity, not absence of wallet collection.

A trust rule requires explicit business confirmation before implementation: recognize validated historical manual mappings as signal-eligible without rewriting confidence, or require manual confirmation. Do not globally trust all `high` links, auto-merge identities, or automatically reactivate suspended entities.

### Upstream data and unresolved identities

At the initial acceptance check:

- Candidate evidence jobs blocked on sources: 1,465.
- Pending identity resolution: 314.
- Recovery closure: 2,148 satisfied, 2,821 pending, 531 terminal.
- Early-trade recovery: 391 pending.
- Local ready signals: 8; no external delivery was enabled.

These counters use different units and denominators; do not interpret them as a single linear completion percentage. Missing market ranges, milestone evidence, early trades, and identity resolution remain material blockers. No reliable overall completion ETA is established.

## Follow-up acceptance requirements

1. Confirm the historical manual-identity trust boundary before changing signal eligibility.
2. Cover the selected mapping rule with regression tests for legacy manual links, non-manual high-confidence links, monitoring-off policies, and suspended entities.
3. Perform a bounded, audited reconciliation without global confidence promotion or identity merging.
4. Verify real eligible buy events reach aggregation and signal projection while preserving current thresholds and Gateway delivery disabled.
5. Continue hourly read-only monitoring of fact recovery, ability evaluation, candidate evidence, identity handoff, disk, and service stability.
