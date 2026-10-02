# Address Radar FOMO Dual-Channel Monitoring SPAC

## Approved business definition

Monitor traders who repeatedly discover high-multiple opportunities, not only their known wallets. Realized profit is not required. Preserve admission thresholds and the 30-day ability window. A trusted, admitted FOMO account may contribute FOMO-only trade evidence without a resolved wallet. Wallet resolution proceeds independently.

USDT/USDC use nominal-dollar amounts with an estimation annotation. Entry prices require real execution evidence. Missing values are not fabricated. Gateway delivery remains disabled throughout rollout.

## Verified baseline

The scanner reads configured FOMO event journals. The original Live Feed observes inbound page WebSocket trading messages and activity-list responses. Trader profiles already have separate FOMO and onchain monitoring switches. Aggregation supports separate and combined source states and currently requires trusted mapping and an eligible lifecycle.

A confirmed account association already qualifies as trusted mapping without a wallet. Historical `high` associations alone must not be promoted. Existing browser capture does not prove that every target account is subscribed or covered. Independent production browser ownership and target subscription coverage remain to be verified.

## Architecture

Use the existing six-service architecture, canonical event store, source provenance, economic matching, aggregation and outbox. Add an Address Radar-owned browser adapter reusing demonstrated Live Feed observation behavior rather than creating a second scoring engine. Keep browser authentication local; never persist credentials in trade payloads, logs or journals.

A monitoring target is not a platform follow, a successful subscription, or proof of recent activity. Track these separately. Observe platform trade records, not arbitrary clicks or private browser activity.

## Phase 1: Eligibility and target registry

Expose FOMO account targets independently of wallet targets. Include an account only when its profile enables monitoring and FOMO monitoring, its trader lifecycle is probation/active/elite/degraded, its account exists, its association is confirmed, monitoring is not explicitly off, and there is no other trader association claiming that account.

Conservatively exclude ambiguous ownership; never pick an arbitrary owner or merge entities. Existing wallet-backed legacy FOMO eligibility remains unchanged in aggregation; expanding the new registry to legacy associations requires explicit trust evidence and tests. Return account ID, handle, entity ID and lifecycle. The registry method is an additive optional interface for compatibility with existing custom adapters.

## Phase 2: Browser ownership and subscriptions

Trace the actual authenticated browser collector and scrubbed account/activity responses. Verify how following or subscription controls event coverage before implementing writes to the platform. Maintain desired targets, applied target generation, platform subscription state and capture state independently.

Use a dedicated authenticated Address Radar browser session with incoming WebSocket and activity response capture. Preserve local authentication and support session-expired status. Start observation before page initialization. Do not assume DOM visibility or socket health means complete target coverage.

## Phase 3: Durable acquisition and recovery

Persist raw event ID, source account ID, chain, CA, side, occurred-at, collected-at, source trade/transaction ID when present, amount and execution provenance. Acknowledge acquisition only after durable insertion. Invalid records retain scrubbed dead-letter reasons.

Use bounded queues and shared source budgets with reserved realtime capacity. Separate live and historical cursors. Reconnection requests supported history for exact missing intervals; unavailable intervals remain uncovered, not complete. Report collector success separately from last trade time. Reconcile target generations after startup and changes without relying on wallet-only registry notifications.

## Phase 4: Canonical ownership and economic matching

Attribute only to trustworthy account ownership. Preserve source observations and revisions. Match FOMO and onchain transactions using strong available identifiers and existing conservative matching rules; time proximity alone is not sufficient. One economic trade contributes once. Distinct buys remain distinct. Ambiguous duplicates remain visible and must not inflate qualified totals.

## Phase 5: Aggregation and signal handoff

Use source-specific trust and monitoring eligibility. Confirm that FOMO-only admitted traders reach projection and aggregation without wallet resolution. Retain admission, amount, independent-trader, bundle-risk and signal policy gates. Missing chain/CA blocks token attribution; missing execution price blocks price-dependent evidence, not raw ingestion.

A generated signal, a projection receipt and user delivery are separate facts. Historical replay must not create a live alert or acknowledge an out-of-window live consumer.

## Phase 6: Console and production acceptance

Show desired/account capture/platform subscription/wallet capture states, freshness, last trade, last successful acquisition, lag, pending acknowledgement, uncovered intervals and explicit aggregation exclusions. Chinese labels must explain missing prerequisites rather than expose raw codes alone.

Trace a real trusted FOMO-only account buy through capture, durable insertion, canonical identity, projection, aggregation and policy result. Trace a matched onchain counterpart without duplicate contribution; a distinct later purchase must remain distinct. Test logout, reconnect, restart and disabled/conflicting identities. No market trade is manufactured to demonstrate a passing signal.

## Rollout safeguards

Each phase runs targeted tests, full tests, types, build, import smoke, module boundaries and browser tests before commit and deployment. Production changes use verified backups, additive migrations where required, rollback release and the existing disk guard. Run bounded readonly acceptance after deployment. A phase with no applicable production event is awaiting verification, not fully accepted.

No broad rewrite of old identity confidence, no automatic account follows, no credential extraction, no bulk cancellation, no business-data deletion and no enablement of Gateway delivery.

## Open verification boundaries

Platform subscription coverage, independent browser capability, stable account identity evidence, available reconnect history and provider limits require real traces. These are technical verification gates, not permission to relax trust or admission. Any new core policy choice returns to the user for confirmation.
