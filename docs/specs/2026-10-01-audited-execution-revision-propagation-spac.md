# Audited execution revision propagation

## Status and authorization

The user approved preserving original facts and revision audit, updating derived results only for the same event and identity using real execution evidence, and recomputing downstream consumers. Missing execution evidence remains pending; no spot-price fallback, identity merge, or invented economic allocation is permitted.

This specification is implementation preparation, not a claim that propagation or historical repair is deployed. The preceding historical-dispatch recovery must finish deployment and read-only acceptance before this implementation phase starts.

## Verified evidence and limits

Code inspection found:

1. Wallet observations and execution bases can retain updated economic values and provenance.
2. Source observations preserve original payloads and append enrichment revisions.
3. The wallet monitor resets projection on a changed execution-basis JSON, but not necessarily on every economic observation change.
4. The trader repository uses `INSERT OR IGNORE` for existing trader events and raw observations. A later projection can therefore retain an old derived event even when a new source revision exists.
5. Canonical trade matching and consumer request dispatch are separate from the original source write; marking wallet projection complete alone does not prove downstream recomputation.

A read-only production audit at 2026-10-01T13:55:36Z found 124,405 projected Solana observations, zero missing trader events, zero stale amount/price values under identical immutable event keys, and 365 retained estimated execution bases. These numbers establish a latent propagation risk and limited explicit basis coverage, not an existing 124,405-row corruption problem. Other chains and FOMO execution provenance need separate inspection; do not extrapolate this audit to them.

## Immutable identity and revision ordering

The event identity includes source event key, entity/account, chain, chain-correct token address, side, and execution time. A revision must not change these keys. EVM addresses normalize case; Solana remains case-sensitive.

Keep source observations, raw trade payloads, and prior enrichment revisions. Derived economic values may be updated only after a validated execution basis links to the same immutable identity. Older or out-of-order revisions must not replace a newer accepted basis. Repeated identical revisions must not trigger writes, duplicate facts, duplicate tasks, or repeated consumer refresh.

A disappeared, failed, ambiguous, or orphaned execution is not a successful revised purchase. Its effect on derived evidence must be explicitly classified, not converted to zero profit or silently ignored.

## Execution evidence contract

For the confirmed nominal-stablecoin policy, require an actual swap/receipt or parsed transaction basis with verified chain-specific USDT/USDC identity, unambiguous token/quote quantities, consistent directions, finite positive values, and a source reference. Preserve the estimated amount marker. Nominal dollar amount and transaction-derived entry price are separate from historical market observations.

Historical/live quotes cannot substitute for execution price. Unsupported native-asset valuation, ambiguous multi-token allocation, absent quantities, or unidentified stablecoin contracts remain pending with a precise reason. FOMO records need their own explicit transaction basis; a field named `priceUsd` is not by itself proof of executed price.

## Propagation transaction and handoffs

Implement source revision acceptance and derived update through a narrowly scoped write boundary:

1. Validate immutable identity, source provenance, revision ordering, execution basis, and orphan/finality state.
2. Preserve the existing fact and append the accepted revision/audit before changing derived values.
3. Update the event's derived economic view only when the accepted revision differs.
4. Resolve the canonical economic trade association. Do not rerun fuzzy matching and accidentally attach the same source event to a second canonical trade.
5. For cross-source trades, reconcile evidence explicitly. A conflicting FOMO/on-chain amount must enter review/pending rather than silently overwrite the combined trade or split/merge identities.
6. Atomically record desired consumer revisions for affected token aggregation, candidate evidence, opportunity history, ability evaluation, and signal projection.
7. Mark source projection complete only after its durable consumer handoffs exist. Worker completion is not business-output completion.

Consumer workers must apply the requested revision idempotently and acknowledge its exact input revision. A newer request must not be lost while a worker processes an older revision. Preserve leased work ownership; use existing bounded scheduling and retry policies rather than clearing leases or resetting all history.

## Historical repair policy

Start with read-only inventory and reason counts, grouped by chain/provider. Repair only identified derived records with retained, valid, newer execution evidence. Preserve original facts, accepted identity links, prior revisions, and rollback audit. Do not indiscriminately rewrite all historical events, delete candidate evidence, demote inactive traders, or automatically merge identities.

Earlier opportunity records without explicit basis remain distinguishable from newly verified results. Current scoring must not present unverified execution basis as verified discovery capability. Versioned re-evaluation and pending-data presentation must be implemented together before old values are removed from current consumer decisions.

## Failure and retry controls

- An accepted source revision with failed derived update must remain replayable after crash.
- Consumer enqueue failure must roll back derived changes or leave an explicit durable handoff state.
- Identity/source conflicts produce audit and a reviewable reason; no infinite immediate retry.
- Out-of-order replay cannot downgrade a newer basis.
- Reorg/orphan handling must invalidate dependent facts through a versioned handoff, not delete the original observation.
- Provider unavailability and quota exhaustion remain distinct from invalid evidence and permanent coverage gaps.
- Disk below the existing safety floor blocks heavy repair/deployment; never reclaim business facts to make a test pass.

## Required validation

Test null-to-valid basis recovery, validated corrected quantities, identical replay, older revision replay, identity/key mismatch, source conflict, ambiguous allocation, nominal-stablecoin markers, orphaned execution, cross-source disagreement, crash boundaries, consumer revision races, duplicate task prevention, and unchanged admission/opportunity thresholds.

Run targeted tests, the full suite, typecheck, build, package smoke, boundaries, and desktop/mobile browser tests. Deploy only with sufficient disk headroom and preserved rollback release. Production acceptance must follow a real source revision through retained audit, derived event, canonical trade, requested/applied consumer revisions, recomputed ability/candidate results, aggregation, and signal readiness, while delivery remains disabled. Pending or review outcomes are valid only when correctly explained; service health alone is not acceptance.

## Still open outside this phase

Strict historical range/extrema coverage proof, physical per-request budget attribution, external early-buy coverage, FOMO identity resolution, and sustained new candidate/signal production remain independent work. Completing execution revision propagation does not certify the entire lifecycle.

## Consumer proof revision fence: first implementation slice

Fact demand and proof JSON may include an optional non-negative integer
`executionRevision`; omitted values mean legacy revision zero. No SQL column migration
is required for this backward-compatible payload field. A positive opportunity or
range proof is reusable only for the same purchase execution revision. A newer
revision must not preserve the prior entry's stronger multiple. Older or unversioned
replays must not overwrite a versioned request, even with a later evaluation time.
Within one execution revision, existing stronger-proof retention remains unchanged.

This slice only supplies the consumer-side fence. Producers still must derive the
revision from audited real execution records and propagate it through requests and
proofs. It does not manufacture a revision from a market quote, replay old data, alter
admission thresholds, or claim that the full revision handoff is wired up.
