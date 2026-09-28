# Closed-Loop Metric Dictionary

## Purpose

This document defines the durable facts used to measure Address Radar's progress from token discovery to signal readiness. A service being active or a job reaching `completed` is not evidence of business progress. Progress means that a canonical fact was added, updated, or moved to a terminal state with an explicit reason.

## Shared Rules

- `discovered`: Distinct entities observed at or before the stage.
- `eligible`: Distinct entities whose prerequisites allow this stage to run.
- `pending`: Eligible entities with runnable or scheduled work remaining.
- `blocked`: Eligible entities waiting for an external fact, provider, or manual action.
- `completed`: Eligible entities whose stage postcondition is satisfied.
- `terminal`: Entities that cannot proceed and have an explicit non-retryable reason.
- `producedFacts`: Canonical facts created by the stage. Job completions are not used as a substitute.
- `oldestPendingAt`: Oldest creation or eligibility timestamp among pending work.
- `lastProgressAt`: Latest canonical-fact creation, postcondition satisfaction, or terminal transition.
- Freshness windows are reported at 15 minutes, 1 hour, and 24 hours.
- Manual identity work is excluded from automated queue convergence metrics.
- Deferred work is not runnable backlog, but remains visible with its next retry time.

## Stage Definitions

| Stage | Eligible population | Completion fact | Primary durable source | Freshness expectation |
| --- | --- | --- | --- | --- |
| `token_discovery` | Tokens observed on supported chains or confirmed by Fomo | Canonical historical token | `historical_tokens` | Live ingestion within 5 minutes |
| `market_history` | Discovered tokens with a supported market identity | Sufficient price/market observations for milestone evaluation | `market_observations`, historical price storage | Historical backlog progresses hourly; live data within 10 minutes |
| `milestone_confirmation` | Tokens with usable market history | One or more canonical milestone crossings, or terminal no-crossing result | `token_milestone_crossings`, `token_fact_status` | Within 15 minutes after market facts arrive |
| `early_trade_recovery` | Tokens with a qualifying milestone and recoverable source window | Canonical early buy/sell facts, or terminal source reason | `early_trades`, `recovery_fact_links` | Within 30 minutes after milestone confirmation |
| `identity_resolution` | Distinct source handles or wallets in early trades | Canonical trader/wallet mapping or explicit manual-resolution state | identity and wallet mapping tables | Automated mappings within 15 minutes; manual backlog reported separately |
| `candidate_evidence` | Resolved traders with eligible early-trade facts | Candidate evidence rows or explicit zero-output outcome | `candidate_evidence_v3`, `automation_job_outcomes` | Within 15 minutes after prerequisites exist |
| `ability_evaluation` | Traders with sufficient candidate evidence/history | Ability evaluation snapshot or explicit insufficient-sample outcome | ability evaluation tables, `automation_job_outcomes` | Within 30 minutes after evidence changes |
| `candidate_admission` | Traders with current ability evaluation | Admission snapshot with admitted/rejected/deferred decision | `candidate_admission_snapshots` | Within 15 minutes after evaluation |
| `wallet_monitoring` | Resolved identities admitted or manually marked for observation | Per-chain coverage cursor and observations, or explicit unsupported status | `wallet_chain_coverage`, `wallet_monitor_observations` | Live cursor within 10 minutes; backfill progress hourly |
| `token_aggregation` | Eligible wallet/Fomo buy observations | Token aggregation state with contributing identities and amount | aggregation storage | Within 5 minutes after source observation |
| `signal_readiness` | Aggregations meeting strategy evaluation prerequisites | Ready/rejected/deferred signal decision with reasons | signal decision and delivery outbox storage | Within 5 minutes after aggregation change |

## Productivity Metrics

| Metric | Numerator | Denominator | Interpretation |
| --- | --- | --- | --- |
| Productive job rate | Jobs with `produced_count > 0` | Attempted jobs | Separates useful work from no-output completion |
| Recovery closure rate | Recovery fact links in `satisfied` or `terminal` | Recovery fact links created | Measures whether recovery reaches a durable conclusion |
| Early-trade conversion | Tokens with canonical early trades | Tokens with qualifying milestones | Detects the current milestone-to-wallet bottleneck |
| Evidence conversion | Traders with candidate evidence | Resolved traders with eligible early trades | Detects identity/evidence loss |
| Admission conversion | Traders with current admission snapshot | Traders with current ability evaluation | Detects decision-stage loss |
| Wallet coverage rate | Healthy or complete identity-chain rows | Required identity-chain rows | Must be reported by chain and provider |
| Queue convergence | Completion rate minus admission rate | Runnable jobs over the same window | Positive is draining; negative is accumulating |

## Baseline at Diagnosis

The following values are a point-in-time diagnostic baseline, not thresholds:

- Historical tokens: `8,065`
- Tokens with milestone crossings: `732`
- Fomo-confirmed tokens: `610`
- Tokens with recovered early buyers: `72`
- Canonical early-trade facts: `1`
- EVM wallet observations: `0`

This baseline shows that the primary loss occurred between milestone/source recovery and canonical early-trade creation. Later-stage job counts must not be interpreted as healthy until the fact conversion metrics advance.

## Acceptance Use

Production acceptance must compare direct read-only SQL results with the developer console for every stage. A mismatch is a metric-integrity defect. A stage with no progress must provide a reason-code distribution; `unknown`, an empty list, or service health alone is not an acceptable explanation.
