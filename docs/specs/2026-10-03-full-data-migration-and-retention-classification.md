# Whole-System Data Migration and Retention Classification

Date: 2026-10-03

Status: Read-only analysis and proposed migration scope. No production migration, purge, backup/export operation, service restart, release cutover, or collector resume was performed.

## 1. Decision summary

Do not migrate only traders and wallets. Do not bulk-copy every legacy table into the active forward pipeline either.

Use four layers:

1. Active reference and control layer: approved identities, token/chain/market references, policy versions, explicit authorization, delivery guards, and external budget obligations.
2. Reusable fact layer: validated real executions, source revisions, required price/market intervals, milestones, ownership provenance, and conflict/reorg evidence for the approved live cohort.
3. Legacy read-only layer: preserved historical tokens, trades, old samples, outcomes, scores, admission decisions, task attempts, consumer receipts, and broadcasts under their original policy/version.
4. Fresh runtime layer: new generation-specific tracking windows, verified per-buy samples, new capability/aggregation/readiness calculations, leases, and health/progress state.

Every inspected source table is preserved initially. A disposition of "not imported into active runtime" is not authorization to delete it. PostgreSQL is the target authoritative writer for new business data; a frozen SQLite history/snapshot is not a second active writer. A later read-only PostgreSQL history namespace is optional and separately resource-budgeted.

## 2. Inspection scope and limits

- The production SQLite catalog contains **141 non-system tables**. All 141 have one proposed disposition in the accompanying inventory.
- Metadata includes columns, primary-key positions, declared foreign-key edges, and index shapes. Schema inspection does not establish business-level validity or validate every foreign key.
- Compact catalog snapshot: `2026-10-03T11:59:10.791Z`.
- Counts for 32 selected reference/derived/control tables were collected in a single read transaction starting at `2026-10-03T12:02:19.557Z`. Queries used compact non-partial indexes rather than raw payload scans.
- Current-cohort aggregate and fact-status inspection: `2026-10-03T12:08:37.363Z`. Values may differ from the earlier census because production continued writing.
- The initial verbose metadata response was truncated by the tool. A compact metadata response was collected successfully; all table names were classified with no unassigned table.
- No production-wide raw-trade or global market-price row count, payload byte census, or table-size ranking was performed. Planner statistics were absent in the initial metadata inspection. No row-count or size estimate is invented for these large populations.
- Identity/provider/rollback findings are in `2026-10-03-wallet-channel-migration-preflight-and-rollback-plan.md`. They remain applicable; this document expands the data scope rather than declaring cutover ready.

The CSV is a planning inventory, not executable DDL or an approved import manifest. Its compact column notation uses `!` for NOT NULL and `#N` for primary-key position. Index shapes do not replace full source DDL; foreign-key edges are flattened and do not reproduce composite constraint grouping. Final migration needs the consistent snapshot's full DDL and semantic dependency mapping.

## 3. Measured populations and implications

| Population | Observed rows | Implication |
| --- | ---: | --- |
| Canonical chains | 5 | Solana, ETH, BSC, Base, Robinhood are enabled reference entries. Configuration is not coverage proof. |
| Canonical tokens / markets / market windows | 0 / 0 / 0 | These schemas exist but have no populated canonical directory. Do not claim token/market mapping is ready. |
| Historical tokens | 8,192 | Keep compact token identity and provenance as reference; do not schedule historical mining merely because an entry is imported. |
| Token observation state | 2,685 | Extract useful identity/quarantine metadata; old stage-status flags are not new runtime progress. |
| Legacy milestones / milestone crossings | 335 / 8,264 | Preserve market-cap value, timestamp, precision, source, references, and strategy; do not relabel all as new 100K triggers. |
| Token fact status | 27,937 | Contains factual and derived categories. An available status does not replace actual inputs or interval evidence. |
| Candidate evidence v2 / v3 | 0 / 1,699 | Empty v2 is not evidence of missing v3. Preserve v3 under its old method/version. |
| Candidate admission snapshots | 35,761 | Historical admissions are not automatic new capability or manual radar permission. |
| Legacy trader-token samples | 24,249 | Aggregated trader/token positions, not one row per actual purchase. |
| Legacy sample outcomes | 124,824 | Retain historic results and their inputs; do not copy results as new-policy hits. |
| Execution heads / revisions | 9,236 / 2,062 | Preserve existing head/revision semantics; a head without a revision row is not automatically corruption because the stores' initialization contracts must be checked. |
| Consumer fact demands | 108,388 at the count snapshot | Legacy demand ledger; do not create that many new active requests by copying rows. |
| Recovery fact links | 18,005 | Preserve dependency and terminal/deferred evidence; reconstruct approved current-cohort obligations only. |
| Automation jobs / admission intents | 208,913 / 7,504 | Audit-rich old scheduling data, not the target runnable queue. |
| Source observation conflicts | 703 | Preserve both representations and conflict history. Count alone does not determine unresolved status. |
| Token fact conflicts | 0 | This one conflict table is empty; other conflict evidence still exists. |
| Broadcast records / legacy signal reviews | 8 / 8 | Reviews are dead-letter, legacy-unreplayable, with no decision recorded. Do not replay them automatically. |
| Active signal outbox | 0 | No active outbox rows in the snapshot. Does not prove that historical broadcasts were delivered. |
| Event/economic consumption ledgers | 8 / 8 | Preserve deduplication and source-to-economic mappings. Do not reset consumption at cutover. |
| Strategy configuration versions | 0 | The table is empty. Legacy rule reproducibility requires preserved deployed artifacts and actual configuration provenance, not an invented database policy snapshot. |
| Operator audit log | 46 | Preserve operator decisions and actor/time references. |
| FOMO Live inbox / revisions | 0 / 0 | This specific inbox is empty; it does not imply all historic FOMO-derived observations are empty. FOMO remains deferred. |
| Collector dead letters | 1 | Unresolved raw evidence remains protected unless reviewed; do not discard as routine logs. |

