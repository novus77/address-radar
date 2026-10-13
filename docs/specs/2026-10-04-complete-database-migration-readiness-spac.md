# Complete Database Migration Readiness SPAC and Implementation Plan

Status: comprehensive pre-migration review; production import and cutover are blocked.

Owner request: find the complete set of migration dependencies, repair them in dependency order, and migrate only after consolidated readiness acceptance. Do not treat another isolated index change as completion of database migration.

## S: Scope, safety boundaries, and success definition

The intended destination is PostgreSQL as the sole authoritative business writer. Existing PostgreSQL repositories and unit-of-work code are reusable components, not evidence that production has switched to PostgreSQL.

Three independent acceptance gates apply:

1. **Preservation:** all source tables and values are accounted for, with a coherent snapshot, lossless historical preservation, exact mapping, references, and resumable import receipts.
2. **Operational cutover:** every writer and input bridge is fenced, final changes are reconciled, PostgreSQL is provisioned and sized, runtime entrypoints are wired, and rollback after new writes is rehearsed.
3. **Business activation:** an explicitly scoped cohort and real events pass the confirmed rules, with truthful coverage, committed consumer receipts, risk checks, and delivery disabled.

Missing historical prices may prevent business activation of an old sample. They must not prevent lossless preservation of that sample. Unapproved archive deletion must block purge, not non-destructive import. These distinctions must also be reflected in executable readiness results, not just operator prose.

Until all applicable gates pass:

- Keep production SQLite authoritative; do not import into a production business database or change release/backend configuration.
- Do not restart services, reset cursors, cancel old work, merge identities, resume FOMO capture, or restart full historical mining.
- Keep `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` and retain economic/event consumption guards.
- Do not delete source history, snapshots, raw evidence, backups, or audit files.
- Development, fixture repairs, and isolated tests do not authorize production cutover.

## Confirmed business invariants

- Ability means repeated discovery of high-multiple opportunities; selling or realized profit is not required.
- A qualifying purchase is at least USD 50. USDT/USDC may use nominal USD for the amount filter, explicitly marked estimated; entry price still requires actual trade evidence.
- Each purchase has its own 30-day opportunity window. Stable ability requires three distinct 3x tokens or two distinct 5x tokens under the confirmed policy.
- Radar requires at least two independent eligible traders buying the same chain/token within 15 minutes, with qualifying amounts, deduplication, and risk/data-quality checks.
- Do not carry the old contribution-score or USD 10,000/20,000 trade gates into the new mainline.
- Token discovery starts at 100K market capitalization. Discovery lasts seven days from first discovery and extends only on a genuinely qualifying new purchase or higher milestone; refreshing the same observation does not extend it.
- Monitoring is not radar authorization. Explicit manual grants and system capability grants remain separate and auditable; tags do not grant eligibility.
- Preserve Solana address case and existing EVM canonicalization. Do not automatically merge owners.
- FOMO capture is deferred. Wallet-channel acceptance must not claim coverage of FOMO-only trades.
- Fifteen days is the raw hot-storage policy, not permission to delete 30-day purchase proof, normalized facts, revisions, deduplication records, or protected evidence.

## P: Verified production position

Fresh read-only evidence was collected on 2026-10-04 at 03:04:44Z, 03:06:22Z, and 03:08:37Z. The accompanying JSON receipt separates fresh observations from older acceptance evidence.

