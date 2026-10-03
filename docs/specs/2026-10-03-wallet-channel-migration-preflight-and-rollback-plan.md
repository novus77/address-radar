# Wallet Channel Migration Preflight and Rollback Plan

Date: 2026-10-03

Status: Planning and read-only preflight. Formal migration and runtime cutover require separate approval.

## 1. Goal and non-goals

Validate the existing address channel before moving identity and monitoring state to the PostgreSQL forward-opportunity mainline. Establish a reversible path for real wallet purchases through capture, normalization, opportunity tracking, capability assessment, aggregation, and signal readiness.

The first acceptance path is:

```text
Existing address registry
  -> explicit chain routes and wallet ownership
  -> real wallet transaction capture
  -> durable source evidence and economic-event deduplication
  -> verified purchase and execution basis
  -> 30-day opportunity sample
  -> opportunity and capability results
  -> eligible independent-trader aggregation
  -> signal readiness
  -> read-only trace and acceptance report
```

FOMO collection and its bridge are deferred, not deleted or automatically resumed. Wallet-only coverage cannot observe FOMO-only activity that has no observable wallet transaction.

This phase does not create business PostgreSQL databases, roles, or permanent tables; export production datasets; import or rewrite business data; switch releases; restart services; or deliver signals. No old token batch mining or wholesale historical trade migration is proposed. Existing SQLite business data and backups remain intact.

## 2. Evidence and current state

### 2.1 Verified production observations

The initial sanitized runtime observation was collected at `2026-10-03T11:34:57.234Z`. The approved corrected census was captured at `2026-10-03T11:43:28.308Z`; provider, coverage, execution-sample, and gateway checks at `2026-10-03T11:46:10.650Z`; BSC error details at `2026-10-03T11:48:28.460Z`; service control-group inventory at `2026-10-03T11:50:07.759Z`. These observations are not an atomic cross-service snapshot.

| Item | Observed state | Interpretation |
| --- | --- | --- |
| Active business release | `/opt/address-radar/releases/4b48fc2-forward-token-code` | New isolated acceptance artifacts are not the active business release. |
| Six business services | Scanner, automation, wallet monitor, wallet analysis, historical backfill, and console are `active`; each has `NRestarts=0` | Process health only. Does not establish event coverage or end-to-end progress. |
| Wallet monitor database | `/var/lib/address-radar/address-radar.db` | The running wallet channel still uses SQLite. |
| SQLite files | Main file `3,713,552,384` bytes; WAL `38,971,112`; SHM `98,304` at the corrected census | Approximately 3.75 GB observed footprint. Online-backup size, PostgreSQL indexes, event journal, and growth margin still require capacity planning. |
| Root filesystem | `92,487,929,856` total bytes; `47,197,114,368` available bytes at the later disk observation | Current space is not the earlier low-disk blocker. Space alone is not migration approval. |
| Gateway process environments | All six business service MainPID environments report `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` | Preserve this invariant; check effective worker configuration again before activation. |
| Wallet interval | `5000` ms | Existing configuration, not an approved new runtime budget. |
| RPC configuration | Primary and fallback configured for `solana`, `eth`, `bsc`, `base`, and `robinhood` | Presence is not a successful RPC or transaction-coverage test. `eth` is the configured key; absence of an `ethereum` alias is not itself a defect. |
| Indexed routes | Configured for `eth`, `bsc`, and `base`; not configured for Solana or Robinhood | Evaluate chain-specific coverage, not a single EVM-family success flag. |
| Indexed lookback | No explicit runtime override was observed | Reviewed source defaults to 60 days. The new channel needs an approved activation watermark rather than inheriting a bulk-history replay. Deployed config, CLI, and registry compiled artifacts match the locally inspected artifacts; this is not a whole-runtime parity assertion. |
| Business PG configuration | `ADDRESS_RADAR_POSTGRES_URL` absent in the wallet process | This named URL is not wired into the current wallet entry point; this observation does not exhaust every possible environment variable. |
| PostgreSQL service | `postgresql@16-radaracceptance.service` active, `NRestarts=0` | The installed cluster is an acceptance environment, not completed business migration. |
| PostgreSQL catalog | Non-template databases observed: `postgres`, `address_radar_acceptance_test`; no permanent non-system tables in the acceptance database | No formal Address Radar PostgreSQL business database/schema was present at that inspection. |

