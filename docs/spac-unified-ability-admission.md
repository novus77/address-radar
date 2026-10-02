# SPAC: Unified Ability Admission and Closure Query Performance

## Confirmed problems

Candidate admission and wallet-analysis completion bypassed producer capacity checks. Fact-recovery dispatch could remain indefinitely blocked while these producers replenished the active queue. A two-hour interactive read query consumed CPU, but was not a business service; it was terminated with explicit authorization. After termination the closure API returned in 3.43-6.42 seconds. The current ability coverage query still scanned snapshots without a strategy covering index. This explains avoidable cost, not every previous timeout.

## Unchanged business rules

Keep candidate admission, opportunity-based ability, the 30-day window, identity ownership, real entry-price requirements and disabled Gateway delivery unchanged. Neither queued work nor unavailable data is successful execution.

## Architecture

All built-in ability evaluation producers use the SQLite bounded enqueue path. Persist immutable inputs and idempotency keys in `automation_admission_intents` when the owner is active or capacity is full. An intent is not an automation job and has no execution receipt. Admission creates the job and records its actual ID atomically; records remain for audit. Claims promote due intents only in the requested lane and enabled job types, excluding busy subjects before the bounded selection. Admission capacity is checked again for every promotion. Restart does not lose pending intents.

Ordinary daily/candidate/wallet-analysis producers use the daily budget of 900 workers plus the dispatcher slot. Recovery-triggered work can use the existing 1,000 active-job budget. No larger queue limit is introduced. Legacy custom job-store adapters retain their existing enqueue contract; the deployed SQLite store provides the bounded operation.

A revision dispatcher must observe an actual active job before acknowledging dispatch. Capacity-only intents are not marked as executed or dispatched consumers.

## Migration

Create the admission table with the base schema. Create covering indexes only after outcome, fact-attempt and execution schemas exist. Indexes cover current strategy/window/entity/evaluation time, global outcome time, and recovery attempt completion time. Production runs only the additive table/index SQL, not a bulk legacy repair. Preserve verified database backup and the previous release.

## Validation

Test durable deferral, stable idempotency, restart recovery, per-owner exclusion, capacity rechecking and retained audit. Verify SQL plans use covering indexes and existing closed-loop counts retain their semantics. Run targeted tests, full tests, types, build, import smoke, boundaries and browser tests before commit and deployment. Production acceptance independently measures active jobs, waiting admission intents, actual evaluations and consumer execution receipts.

## Remaining work

An initial over-capacity queue must drain; existing jobs are not cancelled to manufacture capacity. Source-fact obligations and capacity admission intents are separate counters and must not be summed as distinct traders. Historical price/milestone/early-trade gaps, unresolved wallets and historical signal-window disposition remain separate closure requirements. Do not call this a complete business closure until real upstream facts reach verified downstream consumer receipts.
