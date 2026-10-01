# Historical price page resume SPAC

## Scope and boundaries

Reuse complete DefiLlama hourly pages after an interrupted historical recovery. Keep existing scoring, candidate admission, source quotas and schemas unchanged. A cached page is not a new fact and does not certify opportunity extrema or complete consumer coverage.

## Acceptance contract

- Resolve prices by canonical chain and contract, preserving Solana case.
- Require every requested hourly timestamp, positive finite prices, the same source, and a covering source attempt with finite confidence in [0, 1].
- Missing, empty, sparse, unproven or incompatible pages use the existing HTTP path.
- Consult the cache before acquiring the physical request gate; cached pages do not invoke the persistence callback or record a new source attempt.
- Preserve inclusive millisecond request boundaries and cancellation behavior.
- Keep logical chart budget accounting unchanged; physical budget attribution remains a separate planned increment.

## Implementation and validation

Add a read-only page reader, an optional backward-compatible chart cache callback, and scanner wiring. Test complete reuse, missing pages, source and confidence rejection, hourly gaps, canonical identity and fractional-second boundaries. Run targeted and complete tests, build, typecheck, smoke, module boundaries and browser tests before commit and deployment. Verify six production services, disabled delivery, disk headroom and real checkpoint evidence without claiming an unobserved business closure.

## Risks and fallback

Old observations without matching quality metadata deliberately miss the cache. Timestamp grids that differ from provider request grids deliberately miss the cache. Resume reduces repeated requests but does not solve unavailable historical data, wallet identity gaps, strict extrema coverage or storage capacity. The prior release remains the rollback point.

## Local validation

2026-10-01: the new resume regression initially failed because the first complete page still made an HTTP request. After implementation, 17 targeted tests and all 816 unit tests in 203 files passed. Build, typecheck, package smoke, repository boundaries and both desktop/mobile browser tests passed. The fetch test double parameter typing was corrected before this successful validation. Production deployment and live cache-hit observation are separate acceptance gates.
