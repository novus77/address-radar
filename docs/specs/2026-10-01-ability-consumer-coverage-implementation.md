# Ability consumer coverage: Task 4 implementation slice

## Scope

This slice implements persistent coverage demands at the production ability worker, not merely at the unused token-fact orchestrator. It does not complete Task 4 or the overall lifecycle plan.

## Confirmed semantics

- Keep the approved USD 50 discovery floor and 30-day opportunity horizon unchanged.
- Positive evidence and complete-range non-hit analysis are independent demands.
- A verified partial 3x/5x opportunity remains useful without a sale or complete price history.
- An execution-complete job is not proof of complete price coverage.
- Sparse market points and legacy outcome status cannot manufacture continuous coverage.

## Data contract

`consumer_fact_demands` persists consumer, purchase, case-preserving chain/token identity, strategy, purpose, required interval, evaluation timestamp, reason, status, and proof payload.

Demand identity is stable across repeated evaluation of the same purchase and purpose. The required end advances only as the observation horizon advances; the store rejects older evaluations and conflicting identity reuse. Positive proof is retained when later collection is degraded, provided it still satisfies the same demand. Complete-range proof does not satisfy a larger interval.

The worker currently records derived evaluation references as positive-hit proof. These references are not raw transaction or provider provenance. Full source-revision and precision lineage remains outstanding.

## Production wiring

The actual `trader-ability-worker` writes both demands in a bounded write transaction after opportunity evaluation. The existing opportunity scorer continues to govern business decisions. This change does not create recovery jobs, pretend that providers satisfy coverage, or automatically change admission/lifecycle states.

The current history adapter does not supply continuous coverage proofs; complete-range demands consequently remain pending. That is an observable missing capability, not a claim of recovery completion.

## Migration and rollback

The explicit deployment migration adds an empty table and indexes. It does not alter historical observations, evidence, tags, or jobs. Runtime migrations remain disabled in production. Rollback uses the previous release with the additive table retained.

Existing accepted execution-basis migration remains idempotent. Deployment keeps signed Gateway delivery disabled and the 3 GB disk headroom guard.

## Acceptance

Run targeted database and actual-worker tests, then the complete unit suite, typecheck, build, package smoke imports, architectural boundaries and desktop/mobile browser tests. Production acceptance must verify the deployed release, additive schema, service states, delivery flags, and real newly generated demands when worker execution occurs. A schema-only check is not evidence of ongoing data progress.

## Remaining Task 4 dependencies

1. Map candidate and other consumer requirements to precise source revisions and supported precision.
2. Connect verified continuous provider coverage to the history adapter without inferring completeness from endpoints.
3. Link unmet demands to bounded recovery and explicit no-output explanations.
4. Wake consumers only after semantic demand satisfaction; prevent lower-quality late revisions from regressing proven facts.
5. Expose demand gaps and denominators in read-only diagnostics and the console.

Do not mark the Phase 1 gate complete until these dependencies and the frozen-denominator work are verified.

## Verified checkpoint: ddc0622

- 747 unit tests, typecheck, build, built-package imports, boundaries, and 2 desktop/mobile E2E tests passed.
- Production release: `/opt/address-radar/releases/ddc0622-ability-demands`.
- Six services active with zero restarts; delivery disabled in every process.
- Additive schema verified; first snapshot had no demands, subsequent natural worker execution produced 8,467 pending complete-range demands, 3,482 satisfied positive-hit demands and 4,985 pending positive-hit demands.
- These are per-purchase demands, not new wallets or a complete cohort denominator.
- No historical business-row rewrite or full-runtime migration was run.
- The production disk margin is thin; future releases must keep the existing guard.
