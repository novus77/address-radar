# Radar closure and database closeout implementation plan

## Scope and invariant

Continue from the completed address-only PostgreSQL migration. Retain the 216-address cohort, all source seals and receipts, and the independent backups. Do not import historical tokens or restart global historical mining. Keep FOMO integration unchanged and gateway delivery disabled. Existing opportunity, admission, amount, participant-count, observation-window, and risk rules remain unchanged.

## Evidence at start

The production wallet monitor had 205 automatic restarts, while the console was active. Capture, purchase, and token-discovery counts remained zero. PostgreSQL occupied approximately 17 MB and had no idle transaction. Startup acceptance is therefore not steady-state monitoring acceptance.

## Ordered work packages

1. Restore observable, bounded collection. Preserve sanitized collector failures and lifecycle failure phases. Identify the actual exception before changing deadlines or quotas. Distinguish canceled collection from uncertain transaction completion; never advance a checkpoint for uncommitted capture.
2. Support safe configured-release iteration. Bind each update to the previous complete journal, receipt, sealed release, unit identities, and original import anchors. Explicit recovery from a degraded service must be separately recorded, followed by a full block and new native preflight. Do not assume old process IDs survive automatic restart.
3. Close execution-to-source evidence. Independently attest the exact current sample, execution revision, target and target version. Recheck authority validity, revocation and revision at publication. A candidate or execution signature alone is not a source attestation.
4. Close price-to-opportunity evidence. Acquire real price data through bounded provider contracts, preserve provenance and quality, and verify observations before publishing. Limited candles are not complete non-hit coverage. Missing history remains deferred, not failure or synthetic success.
5. Close safety and participant evidence using existing rules. Use genuinely acquired evidence and existing authorized decisions. Never replace missing risk or participant-independence evidence with default approval.
6. Verify consumer receipts and radar readiness. Follow capture, normalization, economic trade, purchase sample, price/source evidence, opportunity, capability, aggregation and readiness for the same current revision. Preserve the distinction between an ineligible observation, an unfinished window, unavailable evidence and processing failure.
7. Close database operations. Produce a bounded consistent logical backup, restore it into an inaccessible test database, verify the retained cohort and schema invariants, and record owners/ACLs as a separate provisioning obligation. No business-data deletion, forced WAL truncation or SQLite write restoration.

## Release and acceptance gates

Each release must pass targeted regressions, full tests and relevant type checks, then use a new sealed inventory and digest-pinned configuration. Preserve all previous production receipts. Native acceptance must measure actual service identities, current processes, PostgreSQL role privileges, provider budgets and live committed facts.

Required observations are stable restart counters, committed capture with matching checkpoints, actual purchase samples from real transactions, revision-bound consumer receipts, and a readiness result with a specific eligible or ineligible reason. A quiet wallet is not an error, but it also cannot prove the live buy path. Fixture success is not production coverage.

The database migration may remain complete while these radar gates are pending. Do not report the full radar loop as complete until its real-data evidence exists.
