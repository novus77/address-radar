# Bounded purchase dependencies and declared price coverage

## Problem and implementation plan

The legacy preservation reader spends the same bounded row budget on purchase
dependencies and all global delivery/provider ledgers. A complete global-ledger
acceptance elsewhere does not remove that local truncation or establish a coherent
combined snapshot. Increasing limits or setting completeness flags manually is not
an acceptable workaround.

This stage separates diagnostic scopes while preserving the existing reader:

1. Reuse its complete source/event keys, foreign-key grouping, indexed semantic
   lookups, source storage encoding, revisions and bounded read transaction.
2. Add a purchase-only reader restricted to reviewed trade roots. Never enumerate
   global ledgers through this entry point. If a required ancestor is a global guard,
   report an explicit coherent-export blocker instead of silently dropping it.
3. Keep the global preservation flag false and domain-separate the new bundle hash.
   The original all-guard reader and its fingerprint contract remain unchanged.
4. Report the exact observation's declared 30-day coverage separately from purchase
   validity, source dependency completeness and independent provider verification.
5. Exercise isolation, revision retention, cap/missing-row/index blockers, clocks,
   receipt purpose, unfinished/closed windows and private output in real fixtures.

## Scope and safety

The new reader opens the source read-only with query_only in one SQLite read
transaction. It does not invoke a migration, API, writer, collector, consumer,
registry, index creation, retention action or eligibility decision. FOMO remains
paused and signal delivery remains disabled.

The default purchase diagnostic bounds remain 1,000 rows and 8 MiB. These are local
diagnostic limits, not market rules or provider budgets. As with the existing row
reader, bounds are checked after a source row is materialized; they do not provide a
hard oversized-value allocation limit or wall-clock deadline. Approved production
diagnostics must also use an external process timeout.

Declared purchase dependency completeness concerns only this reader's implemented
FK and semantic relationships. It is not the complete semantic inventory, source
ownership verification, original swap/decimal verification, or full revision
content validation. Revision payloads are retained, not promoted to verified facts.

The new reader accepts only trade_evidence roots in wallet_monitor_observations,
wallet_monitor_execution_bases and trader_execution_heads. The public diagnostic
uses an exact wallet observation source/event key. It summarizes table counts and
hashed references without publishing wallets, token addresses or raw payloads.

## Interpretation

- dependencies_available means the declared bounded dependency slice and observed
  purchase clock are available. It does not mean the buy passed the 50 USD rule or
  that the actor is eligible; independent transaction checks remain required.
- Missing basis, missing parents, required revision rows, missing indexes and
  bounded truncation remain explicit blockers. No reverse full scan is substituted.
- Price-window inspection uses the observed buy time, not token launch time. Source
  facts collected after asOf do not derive an as-of window.
- Without compatible supplied price claims, a live window is observing with gaps;
  a closed 30-day window has historical price gaps. Neither is a failed opportunity
  or proof of loss.
- Complete declared price receipts are still not independently verified provider
  responses. Wallet-range receipts and positive hits do not prove a price range.
- Global guard coverage, coherent source snapshots, independent transaction checks,
  new sample creation, eligibility and production readiness stay separate gates.
- Never copy the previous TEMP ledger acceptance flags into this bundle. A combined
  consistent snapshot with both scopes and target proofs remains future work.

## Usage

After the TypeScript build, provide a private request file:

```json
{"source":"solana_rpc","eventId":"reviewed-event","asOf":1234567890000,"claims":[]}
```

```bash
node scripts/purchase-dependency-coverage-preflight.mjs --database /path/to/source.sqlite --request /path/to/private-request.json
```

Exit 0 is diagnostic dependency availability only. Exit 1 means a diagnostic
blocker; exit 2 means invalid input or source access. There is no apply, import,
output-file, restore, migration, activation or purge mode.

## Acceptance and remaining work

Run the new fixture tests with the old preservation and legacy coverage suites, then
the full suite, project test type checks and builds. A bounded read-only production
sample may identify remaining gaps; it is not a population estimate or throughput
measurement. No production database change is required by this stage.

Original transaction verification, original decimal quantities, independent price
pagination/market quality proofs, coherent source backup or shared-snapshot export,
target business DDL mapping and explicit migration/cutover approval remain required.
No old aggregate, old admission or completed task is new-generation eligibility.

## Recorded validation (2026-10-04)

- Test-first run: all 12 new cases failed at the unimplemented entries before implementation. The subsequent receipt fixture correction moved knownAt to the end of its claimed complete interval; production coverage rules were unchanged.
- Targeted new and legacy suites: 38 passed. Complete suite: 1,161 passed, 97 skipped. All project test type checks, 15 project builds and root TypeScript checking passed with the existing compiler.
- Read-only production probe retained the 1,000-row diagnostic limit and a 20-second external process timeout. It inspected at most 200 execution-basis records, selecting a nominal-stablecoin buy after 33 records and verifying direction with the complete source/event key.
- The selected event matches the previous bounded legacy probe: `d5ab988d868fb1084c2a67ba4864c48e9a982749d7976c9868bcefb841735232`.
- The new dependency slice contains 14 rows: one wallet observation, one execution basis, one raw observation, one trader event, one execution head, two revision rows, five revision-consumer requests, one account and one entity. No global ledger occupied its row budget and no row-limit blocker occurred.
- Dependency fingerprint: `a907cf5174d4a542e4d44f8b3a5f424134f851dbff0bf7abb14aebe5ae998519`; capturedAtMs: `1791076263173`.
- The remaining declared-slice blocker is `unindexed_dependency_lookup` on `canonical_trader_event_observations`. No source index was created or lookup bypassed.
- The closed price window reported `historical_price_gaps` because this probe supplied zero coverage receipts. This does not prove the database or providers lack historical prices; independent range proof and a read-only receipt inventory remain required.
- All six service processes were active, each had NRestarts=0 and exactly one delivery flag set to false. No business write, release change, configuration change, service restart or delivery occurred.

The first temporary probe packaging attempt failed locally before SSH. A subsequent
amount-only selector found a non-buy sample that the diagnostic correctly rejected;
that sample is not purchase acceptance evidence. The final selector explicitly
checks buy direction and reports the reviewed event above.

The readable head/revisions are not independent revision validation. Declared
purchase dependencies, coherent global guards, independently verified transactions,
provider price coverage, eligibility and production migration all remain unapproved
or unverified. This stage removes diagnostic global-ledger contention, not the
remaining business migration gates.
