# Wallet Bundle Detection SPAC

**Status:** Approved  
**Date:** 2026-09-25  
**Scope:** Address-event aggregation, signal qualification, persistence, and developer-console diagnostics

## 1. Goal

Prevent coordinated or commonly controlled wallets from inflating trader consensus while retaining their complete capital-flow evidence.

## 2. Rules

- Purchases of the same token by different monitored entities within 10 seconds are suspected bundle evidence.
- A delta of at most 5 seconds is strong timing evidence.
- A wallet pair observed together on at least two distinct tokens is a confirmed recurring relation.
- Every temporal bundle counts as one independent participant for signal qualification.
- A confirmed recurring relation counts as one independent participant whenever both members appear in the same signal window.
- Bundle members retain their original events and purchase amounts. Only consensus votes and probability contribution are collapsed.
- A bundle contributes its strongest member score, not the probabilistic combination of all member scores.
- Fomo/on-chain canonical deduplication remains upstream and unchanged.

## 3. Diagnostics

Each token evaluation stores the raw participant count, independent participant count, bundled participant count, bundled buy amount and share, and the detected bundle groups with their timing level and recurring-confirmation state. The developer console presents these fields in Chinese. Public radar signal payloads remain unchanged.

## 4. Persistence

`wallet_bundle_pair_tokens` stores one auditable row per wallet pair and token. Re-evaluating the same token updates timing observations without increasing distinct-token evidence. A relation becomes recurring only through distinct token IDs.

## 5. Degradation

Bundle persistence failure must fail the current aggregation transaction rather than silently inflate consensus. Missing funding-source evidence does not block scanning; timing evidence remains available and is explicitly labelled as suspected or strong rather than common ownership.

## 6. Acceptance criteria

1. Two high-quality wallets buying within 10 seconds count as one participant.
2. Their USD amounts remain included in aggregate capital flow.
3. Two appearances of the same pair on different tokens produce a confirmed relation.
4. Confirmed pairs are collapsed in later signal windows even when their latest buys are more than 10 seconds apart.
5. Non-related traders retain independent votes.
6. Console aggregation rows expose raw and independent counts plus Chinese bundle diagnostics.
