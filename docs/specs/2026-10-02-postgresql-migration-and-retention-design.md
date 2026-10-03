# Address Radar PostgreSQL Migration and Retention Design

**Status:** Design only. No installation, production migration, purge, collector resume or cutover performed.
**Date:** 2026-10-02
**Parent:** `2026-10-02-forward-opportunity-radar-spac.md`
**Implementation owner:** P1-P6 in `2026-10-02-forward-opportunity-radar-development-plan.md`.

## 1. Approved scope

PostgreSQL becomes the target single authoritative business database. Browser Live Feed runs on the authorized server browser and writes through a durable inbox. Third-party FOMO API and device bridging are excluded. Raw payload hot retention is 15 days, with explicit protection for unfinished processing and 30-day sample evidence. Existing data and policy versions are preserved. Permanent deletion and archive location remain unapproved.

ClickHouse and other infrastructure are not added in this phase. A database transition is not evidence that source coverage or policy migration has passed acceptance.

## 2. Read-only baseline

Measurements below were collected at approximately 2026-10-02T15:05Z. Bytes are reported in decimal units unless stated otherwise.

| Measurement | Observed result | Interpretation |
|---|---|---|
| SQLite main file | 3,480,055,808 bytes | Size alone does not prove overload. |
| WAL | 29,206,712 bytes | A point-in-time value, not growth rate. |
| Root filesystem available | 50,658,754,560 bytes | No current full-disk condition in this snapshot. |
| Memory total / available | 4,104,122,368 / 1,397,583,872 bytes | Migration coexistence must be resource-budgeted. |
| Swap used / total | 2,146,471,936 / 2,147,479,552 bytes | Short interval samples showed no ongoing swap-in/out; occupancy alone is not thrashing proof. |
| Six business services | Active, NRestarts=0 | Not proof of business closure. |
| FOMO durable inbox | 0 rows; 0 received in the preceding hour | The intended real page-to-inbox route is still unverified. Other sources/stores are not inferred empty. |
| Job outcomes in preceding hour | produced=1160, deferred=560, no_output=118 | Attempt outcomes, not distinct trades or successful final consumers. |
| Market snapshot rows in preceding hour | 28 | Not a coverage or transaction count. |
| Global market observation interval query | Interrupted at 2 seconds | A bounded diagnostic timeout; exact count unavailable. |
| Gateway environment | false in Scanner and Console main processes | Delivery remains disabled. |

Daily growth, peak message volume, individual table byte distribution, production PostgreSQL footprint and acceptable cutover pause are not yet measured. Do not extrapolate them from this snapshot.

## 3. Verified persistence constraints and risks

### 3.1 Synchronous SQLite contracts

`packages/database/src/migrations.ts` accepts `DatabaseSync` from `node:sqlite`, uses positional prepared statements, SQLite PRAGMAs and a synchronous write transaction wrapper. `scripts/migrate-database.ts` invokes this migration directly against a local path. The connection layer uses BEGIN IMMEDIATE and WAL/busy-timeout settings.

PostgreSQL requires explicit asynchronous repository and unit-of-work contracts. Audit all transitive callers before changing signatures. A callback that returns a Promise to a synchronous wrapper must not commit before awaited work completes. Database initialization must not execute legacy migration/backfill behavior on a console read or ordinary service startup.

### 3.2 Snapshot safety

`scripts/backup-production-state.sh` performs a WAL checkpoint and then copies the main database file, with a fallback that reads file chunks. Its inspected path does not explicitly hold writers paused for the duration of the copy. A checkpoint alone does not establish that a later file copy is a consistent database snapshot. A quick integrity check is not a substitute for snapshot coherence.

Treat this as a migration backup design blocker, not as a demonstrated corruption incident. Do not invoke the current path as the migration's consistency guarantee without proving external fencing. Select a SQLite-supported consistent snapshot/backup method, or an explicitly approved write drain held until the snapshot completes. Preserve WAL correctness and record a restorable checkpoint. Backup rotation/deletion is a separate authorization boundary.

### 3.3 Query access mismatch

The observed market indexes are keyed for token/time access, while a global recent-time count timed out. This supports investigating an access-pattern mismatch, not declaring every query slow. PostgreSQL does not remove the need for compatible indexes and bounded progress summaries.

