# Legacy Manual Identity Signal Handoff SPAC

## Confirmed scope

Recognize validated historical manual wallet mappings for signal participation without promoting identity confidence or merging identities. Preserve monitoring-off policies and suspended lifecycles. Do not change opportunity thresholds, scores, time windows, or Gateway delivery.

## Root cause

Production has 107 observing entities whose manually resolved identities retain confidence `high`. Wallet collection already runs, but profile synchronization requires confirmed links. Separately, the profile reader previously treated every canonical `high` wallet as mapped, creating inconsistent identity predicates.

## Implementation

Use one mapping predicate for profile synchronization and profile reads. Continue recognizing confirmed identities. Additionally recognize canonical `high` identities only from `legacy:fomolens_manual`, and existing account-wallet mappings only when the account confidence is high or confirmed and the wallet is high from `fomolens_manual`. Enable FOMO monitoring only with an existing explicit non-wallet-only account link backed by the trusted mapping. Never create an account from a wallet.

Signal participation still requires an eligible observing lifecycle or explicit manual/locked designation. Suspended entities remain disabled even when marked manual. An explicit monitoring-off policy takes precedence.

## Data repair and safety

- Select only approved mappings; do not globally trust high confidence.
- Preserve confidence, addresses, identity links, lifecycle, and source data.
- Save affected profile values before repair and write a bounded audit record.
- Reconcile existing profile flags through the repository API.
- Preserve task idempotency and monitoring policies.
- Do not reactivate suspended entities or enable Gateway delivery.
- Roll back to the preceding release if service health fails; profile snapshots support field-level rollback without restoring the entire database or losing new events.

## Acceptance

Regression cases cover approved wallet-only and explicit FOMO mappings, non-manual high confidence, low/medium confidence, ordinary unadmitted candidates, suspended/manual-suspended entities, confidence preservation, and monitoring-off behavior.

Targeted tests: 10 passed. Full suite: 706 passed, zero failures. Type checking, build, package import smoke, boundary checks, and desktop/mobile end-to-end tests passed before commit.

Production acceptance must separately verify eligible profile growth, unchanged trust metadata, no suspended/off participation, service stability, continued collection, and actual downstream projection. Profile growth alone does not establish that a new qualifying market signal exists. Upstream missing milestone/price/early-trade facts remain separate blockers.

## Production checkpoint: 2026-10-01 11:37 Asia/Shanghai

Release `f5ff094-manual-trust` was deployed with bounded, audited reconciliation of 108 eligible identities. Signal-enabled profiles increased from 1 to 108: 108 on-chain and 107 explicit FOMO profiles. Identity metadata fingerprints remained unchanged. Suspended/off participation violations and destructive business operations were zero. No duplicate wallet jobs or outbox items were created.

All six services were active with zero restarts. Gateway delivery was confirmed false in all six running processes. The initial post-deployment log sample contained no SQLite lock matches. Disk available was approximately 3.12 decimal GB.

Between the two short acceptance checks, pending signal projections decreased from 456 to 429. There were 28 produced projection outcomes after repair; these are evaluation/projection records, not new user broadcasts. Opportunity snapshots increased from 65 to 78. The initial check recorded one wallet observation collected after repair; no additional wallet observations were recorded in the short follow-up interval.

This checkpoint passes the identity eligibility repair and demonstrates downstream reevaluation consumption. It does **not** establish complete business closure: no fresh legacy-manual buy evidence was observed in the short interval, ready signals remained eight, and candidate evidence still had 1,477 source-blocked tasks. A real qualifying purchase and continued upstream fact recovery remain required for full-chain acceptance.

The production audit at `/var/lib/address-radar/manual-trust-f5ff094-reconciliation.json` preserves pre-repair profile values for field-level rollback. The previous production release and verified pre-deployment database archive remain available; no historical transaction or token data was deleted.