The local reviewed implementation is commit `b44fcd20464d91fac7c8385a9ded203c90a0aaaf`. Its isolated PostgreSQL acceptance results must not be described as migrated production wallet data.

### 2.2 Corrected bounded identity census

The initial temporary diagnostic script failed while emitting its output. Following explicit approval, the output error was corrected and the bounded read-only census succeeded. No production write was performed. Registry counts were collected in one SQLite read transaction; the actual legacy-to-forward snapshot reader opened separately captured read-only snapshots. This is sufficient for planning, not a frozen cutover export.

| Metric | Observed value | Interpretation |
| --- | --- | --- |
| Trader entities / profiles | 11,432 / 11,358 | A trader entity is not necessarily a monitored wallet or an eligible radar identity. |
| Entity lifecycle | 306 candidate; 122 probation; 11,004 suspended | Do not turn legacy lifecycle labels into new radar qualification. |
| Monitoring policy | 122 realtime; 26 periodic; 11,284 lightweight | These are entity counts, not wallet counts. |
| Account-linked wallet rows | 216 | Legacy `wallet_identities` representation. |
| Direct entity-wallet rows | 216 | Legacy `entity_wallet_identities` representation. |
| Canonical wallet subjects / deduplicated associations | 216 / 216 | The two 216-row registries represent the same deduplicated cohort; do not report 432 independent addresses. |
| Wallet families | 119 Solana; 97 EVM | EVM family membership does not prove coverage on every EVM chain. |
| Entities with wallets | 122 | One trader can have multiple wallets. |
| New snapshot trust helper | 216 trusted; 0 untrusted, missing, or read-error snapshots | Registry-level trust under the existing contract; proof scope remains `legacy_registry_linkage`, not independent cryptographic ownership. |
| Association confidence | 215 high; 1 confirmed | Preserve original confidence and evidence scope. |
| Enabled, trusted, non-suspended wallet snapshots | 192 wallets across 108 entities | Candidate monitoring cohort only; not a new capability result or radar grant. |
| Wallet associations selected by realtime policy | 216 | Legacy selection includes more addresses than the new snapshot monitoring condition. |
| Profile-versus-realtime discrepancies | 24 wallet associations | Retain and review disabled/suspended intent; do not silently enable them during import. |
| Suspended wallet associations | 22 | Included within the 24 non-enabled monitoring candidates; counts are not additive. |
| Canonical multi-owner subjects / invalid owner counts | 0 / 0 | No conflict found in this bounded current cohort. Recheck the final export and delta. |
| `wallet_identity_conflicts` rows | 0 | No pending, accepted, or rejected rows in this specific conflict table. This is not a claim about every conflict table. |
| Checked orphan entity-wallet/account bindings; unlinked account wallets | 0 | The inspected links resolved; this is not a complete database-wide foreign-key audit. |
| Wallet entities without a profile | 0 | The 74 missing profiles in the global entity census are not in this wallet cohort. |
| Normalization changes / normalization exceptions | 0 / 0 | No canonicalization change was needed; this does not independently validate ownership or every address format. |
| Monitor checkpoints / partition-status rows / execution-basis rows | 322 / 424 / 14,160 | Historical metadata counts, not recent qualifying purchase throughput. |
| SQLite migration audit entries | 1 | Previous import audit exists despite `user_version=0`. |

### 2.3 Provider and interval coverage findings

Current Solana, ETH, BSC, Base, and Robinhood RPC provider states were healthy with updates 3-15 seconds before the provider observation. Indexed ETH and Base also had recent healthy provider state. BSC indexed state was actively degraded.