| Area | Fresh observation | Meaning |
| --- | --- | --- |
| Six business services | All active/running, `NRestarts=0`; six child processes hold SQLite DB/WAL handles | Production is still SQLite-backed; parent PID checks alone are insufficient |
| Delivery | All six main processes have exactly one delivery environment entry, set to false | No delivery activation was performed |
| Release | `/opt/address-radar/releases/4b48fc2-forward-token-code` | Local development and deployed code must be distinguished |
| Source DB | 3,846,512,640 bytes; WAL 49,530,672 bytes at capture | These are live sizes, not a final consistent migration snapshot |
| Disk | 41,588,031,488 bytes available at capture | Disk expansion is visible; usable migration headroom still needs a peak-space calculation |
| RAM/swap | 4,007,932 kB total RAM; 1,360,316 kB available; 2,097,148 kB swap with 100 kB free | Co-hosted import/index/PG load needs a resource budget and pressure acceptance; this does not prove an OOM event |
| Table inventory | All 141 source tables match the reviewed compact catalog; zero unknown/missing tables or compact structural differences | Classification is covered; exact DDL, rows, triggers, expressions, and target parity are not proven |
| PostgreSQL | PostgreSQL 16 acceptance cluster on port 5433; only `postgres` and `address_radar_acceptance_test`; acceptance DB has zero permanent application tables | Installed PostgreSQL and temporary round trips are not a production migration |
| PostgreSQL role | Only radar acceptance role observed, connection limit 8, not superuser | A production role/schema/connection budget is still needed |
| Other scheduled work | FOMO verification sync timer and backup timer exist | The cutover barrier must extend beyond the six service names |
| Source handle census | Six observed child-process holders | A point-in-time census is not a future writer fence |
| System cron scan | No matching entries in `/etc/crontab` and `/etc/cron.d` | User crontabs, external deployment agents, and future jobs remain unverified |
| Identity | 11,432 entities, 11,358 profiles; 216 account-wallet and 216 entity-wallet associations | The association tables describe overlapping data, not 432 wallets |
| Wallet flags | 216 realtime associations across 122 entities; 24 fail at least one profile enable flag; 22 belong to suspended entities | Do not silently activate the entire old realtime selection |
| Diagnostic enabled cohort | 192 associations across 108 entities, high/confirmed confidence, enabled profile flags, realtime policy, not suspended | Selection candidate, not cryptographic ownership or radar qualification |
| Canonical directory | Five chains; zero canonical tokens, markets, and market windows | Chain/contract/pool crosswalks are a real missing prerequisite for active projections |
| Coverage | All observed wallet coverage rows lack a valid start/end pair | `healthy` or `complete` labels do not prove interval coverage |
| BSC indexed route | 97 degraded partitions classified as HTTP 404 | Do not misdiagnose these as rate limiting or copy them as healthy coverage |
| Stored errors | Several persisted lock classifications remain | These are stored statuses, not proof of current repeated SQLite locking |
| Recent logs | Zero returned lines in a bounded 300-line/30-minute service query | Limited observation only; not an all-log absence guarantee |

### Existing maintenance backup and index

The preserved operation is `purchase-reverse-index-20261004-4c515f47`. Its backup is 3,837,816,832 bytes, mode 0600, with a recorded `quick_check=ok` and SHA-256 `d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7`. The previous verification took approximately 273 seconds. This recorded verification was not repeated during the new audit.

The operation remains `failed_requires_readonly_reconciliation`, reason `index_transaction_deadline_exceeded`. The reverse index is absent. The failed transaction rolled back; no index completion or migration completion may be reported.

The pending optimized index code replaces full Python row hashing under the writer lock with a scoped SQLite authorizer and connection change counter. Its guarantees are limited to approved index maintenance, not full migration row equivalence. Resume must reconcile source/backup identity, journal state, exact approved index definition, and the new script digest. Do not blindly rerun the old operation or overwrite its failed receipt. A SQLite VM deadline is cooperative; storage stalls and commit latency also require bounded outer execution and operator reconciliation.

### Proven implementation gaps

The wallet monitor CLI opens `openMonitoringRegistry` and `openWalletMonitorStore`. Wallet analysis opens SQLite history/market stores and the SQLite repository. The automation runtime and console application also open SQLite database/store implementations. PostgreSQL consumer modules exist alongside these entrypoints, but the current service processes do not expose the production PostgreSQL URL and actually hold SQLite handles.

`openMonitoringRegistry` performs SQLite migration on open and drains the registry outbox during reads. It is not a read-only migration exporter. Its acknowledgements also write state. A snapshot reader must use an explicitly read-only path without these side effects.

The reviewed proposed production driver/importer/cutover files are absent. Equivalent implementation must be verified by behavior, not by filename alone; the runtime and fresh target-catalog evidence already establish that production composition and production import are not complete.

The deployed `backup-production-state.sh` contains a WAL truncate checkpoint, main-file `cp`, and a manual chunk-copy fallback, without the SQLite online backup API. Concurrent writers can invalidate the checkpoint-plus-copy assumption. `quick_check` is not proof that all committed WAL data was included. The script also removes retained backup directories. Exclude it from the migration snapshot/rollback guarantee until repaired and rehearsed; do not execute it as a shortcut or delete its historical outputs.

