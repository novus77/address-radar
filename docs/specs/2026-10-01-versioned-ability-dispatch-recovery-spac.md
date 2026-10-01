# Strategy-versioned historical ability dispatch recovery

## Verified production blocker

At 2026-10-01T13:58:19Z the daily dispatcher had an exhausted cursor for day 20,727 without a strategy version. It was pending until 2026-10-02T00:00:00Z. All non-dispatch ability workers were completed or cancelled; none were active. Only 534 distinct traders had versioned opportunity-v4 worker completions, despite 11,351 eligible traders in the current coverage inventory.

The dispatcher treats an old strategy's finished daily scan as finished for the new strategy. Event-triggered work advances some traders, but the historical population is not actively queued for the new definition.

## Repair

- Persist `strategyVersion` in dispatcher checkpoints.
- Resume within a day only when both day and strategy match; otherwise restart from the beginning.
- At startup, rearm only pending/retryable dispatcher rows whose checkpoint belongs to another or an unspecified strategy.
- Reset that cursor and make its next attempt no later than startup time. Do not mutate leased/running dispatchers or unrelated jobs.
- Preserve the existing batch size, active-job high-water mark, priority policy, idempotency keys, and backpressure delay.
- Current-version completed workers remain idempotent; restarting enumeration must not duplicate their business facts.

No score, admission, buy amount, stable ability definition, or delivery setting changes. No bulk mutation of historical evaluations is required.

## Tests and acceptance

Test legacy exhausted startup recovery, preservation of current-version next-day scheduling, lease ownership safety, legacy restart versus current-version continuation, and existing reduced-capacity backpressure behavior. Run targeted tests, the full suite, typecheck/build/smoke/boundaries/browser tests.

Deploy only above the disk floor. Read-only acceptance must observe the versioned cursor, historical worker enqueueing within the existing high-water bound, and increased distinct current-version evaluations. Distinguish enqueue progress from completed assessments and candidate/signal production.

## Independent execution revision follow-up

User approved audited same-event/same-identity real execution revisions without identity merging or guessed prices. Code inspection found that retained enrichment revisions do not automatically replace an existing `trader_events` row inserted with `INSERT OR IGNORE`. However, a production audit at 13:55:36Z found zero missing trader events and zero stale amount/price values among 124,405 projected Solana observations; only 365 retained estimated execution bases were present. This is a verified latent propagation risk and a separate coverage gap, not evidence that stale rows are currently blocking historical dispatch. Keep the original facts, revision audit, canonical matching, projection invalidation, and consumer refresh together in its own implementation phase.

## Local validation

- Red regression: two behavior failures reproduced the exhausted legacy cursor and missing version restart; eight existing/preservation tests passed.
- After implementation: 17 targeted tests passed.
- 839 unit tests across 206 files, typecheck, build, package smoke, boundaries, and two browser tests passed.
- Deployment remains subject to the unchanged 3 GB free-space floor. Do not report production recovery before the versioned cursor and worker completions are observed after deployment.