| Finding | Evidence | Migration implication |
| --- | --- | --- |
| BSC indexed requests fail | 97 wallet partitions report `Blockscout wallet request failed with status 404`; 97 BSC indexed coverage rows are blocked | Investigate endpoint/path/API compatibility and resource support. A shared route mismatch is a hypothesis, not yet a verified root cause. Do not describe these errors as proven rate limiting, or fabricate missing trades. |
| BSC RPC still progresses | `evm:bsc` healthy with 97 healthy coverage rows and a fresh checkpoint | The entire BSC channel is not stopped. Current RPC progress does not establish historical/indexed coverage. |
| Persisted lock-error status | One additional BSC indexed partition records `database is locked` | This persisted state alone does not establish ongoing or repeated SQLite contention. Distinguish its timestamp from current 404 failures. |
| Stale healthy label | `evm:monad` provider healthy label last updated about 639,373 seconds before inspection | A healthy label without freshness is not current coverage. Confirm routing/scope before importing this historical state. |
| Unassigned coverage | 1,012 `reconciliation_unassigned` pending rows: 194 each for ETH/BSC/Base/Robinhood, 236 for Solana | These are provider/identity coverage records, not 1,012 distinct wallets. Reconcile identity-key representation and current scope; do not blindly copy these pending rows as new jobs. |
| Missing interval proof | All 1,810 inspected coverage rows lack a pair of recorded coverage start/end boundaries | No full historical interval can be proved from this ledger alone. |
| Complete labels without bounds | Indexed ETH: 24 complete, 73 running; indexed Base: 94 complete, 3 running; none have a full recorded interval pair | Complete is a provider status, not proof of the new sample window or historical completeness. |

The partition table also contains older degraded rows alongside current healthy source state. Import/reporting must preserve timestamps and scope; it must not count every historical degraded row as a current source outage.

### 2.4 Real-data sample limitations

The 20 most recently updated execution-basis rows were selected from the 14,160-row basis table, then joined to observations by the indexed `(source, event_id)` key. No unrestricted scan of the large observation table was used.

- All 20 sampled observations were Solana records; none had a missing observation or a recorded orphan flag.
- 18 bases reported `swap_not_confirmed`; one reported `unsupported_quote_valuation`; one carried `nominal_stablecoin_usd` estimated execution basis.
- Zero sampled rows satisfied the tested buy-side, at-least-50-USD, positive-price/quantity, non-orphan execution-basis condition.
- These observations do not prove that all recent trades fail or that the whole address channel has no qualifying buys. Transfers and non-swaps may legitimately be ineligible.
- No real qualifying purchase was accepted as an end-to-end migration sample in this inspection. Controlled cohort sampling and actual source/ownership/risk evidence remain required.

### 2.5 Database access and compiled artifact parity

All six business service control groups contained a Node worker with live SQLite main/WAL/SHM handles. Service MainPID-only inspection had shown no handles because the actual workers were child processes. No inspected database handle was marked deleted.

| Service | Observed SQLite worker PID |
| --- | --- |
| Scanner | 2625868 |
| Automation | 2625904 |
| Wallet monitor | 2625878 |
| Wallet analysis | 2625869 |
| Historical backfill | 2625903 |
| Console | 2625898 |

PIDs are transient diagnostic facts, not identifiers to reuse for future stop/restart operations. Open descriptors prove access, not which table each process writes or that there are no external/short-lived writers. The approved cutover needs a table-level writer inventory and coordinated barriers, not merely a wallet-monitor stop.

The backup service was inactive; the existing migration-barrier service was `active/exited`; FOMO verification sync was inactive. Their future schedules and activation behavior remain part of cutover planning. No service was started, stopped, or signaled.

Three deployed compiled files match their local counterparts:

```text
monitoring-registry.js  3e828185d874b9af2e2fd63fcf5351a0c4d05030f35d05e78c953eae8e9d0100
config.js              264bc9b9c721a1a6c1b1e018f4a27be064285462d3bba2f47749aff39a228b56
cli.js                 322bdc68962311c0cadc02ced177d0aa0505c8dfcaf833024963d654751c8d18
```

This verifies those compiled artifacts only. It does not prove the live command uses that build rather than a source entry point, or certify all runtime dependencies.

