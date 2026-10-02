# Passive FOMO Browser Capture Checkpoint

## Implemented

The scanner has an opt-in localhost CDP observer using Node's built-in WebSocket and fetch. It attaches only to FOMO HTTPS page targets and does not read outgoing WebSocket frames, modify platform follows, navigate pages, or close the browser. The scanner closes only its observer connections during shutdown.

Validated trading-activity messages use stable source IDs, account IDs, supported five-chain mapping, nonnegative values and original occurrence time. Missing values remain null. Target attribution uses account IDs rather than handles. An ambiguous target owner does not produce an event.

The collector retains an uncommitted batch in its bounded in-memory queue, commits only that batch, rechecks revoked target ownership and reports overflow. Events enter the existing scanner as `fomo_stream`; no second aggregation or scoring engine is added.

## Feature gate

`ADDRESS_RADAR_FOMO_BROWSER_ENABLED` defaults to disabled. `ADDRESS_RADAR_FOMO_BROWSER_CDP_ENDPOINT` defaults to the credential-free loopback endpoint `http://127.0.0.1:9222`. The endpoint is not exposed publicly. Production rollout of this code does not authorize enabling the feature before the acceptance gates below.

## Remaining activation gates

- Validate the actual inbound FOMO socket origin and source-specific provenance, not only the page origin and activity schema.
- Persist raw acquisition and replay checkpoints before acknowledging durable coverage. The current in-memory batch cannot survive process restart; overflow and restart are uncovered intervals.
- Prove target subscription coverage on the authenticated page. A CDP attachment is not authenticated FOMO status or a complete monitored account feed.
- Acquire supported reconnect history and describe exact unsupported intervals.
- Reconcile overlap with original input synchronization and preserve economic-event deduplication before single-owner cutover.
- Run a real target-account transaction through normalization, insertion, projection and aggregation. Quiet traffic is not acceptance failure or proof of full coverage.

No production feature flag or historical confidence is changed in this checkpoint. The target registry currently contains 107 production accounts under existing trust rules, not 107 verified active platform subscriptions.

## Validation

Targeted activity, target filtering, collector acknowledgement and CDP boundary tests pass. Complete validation has 924 unit/integration tests, two browser tests, type checks, build, import smoke and boundary checks passing. These results validate software boundaries; they do not prove live platform coverage.
