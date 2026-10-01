# Bounded Consumer History Requests SPAC

## Problem and scope

Individual purchase windows are bounded to 30 days, but token-level MIN/MAX aggregation merges separate purchases into a multi-month request. Combining that range again with candidate history makes source retrieval larger still. A moving requiredTo can also change the postcondition while retrieval is in progress.

Continue lifecycle Task 4 without modifying business thresholds, consumer proof rules, source quotas or candidate admission. This increment is request coordination, not complete market coverage certification.

## Design

- Select a single valid pending purchase interval in deterministic evaluation/start/end order; do not merge disjoint consumers.
- Skip intervals already covered at the existing coarse hourly fetching tolerance, retaining strict demands as pending.
- Retain bounded request audits so a completed shared job does not repeatedly attempt the same interval. An extended interval remains eligible. Oversized legacy envelopes do not suppress individual bounded intervals.
- Freeze the chosen interval in the existing request manifest for active and retrying market-history/Fomo-history jobs. Collection and canonical postcondition use the same manifest interval.
- Lazily replace only an oversized active manifest with a bounded selection; audit prior job and fact-link state. Do not reset its lease, cursor, status, attempts or retry time.
- Prefer the bounded consumer interval over the legacy candidate envelope for that request. When no consumer interval needs requesting, preserve the existing candidate-history fallback.
- Reuse one canonical token recovery job. Keep the existing 25-job planning batch, 30-minute terminal recheck cooldown, compare-and-set and audited terminal-reason restrictions.
- No new schema and no broad historical data rewrite. Solana addresses remain case-sensitive; other supported address keys remain normalized.

## Tests and acceptance

Cover disjoint intervals, extended-window retries, manifest freezing, legacy oversized manifests, coarse-covered selection, repeated planning idempotency, supported-chain/case behavior and candidate fallback. Run targeted tests, the full suite, build, type checks, imports, boundaries and browser tests before commit/deploy.

Production acceptance is read-only: verify release, six services and delivery=false, active manifest bounds <=30 days, bound_request audits, preserved queue state and disk >3GB. Report missing live examples explicitly. A completed request or an hourly point series is not a strict complete_range proof.

## Remaining work

Provider extrema/continuity certificates, frozen cohort denominators, shared provider budget correctness and all-chain real traces remain open. Partial source failure is not full coverage or evidence of a losing purchase. No completion ETA is inferred from service uptime.

## Local validation checkpoint

Targeted recovery/range/wakeup/source tests: 35 passed. Full unit suite: 782 tests across 194 files passed. Build, type checks, package-import smoke checks, module boundaries and both desktop/mobile browser tests passed. These checks validate request coordination, not complete provider coverage or end-to-end production convergence.
