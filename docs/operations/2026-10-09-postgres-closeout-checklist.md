# PostgreSQL Post-Migration Closeout Checklist

Date: 2026-10-09

## Acceptance boundary

Database operational acceptance and radar closed-loop acceptance are separate decisions. Successful migration, service startup, or release activation does not establish live capture, purchase processing, token discovery, business eligibility, or signal delivery.

The database is operating on the activated stability b release. Final database closeout remains pending the checks below. Stability c is on hold until guard, budget, and deadline fixes are approved and final tests pass. This checklist does not authorize a build, stage, activation, production write, or service operation.

## Evidence basis

This document records the latest reported operational facts and existing release receipts. No new production inspection or database query was performed to prepare it. PASS applies only to the stated observation; it does not imply continuous health or completion of a broader gate. PENDING means the required evidence has not been established here.

| Observation | Status | Recorded fact and limit |
| --- | --- | --- |
| Address-only cohort | PASS | 216 wallet profiles across 122 entities. This is the migrated cohort, not proof of current business eligibility. |
| Business schema version | PASS | Schema version 3 is reported. Independent live constraint and index checks remain separate gates. |
| Six-service startup | PASS | All six services are reported active with NRestarts=0 at the latest observation. This is not a sustained stability measurement. |
| Stability b activation | PASS | Activation SUCCESS was reported for stability-20261009b. The completed transition is the origin for a future c release. |
| Disk observation | PASS | Reported available disk is 5.83 GB. A reserve calculation for backup, restore, WAL, and release retention is still required. |
| Publisher access boundary | PASS | Publisher least-privilege access is reported in place. This does not grant publisher permissions to consumer roles. |
| Logical dump and isolated restore execution | PASS | Backup dump and restore were reported complete. Restored row-count verification remains pending. |
| Capture, purchase, and token counts | PASS | The reported counts are 0 captures, 0 purchases, and 0 tokens. PASS records the observation only; it is not radar acceptance. |

## Database closeout gates

| Gate | Status | Required evidence before final acceptance |
| --- | --- | --- |
| Connection and target identity | PENDING | Record the actual database, business schema, PostgreSQL 16 server identity, schema fingerprint, and each service role. Confirm private connection paths and no public PostgreSQL exposure. Active services alone are insufficient. |
| Connection budgets and lifecycle | PENDING | Measure total and per-role connections against configured caps and reserved capacity. Confirm bounded connection, statement, lock, idle-transaction, and shutdown deadlines; check for idle-in-transaction sessions and leaked connections. |
| Publisher least privilege | PASS | Retain the reported publisher privilege evidence and its exact role/target binding. No broader permission grant is implied. |
| Complete role and schema privilege audit | PENDING | Retain an explicit matrix for consumer, publisher, migration, operator, backup, and restore roles, including ownership, grants, search_path, and default privileges. |
| Constraints | PENDING | Verify expected primary keys, unique keys, foreign keys, NOT NULL rules, and CHECK constraints against the approved schema contract. Record validation state and any deferred constraints. |
| Indexes | PENDING | Compare the live index inventory with the approved schema, including expected columns and predicates. Confirm indexes are valid and ready; record missing, invalid, or unexpected indexes. |
| Orphan and binding integrity | PENDING | Run bounded read-only checks across generation, import ledger, cohort, profile versions, channel identity/head bindings, capture, purchase, and token relationships. Confirm expected generation/import bindings and no orphaned references or duplicate identities. |
| Logical backup execution | PASS | Dump completion is reported. Preserve the archive and execution evidence without replacing existing backups. |
| Isolated restore execution | PASS | Restore completion is reported. No production restore or production data replacement is implied. |
| Backup artifact verification | PENDING | Retain archive SHA256, size, timestamps, tool versions, source identity, included object inventory, dump/restore exit results, and isolated destination identity. Do not infer these details from a completion report. |
| Restored count and content verification | PENDING | Verify restored counts, including the 216-wallet / 122-entity cohort, and relevant generation/import/first-write bindings. Compare changing tables against the dump snapshot or recorded backup-time evidence, not a later live count. Verify sequence state and bounded content checks where applicable. |
| Restore schema verification | PENDING | Compare restored constraints, indexes, schema version/fingerprint, and required dependencies. An isolated restore using different ownership or omitted ACLs does not prove production privileges were restored. |
| Fifteen-day retention | PENDING | Document and verify a retention policy of at least 15 days for verified PostgreSQL backups and associated evidence. Keep migration originals and protected audit artifacts outside automatic expiry. No deletion or rotation is authorized by this checklist. |
| Disaster rollback / recovery | PENDING | Document and rehearse recovery into an isolated PostgreSQL target using the verified backup, required role/configuration material, and a compatible sealed release. Establish measured RPO/RTO, target identity checks, writer fencing, reconciliation, and the activation decision. Do not assume post-migration writes can safely return to SQLite. |
| Capacity reserve | PENDING | Reconcile the reported 5.83 GB free space with bounded dump/restore requirements, WAL/temp growth, retained backups, and release artifacts. Do not reclaim old data merely to satisfy a reserve target. |

## Release and recovery bindings

The active b release is reported as `/opt/address-radar/releases/address-only-stability-20261009b` with sealed inventory SHA256 `7af3e3871aaad332a1055232ccf438f86326961a59d3825ff248a72cf998d7e2`.

The reported COMPLETE origin artifacts are under `/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/`:

- `configured-stability-20261009b-state.json`
- `configured-stability-20261009b-receipt.json`

Before any future c transition, read and pin the actual b journal and receipt, verify COMPLETE and matching bindings, and use the b release and existing native Node pins. Do not use the earlier executionc transition or merely prepared a metadata as the current configured origin. Preserve the permanent oldState and originalManifest pins, credential/key pins, and all a/b audit artifacts.

## Radar closed-loop gates

| Gate | Status | Required evidence |
| --- | --- | --- |
| Post-activation source progress | PENDING | Show bounded, durable progress from correctly wired Solana and EVM collectors without skipping post-activation checkpoints. Unknown historical timestamps remain deferred. |
| Live capture | PENDING | Demonstrate an actual eligible post-activation event and its persisted execution envelope. Current capture count is 0. |
| Purchase processing | PENDING | Demonstrate validated purchase persistence and replay behavior under unchanged admission rules. Current purchase count is 0; the 50 USD admission threshold and activation time must not change. |
| Token discovery and downstream processing | PENDING | Demonstrate token creation and traceable downstream processing from accepted facts. Current token count is 0. |
| Price, risk, qualification, and delivery | PENDING | Provide independent required fact/authority evidence and explicit delivery authorization. Database migration and runtime availability do not establish these capabilities. |

## Closeout decision

Database operation is established at the reported observation level; final database closeout is PENDING. Logical backup and restore execution are reported complete, but count/content verification and the remaining database gates must be evidenced before acceptance.

Radar closed-loop acceptance is PENDING. No successful live capture, purchase, or token-discovery loop is claimed. Stability c remains on hold for guard/budget/deadline approval and final tests.

Preserve all existing PostgreSQL data, SQLite originals, backups, releases, credentials, and audit artifacts. This document records acceptance requirements only and performs no production operation.