### 3.1 Current wallet cohort still references legacy data

The enabled, non-suspended on-chain profile cohort contained 108 entities and:

- 6,420 legacy trader/token aggregates across 3,018 distinct chain/token pairs.
- 4,463 aggregates whose first buy was within the preceding 30 days.
- 4,626 aggregates whose last activity was within the preceding 30 days.
- 4,067 aggregates with a positive weighted entry price.
- Old sample status: 4,673 included, 310 dust, 1,437 non-trade.

These counts overlap and are not additive. Last activity can include a sell; it does not prove a new qualifying buy. A weighted entry price or an old included label does not prove a single real purchase of at least 50 USD with a valid entry basis.

Protect these relevant sample references and required facts while deciding the continuation cohort. Do not throw them away because token discovery now starts incrementally. Conversely, do not turn the 6,420 aggregates into 6,420 forward purchase samples or automatically grant new ability.

### 3.2 Old completeness and pending states cannot be inherited

At the later fact-status observation:

- Price-history status: 606 available, 5,534 partial, 13 missing.
- Milestone-crossing status: 2,261 partial, 3,802 scheduled, 61 missing.
- Early-trade status: 1,918 available, 578 scheduled, 3 missing.
- Available token/market identity status: 8,151 / 2,390.
- The same fact-status table also contains 1,788 available ability-outcome and 382 available candidate-evidence entries; these are legacy derived results, not independent market facts.

The consumer-demand ledger had 54,197 pending complete-range requests, 42,408 pending positive-hit requests, and 11,789 satisfied positive-hit requests. A satisfied positive-hit request does not mean the entire 30-day window is covered. These values are from a later snapshot than the 108,388-row count.

Old terminal state means an old request/provider attempt ended. It must neither permanently blacklist future approved live-cohort data nor cause an unlimited retry of all historical partitions.

## 4. Complete disposition taxonomy

| Family | Tables | Proposed handling |
| --- | ---: | --- |
| Identity | 10 | Import approved identity/provenance/monitoring cohort with disabled and conflict states preserved. No implicit radar authorization. |
| Identity audit | 8 | Preserve mapping conflicts, lifecycle/operator decisions, and migration lineage. Import the references needed by active identities; keep remaining history read-only. |
| Reference | 7 | Import compact chain/token/market references where valid; preserve old aliases and strategy provenance. No automatic token activation or observation-window extension. |
| Market facts | 4 | Import verified facts and time intervals required by current samples/targets. Retain other history outside active indexes. |
| Source facts | 10 | Import the protected, validated source/execution slice and its economic identity links, not every raw payload or old projection head as live state. |
| Fact/conflict ledger | 8 | Preserve evidence and dependency context. Revalidate current coverage/freshness; old status is not a new receipt. |
| Legacy results | 20 | Preserve read-only under the original strategy; no direct reuse as new eligibility, 3x/5x capability, or signal readiness. |
| Work and receipts | 32 | Preserve job/attempt/request/receipt history. Rebuild only justified current-generation work after approval; never copy live leases wholesale. |
| Wallet analysis | 9 | Preserve analysis results and provenance. Extract independently proven transaction facts for approved targets; do not restart old analyses by import. |
| Delivery safety | 6 | Preserve frozen signal history, reviews, and event/economic consumption guards. No automatic replay or delivery. |
| FOMO deferred | 4 | Preserve existing sessions/gaps/inbox revisions; no collector or account-follow activation. |
| Protected errors | 1 | Preserve unresolved dead-letter source evidence and its recovery context. |
| External budgets | 3 | Carry applicable live quota/cooldown obligations across the writer boundary; preserve older usage as audit. |
| Runtime | 19 | Preserve old state as history; establish new health, cursors, generations, and consumer acknowledgments through a fenced handoff, not status copying. |

