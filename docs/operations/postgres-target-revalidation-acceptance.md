# Forward target source revalidation

## Contract

The existing verified legacy registry reader remains the only source of identity facts. The new worker rechecks both registered channels with an explicit bounded per-channel budget and caller-owned cursors, interleaves execution, and preserves disabled or conflicted targets in the registry scan so that one source cannot starve the other. No timer, browser, follow action or external request budget is introduced implicitly.

A revalidation assessment has an explicit clock shared with the consuming evaluation. Verified source facts, current target versions, the current authorization stamp and a refresh receipt are committed atomically. Changes become effective when observed; source observation time is preserved separately. A source missing or unavailable receipt blocks fresh consumers without deleting identity history or counting absence as capability failure. Recovery rechecks the source instead of guessing identity.

The fresh authorization reader requires a matching assessment-clock receipt and rechecks the actual current authorization stamp. An intervening revocation, ownership change or target revision blocks reuse. There is no invented cache TTL. Consumers must use this reader, not the legacy snapshot-only authorization reader. Continuous runtime scheduling, durable cursor checkpoint composition and permanent business schema activation remain explicit integration gates; this increment is not evidence that the production pipeline already runs the worker.

## Isolated proof

The acceptance script uses a dedicated loopback PostgreSQL connection and owned session-local TEMP tables. It verifies FOMO-only manual eligibility, independent wallet monitoring, source disable and recovery, missing and unavailable source failures, assessment-clock fencing, revocation fencing, ambiguous ownership, and rollback of a channel update if receipt insertion fails. It does not activate business writers, migrate SQLite, resume FOMO or send signals.

## Confirmed forward signal boundary

The user confirmed that old contribution-score and age-dependent large-buy gates stay only in the legacy route. The forward route uses verified eligible identities, at least two independent traders in fifteen minutes, and a qualifying single buy of at least 50 nominal USD, with actual entry evidence and existing provenance/deduplication/risk gates. Legacy lifecycle-specific signal policy is not silently modified. Unknown risk thresholds and provider budgets remain unresolved configuration decisions, not guessed defaults.
