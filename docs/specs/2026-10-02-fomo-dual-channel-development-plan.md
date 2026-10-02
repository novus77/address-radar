# FOMO Dual-Channel Monitoring Implementation Plan

> Execute in the current session using executing-plans. No subagent delegation.

**Goal:** Trusted admitted FOMO accounts are monitored independently of wallet discovery and feed the existing radar pipeline.

**Architecture:** Add target selection to the existing monitoring registry, then integrate an owned browser acquisition adapter with existing canonical events, durable checkpoints, projection and aggregation.

**Tech Stack:** TypeScript, pnpm, SQLite, Vitest, Playwright.

## Phase 1: Target registry

Files: `packages/identity/src/monitoring-registry.ts`; new `packages/identity/test/fomo-monitoring-registry.test.ts`.

- [ ] Write regression tests for a confirmed admitted account without wallets, unconfirmed ownership, candidate/suspended lifecycle, monitoring off, disabled FOMO switch and conflicting ownership.
- [ ] Run the new test and observe missing registry capability.
- [ ] Add optional `fomoAccounts()` to the registry interface; implement deterministic immutable targets with conservative ownership exclusions.
- [ ] Run targeted and complete validation. Commit, deploy without a schema migration, and record production target counts separately from active capture.

## Phase 2: Owned browser capture

Start by locating the active collector and tracing a real authenticated page session. Existing reference: original plugin `src/fomo/websocket-observer.ts`; integration boundary: `apps/scanner/src/collectors.ts`.

- [ ] Document target subscription semantics from actual messages/responses; do not infer full coverage from sample traffic.
- [ ] Capture redacted fixtures and test startup interception, inbound activity, session expiry and subscriptions.
- [ ] Introduce a small owned adapter after locating its runtime; connect it to the target registry and existing event ingress, not a second engine.
- [ ] Persist desired/applied target generation and report subscription/capture coverage separately. Platform follow writes require separate authorization.
- [ ] Validate, commit, deploy and trace one real account event.

## Phase 3: Durable replay and budgets

Boundaries: scanner collection acknowledgement, existing FOMO request lifecycle and source budgets.

- [ ] Test crash before/after insertion, duplicate replay, disconnect gaps, historical overlap, invalid records and exhausted budgets.
- [ ] Connect insertion acknowledgements to acquisition checkpoints; reserve realtime capacity and schedule exact supported gap recovery.
- [ ] Keep unsupported gaps visible. Validate, commit, deploy and inspect recovery and freshness.

## Phase 4: Identity and matching

Boundaries: database trader profiles, `packages/aggregation/src/canonical.ts`, economic matching and revision consumers.

- [ ] Test FOMO-only ownership, matched transaction, distinct same-sized buys, ambiguous ownership and late revisions.
- [ ] Reuse canonical matching; separate source observations from economic contribution. Do not lower trust or automatically merge accounts.
- [ ] Validate, commit, deploy and compare contribution counts with source records.

## Phase 5: Projection and aggregation

Boundaries: `apps/automation/src/signal-projection-worker.ts`, `packages/aggregation/src/service.ts`, signal policy.

- [ ] Test admitted FOMO-only evidence, disabled sources, missing execution basis, historical replay and mixed-source deduplication.
- [ ] Remove wallet prerequisites only where independently trustworthy FOMO ownership suffices; preserve all scoring and risk gates.
- [ ] Validate, commit, deploy and trace policy outcomes without delivering to users.

## Phase 6: Console and final acceptance

Boundaries: console application and workbench, existing observability APIs.

- [ ] Present target, subscription, capture and wallet states separately with Chinese labels.
- [ ] Add browser tests for no-wallet targets, explicit gaps and exclusions.
- [ ] Validate, commit, deploy and run real-event end-to-end acceptance with bounded readonly queries.
- [ ] Report verified results, remaining external limits and waiting real events separately.

## Validation commands

```sh
pnpm exec vitest run packages/identity/test/fomo-monitoring-registry.test.ts
pnpm test
pnpm typecheck
pnpm build
```

Use the repository's current import-smoke, boundary and browser scripts after checking their configured command names. These commands are a plan, not evidence of execution. Each stage retains delivery-disabled configuration and release rollback.