The FOMO verification sync script copies request/result files and writes cursor/status files; it is not itself proven to write the business DB. Nevertheless, it changes the migration input boundary and belongs in the fence inventory. Do not confuse pausing capture with pausing all file bridges.

## A: Complete readiness matrix

Each gate needs an owner, artifact, automated test, and explicit status. `unknown` is not success. New gates discovered by testing are added to this matrix rather than creating unrelated mini-projects.

| ID | Gate and present state | Required correction / acceptance |
| --- | --- | --- |
| G01 | Inventory classification: compact metadata passes | Exact DDL inventory with grouped compound FKs, collation, partial/expression index predicates, defaults, triggers/views, and schema version; review any authorized index delta explicitly |
| G02 | Snapshot: one verified backup exists; restore and final boundary not proven | Read-only application restore rehearsal, immutable snapshot manifest, checksums, snapshot identity, safe online backup implementation; avoid copying the live main file |
| G03 | Source export: metadata and bounded dependency readers exist | Lossless 141-table historical accounting; paginated row export with deterministic identities; preserve NULL/INTEGER/REAL/TEXT/BLOB and large integers without JS rounding |
| G04 | Dependency proof: bounded/global-ledger tests are partial | Coherent row-level FK and semantic-JSON crosswalk; protected purchases, conflicts, dead letters, budget and delivery ledgers from compatible snapshots; explicitly report unresolvable historical references |
| G05 | Target production DB: absent | Dedicated business database/schema ledger and least-privilege migration/runtime/read roles; secret delivery without logging; no reuse of the acceptance role as a production shortcut |
| G06 | Production capacity: unaccepted; swap nearly full | Global six-service pool budget plus migration/operator/backup reserve; measured import peak RAM/disk/WAL/temp demand; pressure thresholds and maintenance window agreed as one package |
| G07 | Typed schema: reusable PG module DDL exists, permanent target absent | Versioned business schema and indexes; exact numeric/time/NULL/type/constraint adapters; sequences and collation reviewed; source floating-point uncertainty must not become claimed exactness |
| G08 | Full import/resume: not demonstrated | Chunk digests, durable import operation/row-map receipts, atomic chunk commit, restart reconciliation, duplicate/collision quarantine; no consumer activation while importing |
| G09 | Identity/cohort: current selection disagreement confirmed | Preserve all identity/history records; apply enabled flags and suspended state to active projection; retain conflicts and manual grants without automatic merge or inherited capability |
| G10 | Token/market crosswalk: empty canonical directory | Resolve chain plus contract, token/pool distinction, temporal market selection, real price provenance; symbol/name alone must never identify a token |
| G11 | Six-service production composition: SQLite | Wire existing async PG repositories/UOW into real entrypoints, routes and workers; validate startup backend/generation; never fall back silently to SQLite |
| G12 | Atomic consumers and fair work: tested in isolation, runtime unproven | Commit fact + demand + fanout + receipt atomically; lease owner/generation/input revision fencing; reserved quotas/fairness; explicit missing-data deferral with no false receipt |
| G13 | External input/coverage: provider gaps confirmed | BSC 404 compatibility/fallback diagnosis, canonical chain routing, stable event IDs, shared provider cooldown/budget, interval boundaries, reorg/late revision handling; chain-specific degradation rather than fake all-chain success |
| G14 | Incremental capture/final delta: absent rehearsal | Capture all changed facts, identity/config/grants/budgets/cursors/work since snapshot; prove no unjournaled gap; if capture is unavailable, take the final coherent snapshot behind a complete approved writer fence |
| G15 | Writer fence: census only | All six services, file sync, backup/checkpoint timers, operators, deployments, user cron, and external collectors; prevent stale workers from acquiring the old generation |
| G16 | Queue/cursor handoff: old work must not be replayed wholesale | Separate frozen old jobs from selected new-generation work; fresh leases and truthful checkpoints; replay only accepted input scope; preserve expired/cancelled/failed history |
| G17 | Delivery safety: preserved isolated tests, activation disabled | Import economic/event consumption guards and frozen old outbox decisions without reset; generation-aware idempotency; risk/authorization revalidation at readiness; no actual delivery |
| G18 | Rollback after new writes: not rehearsed | Durable mutation/input journal, replayable reverse delta or verified compatible PG-backed release; source return parity; commit-unknown reconciliation; no mere old SQLite symlink rollback |
| G19 | Retention: raw hot policy known, purge not approved | Read-only protection dry run for 15-day raw hot storage versus 30-day proof; dedup/source headers and unresolved raw protected; exclude backup/purge jobs during migration |
| G20 | Console: current SQLite reads | PG-backed trace and metrics; distinguish legacy totals, active generation, observation, data gaps, waiting for thresholds, and committed progress; bounded plans/pagination |
| G21 | Test evidence: current maintenance fixture repair pending | Targeted regressions, full suite and types, real isolated PG integrations, all-table import/restore/fault tests; skipped PG tests do not count as PG acceptance |
| G22 | End-to-end acceptance: not complete | Real selected wallet transaction through capture, normalization, purchase, price proof, opportunity, capability, aggregation, readiness; natural two-trader cases only, no fabricated qualifying signal |
| G23 | Cutover manifest and approval: not ready | One artifact containing passing gates, exact release/schema/generation, cohort, watermark, resource limits, writer set, window and rollback target; one formal authorization before production changes |