Full per-table mapping and source contracts are in `docs/operations/2026-10-03-legacy-data-disposition-inventory.csv`. Family assignment is not permission to copy all rows or to erase those kept outside active storage.

## 5. What should go into the active PostgreSQL system

### 5.1 Reference metadata and identity

Keep chain/contract identity, market/pool identity and validity intervals, immutable old ID aliases, symbol/decimals when known, provenance, quarantine/conflict state, trader/account/wallet links, monitoring intent, explicit grants/revocations, and policy generation.

There is no production table named simply `tokens` in the inspected catalog. Useful token information is distributed across `historical_tokens`, `token_observation_state`, and observed source facts, while `canonical_tokens` is empty. The importer needs a collision-safe crosswalk rather than assuming a populated canonical registry.

Preserve original token IDs and add a mapped canonical key. Match by verified chain and contract, never symbol/name/image. Solana case remains significant. Do not fabricate a pool address from a token address or assume that market cap is FDV. Keep unknown launch time as optional metadata, not an eligibility prerequisite.

A metadata row imported for reference must not:

- Create a historical mining task.
- Turn an old million-dollar crossing into a new 100K trigger.
- Reset first-discovery time to the import time or extend a discovery window on every replay.
- Re-enable suspended identities, turn a note into a grant, or import legacy scores as new capability.

### 5.2 Actual executions, source evidence, and needed price intervals

Prefer the approved target/sample dependency closure, not a global age-only dump:

`identity -> real source event -> execution revision -> economic trade -> purchase window -> required token/market intervals -> peak/risk proof -> consumer result`.

A reusable execution needs side, chain/contract, real quantity and quote basis, event/instruction identity, source and ownership evidence, occurrence/known times, revision/reorg status, and amount quality. Keep USDT/USDC nominal USD explicitly estimated. A transfer, aggregate weighted cost, spot-price lookup, or old profit label cannot invent a purchase entry.

Map old source/event IDs to stable economic keys in a separate audited crosswalk. Multiple source observations can support one economic trade. Different fills must not collapse into a single trader/token sample. Preserve pending/conflicted execution states; do not select the latest row and drop contrary evidence.

Market observations and snapshots can be valuable even for old tokens. Import the intervals needed by protected/current samples, plus the corresponding chain/pool/source validity references. Recheck actual timestamps, precision, source quality, and risk status before using a peak. Price-history partial/available markers alone cannot prove complete coverage.

Historical milestone facts retain their real crossing time, precision, source, and strategy. Imported facts remain facts under their original provenance; the new generation computes its own trigger/evidence decisions without inventing a new crossing at cutover.

### 5.3 Safety ledgers and external obligations

Preserve minimal immutable event/economic deduplication and delivery-review records even when their raw payloads leave hot storage. Old delivered/pending/unreplayable states must remain distinguishable; a broadcast row is not a delivery receipt.

The eight reviewed signals are explicitly `dead_letter / legacy_unreplayable`; they remain frozen until a separate reviewed decision. Empty active outbox does not justify discarding broadcast IDs or consumption guards.

Provider cooldowns, current-window usage, and global quota obligations cannot reset simply because the destination changes. Coexisting old/new workers must share one approved budget authority or be fenced; two independent reset counters would double requests. Expired budget state is historical context, not a permanent blocker.

## 6. What stays preserved but is not copied into new live behavior

### 6.1 Legacy scoring, admission, and trader/token aggregates

Keep candidate evidence, old admission, ability/style/score snapshots, aggregate samples, outcomes, lifecycle reasons, and legacy token aggregation/readiness results under their original policy.

The legacy `trader_token_samples` uniqueness is `(entity_id, chain, token_address)`. The new design is one 30-day window per actual qualifying purchase. The former cannot be converted by renaming the table or using its weighted entry price as each purchase's entry.

Stable capability remains the confirmed distinct-token opportunity rule. Selling is not required. Old realized-return, token-launch-age, contribution-score, or large-order fields may remain useful audit/display data but do not become new gates.

For an existing unfinished observation:

