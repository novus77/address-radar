# SQLite Write Stability and Migration Boundary SPAC

## Status

Approved. Implement Scheme A now and preserve a unified write contract for Scheme B.

## Context

Production monitoring exposed four related failures: concurrent service startup can contend while every process runs migrations; historical candidate jobs calculate retries from stale event timestamps; candidate evidence replay reports unchanged rows as new output; and the operations API reports a draining queue as non-converging whenever backlog remains.

The current single-host SQLite deployment remains appropriate, but write semantics must be explicit before increasing throughput.

## Decision

Use SQLite with WAL as the production store. Business workers write through an `AddressRadarWritePort` boundary. The first implementation is in-process and synchronous. A future single-writer service or PostgreSQL adapter must implement the same domain methods and result semantics.

Identity ownership is immutable for an existing evidence identifier. Conflicts are rejected and must be reviewed; the system never merges trader identities automatically.

## Requirements

1. Candidate evidence writes return `inserted`, `updated`, or `unchanged`.
2. Replaying identical evidence does not modify the row and does not increment produced output.
3. Mutable evidence facts may update in place; trader and token ownership may not change.
4. Candidate event jobs use a business-state idempotency key. Collection timestamps alone cannot create another job.
5. Source retries are based on processing time and remain in the future for historical events.
6. Queue convergence is based on completion/admission flow, not on backlog being empty.
7. Candidate progress time reflects processing time, not historical evidence time.
8. Production startup must eventually use one migration barrier before worker services start.
9. Gateway delivery remains disabled throughout rollout and acceptance.

## Unified Write Contract

`AddressRadarWritePort` owns serializable domain write methods. It must not expose SQLite statements or transactions to callers. Scheme A delegates to local stores. Scheme B may proxy these commands to a dedicated writer without changing workers.

The initial method is `saveCandidateEvidence`. Additional write paths move behind the port incrementally, prioritizing high-contention tables.

## Migration Barrier

Add a dedicated migration unit that acquires the database write lease, runs schema migration once, records the schema version, and exits. Runtime services declare `After=` and `Requires=` on that unit. Runtime startup opens the migrated database and must not perform structural migration.

This step is additive and must be deployed separately from semantic write changes so rollback remains safe.

## Observability

Expose write outcomes, retry counts, lock wait duration, queue flow delta, oldest runnable age, and migration version. Backlog and convergence are independent dimensions: a queue can have backlog and still be converging.

## Acceptance

- Identical evidence replay produces zero new facts.
- A changed evidence fact updates once.
- Conflicting identity ownership fails deterministically.
- Historical blocked jobs retry from current processing time.
- Collection-only event changes do not create duplicate candidate jobs.
- Queue flow is marked converging when completions exceed admissions.
- Cold boot starts all workers without migration lock exits.
- A two-hour shadow run has no unbounded queue growth, SQLite lock loop, or disk exhaustion.

## Rollback

The schema remains backward compatible. Revert workers to direct local stores if the port adapter fails. Do not delete evidence or rewrite identity ownership. Keep Gateway delivery disabled until acceptance completes.
