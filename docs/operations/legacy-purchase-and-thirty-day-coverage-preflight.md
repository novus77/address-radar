# Legacy purchase reconstruction and 30-day coverage preflight

## Scope

This stage inspects preserved source facts. It does not write forward purchase
samples, change eligibility or import business tables. Candidate means suitable for
additional external validation, not verified purchase admission.

The existing confirmed domain policy is reused for the 50 USD buy threshold and
30-day purchase window. Token launch time, realized sales and old weighted entry
prices are not required or substituted.

## Reconstruction checks

Each observation and basis is selected by the complete source/event key. The
preflight requires a non-orphaned buy, supported chain, source transaction reference,
matching actor/token identity, known-as-of source clocks, a stored nominal stablecoin
basis, consistent observed amounts and an applied execution revision head.

Revision zero and every revision through the current head are retained. The current
fingerprint must match the head and have been recorded by the analysis time.
Incomplete preservation or global delivery/budget guards block the proposal.

Amounts and prices inherited from legacy numeric cells are explicitly labeled
legacy_sqlite_numeric_not_original_decimal. Expanding scientific notation creates a
plain representation of the same approximation, not newly exact financial evidence.

Drafts still require original swap/quote-contract verification, canonical economic
execution keys across providers, ownership revalidation and original decimal
quantities. Pre-generation fact eligibility remains unreviewed. No automatic
identity merge or legacy-result promotion occurs.

This is a conservative migration diagnostic, not a replacement for the existing
runtime execution-basis derivation. Ambiguous or inconsistent legacy values stay
available for review rather than being silently rewritten.

## Price coverage contract

The coverage port accepts immutable declared receipts, each with provider, claim ID,
chain/token, purpose, claim type, state, closed millisecond bounds, known-at time and
evidence references. It checks provenance presence and merges compatible declared
ranges within the purchase's 30-day interval.

This stage does not independently fetch or validate a provider's pagination, market
mapping or payload. Even full_window_range_declared retains
independentProviderCoverageVerified=false.

Wallet coverage, a single positive hit, healthy/complete service flags, missing
bounds, future knowledge and pending-review prices cannot prove full price coverage.
Contradictory copies of the same immutable claim are rejected; identical copies do
not extend coverage.

Missing coverage is reported as observing_with_coverage_gaps or historical_price_gaps.
It never establishes a failed opportunity, a loss or the absence of a high multiple.
A separately validated positive opportunity can be meaningful without a complete
negative-search range; this tool does not score or reject that positive evidence.

## Isolated usage

~~~bash
pnpm exec tsx scripts/legacy-purchase-coverage-preflight.ts --database /path/to/source.sqlite --source provider --event event-id
~~~

An optional --coverage path accepts an array of declared receipt objects. The CLI
prints hashed event references, diagnostic states and range gaps, not raw payloads,
wallet identities or source transaction references. No external API call is made.

Exit 0 means an external-validation draft exists, not live eligibility or complete
price coverage. Exit 1 means reconstruction remains deferred or below the confirmed
buy threshold. Exit 2 means invalid input or source-read failure.

The source reader retains its bounded row limits and indexed semantic lookup
requirements. A missing observation-leading canonical-link index remains a blocker;
no production index is created automatically.

## Remaining work

Original transaction verification adapters, original decimal recovery, provider
price-range proof adapters, canonical execution deduplication, coherent real-source
acceptance, formal target business mappings and separately approved migration/cutover
are still required. No old aggregate is converted directly into a purchase sample.

## Tests

~~~bash
node node_modules/vitest/vitest.mjs run packages/database/test/legacy-purchase-coverage-preflight.test.ts
~~~