1. Protect its source/execution/market dependencies first.
2. Identify the actual purchase(s), individual timestamps, ownership, and price basis.
3. Continue only the approved window under an explicit generation/policy mapping.
4. Keep legacy result visible separately; no automatic new radar grant.
5. If a per-buy basis cannot be reconstructed, keep it as legacy context with a reason, not a fabricated migrated sample.

Whether pre-cutover validated purchases also contribute to the new capability cohort is a business-continuation decision to confirm. Preservation itself does not require or imply that promotion.

### 6.2 Old jobs, requests, and completed receipts

The 208,913 old jobs include large completed/cancelled populations. At the queue snapshot, candidate evidence still had 4,044 blocked, 959 pending, and 3 retryable rows; ability evaluation had 987 pending; signal projection had 4,325 pending; lightweight evaluation had 1,491 pending; initial wallet backfill had 15 pending.

These counts do not justify rebuilding the old backlog in PostgreSQL. Retain immutable attempts, input revisions, cancellations, and reason codes. Select only obligations that are still required by the approved current cohort, with new semantic keys and fenced generation-specific leases.

Do not import old lease owners/expiry, lane credits, claim counters, applied revisions, producer-success receipts, or old desired signal revisions as proof that a new consumer finished. Do not silently cancel the current production jobs during this planning phase.

Historical partitions/mining, old verification queues, identity batches, launch-time-only demands, and deferred FOMO jobs remain dormant/read-only in the proposed new runtime until independently approved. Old queued metadata is not new ingestion.

### 6.3 FOMO and wallet-analysis history

FOMO capture is deferred, not erased. Preserve account/wallet association evidence and historic FOMO-derived source events. Empty Live inbox does not describe every legacy FOMO source.

Preserve wallet-analysis jobs, positions, checkpoints, provider events/blocks, and provenance as history. Extract actual execution facts only where verified and relevant. An old analysis status/coverage percentage or position price is not new execution or independent eligibility proof.

## 7. Fifteen-day raw retention is not fifteen-day business retention

The confirmed 15-day policy concerns ordinary raw payload hot storage, not all trades, prices, samples, or audits.

| Data | Proposed lifecycle |
| --- | --- |
| Unneeded, fully processed raw payload | Eligible for an approved archive/removal workflow after 15 hot days and complete dependency checks. No purge performed or authorized by this document. |
| Unparsed/uncommitted/unmatched raw input | Protected until processing/review establishes its disposition. |
| Raw input that is the only execution/ownership/peak proof | Protected until sufficient reproducible evidence is preserved; a hash alone is insufficient. |
| Active 30-day sample and its required price interval | Retained through its evaluation, relevant revisions, consumer completion, and audit obligations. Not expired on day 15. |
| Source/event/economic identities and dedup guards | Survive raw hot expiry and cross-day replay. |
| Normalized trades, capability/evidence/authorization revisions | Business facts/audit with separately confirmed lifecycle; no blanket 15-day deletion. |
| Old batch queues, diagnostics, and unused payloads | Preserve initially outside active runtime; archive eligibility after dependency/protection review. |
| Broadcast/review/consumption history | Retain enough immutable identifiers and decisions to prevent replay or false delivery claims. |

A protection manifest must include record identity, dependent sample/request/review, required time interval, protection reason, source/evidence reference, known expiry/review point, and storage location. Holds with no safe expiry remain visible and require review; do not hide indefinite growth.

No archive destination, final deletion age, audit duration, compression scheme, or proof-excerpt format is chosen silently. Snapshot files, existing backups, and disputed/unfinished evidence are not cleanup targets in this task.

## 8. Dependency closure and migration correctness

Declared foreign keys are only part of the dependency graph. Many tables use token IDs, source-event lists, request subject keys, fingerprints, or JSON payload references without SQL foreign keys.

Before importing a row:

1. Resolve chain/token/market and identity aliases without rewriting original provenance.
2. Include or preserve every referenced owner/source revision, conflict record, execution basis, sample, market interval, and audit parent.
3. Record whether a dependency is in active PostgreSQL, frozen legacy storage, or missing. Missing does not become zero, false, or completed.
4. Capture original policy/generation, amount precision, null semantics, UTC epoch clocks, and occurred-versus-known time.
5. Write explicit import receipts and checksums; do not use independent per-table copies that leave dangling semantic references.
6. Keep the new evaluation namespace separate from old strategy results and delivery/lease state.

SQLite REAL does not gain exact source precision by conversion to PostgreSQL NUMERIC. Keep the original representation and quality marker when available. Do not rescale or round amounts/prices arbitrarily.

