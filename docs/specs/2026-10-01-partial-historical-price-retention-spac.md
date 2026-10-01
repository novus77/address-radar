# Partial Historical Price Retention SPAC

## Problem and scope

DefiLlama chart collection merges successful pages only in memory. A later page failure discards that progress and prevents recovery from persisting already-observed prices. This checkpoint preserves authentic completed-page prices across later-page throttling, cancellation, and errors. It does not certify full extrema coverage, change opportunity rules, or introduce a schema migration.

## Design

- Extend the internal DefiLlama error with an optional immutable partial result while preserving existing status, retryability, and error behavior.
- Preserve only validated, in-range prices from completed successful pages, never fabricated observations or the failing page.
- At the recovery boundary, atomically write retained observations and a partial attempt audit through the existing write-transaction wrapper.
- Use existing partial fact state where allowed. Do not downgrade an available fact or automatically reopen terminal facts.
- Re-throw the original transport failure so scheduling and backoff remain unchanged. Never complete a consumer demand or wake it as covered merely because some prices were saved.
- Make observation writes idempotent across retries. Count newly inserted rows in the attempt audit.
- Leave full-range continuity proof, exact extrema certification, per-page physical budget attribution, and skipping already-fetched pages as explicit follow-up work.

## Safety and acceptance

No broad old-data rewrite, schema change, identity merge, quota increase, business-policy change, or signal delivery activation. Real partial observations remain available to later recovery while the demand remains pending. Tests cover later-page 429, cancellation, no invented coverage, durable persistence, duplicate retries, and preservation of existing availability. Run targeted/full tests, build, typecheck, package smoke checks, module boundaries, and browser tests before committing/deploying. Production acceptance is read-only and distinguishes deployed readiness from an observed real partial-page event.