## Data routing: preservation is not activation

All 141 source tables remain preserved initially. The existing fourteen-family inventory is reused; no table is omitted because it is not active in the new strategy.

| Family | Tables | Destination intent |
| --- | --- | --- |
| Identity | 10 | Preserve all; reviewed active identity/cohort projection only |
| Identity audit | 8 | Immutable audit/conflicts; no automatic owner merge |
| Reference | 7 | Preserve old records; verified token/market crosswalk for active use |
| Market facts | 4 | Preserve history; activate only provenance/quality-validated relevant facts |
| Source facts | 10 | Preserve originals, normalization links, execution bases and revision history |
| Fact/conflict ledger | 8 | Preserve proof and conflict lineage; revalidate state, not old success labels |
| Legacy results | 20 | Queryable historical namespace; no new eligibility from old scores or aggregates |
| Work/receipts | 32 | Preserve full ledger; build only approved new-generation work |
| Wallet analysis | 9 | Preserve analyses; extract only individually proven transaction facts |
| Delivery safety | 6 | Preserve frozen decisions and consumption guards; delivery stays disabled |
| FOMO deferred | 4 | Preserve raw/session/gap history; no capture resumption |
| Protected errors | 1 | Preserve unresolved raw evidence and reasons |
| Provider budgets | 3 | Carry live usage/cooldowns across cutover; preserve expired history separately |
| Runtime | 19 | Preserve history; initialize fresh generation state with proved handoff |

Use a lossless staging/historical representation before typed active projections. Do not silently convert missing numbers to zero, NaN to a valid number, unknown launch time to a fabricated timestamp, or old aggregated entries to individual fills. Compound foreign keys and references inside JSON require explicit mapping. Every source table must have a destination route, imported/preserved count and digest, quarantine count, and retrieval test.

The existing compact CSV is a classification ledger, not executable PostgreSQL DDL. Existing temporary BYTEA preservation round trips are useful building blocks, not proof of a complete searchable production historical store.

## C: Dependency-ordered implementation and acceptance

### M0. Consolidate readiness and finish bounded maintenance tooling

Files/modules: this SPAC, the audit receipt, `apply-reviewed-purchase-reverse-index.py`, its existing tests and runbook.

- Repair Python SQLite exception compatibility in the fixture without weakening the authorization assertion.
- Run maintenance regressions and record their actual result. Maintain failed production receipts unchanged.
- Treat any production reverse-index resume as a separately reconciled maintenance action, not database migration.
- Acceptance: all index guards pass in fixtures; zero source business writes; complete readiness inventory exists.

### M1. Safe snapshot, export, and restoration foundation

Files/modules: backup scripts, `full-data-migration-preflight.ts`, `full-data-migration-manifest.ts`, `full-data-row-protection.ts`, new exact-catalog/export/restore modules and tests.

- Replace migration use of checkpoint/main-file copy with the SQLite online backup API or a fully fenced offline snapshot.
- Keep migration backups outside pruning rules; private file permissions, exclusive operation identity, bounded verification, fsync/digest receipts, no overwrite.
- Separate metadata classification, preservation parity, business proof, and purge gates in the executable report.
- Inventory exact schema and all non-DB inputs/configuration artifacts required for restoration.
- Export deterministic chunks from an immutable snapshot; support all source value types, compound identities and unresolved historical references.
- Rehearse restore and application reads without triggering schema migration, outbox draining or task execution.
- Acceptance: coherent restored snapshot, 141-table accounting, lossless value/type tests, corrupt/incomplete backup refusal, no source mutation.

