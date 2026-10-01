# Immediate Historical Page Checkpoints: Production Acceptance

## Release and local verification

Release: `859fdda-page-checkpoints`. Rollback release: `b3010e4-partial-history`.

Passed 26 targeted tests, 803 unit tests across 201 files, build, typecheck, package import smoke checks, module boundaries, and two desktop/mobile browser tests. The cross-connection integration test proves first-page data and partial audit commit before a later page fails. Consumer demand stays pending. Duplicate data does not inflate the audit.

## Approved storage maintenance

Recent radar logs and warnings were preserved under `/var/log/address-radar/maintenance-20261001T114046Z-page-checkpoint`. Only archived system journals were vacuumed after rotation. Journal usage changed from 93.3M to 62.9M. Disk availability changed from 3,046,318,080 to 3,078,082,560 bytes, a net gain of 31,764,480 bytes. No business database, event data, backup, rollback release, persistent configuration, or service was removed or changed by this cleanup.

## Production snapshot

At 2026-10-01T11:42:26Z (19:42 China Standard Time), current pointed to `/opt/address-radar/releases/859fdda-page-checkpoints`. All six services were active with NRestarts=0 and ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false. Zero matching SQLite contention, invalid budget, missing-table, or fatal entries appeared in the last five minutes. Existing additive schemas were verified by the deploy script; this checkpoint introduced no new schema.

Disk available after deployment: 3,064,528,896 bytes. Storage headroom remains thin. Shared provider gate rows were present. Oversized active history manifests: zero.

## Progress and acceptance limits

- Opportunity-v4 distinct evaluated entities: 279, versus 277 at the previous stage acceptance.
- Candidate evidence facts: 1,439, unchanged.
- Early trade recovery completed: 1,708; pending: 412.
- Recovery satisfied: 2,195; pending: 3,071; terminal: 532.
- Candidate evidence blocked: 1,961.
- Runnable: 137; runnableDelta15m: +52; converging=false.
- Signal projection runnable: 44 in the immediate post-deployment snapshot; this does not establish persistent scheduler starvation.

No page-price audit record had yet been observed, so production triggering remains unverified. Local proof and deployed readiness are not evidence of a real successful provider page in production. Full page-resume optimization, source coverage/exhaustion proof, physical budget attribution, and full lifecycle acceptance remain open. No reliable overall completion estimate is available.
