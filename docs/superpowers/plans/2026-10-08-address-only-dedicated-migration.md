# Dedicated Address-only Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Retain confirmed addresses and their associated registry settings, switch future-only processing to PostgreSQL, and preserve recoverability without importing historical tokens or transactions.

**Architecture:** A dedicated privileged controller measures backup and SQLite write isolation, imports a fresh bounded registry in one PostgreSQL transaction, independently checks its immutable cohort and ledger, and publishes a protected startup manifest only after an acknowledged commit. The existing signed full-cutover protocol remains available but is not fabricated or relabeled as having passed. The new address-only startup branch has its own explicit protocol and real database checks.

**Tech Stack:** Python 3.12, TypeScript/Node 24, PostgreSQL 16, SQLite readonly snapshots, root-owned systemd deployment material.

## Invariants

- Only confirmed manual and high-confidence manually linked wallets, their linked accounts/entities, profiles and monitoring settings are retained.
- No old tokens, trades, prices, evidence, capability results or historical jobs are imported. Existing SQLite databases and backups remain untouched by cleanup.
- Gateway delivery, FOMO collection activation and full historical mining remain disabled. Existing FOMO login/browser processes are preserved.
- Root-owned expectations alone never replace an actual PostgreSQL commit, ledger, generation and immutable cohort check.
- Before the first import commit, failure restores the recorded source ownership/mode and old service state. After any new PostgreSQL business writes, rollback retains live PostgreSQL data and uses a compatible PostgreSQL release, never silently restarts SQLite writers.
- Missing provider budgets or source contracts mean waiting for configuration, not successful live monitoring acceptance.

## Task 1: Address-only committed startup verification

Files: `apps/automation/src/postgres-address-only-startup.ts` and its matching test.

- [ ] Implement an explicit `address-only-v1` manifest with operation/import/generation, schema/cluster/release identities, seed/backup/fence/cohort digests and measured counts.
- [ ] In one SQL snapshot, compare live cluster, generation clock, non-revoked address-only import ledger, the entire immutable cohort and required profile/channel/identity version heads; reject extra rows, changed payloads and wrong imports. Do not change isolation after the runtime has issued its initial queries.
- [ ] Bound rows and serialized bytes before driver materialization, enforce the original deadline, and compare independently measured backup/fence hashes and actual disabled switches; retain no eligibility grant.
- [ ] Run direct Vitest and automation TypeScript checks, then independent specification and quality review.

## Task 2: Native backup and write-isolation controller

Files: new `scripts/address-only-native-fence.py` and matching Python tests.

- [ ] Preflight all source parents, source DB/WAL/SHM metadata, active service/timer states, open handles, FOMO process identities and disk capacity before a stop.
- [ ] Retain an exclusive controller lock and fsync a root-only recovery journal before the first mutation. Disable legacy timer reactivation, stop timers before writers, and wait with one original deadline; do not stop protected FOMO login/browser services.
- [ ] Establish source write isolation and reject remaining writable descriptors/mappings before taking the server-local SQLite backup. Verify readonly WAL compatibility and reopen the backup for integrity verification; never accept a backup made before the verified source barrier.
- [ ] Persist measured source identities, original permissions, service/timer states, backup digests and each phase transition in the private recovery journal. Reconcile the actual import outcome after interruption; unresolved outcomes prohibit restarting SQLite writers. Pre-commit restoration has its own bounded recovery deadline and verifies restored services. Any unresolved writer or changed FOMO process refuses further progress.

## Task 3: Atomic reduced-scope import

Files: dedicated address-only transaction adapter and native production launcher; reuse `postgres-cohort-import.ts`.

- [ ] Capture a fresh six-table address registry under the measured fence, not the October 7 rehearsal seed.
- [ ] Create/verify the generation and import the genuine reviewed cohort in one dedicated migration UOW with explicit native role/cluster/schema authority and bounded SQL/time.
- [ ] Read back the entire cohort, compare its exact canonical digest and counts, and anchor the import in the existing import ledger before the same COMMIT.
- [ ] For an uncertain COMMIT, inspect the ledger/cohort under the same source lock; never blind-replay or restore SQLite writes while the outcome is unknown.

## Task 4: Root service startup integration

Files: `scripts/postgres-service-entry.ts` and its tests, release builder and deployment controller.

- [ ] Add a mutually exclusive address-only startup protocol branch while preserving the legacy v2 branch unchanged.
- [ ] Require the protected release/deployment seal and actual committed address-only verification before opening worker polls or the console.
- [ ] Use the same activation clock for future-only wallet cursors. Preserve explicit existing RPC/provider limits rather than inventing credentials or budgets.
- [ ] Install least-privilege service material, protect old SQLite paths against the new service identity, and prevent legacy timers/bridges from reopening writes.

## Task 5: Production acceptance and final receipt

- [ ] Verify independent source-to-target address/entity/settings parity without exporting wallet data from the server.
- [ ] Verify six service states/restarts, disabled delivery, console continuity, queue consumption and one real post-activation event when an authorized source supplies one.
- [ ] Distinguish database migration completion from source configuration readiness and real-event acceptance; an absence of real events is not fabricated success.
- [ ] Publish final phase, identities, counts, checksums, recovery route and outstanding external dependencies. Commit only reviewed files, never unrelated worktree changes.

## Validation commands

```bash
NODE=/Users/a77/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
PYTHON=/Users/a77/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
"$NODE" node_modules/vitest/vitest.mjs run
"$NODE" node_modules/typescript/bin/tsc -b apps/automation --pretty false
"$NODE" node_modules/typescript/bin/tsc -p scripts/tsconfig.postgres-services.json --pretty false
"$PYTHON" scripts/test/address-only-native-fence.test.py
```

Offline/mock tests never count as production fence, commit, parity or fresh-event evidence.
