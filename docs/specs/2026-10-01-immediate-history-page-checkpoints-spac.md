# Immediate Historical Page Checkpoints SPAC

## Scope

The prior patch preserves completed pages when a later request raises a handled error. Its error-only persistence still leaves an entire chart vulnerable to process termination before error propagation. This checkpoint commits each successfully parsed nonempty page before starting the next request. It is not page-resume optimization or complete coverage certification.

## Design and invariants

- Add an optional awaited internal per-page callback to HistoricalTokenPriceClient.chart, preserving existing callers and chart result semantics.
- Deliver immutable validated in-range price points; do not certify empty pages as coverage.
- Complete the HTTP timeout boundary before waiting for database persistence.
- Reuse the existing transactional price/fact/attempt write path for immediate pages and error fallback.
- Emit page-price audit records only when new observations are inserted. A later error fallback must not duplicate the same page audit.
- Persist each nonempty page as partial, never complete a consumer demand or task from a page callback.
- Preserve available/conflicted/terminal fact status and use existing retry scheduling on request or persistence failure.
- Stop pagination if the persistence callback fails. No new HTTP request is issued until the previous callback returns successfully.
- Use unique write-attempt IDs so same-clock pages cannot collide in the audit ledger.

## Safety and remaining work

No schema migration, broad historical rewrite, quota increase, scoring change, or signal delivery activation. The durable boundary is the completed transaction; termination during a transaction may roll back that page but cannot invalidate previously committed pages. Full page-resume logic, empty-page source exhaustion proof, physical per-request budget accounting, and strict extrema/continuity coverage remain open.

## Acceptance

Tests require a first-page commit visible to an independent SQLite connection before a failing second request, immutable callbacks, empty-page exclusion, and propagation of persistence failures. Run targeted and full tests, build, typecheck, package smoke checks, boundaries, and desktop/mobile browser tests before deployment. Production acceptance distinguishes page-price observations from legacy partial-price errors; never claim production page checkpointing was observed when its audit prefix is absent.
