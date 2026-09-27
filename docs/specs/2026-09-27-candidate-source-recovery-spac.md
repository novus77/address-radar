# Candidate Source Recovery SPAC

## Status

Approved for implementation on 2026-09-27.

## Problem

Candidate evaluation is progressing, but most jobs cannot produce evidence because one or more source prerequisites are absent. The current system records free-form diagnostics in `automation_jobs.last_error`, moves jobs to `blocked_source`, and waits for unrelated writes to wake them. The Scanner also starts the durable recovery runtime with no handlers. As a result, recovery jobs can be durable without being executable.

The system must distinguish scheduling health from source completeness. A missing source must not block unrelated work, but it must create an explicit, observable recovery plan and wake the original candidate evaluation only after verifiable data arrives.

## Goals

- Classify every source-blocked candidate job with a stable reason code.
- Persist the blocked dependency independently from free-form diagnostics.
- Enqueue idempotent recovery work before blocking the candidate job.
- Execute real recovery handlers for sources already available to the Scanner.
- Wake candidate evaluation immediately after a successful recovery.
- Expose blocked reason and recovery progress in the developer console.
- Preserve degraded operation when a provider is unavailable or rate limited.

## Non-goals

- Invent historical prices or milestone timestamps from a current quote.
- Treat a recovery attempt as successful when no new source fact was persisted.
- Add a second general-purpose scheduler.
- Enable Gateway delivery.
- Make Dune the sole historical source.

## Source Dependency Model

`CandidateSourceBlockReason` has the following values:

- `missing_token_identity`: chain or contract identity cannot be resolved.
- `missing_market_history`: no usable price observation exists at or before a milestone.
- `missing_milestone`: no verified market-cap crossing exists.
- `missing_early_trades`: no canonical buy event exists before the milestone.
- `missing_wallet_mapping`: a trade exists but cannot be assigned to a canonical trader.
- `insufficient_coverage`: source data exists but does not cover the required interval.

Each blocked automation job has one current block record containing the reason code, JSON context, recovery job identifiers, blocked time, last update time, and resolution time.

## Recovery Mapping

| Block reason | Recovery job | Completion condition |
| --- | --- | --- |
| `missing_token_identity` | `market_enrichment` | Canonical chain and contract metadata are persisted |
| `missing_market_history` | `market_enrichment` | A usable market observation is persisted; historical coverage is never fabricated |
| `missing_milestone` | `historical_research` | A milestone crossing with non-`unavailable` precision exists |
| `missing_early_trades` | `milestone_early_buyers` | At least one canonical buy before a milestone is persisted, or the source returns a terminal no-history result |
| `missing_wallet_mapping` | `identity_resolution` | The address maps to a canonical trader entity |
| `insufficient_coverage` | `historical_research` | Coverage includes the required start and end timestamps |

Recovery jobs use the existing `recovery_jobs` table. They remain idempotent by `(job_type, chain, subject_key)` through stable job identifiers.

## Data Flow

1. Candidate evaluation validates token metadata, milestones, early buys, price history, and trader identity.
2. On the first missing prerequisite, it persists an `automation_job_blocks` record and enqueues the mapped recovery job.
3. The candidate job enters `blocked_source` and consumes no scheduler capacity.
4. A recovery handler obtains data from an existing source adapter.
5. The handler persists facts before returning success.
6. Recovery completion invokes `wakeBlockedSource(tokenId, now, "candidate_evidence")`.
7. Candidate evaluation runs again from durable source data.
8. A successful evaluation resolves the block record.

## Recovery Handlers

The Scanner registers handlers instead of passing `handlers: {}`.

- `market_enrichment` uses the configured market provider and persists token state and a market snapshot. It may record a real-time estimated milestone only when the observation itself crosses the threshold. It does not backdate that milestone.
- `milestone_early_buyers` submits an idempotent Fomo milestone lookup request. Until imported canonical events exist, the recovery job remains retryable with exponential backoff.
- `historical_research` checks facts produced by historical partitions. It never calls Dune outside the existing historical research boundary. Missing facts remain retryable at low priority.
- `identity_resolution` wakes only when an existing identity mapping is present; otherwise it remains retryable for the manual or automated identity pipeline.

## Scheduling and Failure Policy

- Source-blocked candidate jobs are never time-polled by the automation scheduler.
- Recovery jobs use exponential backoff capped at one hour.
- Provider budget exhaustion is isolated to the recovery job.
- Terminal source responses enter `dead_letter` with an operator-readable code.
- Missing handlers are a deployment failure and appear in runtime diagnostics.
- Gateway delivery remains disabled independently of recovery status.

## Observability

The developer console reports:

- blocked candidate count by stable reason code;
- recovery job count by type and status;
- oldest unresolved dependency;
- blocked-to-woken conversion count;
- successful candidate re-evaluation count;
- recovery failures and dead letters.

Chinese labels are applied in the UI. Stored identifiers remain English.

## Acceptance Criteria

- A candidate without milestones creates one `historical_research` recovery job and one structured block record.
- A candidate without early buys creates one `milestone_early_buyers` recovery job instead of completing with no evidence.
- Replaying the same candidate does not create duplicate recovery jobs.
- Completing recovery wakes only matching blocked candidate jobs.
- Jobs with unrelated subjects remain blocked.
- The Scanner starts with non-empty recovery handlers.
- No recovery handler fabricates historical timestamps.
- Unit tests cover reason classification, idempotent enqueue, wake-up, retry, and console aggregation.
- Full build and test suite pass before production deployment.

## Rollout

1. Add schema and store behavior behind existing migrations.
2. Enable structured blocking and recovery enqueue in candidate evaluation.
3. Register recovery handlers in Scanner.
4. Deploy with Gateway disabled.
5. Compare `blocked_source`, recovery completion, and evidence production for at least two monitoring intervals.