The bounded address census is complete. Formal migration/cutover remains a no-go until state mapping, source/cohort acceptance, capacity, production schema/runtime tooling, writer barriers, and journal-backed rollback gates are satisfied. No completion time is inferred from service uptime.

## 3. Verified architecture boundaries and risks

### 3.1 Registry access is not a read-only export API

Reviewed `packages/identity/src/monitoring-registry.ts` opens the business database, invokes SQLite migration, drains resolved-wallet automation work during registry reads, and writes consumer acknowledgments. Do not call `openMonitoringRegistry()` from a read-only preflight or exporter.

Use an explicitly read-only SQLite connection and the read-only snapshot contract. For a final export, use a fixed backup snapshot rather than the live registry API.

### 3.2 Legacy monitoring and new eligibility are different contracts

The reviewed legacy wallet selection is based on `realtime` policy. Its account path chooses an owner by confidence and recency, and its direct-wallet fallback excludes addresses already present in account wallets. That SQL does not independently enforce profile monitoring flags, suspended lifecycle, or the new-mainline ownership trust contract.

This is a verified code-contract discrepancy with a measured 24-association realtime-versus-snapshot mismatch. The inspected deployed compiled registry matches the local compiled artifact. Actual execution entry-point parity still needs confirmation before changing production behavior; this preflight did not disable or repair any current target.

Migration must reconcile lifecycle, monitoring flags, policy, ownership ambiguity, and provenance. It must not reproduce the old owner tie-breaker as an identity merge rule.

### 3.3 Identity storage does not prove ownership or chain coverage

Observed SQLite schemas contain:

| Source | Existing constraint | Migration treatment |
| --- | --- | --- |
| `wallet_identities` | Primary key: account, family, address; address lookup index | Account association needs its entity link and ownership provenance. |
| `entity_wallet_identities` | Entity/family/address primary key and raw family/address unique constraint | Raw uniqueness does not prove canonical uniqueness or cross-table uniqueness. |
| `wallet_identity_conflicts` | Pending, accepted, rejected conflict status with audit payload | Unresolved conflicts cannot become an owned target. |
| `trader_profiles` | Separate monitoring, on-chain monitoring, FOMO monitoring flags | Preserve intent and disabled states. |
| `trader_monitoring_policy` | Realtime, periodic, lightweight, off | Map explicitly; do not convert every registered address to realtime. |
| `wallet_monitor_observations` | Source/event primary key, chain and family, execution/reorg metadata | Useful for source sampling; not sufficient proof of economic deduplication or an eligible purchase. |
| `wallet_monitor_execution_bases` | Source/event relation to observations | Preserve evidence references and actual execution basis. |
| `migration_audit` | SQLite import checksum and counts | `PRAGMA user_version=0` does not mean no previous migration occurred. |

Use `canonicalForwardTargetChannelFact`, `forwardTargetSubjectKey`, `normalizeWalletAddress`, and `forwardTargetIdentityTrusted` rather than new ad hoc trust logic. Preserve Solana case. Canonicalize EVM addresses using the existing contract and detect resulting collisions.

`createLegacyForwardTargetSnapshotReader()` reports `proofScope=legacy_registry_linkage`. A registry-linkage reference must not be upgraded to independently verified cryptographic ownership. Keep that proof scope visible through import, refresh, capture, and trace.

### 3.4 Production runtime composition is still missing

Reviewed `apps/wallet-monitor/src/cli.ts` opens the SQLite registry and store. Its runtime writes observations, checkpoints, diagnostics, provider state, and coverage. Adding PostgreSQL tables alone will not route real wallet events into the forward pipeline.

The acceptance driver is test-database restricted. Do not remove that restriction or reuse acceptance credentials for business writes. A separate production driver, restricted business roles, schema ledger, and runtime wiring are required.

### 3.5 Checkpoints cannot be transplanted blindly

Existing checkpoint identity is `(source, partition_key)`, not simply wallet address. Raw observations currently have no inspected time index beyond their source/event primary key. Avoid unrestricted recent-period scans or full joins on this multi-gigabyte database.