## 4. Initial table mapping

The mapping uses tables observed in production or explicitly referenced by inspected migration code. It is a design proposal; complete column/FK/index mapping is required before executable DDL.

| Existing population | Target treatment | Protected invariant |
|---|---|---|
| fomo_live_inbox / revisions | Source identity ledger, raw inbox payload and parser/normalization revisions | One event identity across reception dates; preserve raw revision provenance. |
| fomo_live_capture_sessions / gaps | Session state and explicit uncovered intervals | Session health cannot imply event coverage. |
| fomo_accounts / trader_entities / wallet mappings | Typed identity/association repositories | Stable IDs, source trust, Solana case and conflict history. |
| wallet_monitor_observations / execution_bases | Normalized source trades with versioned execution basis | Actual buys versus transfers; no guessed entry price. |
| market_observations | Shared token/source/time price observations | Keep source/time/identity and required sample intervals. |
| token_market_snapshots | Typed quote fields with bounded source payload | FDV is not substituted for market cap; avoid duplicate payload copying. |
| canonical_markets / canonical_market_windows | Canonical market relations and validity ranges | Chain/pool identity and historical source choice. |
| candidate_evidence_v2 / v3 / execution_audits | Preserve legacy evidence and versions; map forward evidence separately | No automatic relabeling or promotion under the new policy. |
| candidate_admission_snapshots | Strategy-versioned admission snapshots | Candidate admission, stable capability and manual grant stay separate. |
| automation_jobs / blocks / outcomes | Lease-fenced queue, blockage and immutable attempt outcomes | Semantic idempotency, lane fairness and retained audit. |
| candidate_evaluation_requests / triggers | Revision requests and deduplicated triggers | Requested/processed revisions do not regress. |
| source_fact_revision_receipts / consumer_history_wakeup_receipts | Fact and dispatch receipts | Producer receipt is not consumer success. |
| signal_projection_execution_receipts | Consumer execution revision receipts | Result tied to correct evidence and execution fingerprints. |
| signal_outbox / evidence consumption | Transactional outbox and economic consumption ledger | Replay does not duplicate broadcasting; delivery needs a receipt. |
| Legacy history populations | Preserved, strategy-tagged and held after controlled forward activation | Migration does not reactivate old batch discovery. |

Do not partition every business table. Candidate raw partitioning is by UTC received date. Identity, queue head, authorization and idempotency ledgers should remain usable independently of raw partition expiry.

## 5. Repository and atomicity design

| Transaction | Atomic write set |
|---|---|
| Receive | Source identity check, raw revision insert and durable receipt |
| Normalize | Parsed normalized revision, processing state and downstream work intent |
| Match | Ownership/execution match, economic identity and affected-consumer intent |
| Evaluate | Sample/evidence revision, eligibility result and work revision |
| Claim | Bounded indexed eligible job selection, lease owner, expiry and fence token |
| Complete | Fence-validated outcome, satisfied input revision and next durable intent |
| Signal | Economic consumption, signal version, outbox and projection result |

Use parameterized SQL and explicit asynchronous transaction context; do not pass the global pool inside transaction callbacks. Retried transactions have bounded attempts and externally idempotent behavior. SKIP LOCKED is a claim primitive, not a fairness or exactly-once guarantee.

PostgreSQL partition uniqueness must account for partition keys. Maintain a partition-independent source event ledger and economic ID mapping. A replay received on day 16 must not duplicate day 1's processed event after day 1's raw partition leaves hot storage. Keep uncertain matches distinguishable from proven shared economic events.

Map UTC epoch timestamps to an explicit consistent target representation. Preserve null/missing values, decimal precision, numeric units and Boolean meaning; converting every SQLite REAL to an arbitrary fixed-scale value is not approved. Preserve raw source representations where needed for lossless numeric interpretation.

## 6. Reads and indexes

Proposed access paths, subject to actual query and isolated workload inspection:

- Source event lookup by stable source/event identity; pending inbox lookup by processing state and reception order.
- Trader purchase lookup by owner and occurrence interval, with chain/token keys for evidence fan-out.
- Token observations by canonical token, source and market time; raw hot partitions by reception time.
- Due queue lookup by status, next eligibility and priority with bounded lease selection and deterministic ordering.
- Evidence/admission lookup by trader, strategy version and evaluation time; outbox by delivery state and next attempt.
- Global operations counters maintained from committed changes with a recovery reconciliation path and a stated measured-at timestamp.

