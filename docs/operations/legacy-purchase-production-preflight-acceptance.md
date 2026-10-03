# Bounded Legacy Purchase Production Preflight

## Scope

This is a diagnostic of the legacy purchase reconstruction path, not approval to
migrate business data or activate legacy evidence in the new generation.
The production database was opened read-only, with `query_only` enabled. The
diagnostic ran from standard input using in-memory modules; no release was
uploaded, no configuration was changed, and no service was restarted.

All six running service processes had exactly one delivery flag, set to
`ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false`.

## Observed source result

The selector read at most 200 execution-basis records in primary-key order. It
selected a nominal-stablecoin buy of at least 50 USD after inspecting 32 records.
This is a bounded, ordered sample, not a population estimate or a recent-progress
measurement. Its source-event fingerprint was
`d5ab988d868fb1084c2a67ba4864c48e9a982749d7976c9868bcefb841735232`.

The subsequent preservation slice reached its 1,000-row safety limit while
retaining `provider_budget_usage`. Both dependency-completeness flags were false.
The result was correctly deferred, with no new purchase sample or eligibility.
However, the original diagnostic reason incorrectly implied that the execution
basis was missing: the selected basis could be omitted from the truncated slice.

The reconstruction gate now checks preservation completeness before inferring
source absence. Three regression cases cover incomplete dependencies, incomplete
global guards, and both together. They reproduced the incorrect reason before the
gate-order correction. No row limit was raised and no preservation obligation
was removed to force a passing production result.

## Validation boundaries

The first local full-suite run had one timeout in the existing backup-retention
test. Both backup tests passed in isolation without changes. A full-suite rerun
with two workers passed 1,120 tests, with 96 skipped, before the three additional
regressions were introduced. The result is consistent with resource contention;
it does not establish that all timing risks in that test have been eliminated.

The temporary production harness required two corrections before obtaining a
data result: using the documented `trade_evidence` root reason and resolving the
existing remote domain module through a `file:` URL. Those harness failures were
not business-data findings.

Neither a complete preservation export nor independent verification of the
original swap, original decimal quantities, canonical economic execution key,
ownership, or a full 30-day price range has been established by this probe.

## Next migration gates

1. Export the complete global delivery and budget ledgers from a consistent source
   snapshot, separately from bounded per-purchase dependency diagnostics.
2. Retain ledger and dependency fingerprints and verify their target round trip;
   missing pages or rows must keep the completeness gates closed.
3. Reconstruct individual buys only after preservation is complete. Recover
   original transaction quantities rather than promoting legacy floats to exact
   business numeric values.
4. Verify price-range receipts against actual provider responses. A wallet-range
   receipt or a positive price hit is not a full price-history proof.
5. Obtain explicit approval before a formal migration, business activation, or
   release/service cutover. Keep the original database and rollback path intact.

Current outcome: production migration is not ready. This probe does not authorize
business writes, delivery, legacy eligibility promotion, or source-data deletion.

## Final local validation

After correcting the gate order, all 18 targeted tests passed. The complete suite
passed 1,123 tests, with 96 skipped, using two workers. Database test type checking
and the project TypeScript build both passed. Skipped tests are not acceptance
evidence for their optional integration environments.