### M2. Production PostgreSQL schema and resource-safe driver

Files/modules: reuse `postgres-unit-of-work.ts` and existing PG repositories; add the production driver/schema ledger/role provisioning separately from the acceptance driver.

- Explicit backend identity and startup checks; no automatic fallback or automatic production DDL in service reads.
- Derive a global connection and memory budget from the six-service composition and measured host pressure; do not copy the two-connection acceptance pool or the 512 MiB acceptance cgroup blindly.
- Define typed active tables and lossless legacy staging/history, migration-role privileges and restricted runtime/read paths.
- Guarantee awaited async transactions; prohibit adapting asynchronous PG calls inside synchronous SQLite transaction callbacks.
- Acceptance: least-privilege real PG integration, crash/abort/commit-unknown tests, type/constraint parity, bounded query plans and pressure tests on a non-production target.

### M3. Complete resumable import and crosswalks

Files/modules: manifest/row protection, existing preservation and global-guard round-trip components, new importer and chunk/row-map receipts.

- Import preservation data before projections. Maintain snapshot, operation, schema and generation provenance.
- Validate grouped FK/semantic references, ID uniqueness/collisions, exact values, source representation and historical retrieval.
- Map identities and token/market contracts; quarantine conflicts without blocking unrelated valid records or discarding history.
- Carry live provider/delivery guards without reset. Do not assign old policy results to new capability.
- Acceptance: every table accounted for, idempotent chunk retries, forced partial-write rollback, interruption/resume, counts/digests and reference parity.

### M4. Production wiring and active scope correction

Files/modules: scanner CLI, automation CLI/runtime, wallet monitor CLI/store/registry, wallet analysis CLI/history/performance, historical-backfill entrypoint, console CLI/application/server.

- Resolve the actual historical-backfill launch path from deployed units before modifying it; do not assume a separate application directory exists.
- Compose existing PG capture, normalization, consumer work, token watch, purchase, opportunity, capability, authorization, signal and trace modules into the real service paths.
- Honor profile enable flags and suspended state. Monitoring eligibility and radar authorization remain separate.
- Persist facts/intents/receipts in one transaction, fence leases/generations/revisions and enforce cross-job fairness.
- Keep FOMO paused and old full historical mining disabled; current-event proof lookup only within the accepted scope.
- Acceptance: six entrypoints exercise PG in isolation, no unintended SQLite handles/writes, no duplicate provider requests or inherited old jobs.

### M5. Provider accuracy and realistic wallet-channel rehearsal

Files/modules: RPC/indexed collectors, execution normalization, token/market crosswalk, shared provider budget, forward consumers and trace.

- Diagnose BSC 404 by route/API compatibility, not guessed cooldowns; prove indexed or RPC fallback scope and finality.
- Populate verified chain/contract and temporal price/pool mappings; enforce quote-estimation versus actual entry-price distinction.
- Record covered intervals, stale checkpoints, gap/reorg/late-revision handling. Status strings alone are insufficient.
- Use one isolated collector/input journal and fan out replay to avoid doubling source budgets.
- Follow a real eligible wallet event through every consumer. A naturally incomplete sample remains deferred; waiting for two traders or a future 30-day outcome is not a migration defect.
- Acceptance: source provenance and consumer commit receipts; no fake prices, no fake qualification, no actual radar delivery.

### M6. Final delta, comprehensive fence, and rollback rehearsal

Files/modules: new writer inventory/barrier, migration coordinator, mutation/input journal, cursor/work handoff, deployment integration and rollback runbook.

- Identify all writer/input entrypoints including sync/backup timers, operator tools, deployments, user cron and collectors; annotate file-only versus DB-writing paths.
- Demonstrate incremental coverage for every mutable family. If a complete delta is unavailable, use a final fenced coherent snapshot rather than pretending timestamp filters capture deletes or same-time updates.
- Preserve original source time and cutover watermark separately. Replay continuity must not grant eligibility to an unapproved historical sample.
- Quiesce old leases, fence new generation admission, reconcile final data/config/authorization/budgets/consumption, and prove old workers cannot resume writes.
- Rehearse rollback before and after new PG writes, with reverse-journal parity or a proven PG-compatible rollback release.
- Acceptance: crash-point matrix, no lost/doubled event, no stale lease receipt, no repeated consumed signal, no unauthorized replay or writer.