Evaluate a time-leading or BRIN index for large append-only time-range reads; do not mandate one without distribution/query evidence. Avoid indexing every JSON field or treating JSONB as the primary business key store. Use keyset pagination and server timeouts, not unbounded OFFSET/full-payload lists. Historical audit reads use bounded intervals and can tolerate a separate archive access path.

## 7. Retention lifecycle

Raw lifecycle: received -> durably committed -> parsed/dispositioned -> required evidence preserved -> 15-day hot eligibility -> approved archive/removal operation.

Protected cases include pending parsing, unresolved ownership needed for recovery, disputed/revised execution, active samples without sufficient source evidence, unfinished consumers and recorded review holds. Show exclusion reason and retained bytes/age so protection does not become invisible unlimited retention.

Before raw expiry, store sufficient execution/source evidence, not only a hash. Required fields include source event identity and schema/parser revision, occurrence/reception times, identity association basis, trade side, canonical token/chain, original amount and unit, amount quality, execution identifiers and entry derivation basis. Price peaks retain their own source/time/quality support. Define a minimally sufficient excerpt per source shape in fixture tests rather than copying all payloads indefinitely.

Do not remove partition metadata or identities that are referenced by normalized events. Fifteen-day raw retention does not delete normalized trades, shared required market intervals, 30-day active samples, evidence versions or authorization history. Final archived-data deletion, audit duration and archive destination remain decision gates.

## 8. Migration protocol

1. Complete source schema/caller inventory and approve deployment resources, snapshot method and allowable capture pause.
2. Build the PostgreSQL schema and asynchronous repository adapters in an isolated environment; test transaction parity before production installation.
3. Take a consistent source snapshot, preserve source files and restore evidence, and copy in bounded restart-safe batches with durable migration checkpoints.
4. Compare per-table counts, identity/foreign-key integrity, event fingerprints, null/numeric/time semantics and representative business outcomes. Use cohort-aware parity, not only total counts.
5. Rehearse stopping claims and fencing late results, draining the final source write interval, and replaying retained captures without duplicates.
6. Under explicit production approval, switch one authoritative write destination. Do not improvise dual writes. Keep Gateway disabled and legacy mining held as configured.
7. Verify a real FOMO browser buy through raw receipt, normalization, matching and consumer result. No event yet means awaiting verification, not acceptance by empty inbox.
8. Exercise retention eligibility in dry-run before executing any archive/deletion maintenance.

Rollback before target-only writes can resume a verified consistent source. Rollback after target-only writes requires a verified reverse delta or a compatible PostgreSQL-backed application release. Repointing to the old SQLite file would discard target-only facts and is prohibited as an untested rollback.

## 9. Acceptance and implementation gates

Required isolated tests: cross-day replay, duplicate raw revisions, crash before/after commit, lease expiry/fencing, concurrent evaluation, distinct fills under a single position, transaction rollback, 15-day eligibility, protected 30-day evidence, and recovery after a raw payload moves out of hot storage.

Required real evidence: resource measurements, backup restore, mapping/parity report, single-writer switch checkpoint, real capture/consumer trace and bounded console reads. Record actual latencies without promising unspecified capacity. Full quality gates follow the parent plan; no tests or migration ran for this design-only update.

Outstanding decisions: source cadence/budget, maximum concurrent tracking, numeric price-quality and coverage thresholds, connection/resource sizing, residual signal score gates, archive/deletion policy, downtime allowance and production activation.

## 10. Verified schema differences and forward storage model

Additional local inspection: `packages/database/src/schema.ts` defines trader_token_samples with UNIQUE(entity_id, chain, token_address). This is a trader/token aggregate, not one purchase window. The forward requirement is one 30-day window per economic purchase; retain the legacy table for compatibility and do not reinterpret it as the new purchase store.

