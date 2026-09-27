# Fomo Token Verification Gate

## Objective

Remove unsupported-chain and false-token noise before historical milestone reconstruction or smart-money discovery. Raw discovery records remain immutable for audit and recovery.

## Active scope

- Solana
- Ethereum (`eth` is canonical)
- BSC
- Robinhood
- Base

Monad and every other chain are marked `unsupported` and excluded from active analysis.

## Identity and deduplication

The canonical identity is `canonical_chain + normalized_contract_address`. EVM addresses are lowercase; Solana addresses preserve case. A token name or symbol is never an identity key.

## Fomo verification states

| State | Meaning | Analysis eligibility |
| --- | --- | --- |
| `pending` | Waiting for a lookup | No |
| `queued` | Lookup sent to the logged-in collector | No |
| `confirmed` | Chain and full CA match a Fomo token | Only when history is available |
| `deferred` | Provider, login, timeout, or legacy-result ambiguity | No; retry |
| `not_found` | Two healthy lookups could not find the token | No; quarantine |
| `mismatch` | Search result exists but chain or CA differs | No; quarantine |
| `unsupported` | Outside the four-chain scope | No |

A provider failure never increments the consecutive-not-found counter. Raw tokens are never physically deleted by verification.

## Processing gate

Milestone and pre-milestone trade partitions may run only after every token in the partition has a terminal verification result. The worker sends only `confirmed + history_available` tokens to Dune. A partition containing pending verification is delayed without consuming a Dune query credit.

## Runtime transport

The historical service writes lookup requests to `ADDRESS_RADAR_FOMO_LOOKUP_QUEUE_PATH`. A logged-in Fomo collector returns structured results to `ADDRESS_RADAR_FOMO_LOOKUP_RESULT_PATH`. Network responses are preferred; DOM extraction is the fallback. Results must report explicit verification status, exact-address match, and history availability.

Legacy results with positive holder, trader, or observation counts are accepted as confirmed. Empty legacy results are deferred rather than treated as not found.
