# DefiLlama Request Boundaries SPAC

## Scope and evidence

The client currently applies one timeout to a complete paginated chart. Scanner construction does not attach a shared request gate. Pagination therefore lacks the same cross-process spacing and cooldown used by GeckoTerminal. This checkpoint addresses transport boundaries, not business thresholds or strict historical coverage.

## Design

- Add optional backward-compatible beforeRequest and onRateLimit hooks.
- Acquire the shared gate before every HTTP page; cancellation remains effective during gate waits.
- Start a fresh timeout only after gate acquisition. Include response-body parsing in that timeout.
- Publish provider Retry-After cooldown for HTTP 429 before propagating the existing retryable error. Use a bounded fallback when the header is absent or malformed.
- Wire scanner DefiLlama requests to the database-backed gate at 3,000 ms spacing, matching the existing 20 logical calls per minute ceiling without increasing the configured quota.
- Keep existing logical budget accounting explicitly separate from physical HTTP spacing. Per-page budget usage and durable partial-page retention remain follow-up work.
- Keep unsupported chains explicitly empty and preserve Solana address case.

## Safety

No schema migration, identity merge, scoring change, broad old-task repair, or signal delivery activation. Maintain rollback release and the existing deployment disk guard. A failed page remains an error; do not return partial pages as complete coverage.

## Acceptance

Targeted regression tests cover gate wait timeout exclusion, per-page timeout renewal, every-page gating, Retry-After cooldown, and cancellation during gate waits. Run the complete unit suite, build, typecheck, package smoke checks, module boundaries, and desktop/mobile browser tests before deployment. Verify all six services, delivery=false, disk headroom, shared gate rows, and SQLite errors after deployment. Production service health does not prove full source coverage or a complete business closed loop.
