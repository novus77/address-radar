# Code-only release material candidates

## Scope

Preserve the active PostgreSQL generation, source registrations, request budgets,
validator definitions, eligibility rules and safety flags while rebinding a staged
release. Source-replacement generators are not used for a code-only update.

## Implementation

`produce-code-only-release-material.mjs` accepts a bounded JSON input containing
current material, the completed configured origin, a code-stage receipt and a
canonical private output directory. It returns deterministic file contents and
hashes without filesystem access, network access, database access or activation.
Only release bindings and derived material references change. All other values
are copied unchanged, including source endpoints and authority validity data.
Returned file contents are private material and must never be logged or committed.
The summary contains no endpoint or credential values.

## Acceptance and remaining gates

Unit tests cover unchanged sources and budgets, deterministic hashes, invalid
origin bindings, unsafe flags, entry-path mismatch and output traversal rejection.
A candidate is not deployment authorization or a verified release. This module
cannot authenticate supplied documents, verify the sealed on-disk release or
check database-ledger freshness. A protected host wrapper, independent validation,
native preflight, current lifecycle verification and controlled rollback remain
required before production use. No controller may consume these candidates as
activation-ready solely because generation succeeded.

## Production state

Commit 5ccd26a is staged only. No source replacement, schema import, service
restart or signal delivery is performed by this development phase.

## Reported-price binding

When approved reported market-cap acquisition is enabled, the caller must provide
its existing reported-price authority material and environment references. The
candidate rebinds only that authority's release hash and its environment file/hash
references. Approval evidence, expiry times, validator settings and provider
contracts remain unchanged. Missing or mismatched material is rejected. An unused
reported-price authority is also rejected, not silently carried into the candidate.
Protected input authentication and ledger freshness remain external gates.
