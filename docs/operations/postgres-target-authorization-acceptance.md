# Isolated forward target authorization acceptance

## Scope and trust boundary

Add a versioned PostgreSQL channel registry and an independent manual radar grant/revocation ledger. A trusted FOMO-only target needs no wallet; a trusted wallet-only target needs no FOMO account. Registration defaults to monitoring, never radar. Ordinary notes and labels are not authorization inputs. The existing confirmed-association and high-confidence `fomolens_manual` wallet exception are preserved, with explicit evidence references and unique ownership required.

Write methods require an internal authenticated principal with separate registry-write and radar-authorization-write permissions. These are service contracts, not public self-asserted HTTP credentials. No console endpoint or production identity hydrator is activated. Actual adapters must derive principals from authenticated server context and identity facts from trusted ownership records, never request-supplied confidence or actor fields.

## Persistence and decisions

Channel revisions, manual commands and authorization-change intents commit atomically. Replay retains the original availability and audit. A conflicting confirmed claim quarantines the binding for both entities without merging or reassignment. This slice does not automatically resolve such conflicts. Disabled monitoring, suspension, missing ownership evidence and ambiguous identities block manual as well as system qualification.

Historical reads separate effective and known times. Revocation wins over a grant at the same effective time; late replay cannot restore authority. An authorization stamp binds the semantic target/binding/manual/capability versions. Downstream consumers must re-read eligibility and validate the stamp before queued signal projection/delivery. This stage supplies that validation interface but does not claim an actual signal consumer or transport is wired.

System qualification requires a capability head evaluated at the decision's explicit `asOf`; no unapproved freshness tolerance is invented. A semantic clock-only refresh retains the capability version and stamp. A manual grant is independent of missing capability, but does not bypass identity, monitoring or other signal gates. The existing stable-capability consumer must supply current decisions before system participation.

## Acceptance

```sh
node scripts/verify-postgres-target-authorization-acceptance.ts
```

Provide the dedicated localhost acceptance URL through the protected environment and keep Gateway delivery false. All synthetic records use transaction-local temporary tables and roll back, including interrupted outbox writes. Fixture counts are not live users or production progression.

Candidate observation is shown separately from stable capability. Legacy two-Early/one-Strong admission and historical statuses are not rewritten or mapped to new classes. The authenticated registry hydrator, console actions/read models, explicit candidate integration, signal/aggregation receipts, live-source acceptance and permanent schema/write-path cutover remain open work.
