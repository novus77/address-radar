# Manual Trader Identity Idempotency SPAC

> Status: Approved and implemented locally  
> Date: 2026-09-28  
> Scope: Developer console manual trader admission, identity ownership, wallet-analysis deduplication, monitoring registration, and production repair

## 1. Executive Summary

The manual trader workflow currently treats every wallet-only submission as a new identity. A successful request can therefore be followed by a misleading client-side failure and a retry that creates a new synthetic account. The second request then conflicts with the wallet owner created by the first request.

The selected design makes manual admission idempotent without automatically merging established identities. A wallet already owned by one account reuses that account and entity, updates operator-managed metadata, and keeps monitoring enabled. A request is rejected only when it would cross an established identity boundary.

Wallet analysis creation follows the same principle. One chain, normalized address, requested sample count, and active lifecycle may have only one active job. Existing duplicate active jobs are deterministically superseded before a partial unique index is installed.

## 2. Production Incident

The trader `高倍巨鲸` was successfully persisted during the first request:

- lifecycle: `probation`
- priority: `important`
- monitoring enabled: true
- on-chain monitoring enabled: true
- wallet confidence: `confirmed`
- source tag: `source.manual`
- registry events: `identity.created`, `identity.wallet_resolved`
- initial 60-day wallet backfill: `collecting`

The client then threw while calling `event.currentTarget.reset()` after an asynchronous request. The UI reported the entire operation as failed even though the database transaction had committed. Retrying without a Fomo handle generated another synthetic account and produced `wallet_identity_conflict`.

The same wallet also accumulated five active analysis jobs because manual analysis and automatic initial backfill had no shared active-job identity.

## 3. Invariants

1. A normalized wallet belongs to at most one account.
2. A repeated manual submission for wallets owned by one account updates that account and entity.
3. The system never automatically merges two established accounts or entities.
4. An operator-provided handle may replace a synthetic `wallet-*` handle but may not silently replace another named handle.
5. Monitoring flags are monotonic during manual upsert; a metadata update cannot disable existing monitoring.
6. Locked status is monotonic during manual upsert; a normal-priority retry cannot unlock an important trader.
7. One `(chain_family, address, requested_sample_count)` tuple has at most one `collecting` or `review_required` analysis.
8. A committed admission is never reported as an admission failure because a later UI refresh or analysis-link action failed.

## 4. Manual Admission Decision Table

| Existing state | Requested state | Result |
| --- | --- | --- |
| No wallet owner, no handle owner | New identity | Create, HTTP 201 |
| All wallets owned by one account, no conflicting handle | Same identity | Update, HTTP 200 |
| New handle plus synthetic wallet owner | Same identity | Replace synthetic handle and update |
| Existing handle owner equals wallet owner | Same identity | Update |
| Existing handle owner differs from wallet owner | Real conflict | Reject, HTTP 409 |
| Submitted wallets have multiple owners | Real conflict | Reject, HTTP 409 |
| Explicit entity differs from the account entity | Real conflict | Reject, HTTP 409 |

## 5. API Contract

`POST /api/v1/traders/manual`

Created response:

```json
{
  "entityId": "manual-entity:...",
  "accountId": "manual-account:...",
  "displayName": "Early Alpha",
  "fomoHandle": null,
  "lifecycleStatus": "observing",
  "created": true,
  "updated": false
}
```

Idempotent update response uses HTTP 200:

```json
{
  "entityId": "manual-entity:...",
  "accountId": "manual-account:...",
  "displayName": "Early Alpha Updated",
  "fomoHandle": null,
  "lifecycleStatus": "observing",
  "created": false,
  "updated": true
}
```

Real conflict response:

```json
{
  "error": "wallet_identity_conflict",
  "reason": "wallet_owned_by_another_trader",
  "chainFamily": "solana",
  "address": "...",
  "conflictingAccountId": "...",
  "conflictingEntityId": "...",
  "conflictingDisplayName": "..."
}
```

## 6. Transaction Semantics

The server resolves handle ownership and every wallet owner before opening the write transaction. It then chooses exactly one target account and entity. The transaction performs:

1. account upsert;
2. entity upsert;
3. account-to-entity confirmation;
4. profile upsert with monitoring preservation;
5. wallet attachment;
6. additive tag attachment;
7. `identity.created` or `identity.updated` outbox publication;
8. registry version increment;
9. operator audit record.

No write occurs when identity ownership is ambiguous.

## 7. Wallet Analysis Idempotency

The create endpoint first searches for an active job with the same chain, normalized address, and requested sample count. If found, it returns HTTP 200 with `reused: true`.

The database migration ranks duplicate active jobs in this order:

1. `review_required` jobs;
2. deterministic `initial-wallet-backfill:*` jobs;
3. other collecting jobs;
4. newest update timestamp as a tie-breaker.

Non-winning jobs become `failed` with `last_error = 'superseded_duplicate'`. A partial unique index then enforces the invariant for `collecting` and `review_required` jobs.

## 8. Console Behavior

- The form node is captured before asynchronous work.
- A real identity conflict receives a Chinese operator-facing explanation.
- A repeated submission reports `已更新观察交易员`.
- Analysis association failure is a warning after successful admission, not an admission failure.
- List refresh failure is reported separately.
- Static responses already use `Cache-Control: no-store`; an already-open page still requires a refresh after deployment.

## 9. Production Repair

The production repair is executed only after backup and migration validation:

1. run duplicate-analysis migration with writers stopped;
2. deploy the idempotent API and console;
3. resubmit `高倍巨鲸` through the local API with `style.early_launch`;
4. confirm one entity, one wallet owner, expected tags, monitoring enabled, and one active analysis;
5. keep Gateway delivery disabled.

## 10. Acceptance Criteria

- Repeating the same wallet-only request returns HTTP 200 and the original IDs.
- Repeating the request does not increase entity, account, or wallet counts.
- New tags and profile metadata are applied to the existing entity.
- A known handle belonging to another account still returns HTTP 409.
- Duplicate active wallet analyses are superseded and cannot recur.
- Manual admission, monitoring registration, and backfill remain connected.
- The production trader has `source.manual` and `style.early_launch`.
- No user-facing Gateway signal is delivered during repair.

## 11. Rollback

- Retain the previous release directory and database backup.
- Repoint `/opt/address-radar/current` to the previous release if application behavior regresses.
- Do not remove the unique index during application rollback; the invariant is backward compatible.
- Superseded analysis jobs remain auditable as failed records and are not deleted.