Use bounded source/event lookups, metadata-guided query plans, and a dedicated snapshot for expensive reconciliation. Distinguish extraction time from event time and successful polling from complete trade history. A timeout invalidates a census; it does not establish zero missing rows.

## 4. Business invariants

These are previously confirmed rules, not new migration decisions:

- Ability means repeated discovery of high-multiple opportunities; selling or realizing profit is not required.
- A qualifying purchase is at least 50 USD with real entry/execution evidence. USDT/USDC nominal USD is explicitly estimated, not presented as independently verified fiat value.
- A captured purchase is tracked for 30 days. Missing data is deferred rather than counted as failure.
- Stable opportunity capability requires three distinct valid 3x tokens or two distinct valid 5x tokens in the confirmed window.
- New radar readiness requires at least two independent eligible traders for the same chain/token in 15 minutes and the confirmed purchase threshold, plus source, deduplication, and risk checks.
- Old contribution scores and old large-order thresholds are not new-mainline gates.
- Default manual addition grants monitoring, not radar eligibility. Explicit manual radar authorization is separate and audited. Notes, priority, old lifecycle, or old scores do not grant it.
- New token discovery starts at 100K with the confirmed rolling discovery window. Do not re-enable old full-batch history mining.
- Raw-data retention is 15 days, but derived 30-day samples and the evidence/audit required to prove them must survive. Migration does not authorize deleting old data or backups.
- Identity conflicts are quarantined; identities are not automatically merged or reassigned.
- FOMO stays deferred. Gateway delivery stays disabled.

## 5. Migration scope and classifications

### 5.1 Import scope

Import stable trader identifiers, canonical wallet subjects, identity associations, original provenance and proof scope, lifecycle/monitoring intent, and explicit chain coverage/configuration references. Retain immutable source references and timestamps.

Existing FOMO linkage may remain an audit reference for a wallet identity. It is not activation of the FOMO channel. FOMO-only traders without wallets are outside this phase's tested coverage and must remain visible as such.

Do not import old automation leases, old completion flags, inferred authorizations, or wholesale historical trade/token data. Existing opportunity scores are contextual legacy data, not new-generation verified capability. New economic samples start from an approved activation boundary; any narrowly required gap recovery needs an explicit bounded interval and its own audit.

### 5.2 Mandatory classification

Each identity must be classified as importable monitoring target, retained disabled target, evidence-limited target, quarantined conflict, orphan/invalid reference, or out-of-scope FOMO-only target.

Classification is exhaustive and mutually exclusive for each exported record. Separate raw record counts from canonical subjects and entity counts. Preserve all excluded/quarantined records in the migration manifest; never silently drop them.

Address normalization is not full address validity, ownership, or chain availability validation. Report these independently. Profile-policy disagreements require an explicit mapping decision; do not invent precedence and enable a trader silently.

## 6. Proposed implementation files

The following are planned changes, not files implemented by this preflight:

| File/module | Responsibility |
| --- | --- |
| `packages/database/src/wallet-channel-migration-preflight.ts` | Read-only census, bounded queries, canonical conflicts, classification report. |
| `packages/database/src/wallet-channel-migration-manifest.ts` | Stable manifest schema, source cutoff, checksums, provenance, counts, mapping version, quarantine records. |
| `packages/database/src/wallet-channel-migration-import.ts` | Idempotent generation-scoped target import using existing authorization/identity stores; migration receipts. |
| `packages/database/src/postgres-business-driver.ts` | Separate restricted production transaction runtime; preserve acceptance-driver fences. |
| `packages/database/src/postgres-business-migrations.ts` | Ordered additive schema installation and checksum ledger using existing module schemas. |
| `apps/wallet-monitor/src/forward-channel-adapter.ts` | Real wallet event-to-forward-capture adapter with evidence, chain routes, reorg handling, and economic keys. |
| `apps/wallet-monitor/src/cli.ts` | Explicit runtime mode and production composition after separate activation approval. |
| `packages/identity/src/monitoring-registry.ts` | Preserve old path; introduce an explicitly side-effect-free forward registry contract instead of reusing writable reads. |
| `scripts/wallet-channel-migration.ts` | Explicit preflight/export/import/report modes; no implicit migration at service startup. |
| `docs/operations/wallet-channel-cutover-and-rollback.md` | Approved operational commands, roles, barriers, event journal, and rollback reconciliation. |

