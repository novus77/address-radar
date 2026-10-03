# Forward target control-plane acceptance

This slice provides a read-only adapter for existing SQLite registry linkage and an opt-in authenticated asynchronous console extension. It does not activate a second business writer, permanent PostgreSQL tables, platform following, a browser collector or radar delivery. The existing console CLI deliberately does not install the extension.

## Trust and audit boundaries

- Read source identity rows in a read-only SQLite transaction. Reuse confirmed association and trusted `fomolens_manual` wallet rules. An ordinary manual wallet placeholder does not become a FOMO account.
- Identity evidence references attest existing registry linkage, not a new independent chain/platform ownership proof. Ambiguous owners, pending wallet conflicts, future source clocks and missing subjects do not gain monitoring eligibility.
- Preserve actual channel monitoring flags and suspension. Manual importance, notes and tags never grant radar access.
- Require a validated bearer token and a server-configured principal for this extension, including on loopback. Never derive actor, permissions, identity confidence, ownership or timestamps from JSON.
- `POST /api/v2/forward-targets/hydrate` accepts only entity/channel/subject/family. It versions the source snapshot and reads the real authorization decision in the same PostgreSQL unit of work.
- `POST /api/v2/forward-targets/manual-authorization` accepts an immutable authorization ID, entity, explicit grant/revoke action and audit basis. Serialize command retries by entity; preserve the first server timestamp and reject reused IDs with changed meaning.
- `GET /api/v2/forward-targets/state` exposes current decision and explicitly labels identity verification as the last hydrated snapshot. `GET /api/v2/forward-targets/registry` uses the existing bounded filtered reader and its continuation cursor.
- Production composition must supply the actual decision/registry readers and transactional runner. Continuous source change hydration, authenticated UI composition and signal-time revalidation must precede business cutover. No freshness tolerance or authorization bypass is invented.

## Verification scope

Use an explicit isolated acceptance URL and `ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false` to run `node scripts/verify-postgres-forward-target-control-acceptance.ts` after building. The real driver fixture creates temporary PostgreSQL tables, reads an owned disposable SQLite fixture through the read-only adapter, exercises HTTP authentication and immutable grant/revoke auditing, and rolls back the entire acceptance transaction. The fixture delegates sequential HTTP operations to its outer transaction; it does not prove separate production HTTP commits or multi-client concurrency. Six target revisions and two manual events are synthetic counts, not production progress.

Before deploying this acceptance artifact, retain the current business release, verify all six gateway flags remain false and verify the intentionally paused FOMO process stays paused. Actual schema activation, operator UI, continuous registry reconciliation, live-source coverage and permanent business cutover remain separate gates.
