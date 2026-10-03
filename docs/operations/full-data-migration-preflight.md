# Full-data migration classification preflight

## Scope and safety boundary

This stage turns the reviewed 141-table production inventory into a deterministic
classification and preservation proposal. It does not implement a business
PostgreSQL importer, row-level evidence selection, activation, archive or purge.

All source data stays in its original database and existing backups. A successful
classification exit is not production migration approval or end-to-end acceptance.
The report always contains productionMigrationReady=false.

The baseline was captured read-only at 2026-10-03T11:59:10.791Z. The proposal
preserves original field names, source types, nullability and primary-key positions.
It does not turn SQLite REAL values into newly precise NUMERIC facts.

## Local or isolated usage

Run against an existing local fixture or an already-authorized consistent copy:

~~~bash
pnpm exec tsx scripts/full-data-migration-preflight.ts --database /path/to/source.sqlite
~~~

The command emits JSON to stdout. It has no output-file, apply, migrate, delete,
resume or cutover mode. The source is opened with SQLite readOnly and query_only.
It does not call the legacy monitoring registry, source migrations or consumers.

Exit codes: 0 means the structural classification matches the reviewed baseline;
1 means classification or dependencies require review; 2 means input or catalog
reading failed. The tool never infers that an unmeasured table is empty.

No production run is part of this implementation stage. Reading a live WAL database
may use SQLite shared-memory coordination; byte-for-byte immutability is tested
only against a closed isolated fixture, not claimed for a concurrently running source.

## Report interpretation

- Unknown, missing or duplicate tables block classification.
- Column, foreign-key edge and index-shape drift blocks classification.
- The DDL fingerprint identifies the inspected source, but the baseline does not
  establish CHECK constraints, partial-index predicates, collations, defaults,
  triggers, composite foreign-key grouping or target SQL compatibility.
- Protected tables include audit/conflict history, delivery deduplication and
  external budget guards, plus transitive foreign-key and conservative semantic
  dependencies of supplied preservation obligations.
- The CLI provides mandatory safety roots only. Caller-supplied unfinished purchase
  obligations are available through the manifest function, not discovered by SQL.
- This is table dependency review, not row-level evidence closure. Source-event
  identities, actual entry basis, full 30-day windows, unresolved revisions,
  foreign-key ancestors and minimum replayable proof excerpts need separate
  bounded row-level validation before any subset import or retention execution.
- Legacy capability, admission, queue completion and signal receipts remain legacy
  preservation data. They do not satisfy a new generation or grant radar eligibility.
- Historical token headers do not restart mining or establish a new 100K trigger.
- FOMO remains paused; outbox review remains frozen; gateway delivery remains off.
- No provider budget or cooldown is reset.

## Remaining migration gates

The manifest explicitly lists approvals, business driver/schema/roles/capacity,
coherent backup and single-writer boundary, row-level proof dependency validation,
target DDL mapping, identity/manual authorization review, generation provenance,
real purchase acceptance, post-cutover write journal/replayable rollback and archive
policy. Do not remove these gates simply because classification or unit tests pass.

Formal business database creation, production import and service cutover still need
separate user confirmation. The existing restricted acceptance database is not a
business migration destination.

## Tests

~~~bash
pnpm exec vitest run packages/database/test/full-data-migration-manifest.test.ts
pnpm --filter @address-radar/database typecheck
~~~

Tests cover all reviewed classifications, conservative dependency closure, legacy
isolation, drift detection, invalid protection obligations, stable fingerprints and
a real isolated SQLite fixture. They do not claim a real purchase has traversed the
new production pipeline.