Tests are planned as `packages/database/src/wallet-channel-migration-preflight.test.ts`, `wallet-channel-migration-import.test.ts`, `postgres-business-migrations.test.ts`, and `apps/wallet-monitor/src/forward-channel-adapter.test.ts`. Exact runner wiring and existing monorepo gates must be resolved before execution; this document does not claim these files or commands already exist.

## 7. Dependency-ordered implementation and gates

### Phase A: Finish read-only preflight

1. Completed: correct the approved temporary census output and emit sanitized timestamped results. Association budget was 5,000; process deadlines were bounded; registry counts used one read transaction.
2. Completed for the current registry cohort: measure trust, ownership ambiguity, profile-policy disagreements, canonical collisions, and checked orphan links. Independent ownership-proof validation and final mutually exclusive import classifications remain open.
3. Completed for the inspected scope: compare deployed/local compiled registry, config, and CLI hashes and check six MainPID gateway environments. Live source/build entry-point and effective worker configuration must be verified before activation.
4. Completed: inspect provider/coverage schemas and read bounded state and execution samples. Resolve BSC 404 behavior, stale/unassigned coverage, interval proof, and selection of genuine qualifying purchases before claiming real-source acceptance.
5. Completed access inventory: all six service control groups contain SQLite workers. Finish table-level writer ownership, external writers, scheduled backups, and the existing migration barrier's behavior before proposing service operations.
6. Completed current main/WAL/SHM sizing. Backup restore, staging/index/journal capacity, retention behavior, and forward growth remain pre-migration gates; do not scan all production history to infer them.

Exit: emitted census, explicit unknowns, no unbounded queries, no data changes. Unresolved critical classification or writer ownership prevents migration.

### Phase B: Develop migration tooling and rollback foundations

1. Implement manifest versioning and import classifications with existing canonicalization/trust contracts.
2. Implement separate business PG driver and a schema ledger. Resolve foreign-key dependency order from the actual schema exports for strategy generation, capture/normalization, targets/authorization, refresh/coordinator, purchases, opportunity, capability, aggregation, readiness, and trace.
3. Restrict importer/runtime/read-only roles independently. Never log a connection URL or credential.
4. Require explicit approved configuration for connection budgets, query/lock limits, batch size, lease duration, refresh cadence, activation watermark, and event-journal retention.
5. Implement migration receipts containing manifest checksum, mapping version, generation, counts, quarantines, and transaction boundary.
6. Import retries must detect same-manifest success and reject conflicting payloads. Commit-uncertain retries must reconcile durable receipts first.
7. Establish immutable event-journal/replay capability before any write cutover. Without that capability, rollback after new writes is not safe and activation is a no-go.

Exit: targeted tests, full tests, type/build/boundary gates, and isolated database acceptance pass. Synthetic tests are not real-source acceptance.

### Phase C: Back up and import after migration approval

1. Obtain approval for formal business DB/roles/schema creation, a bounded identity import, backup operation, and its storage locations. This is not permission to cut over services.
2. Produce a consistent SQLite online backup with the SQLite backup API. Do not copy a live main file while ignoring WAL; do not checkpoint or vacuum production as part of preflight.
3. Restore the backup into an isolated validation location and validate integrity and the exported subset there. Capture cutoff, checksum, source schema fingerprint, and provenance.
4. Include backup, scratch restore, PG tables/indexes, import manifest, WAL, event journal, and growth margin in capacity planning. Stop when the measured requirement exceeds available space or the approved safety reserve.
5. Create the separately approved business schema, import the fixed manifest transactionally in bounded batches, and retain SQLite unchanged.
6. Compare entity/subject/category counts, per-record fingerprints, disable states, conflicts, and ownership proof scopes. Counts alone do not prove equivalence.