`packages/database/src/write-port.ts` currently exposes only synchronous candidate evidence persistence. `automation-job-store.ts` exposes synchronous enqueue, claim, checkpoint and completion methods and nests enqueue from a bounded admission transaction. These interfaces need explicit asynchronous ownership; a narrow existing write port cannot stand in for the full capture-to-consumer contract. The inspected lease check validates owner/status, so the target design must additionally define expiry and generation fencing rather than assuming old owner strings are sufficient.

### Target logical tables and keys

Names are proposed target contracts, not installed schema. Equivalent existing stores should be adapted rather than duplicated.

| Logical table | Primary identity | Required fields and relationships | Access/retention |
|---|---|---|---|
| source_event_identity | source_namespace + source_event_id | first_received_at, current_revision, stable ownership reference when known; processing/transport receipts reference this identity | Unpartitioned; survives raw expiry and cross-day replay. Missing source IDs use an explicitly audited fallback key. |
| source_event_revisions | source identity + semantic content fingerprint | immutable scrubbed normalized source fields, occurrence time/quality, parser/provenance revision, required evidence excerpt | Preserve dependent evidence; distinguish business revisions from reception timestamp changes. |
| raw_capture_payloads | received_date + payload_id | source identity/revision, collector/session, received_at, payload encoding/text, content hash, retention disposition | Candidate daily UTC partitions; no protected business FK cascades into these partitions. |
| normalization_state | source identity + parser_version + source_revision | status, retry eligibility, result revision, failure reason, last attempt | Indexed pending/retry state; duplicate delivery cannot duplicate work. |
| forward_purchase_samples | sample_id; unique forward_generation + economic_trade_id | owner_id, token_id, occurred_at, expires_at, amount/entry bases, execution_revision, coverage state | Owner/time, token/time and due-expiry access; one actual buy, not trader/token aggregate. |
| forward_opportunity_evidence | sample_id + evidence_revision | peak observation reference, post-entry timestamp, multiplier, quality revision/status, source facts | Preserve revisions; monotonic observed tier is not immunity to a later invalid execution correction. |
| forward_capability_snapshots | trader_id + policy_version + input_revision + as_of | cohort bounds, distinct 3x/5x counts, stable result, coverage diagnostics, known_at | Rolling cohort query; different buys of one token contribute one distinct token. |
| target_authorizations | authorization_id | target, monitoring state, explicit radar grant/revocation, actor, basis, effective interval | Latest effective state plus immutable audit; no grant from an ordinary tag. |
| work_heads / work_attempts | job_id / job_id + attempt identity | origin/generation, semantic idempotency, subject, due time, lane/type, lease owner/generation/expiry, typed outcome | Partial due indexes and per-type quotas; immutable results separate from mutable queue heads. |
| consumer_receipts | consumer + subject + policy/input revision | result key/status, committed_at, dependencies, reason for deferred or no-output | Only the committed matching revision can confirm consumption. |
| signal_outbox / consumption ledger | signal version / economic consumption identity | immutable payload/reference, delivery status, retry due, claim generation and receipt | Preserve existing external signal IDs and freshness; no restart delivery enablement. |
| progress_interval_summaries | metric + cohort/source + interval | committed deltas, reconciliation checkpoint, measured_at, semantic units | Bounded console reads; exclude raw bytes and mixed units. |

Stable FOMO ID, trader entity ID and wallet ownership are distinct identities. Unresolved owner references can exist in source storage without falsely creating a trader. Forward samples require attributable ownership and a real buy. Legacy event IDs remain preserved through explicit mapping; they are not all rewritten into a new generation or converted into forward samples.

### Field representation

- Store epoch-millisecond application clocks as BIGINT for explicit migration parity. Provide UTC conversion at API/report boundaries and derive partition dates from received_at. Reject unsafe numeric conversion in TypeScript.
- Use BOOLEAN for approved flags and constrained text for states. Keep missing values NULL, not zero or an invented default.
- Use unconstrained NUMERIC where exact source decimal amounts/prices must be retained; preserve the original numeric representation. Legacy REAL values remain identifiable as legacy approximation and cannot gain precision merely by conversion.
- Store queryable source attributes as typed columns. Use JSONB only for bounded structured context; use scrubbed raw text/bytes where JSON reserialization would lose source numeric representation. JSON parse success is not execution validation.
- Use token_id for canonical chain/contract references, with Solana case preserved. A wallet chain-family association is not a claim that all EVM chains were monitored.
- Keep policy version, forward generation and semantic revision explicit. No imported lifecycle label directly becomes stable capability under the newly approved policy.

