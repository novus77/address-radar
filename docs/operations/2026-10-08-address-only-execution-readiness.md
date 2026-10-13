# Address-only execution readiness

## Current acceptance status

The address-only database migration is complete. Production renewal-c completed successfully and produced the configured transition receipt `executionc`. Final verification confirmed transition journal phase `COMPLETE`, all six services active with actual bound readiness and `NRestarts=0`, and gateway delivery false in all six service environments. The active release inventory SHA256 is `96a27d5532419694c9ce0af1b99a04986ea871710113cd59565fee7c7808f038`. Transition success is distinct from monitoring acceptance: `sourceMonitoring=configured_pending_observation` and `monitoringCompleted=false`. Price, safety, and complete radar capabilities remain missing.

## Confirmed migration baseline

The address-only migration `20261008-final4` completed with 216 wallet profiles and 122 entities: 119 Solana addresses and 97 EVM addresses. Historical tokens, transactions, market facts, and automation jobs were not imported. The original SQLite database, independent backup, import manifest, and migration receipts remain preserved. Final verification confirmed PostgreSQL cohort count 216; both the original database and independent backup are root-owned mode `0400`, each 4,619,636,736 bytes. The global current release remains unchanged at the reported `4b48...` prefix, preserving the existing FOMO release path. No historical facts were carried into the new runtime as current evidence.

## Approved technical scope

Enable bounded address-channel capture and independently replayed execution publication. The initial configured scope is **Solana, BSC, and Base**: their source/replay chain and genesis checks have passed. Ethereum source genesis probing returned error `4444`; Ethereum is disabled and must not be counted as configured coverage. Future Ethereum enablement requires successful actual source/replay identity checks.

Keep gateway delivery, FOMO collection changes, and full historical mining disabled. Preserve existing business qualification rules. Use explicit provider contracts and durable shared limits: 60 requests per minute per origin, concurrency one, and provider Retry-After handling. Source and replay endpoints must have matching chain/genesis pins and verified stable-token mappings. A different hostname alone is not sufficient evidence of independent ownership.

The controller environment must contain source primary RPC endpoints only. Replay endpoints belong to the execution authority configuration. The generated mixed primary/replay RPC environment file is audit material and must not be used directly as a service EnvironmentFile: collector fallback would lack a matching producer.

Use a dedicated execution publisher login with one connection, separate from all six consumers and the migrator. Approved configured connection allocation is eleven, with three reserved and two unallocated out of sixteen. Signing keys and publisher credentials remain server-local, digest-pinned, and readable only by the dedicated wallet-monitor runtime UID. Root-private maintenance copies use the same credential bytes with separate ownership and permissions. Do not include secrets in logs, command arguments, source control, or this document.

## Completed technical milestones

- The configuration generator supports execution-only configuration without fabricated price, source, risk, or independence authority metadata. Missing capabilities remain explicit gaps, not validated safety evidence.
- Independent execution replay validation and CLI publisher wiring are implemented. Source/replay binding includes Solana genesis and EVM chain ID, genesis block hash, and stable-token mapping; conflicts are rejected before publisher runtime construction.
- Server-local material generation and the actual provisioner credential contract are integrated: a 32-byte random hex password, execution-publisher service binding, credential digest preservation, and distinct runtime/maintenance file permissions.
- Actual PostgreSQL authority provisioning covers six providers, six provider contracts, one execution validator, and a least-privilege execution publisher. A read-only operator access path is available. This is authority infrastructure evidence, not evidence of published execution facts.
- Solana, BSC, and Base source/replay chain and genesis checks have passed. Ethereum remains disabled.
- Configured release construction, sealing, native preflight, and renewal-c recovery completed successfully, with transition receipt `executionc`. All native execution checks reported true. This establishes the execution transition milestone, not completed source monitoring or complete radar closure.

## Test evidence

The coordinator reports the following completed validation runs:

| Validation run | Passed | Skipped |
| --- | ---: | ---: |
| Final fulltest-c run A | 354 | 25 |
| Final fulltest-c run B | 3029 | 107 |
| Relevant TypeScript checks | 2 | Not applicable |
| Recovery regression tests | 53 | Not reported |

Fulltest-c completed in 33.65 seconds. Its log is `/private/tmp/address-only-final-tests-20261008c.log`. The final counts above supersede the earlier 3016-pass run.

Skipped tests are not passed acceptance checks. These results support implementation validation; they do not substitute for native transition completion, live capture, independent replay, committed fact publication, or end-to-end monitoring evidence.

## Current native observation and recovery state

- Production renewal-c succeeded with receipt `executionc`; the final transition journal phase is `COMPLETE`. All six services are active with actual operation/generation/release-bound readiness and `NRestarts=0`. Gateway delivery is false in all six service environments.
- Measured capacity evidence reports available RAM of 3,022,626,816 bytes and available disk of 5,876,547,584 bytes. Reported per-service memory use is approximately 46-58 MB. These are point-in-time observations, not a sustained-load acceptance claim.
- All native execution checks reported true. PostgreSQL data and migration audit artifacts remain preserved; no SQLite write restoration was performed or authorized.
- Observed capture count is zero. EVM checkpoint progress has been observed, but checkpoint movement alone is insufficient to establish transaction capture, independent replay, or committed execution publication.
- Diagnostic code has been implemented but has not been deployed; it must not be described as part of the verified production runtime.
- Database migration is complete, but capture remains zero and `monitoringCompleted=false`. There is no accepted claim of address monitoring completion or complete radar closure.

## Previous failure and recovery

Earlier attempts were blocked during bounded transition recovery. Review identified that exhaustion of the execution deadline could prevent durable persistence of `REBLOCK_REQUIRED` and reblocking, leaving intermediate phases outside the original renewal checkpoint allowlist. Native-proof expiry also required handling through activation completion rather than only at deploy entry. Recovery addressed these failure paths while preserving original request/journal bindings and PostgreSQL data. Renewal-c subsequently succeeded; 53 recovery regression tests passed. The previous blocked/paused state is historical, not the current production state.

## Remaining verification and acceptance gates

1. Preserve the verified `executionc` transition receipt, original import manifest, migration receipts, and root-read-only source/backup artifacts. Keep the global current release unchanged.
2. Deploy and verify the implemented diagnostic code through a separately pinned release change before relying on it for production observations.
3. Demonstrate real forward capture for the enabled chains, independent replay, committed execution fact publication, durable cursor/checkpoint behavior, provider budget enforcement, resource limits, and gateway delivery remaining false.
4. Report address execution monitoring acceptance separately from price, safety, source attestation, opportunity coverage, and complete radar closure. Do not enable or claim Ethereum coverage until its source identity probe succeeds.

## Explicit remaining capability gaps

- Independent price validation and dynamic mapping acquisition are missing from the accepted scope.
- Source-candidate validation does not independently attest the complete source envelope; it must not be published as a fully attested source fact.
- Risk and participant-independence safety authority remain missing. Genuine evidence acquisition and documented decision rules are required; missing evidence remains deferred and must not default to validated.
- Limited candle observations do not prove complete non-hit coverage.
- Zero capture, a quiet wallet interval, an active service, checkpoint movement, or a completed task does not prove end-to-end radar success.

Technical milestones, database migration completion, execution monitoring, and full radar acceptance are separate claims. Renewal-c establishes the successful configured execution transition milestone. The current state does not establish business eligibility, safety verification, monitoring completion, or complete radar closure.