Exit: every manifest record reconciled; zero unexplained losses, duplicate canonical owners, or inferred radar grants; backup restore proven.

### Phase D: Shadow wallet validation

1. Compose real wallet capture with the forward inbox and typed execution evidence. Preserve chain, transaction hash/signature, event/instruction discriminator, event time, observation time, quote basis, and source/ownership references.
2. Use a bounded approved wallet/chain cohort. Prefer one collector with durable fan-out over two independently polling collectors that consume duplicate provider budgets.
3. Keep the old business path authoritative. The forward generation is shadow-only; no user-facing delivery and no new FOMO polling.
4. Persist raw evidence before acknowledging ingestion; persist consumer receipts before advancing checkpoints. Crash/replay and multi-source duplicates must produce one economic event, not one event per representation.
5. Reorgs, source conflicts, missing entry price, and unsupported routes defer or invalidate dependent results rather than confirming a receipt with guessed data.
6. Run real transaction-to-trace acceptance. A quiet wallet is not a failing collector, but it also does not provide a positive end-to-end acceptance sample.

Exit: traceable real purchases, verified ingest/checkpoint ordering, no source-conflict false hits, and no duplicate economic consumption. Do not fabricate a qualifying two-trader signal to force completion.

### Phase E: Approve and execute write ownership cutover

1. Present the latest import reconciliation, shadow evidence, backup restore result, writer inventory, remaining gaps, and explicit rollback decision before requesting cutover approval.
2. Establish a barrier for the relevant identity/configuration and wallet event writers. Drain or fence only the approved dependencies; do not stop unrelated services casually.
3. Export and reconcile the bounded delta after the snapshot cutoff. An identity change during export must be retained or detected, never overwritten silently.
4. Switch exactly one authoritative writer/consumer generation with explicit leases. Do not copy old leases or reset cursors to replay all history.
5. Verify current identity versions, authorizations, refresh receipts, coverage, and actual event journal before releasing the barrier.
6. Preserve the previous release/configuration and SQLite backup. Keep gateway delivery disabled. Radar transport activation is separate from wallet cutover.

Exit: single writer ownership, no unexplained missing events or duplicate deliveries, bounded queue age, accurate trace, and the approved observation window passed.

## 8. Rollback decision matrix

| Failure point | Safe action | Data treatment |
| --- | --- | --- |
| Preflight/tooling | Stop diagnostics; retain current services | No migration to reverse. |
| Schema/import before forward live writes | Fence new importer/runtime and continue the unchanged SQLite business path | Keep additive PG schema, manifest, audit, and quarantine for investigation; do not DROP or delete backups. |
| Shadow validation | Disable the shadow worker through the approved operation; keep old writer authoritative | Retain shadow event journal and receipts; no old-path cursor reset. |
| Cutover before any new PG-only write | Restore the previously approved configuration/release and old writer ownership after fencing the new one | Prove the cutover watermark and absence of PG-only writes before claiming lossless rollback. |
| Cutover after PG-only writes | Fence new writes, preserve the journal, reconcile/replay the approved delta using stable economic keys, then return writer ownership | A simple SQLite connection-string switch is unsafe. Preserve new data and receipts; replay must reject duplicates and retain new identities/configuration decisions. |
| Missing or incomplete journal after new writes | Stop write cutover progression; retain PG data and provide read-only fallback if feasible | No claim of lossless rollback. Request a reconciliation decision rather than discarding new records. |

Rollback requires a recorded `cutover_id`, generation, source/export cutoff, last durable event/checkpoint per source partition, new-write watermark, old/new lease ownership, config/release fingerprints, manifest checksum, and operator approval.

Before reopening the old writer, prove: the new worker is fenced; every committed event after the barrier is reconciled; receipts and purchases remain idempotent; manually changed authorization/monitoring state is preserved; no event is delivered twice; gateway is still false. Prefer additive forward repair when already-written data makes an old release incompatible.

## 9. Test and acceptance matrix

