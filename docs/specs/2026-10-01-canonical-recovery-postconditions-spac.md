# Canonical recovery postconditions: Task 4 implementation slice

## Verified problem

The production scanner's recovery postcondition accepts `available` or `partial` metadata without independently checking persisted canonical records. This can make a recovery link appear satisfied for the wrong interval or stale metadata, even though the downstream consumer remains unable to evaluate.

## Implementation scope

Replace the live status-only predicate with read-only verification of persisted records:

- Price history: matching chain/token and the actual requested range, checked using the existing hourly recovery coverage policy, rejecting invalid/future intervals and interior gaps.
- Milestones: a persisted, non-unavailable, non-future crossing with valid timestamp and source.
- Early trades: a real matching buy at or before the earliest known crossing.
- Market identity: a positive finite persisted market price at a valid non-future observation time.
- Trader attribution: an existing wallet mapping, not a fabricated metadata record.

Canonical proof is checked before obsolete terminal metadata. Without canonical proof, terminal and deferred states remain explicit. Unsupported fact types do not become ready merely because metadata says available.

## Business boundaries

Do not alter discovery/admission/recurrence thresholds, ownership, data retention, or delivery flags. Do not introduce a new maximum price-gap rule: retain the existing hourly recovery predicate.

Hourly recovery acceptance does not prove tick-complete 30-day non-hit opportunity coverage. This slice does not manufacture complete-range consumer proofs, claim all early buyers were recovered, or guarantee source acquisition-time precision. Recovery satisfaction is evidence of an existing required record, not a unique newly produced fact count.

## Migration and regression handling

No schema migration or bulk rewrite is needed. Existing satisfied recovery links are not silently rewritten. A separate bounded audited repair remains necessary for previously incorrect derived results and links. The helper is wired into the production recovery handlers, not only the unused orchestrator.

## Validation and release

First run failing tests for phantom available metadata, interior price gaps, a mismatched/future interval, Solana case distinction, cross-chain identity, future milestones and post-crossing buys. Then run the actual handler and recovery-runtime suites, all unit tests, build, typecheck, import smoke, architecture boundaries and desktop/mobile E2E tests.

Deploy only above the existing 3 GB free-space guard, retain the current rollback point, and check all six services and disabled delivery flags. A successful deployment does not count as full lifecycle or provider-coverage acceptance.

## Remaining dependencies

Consumer-specific source precision/revision lineage, demand-aware recovery scheduling, source coverage proof publication, semantic consumer wakeup, honest UI denominators, and audited correction of old derived rows remain separate work.

## Local acceptance

The three targeted suites passed 14 tests. All 750 unit tests, build, typecheck, built-package imports, repository boundaries and two desktop/mobile E2E tests passed before release.

## Production checkpoint: 8cfab8a

Released to `/opt/address-radar/releases/8cfab8a-canonical-recovery` after all local gates passed. All six services were active with automatic restarts zero; Gateway delivery remained disabled.

At `2026-10-01T07:08:37.948Z`, a read-only bounded sample of the 100 most recently satisfied recovery links verified 95 market identities and 5 milestone records using the deployed predicate. The sample contained no early-trade or price-history links; it does not certify those production paths or the full historical cohort. Source-bounded positive proofs numbered 1,368 with zero detected interval/time/threshold violations in the read-only predicate check. Recent scanner/automation database error messages were zero; available disk was 3,170,217,984 bytes.

The next dependencies remain demand-aware recovery ranges, explicit source precision/proof lineage, semantic consumer wakeup, frozen-cohort denominators, and bounded audited correction of old derived rows. No old recovery links or historical business records were batch rewritten in this release.
