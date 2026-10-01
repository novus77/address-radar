# Price-to-milestone recovery handoff SPAC

## Evidence and scope

2026-10-01 production diagnostics found 29 DefiLlama-priced token identities without a token market snapshot. The milestone reconciler inventories only market snapshots, so newly retained price facts alone cannot enter that repair scan. Candidate source blocks require real milestone data; prices alone cannot establish circulating supply or a market-cap crossing.

Production currently has 7,233 estimated crossings with integer timestamps. None of the inspected active missing-milestone blocks has a crossing record. Invalid-placeholder handling is therefore a latent correctness gap, not the demonstrated cause of those source blocks. Candidate consumption and milestone reconciliation currently use weaker presence checks than recovery postconditions.

## Implementation

- Extend the bounded milestone repair inventory with already-known available/partial/degraded price-history facts. Do not repeatedly scan every raw price observation.
- Deduplicate the inventory, preserve existing batch limits, backoff, priorities and idempotent recovery IDs.
- Use the established recovery-postcondition requirements for a usable crossing: non-unavailable precision, integer time within [0, asOf], positive market cap and a nonempty source.
- Do not let unavailable, future, malformed-time or unattributed crossings suppress prerequisite recovery or enter candidate evaluation.
- Time-bound market-cap trade-event fallback to the evaluation snapshot.
- Preserve source terminal decisions and existing future retry dates; do not bulk reopen old dead letters or modify production records manually.

## Non-goals

No new score, threshold, quota, launch-time requirement or realized-profit gate. No conversion from price to market cap using guessed supply. No claim that partial price history proves continuous consumer coverage. No claim that an enqueued repair establishes a milestone, early buyer or admitted wallet. Existing candidate execution-entry provenance remains a separate lifecycle gate.

## Tests and acceptance

Regression tests cover price-fact-only inventory, snapshot/fact deduplication, source placeholders, future crossings, candidate prerequisite blocking and future trade-event fallback. Preserve existing valid-crossing, admission, early-trade and idempotency tests. Run full verification, commit and deploy, then read-only inspect service health, disabled delivery, queue changes and fact growth. Distinguish production evidence from latent guard tests and document all remaining source limitations.

## Local validation

The initial fixture omitted the required trader identity. After explicit authorization, the identity fixture was corrected and all eight expected feature regressions still failed for their intended reasons. Implementation passed 22 targeted tests, all 829 unit tests across 205 files, typecheck, build, package smoke, boundaries and both desktop/mobile browser tests. The inventory also includes non-DefiLlama available/partial/degraded price facts without snapshots; the observed 29 DefiLlama-priced identities are not an exhaustive count of that inventory. This is prerequisite scheduling, not new crossing production.