| Case | Required result |
| --- | --- |
| EVM case variants; Solana case-sensitive subjects | Canonicalization follows the existing contract without merging unrelated subjects. |
| Same canonical wallet linked to multiple entities/accounts | Quarantine with owner/provenance evidence, not last-observed owner selection. |
| Missing entity/account/provenance; pending conflict | Retained audit and explicit deferred/quarantined state, no fabricated trust. |
| Disabled/suspended/profile-policy mismatch | No implicit activation; mismatch is resolved by approved policy mapping. |
| Old ability tag, priority, or lifecycle | Does not create manual radar permission or new-generation capability. |
| Repeated import, concurrent import, commit-uncertain response | One stable import receipt; conflict detected; no duplicate authorization or target head. |
| Identity updated while exporting/importing | Snapshot plus bounded delta reconciles it or blocks cutover. |
| Business schema retry/version drift | Existing checksum matches; mismatched migrations stop; acceptance DB fences remain intact. |
| Source reconnect, checkpoint crash, multi-provider representations | Durable ingestion precedes acknowledgment; exactly one economic purchase. |
| Wallet reorg or source/risk conflict | Dependent opportunity/readiness defers or invalidates with traceable reason. |
| Stablecoin nominal amount | Estimated flag survives capture, purchase, trace, and downstream filtering. |
| Buy missing real execution price | Deferred; no hit, no confirmed successful consumer receipt by assumption. |
| Inactive wallet versus blocked provider or missing route | Distinct states, accurate coverage; no false all-chains-complete flag. |
| Raw data expires at day 15; sample still within day 30 | Required derived facts and evidence remain reproducible; no blind expiry of opportunity proof. |
| Two eligible independent traders, qualifying purchases, same token within 15 minutes | New policy readiness can pass with real risk/source evidence; legacy large-order rules do not leak in. |
| One trader represented by multiple wallets or sources | Not two independent traders; ownership ambiguity blocks eligibility. |
| Rollback before/after new writes | New writer fenced; journal reconciled; no lost event, duplicated purchase, or implicit permission. |
| FOMO unavailable | Wallet and market paths remain independent; FOMO coverage explicitly absent. |

## 10. Operational acceptance report

Each report must separate:

1. Imported entities, canonical addresses, association records, retained disabled targets, and quarantines.
2. Chain routes configured versus verified, successful and blocked partitions, checkpoint age, and coverage gaps.
3. Real captured buys, normalized purchases, valid execution bases, source deduplication, and missing-data reasons.
4. Opportunity observations/hits/deferred states, distinct-token capability, manual authorization, and current eligibility.
5. Aggregation/readiness receipts, pending/cancelled signals, and gateway disabled status. Pending is not delivered.
6. Queue oldest age, progress watermarks, durable refresh cursors, lease ownership, and actual processing rates.
7. SQLite/PG lock errors, query timeouts, service restarts, disk/WAL/journal growth, and rollback readiness.

Use explicit denominators and time windows. Do not infer completion from an active service, an empty queue, or a fixture passing. No reliable observed processing rate means no credible remaining-time estimate.

## 11. Decisions and authorization still required

- Review the completed bounded census and approve the final manifest scope. The 192 enabled/trusted/non-suspended wallets across 108 entities are monitoring candidates, not automatic radar grants; retain the other 24 associations without silently enabling them.
- Confirm the mapping for legacy `periodic`/`lightweight` targets and profile-policy disagreements. No silent enablement or automatic promotion to radar participation.
- Approve business database/role names, connection/query/provider budgets, migration batch size, lease/cadence, activation watermark, backup/export destinations, observation period, and event-journal capacity/retention.
- Explicitly approve formal backup, schema creation, and identity migration before Phase C.
- Separately approve writer barriers, release/configuration cutover, and service operations before Phase E.
- Independently approve any later signal delivery or FOMO activation; neither is included here.

The current deliverable is a preflight-and-rollback plan with a completed bounded identity census, measured provider/coverage blockers, and an observed multi-service SQLite access boundary. Production migration, backup restore, writer cutover, and a real qualifying-purchase closed loop have not been performed. No production data, release, configuration, service state, or signal delivery was changed.
