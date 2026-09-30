# Source Recovery Deployment Checkpoint

## Implemented

- Recovery attempt telemetry, execution timestamps, fair job selection, deadlines and lease fencing.
- Shared multi-pool milestone reconstruction with estimated precision and supply basis.
- DefiLlama historical price requests split at the observed 500-point API limit.
- Durable FOMO milestone lookup handoff with bounded revision retries.
- Transaction-level early-buy reconciliation and fact-revision downstream requests.
- Independent recovery execution metrics in the console.
- Explicit indexed-history fallback URLs and a 30-minute cooldown for unsupported routes.
- Malformed and ERC721 transfer logs are excluded from fungible-token swap extraction.
- Explicit, audited, idempotent recovery repair; dry-run default; at most 20 selected jobs.

## Validation

- Full Vitest suite: 161 files and 649 tests passed.
- Workspace typecheck, build and built package import smoke check passed.
- Production evidence: DefiLlama HTTP 400 reports a maximum of 500 points.
- Production evidence: BSC indexed history returns HTTP 404; Robinhood failed parsing empty transfer data.

## Remaining acceptance boundaries

- BSC needs an operator-configured, verified free indexed-history endpoint; no endpoint is fabricated.
- Historical market-cap crossings reconstructed with current supply remain estimates.
- Recovery telemetry counts fact-state revisions, not necessarily new tokens or raw historical rows.
- Multi-process provider budgets and historical profit accounting require separate validation.
- This checkpoint does not claim that all historical data or all SPAC acceptance items are complete.
- Gateway delivery must remain disabled during deployment and acceptance.