Canonical-market child rows have cascade-delete relationships. Do not remove reference rows as a side effect of raw retention. Source-observation links to old raw records also need a protected evidence record before raw data can be moved safely.

The empty strategy-version table is a provenance gap, not permission to call old results reproducible under the current rules. Preserve prior releases and capture available configuration provenance before approved cutover.

## 9. Migration sequence for the expanded scope

### Stage 1: Classification and protection manifest

Completed in this analysis: inspect all 141 schemas, classify every table, collect bounded selected counts, identify cohort-linked aggregates, and separate legacy results from facts.

Next implementation boundary: build a row-level scope/protection manifest from the approved cohort with semantic references. Profile large raw/market tables on an approved consistent offline snapshot; do not perform unbounded production size scans.

### Stage 2: Reference and safety foundations

Prepare business PG driver/schema and source-to-target alias/provenance mappings. Import the approved chain/token/market references, identity cohort, audited policy generation, frozen signal/dedup guards, and applicable live budget obligations.

No token-watch activation, old queue replay, account follow, or delivery occurs during reference import.

### Stage 3: Protected fact slice and legacy access

Import relevant verified executions/source excerpts, revisions/conflicts, required market intervals and milestones, plus their complete dependency closure. Keep other legacy history read-only in the consistent source snapshot or the separately approved history namespace.

Do not copy all raw payloads, the mining backlog associated with the 8,192 historical token records, or all legacy scores into active tables. The 8,192 count describes historical tokens, not mining-job rows. Importing a token header does not require replaying its historical batch pipeline.

### Stage 4: Continue approved observations and rebuild new results

Resolve the approved continuation cohort and per-buy windows. Recalculate opportunity/capability/aggregation/readiness under the confirmed strategy only from valid facts. Recreate narrowly required work with semantic deduplication and fresh leases; missing inputs remain deferred.

Run actual wallet-source shadow acceptance and compare old context with new trace without forcing score equality between different rules.

### Stage 5: Fence all affected writers and cut over

Use the wallet migration plan's multi-service writer barrier, consistent snapshot/delta manifest, single-writer generation, durable event journal, and post-write rollback reconciliation. Reference/safety metadata, facts, authorization changes, and queue obligations are all part of the delta, not just new trades.

Formal backup/schema/import and release/service cutover require explicit approval. Gateway remains false. FOMO stays deferred.

### Stage 6: Retention dry-run and archival approval

First report ordinary hot-raw eligibility, protected records, required intervals, and storage/capacity. Demonstrate day-16 replay deduplication and day-30 reproducibility with evidence outside ordinary raw hot storage.

Archive/removal is a separate approved operation. No legacy table becomes disposable simply because the new worker no longer queries it.

## 10. Validation required before expanded migration

- Token alias collision, chain mismatch, Solana case preservation, empty canonical directory, absent pool identity, and FDV/market-cap separation.
- Cohort-specific dependency closure including JSON/event-list references, compound keys, missing parents, and audit namespace.
- Distinct actual fills versus one old aggregate; transfer/non-trade rejection; amount/entry estimation markers; conflicting/reorg execution.
- Existing unfinished sample preservation without silent capability/grant promotion.
- Actual required market interval, peak source/quality/time, missing coverage, and old milestone precision.
- Legacy scores/receipts/status labels cannot satisfy new consumer completion or eligibility.
- Current-window provider budget/cooldown survives overlap, failure, and rollback.
- Eight unreplayable signal reviews remain frozen; no delivery from import; economic consumption cannot be reset.
- Day-16 cross-source/day replay remains one economic event; raw hot expiry does not break a live 30-day window.
- Before/after-PG-write rollback preserves new facts, identities, authorizations, journal, and provenance.
- Backup restore, source checksums, per-category and per-record parity, null/numeric/clock semantics, bounded queries, and actual real-purchase trace.

These are required future tests, not tests executed in this documentation task.

## 11. Remaining decisions and explicit boundaries

Existing confirmed business rules remain unchanged. The newly exposed decisions are:

- Which pre-cutover, genuinely attributable individual purchases continue their remaining observation windows, and whether they may count toward new-generation capability. Recommendation: preserve and finish valid observations, but do not promote aggregate rows or old eligibility automatically.
- Where the full historical read-only dataset and protected raw evidence will live, and the approved archive/audit lifecycle. Until approved, retain the source and backups.
- The exact import cohort, observed interval scope, external budget handoff, capacity reserve, protection rules, and cutover writer boundary.
- The permanent schema/import operation and the later runtime cutover, each separately approved.

A schema census and classification do not prove that every old fact is usable, every history interval is complete, or migration is ready. No production migration, destructive cleanup, or configuration change was performed.