### M7. One consolidated production go/no-go

Prepare one approval package, not successive requests for individual tables:

- Exact target database/schema/roles, production release, source/target manifests and generation.
- Measured global resource budget, peak disk/WAL/temp demand and abort limits.
- Active cohort, input watermark and scope; unresolved historical/FOMO data explicitly inactive.
- Writer set, downtime window, final-delta procedure and rollback target/journal retention.
- Passing targeted/full/type/real PG tests, preservation/import/restore and end-to-end receipts.
- Retention remains non-destructive; delivery remains false.

Production import, backend/release switching, writer stops/restarts and final migration are withheld until this complete package is authorized. Routine fixture repairs and development do not need separate business-rule decisions.

### M8. Post-cutover completion acceptance

- Confirm all affected services use the intended backend and generation; inventory residual SQLite handles and external input bridges.
- Observe backlog age, committed receipts, provider interval lag, fair execution, conflict/deferred reasons, host pressure, connection usage and disk/WAL growth for the agreed acceptance window.
- Verify a real wallet trace and normalized value parity. Readiness may legitimately be empty if no natural two-trader event exists; report that as an acceptance limitation, not fabricate success.
- Test historical retrieval, config/authorization revocation, restart recovery and rollback readiness.
- Preserve frozen source and verified backups; retention deletion and signal delivery require separate explicit authorization.

## Failure and fallback matrix

| Failure | Safe behavior |
| --- | --- |
| New source table or exact DDL drift | Stop import planning; classify/map it; no silent skip or blanket drift waiver |
| Bad/null/ambiguous old data | Lossless quarantine with explicit reason; valid unrelated data continues; no invented proof |
| Backup deadline or corruption | Keep failed operation evidence; reconcile private partial artifact; do not copy live DB as fallback |
| Snapshot/delta gap | Keep SQLite authoritative; redo final coherent snapshot behind an approved complete fence |
| PG pressure/space limit | Stop isolated import/acceptance safely; preserve chunks and receipts; no business service restart or data deletion |
| Duplicate economic event or import retry | Reconcile stable keys/chunk receipt; do not double samples, intents or consumption |
| Stale lease or superseded revision | Reject commit/receipt; rebuild current demand through fenced work |
| Provider unavailable or 404 | Mark the actual provider/chain scope degraded; use validated configured fallback only; preserve gaps |
| FOMO login missing | Leave capture paused; wallet/market scope remains independent; no account rotation or new-page loops |
| PG commit outcome unknown | Query idempotent operation receipt before replay; do not blindly retry a potentially committed write |
| Rollback after new writes | Reconcile/replay durable mutations or retain verified PG-compatible rollback release; never silently lose post-cutover facts |
| No natural qualifying signal | Report waiting for business conditions, separately from missing data/consumer failure |

## Consolidated decisions and defaults

No new core scoring rule is introduced by this plan. Preserve all old data by default, keep it out of new qualification unless individual facts pass the confirmed policy, and do not change the old 216 realtime selection silently in production.

The final approval package must resolve together: measured production resource limits and target placement; the exact active cohort/watermark; writer-fence downtime; rollback/journal retention. Archival deletion location/age is a separate future decision and does not block preservation-only migration.

## Evidence and reuse

- `docs/specs/2026-10-02-postgresql-migration-and-retention-design.md`
- `docs/specs/2026-10-03-wallet-channel-migration-preflight-and-rollback-plan.md`
- `docs/specs/2026-10-03-full-data-migration-and-retention-classification.md`
- `docs/operations/2026-10-03-legacy-data-disposition-inventory.csv`
- `docs/operations/postgres-global-guard-round-trip-acceptance.md`
- `docs/operations/legacy-purchase-production-preflight-acceptance.md`
- `docs/operations/postgres-acceptance-instance.md`
- `docs/operations/purchase-reverse-index-maintenance-recovery-acceptance.json`
- `docs/operations/2026-10-04-database-migration-readiness-audit.json`

The fresh audit does not rerun all historical queries or integrations, and cannot establish that no undiscovered defect exists. It establishes a consolidated, fail-closed work boundary: repair and accept the complete chain before formal migration, with no claim that service health, a backup, an index, or a temporary PG round trip alone constitutes completion.
