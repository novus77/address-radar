# Provider Budget Coordination SPAC

## Verified implementation defects

Source recovery checks budgetUsage and then addBudgetUsage in separate statements. Independent consumers can observe the same remaining quota and both charge it. Market-history recovery captures its minute window before awaiting the primary provider and reuses that old window for fallback.

Configured Gecko clients already share geckoterminal:public request spacing and cooldown between scanner and historical backfill. Do not remove that working coordination or change its existing interval. DefiLlama currently has no shared before-request gate, paginates up to 500 hourly points per HTTP request and applies one timeout to the whole chart call; those separate request-level issues remain open.

## Increment design

- Add an atomic compare-and-reserve ledger operation using the existing provider/window primary key, write-transaction retry support and conditional SQLite UPSERT.
- Reject an over-limit reservation without charging. Preserve existing usage rows, fractional units, provider isolation and caller-selected quota windows.
- Make recovery runtime consume this atomic operation instead of its read/add sequence. Keep the existing budget-exhausted retry outcome and lease release behavior.
- Resolve the minute window and future retry time at each primary/fallback budget consumption, not at the earlier market-observation timestamp.
- Preserve configured quotas, opportunity/admission policy, gateway delivery=false and partial factual progress. Do not infer coverage from quota reservations or successful service startup.
- No schema migration or broad data rewrite.

## Verification

Reproduce two connections spending the same observed quota and a runtime stale-read interleaving. Test rejected reservations, existing fractional ledger usage, provider/window independence and invalid inputs. Exercise a primary-to-fallback call crossing a minute boundary with actual source handlers.

Run targeted tests, complete unit tests, build/type/import/boundary checks and desktop/mobile browser tests. Commit and deploy only after all checks pass and disk remains above the existing 3GB guard. Production acceptance must check the release, services, delivery flags, budget usage and retry times, real fact progress and known missing data.

## Remaining boundaries

Atomic logical reservations do not yet provide atomic accounting for every paginated HTTP call. DefiLlama request-level hooks/cooldown, source capability contracts, source precision/extrema certificates and coverage denominators remain open. Do not declare Task 5 or the whole lifecycle complete after this increment.

## Local validation checkpoint

The frozen ledger test double was corrected with an object copy, without changing the production store's immutability. Targeted tests: 33 passed. Full suite: 790 tests across 196 files passed. Build, type checks, package-import smoke tests, module boundaries and both desktop/mobile browser tests passed. No production data was rewritten by this increment.