## 11. Asynchronous repository boundaries

Design contracts below are illustrative and are not implemented exports. Each repository is bound to the active transaction context. No caller receives an unrestricted SQL connection.

```typescript
export interface RadarUnitOfWork {
  run<T>(operation: (transaction: RadarTransaction) => Promise<T>): Promise<T>;
}

export interface RadarTransaction {
  readonly capture: CaptureRepository;
  readonly trades: TradeRepository;
  readonly work: WorkRepository;
  readonly receipts: ReceiptRepository;
}

export interface CaptureRepository {
  accept(input: CaptureEnvelope): Promise<CaptureCommit>;
}

export interface TradeRepository {
  applyRevision(input: NormalizedTradeRevision): Promise<TradeCommit>;
}

export interface WorkRepository {
  request(input: SemanticWorkIntent): Promise<WorkRequestResult>;
  claim(input: ClaimRequest): Promise<LeasedWork | null>;
}

export interface ReceiptRepository {
  record(input: ConsumerResult): Promise<void>;
}
```

Define the referenced input/result types from the inspected domain contracts during implementation. A source transport acknowledgement is emitted only after run resolves from a successful database commit. WebSocket observation, HTTP response transmission and provider RPC calls must not hold open a database transaction.

Repository compositions use the caller's transaction. Nested repository calls do not start independent transactions or obtain unrelated pool clients; if savepoints are needed, they are explicit and tested. A transaction retry must not repeat external effects, and the acknowledgement must not precede the successful final attempt.

### Atomic normalization flow

1. Receive and commit immutable source revision plus receipt; no inferred ownership or price is necessary for this durable raw step.
2. Claim parsing work with a fenced lease, parse outside the write transaction, and validate input version.
3. In one transaction, apply the normalized revision, advance parser state and request durable matching/sample work for that revision.
4. Commit before acknowledging parsing completion. If input was revised during parsing, do not mark the new revision consumed by the old result.
5. Match economic trades and attach execution/ownership basis in a separate bounded transaction; request affected consumers once per semantic revision.

Do not replace these transactions with uncoordinated writes to raw storage, queue and projections. The currently missing real Live Feed trace remains an acceptance gate independent of whether this API exists.

### Fenced work completion

Claims carry job ID, lease owner, monotonically increasing claim generation, expiry and input revision. Checkpoint/complete/retry updates must conditionally match the active claim and policy. A stale worker cannot complete another worker's generation or overwrite a newer input result. Define authorized renewal explicitly; do not accept indefinite ownership after expiry. Persist attempt outcome and next work intent in the same completion transaction.

Preserve per-type fairness and bounded admission. Counting active jobs and then inserting from multiple workers is not sufficient to enforce a global cap; serialize the corresponding quota reservation with a dedicated state row or another tested transactional mechanism. SKIP LOCKED applies to eligible row claims and does not itself reserve every lane or guarantee admission fairness.

## 12. Implementation-ready slices and acceptance

1. PostgreSQL unit-of-work and isolated integration harness: rollback, pool ownership, nested composition, timeout and retry behavior. No production driver switch.
2. Source identity/raw inbox repositories: same-day/cross-day duplication, business revision, reception-only changes, commit-before-acknowledgement and unresolved identity.
3. Work/receipt repositories: atomic semantic enqueue, capacity reservation, concurrent claims, expiry fencing and obsolete revision handling.
4. Normalized trades/per-buy sample storage: distinct buys of one token remain separate windows; same economic buy from FOMO/onchain becomes one sample; trader/token success counts remain distinct-token counts.
5. Evidence/authorization/outbox integration: approved predicates, no age dependency, revoked eligibility, real risk gates, late replay and delivery-disabled behavior.
6. Progress summaries/retention references: recoverable delta accounting, bounded reads, cross-partition replay and protected evidence after raw movement.

Each slice requires targeted PostgreSQL tests followed by the parent quality gates when implementation is authorized. Schema creation, tests and new interfaces are not claimed complete by this design. Runtime packages/driver choice, test database setup, production resources and cutover pause still need an implementation proposal based on actual dependency inventory.
