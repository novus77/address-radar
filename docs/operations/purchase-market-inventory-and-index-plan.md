# Purchase market-point inventory and reverse-index proposal

## Scope

This stage prepares a source-index change proposal and reads existing price points.
It does not execute the proposal, migrate data, invoke a provider, grant eligibility,
resume historical mining, change service configuration or deliver a signal.

The production metadata review confirmed the reverse-link table has only a
canonical_event_id-leading composite primary key. The market-point table already
has a full chain/token/time/source key usable for an ordered bounded range lookup.
An all-guard TEMP acceptance and a purchase dependency slice do not prove a
complete market range or authorize source schema changes.

## Reverse-index proposal

The preflight reviews the two-column link table shape, ordinary index key parts,
partial/expression indexes, collation, direction and global object-name collisions.
It proposes a nonunique observation_id-leading covering index only when no suitable
ordinary prefix exists. Existing suitable indexes have no create or rollback DDL.
An unreviewed shape or colliding object blocks the proposal; IF NOT EXISTS is not
used to conceal a collision.

The output contains a source metadata fingerprint, CREATE INDEX proposal and
ownership-gated DROP INDEX proposal. No DDL is run. Neither an inspected report nor
SQL text is production approval. Fingerprints identify the inspected metadata;
they do not establish full CHECK/default/collation/trigger or target DDL equivalence.

Before any approved production index build:

1. Confirm a coherent backup and restore path, disk/WAL headroom, current database
   identity, metadata fingerprint and index-name ownership.
2. Review the complete source DDL/collation and current writers. Use a scheduled,
   bounded locking window with the approved single-writer/service policy. The
   source is SQLite; do not imply PostgreSQL concurrent index construction applies.
3. Record the exact created index definition and ownership in a deployment journal.
   Abort on lock timeout or drift; do not silently retry unboundedly.
4. Recheck indexed lookup and the same purchase dependency slice. A successful
   index build does not verify original swaps, revisions or price range coverage.
5. Drop only the index demonstrably created by this deployment and still matching
   its journal. Never drop pre-existing or changed indexes by name alone.

This stage supplies no DDL executor or service restart mode. Formal production
schema modification remains a separate explicit approval.

## Stored-price inventory

The tool reads an exact source/event observation, requires an ordinary indexed
lookup, buy direction, non-orphaned state and known observation clocks, then derives
the confirmed 30-day window. It uses the existing domain window constant rather
than launch time or aggregate weighted entry prices.

Within the same read-only SQLite transaction it samples market_observations by
exact stored chain/token identity and closed bounds. The ordinary full prefix and
EXPLAIN plan must avoid full scans and temporary ordering. The default cap is
1,000 points with one extra row to detect truncation; the maximum diagnostic cap
is 10,000. These are local diagnostic bounds, not business or provider budgets.

Reports include point count, sample bounds, hashed source groups, finite-positive
versus invalid price counts, and a typed point digest. They do not expose wallets,
token addresses, raw events or provider identifiers. A source row is materialized
before hashing; this is not an oversized-value allocation bound. Use an external
process deadline for approved production probes.

Zero points means no matching rows were found in this one table/window, not that
providers or other source tables have no history. Reaching the cap is not complete
enumeration. Even complete local enumeration and positive prices do not establish
market mapping, liquidity/spike quality, original decimal precision, as-of
publication knowledge, provider pagination completeness or full 30-day coverage.
No high-multiple result or loss is calculated or inferred by this diagnostic.

No chain/address alias or pool mapping is invented to broaden matches. Other
canonical-market snapshots, receipt adapters, market identity normalization and
independent provider coverage require separately reviewed adapters.

## Usage and acceptance

After building, use a private request file containing source, eventId and asOf:

```bash
node scripts/purchase-market-inventory-preflight.mjs --database /path/to/source.sqlite --request /path/to/private-request.json
```

Exit 0 means the scoped read and proposal inspection completed, not that the
proposed index exists or coverage is verified. Exit 1 is a diagnostic blocker;
exit 2 is invalid input or source access. There is no apply, purge, output-file,
provider-fetch, migration or activation mode.

Fixture acceptance covers proposal-only behavior, ownership-safe rollback,
pre-existing indexes, partial/expression/collation rejection, collision and drift,
closed/open windows, exact identity, row caps, missing indexes, invalid points,
future source clocks, orphaned/sell observations, private output and unchanged
source bytes. Production WAL coordination is not byte-immutability evidence.

Coherent global/purchase source export, original transaction and decimal proof,
independent range receipts, business PostgreSQL mapping and formal cutover remain
gates. FOMO remains paused and gateway delivery remains disabled.

## Recorded validation (2026-10-04)

- Test-first run: all 15 new fixture cases failed at the unimplemented entry. After implementation, all 27 new/previous purchase diagnostic tests passed.
- Full local suite: 1,176 passed and 97 skipped. All project test type checks, 15 project builds and root TypeScript checking passed using the installed compiler directly.
- Production metadata was read without any DDL or business writes. The initial metadata command had a local shell-quoting error and did not yield a source finding; its corrected read-only retry supplied the reviewed structures.
- The final production probe had a 20-second external deadline. It selected the previously reviewed event within a 200-record cap after 33 records and matched source-event fingerprint `d5ab988d868fb1084c2a67ba4864c48e9a982749d7976c9868bcefb841735232`.
- Source reverse-link metadata fingerprint: `19d5d40485e8a30f91b6624d515668ce3790c80f820c024c2f63f0b295c677e5`. No suitable reverse prefix exists; the current reverse lookup plan does not use SEARCH. The proposed nonunique index remains unexecuted and requires explicit production approval.
- Scoped market inventory: two matching points, no extra page, positive finite price values in both rows. First observed time: `1762278449000`; last: `1762281008000`. Their approximately 43-minute span does not prove a complete 30-day price history.
- Point fingerprint: `2517b13fbaceece577cbc9704e113930a30b2c41848d3c53f6a836ae85545b86`. Source capture time: `1791078139358`.
- This read establishes only the matching market_observations rows in the selected window. Other stores, archives and providers were not inventoried. Publication-as-of provenance, market mapping/quality and independent coverage all remain unverified.
- All six business services were active with NRestarts=0 and their actual delivery flags false. Available disk bytes: 45,449,367,552. No index was created, no release changed, no service restarted and no business data was written.

The backup/write-window/index-ownership execution journal, independent transaction
and range adapters, shared-snapshot export and formal migration/cutover approval
remain outstanding. Do not promote this inspected report to readiness or apply its
rollback SQL without proving deployment ownership.
