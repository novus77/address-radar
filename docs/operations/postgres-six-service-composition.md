# PostgreSQL wallet-first composition: bounded integration contract

This is development composition, not evidence of six production services being
activated or of business acceptance. No production SQL, import, restart or Git
commit is performed by this slice. FOMO, full historical mining and gateway
delivery remain disabled. The parent owns CLI dispatch, deployment verification,
schema installation, imported crosswalks, service ACLs and the final switch.

## Actual modules and schema exports

| Module | Public contract | Migration constant |
| --- | --- | --- |
| `apps/wallet-monitor/src/postgres-wallet-channel.ts` | `createPostgresWalletChannel`, `preparePostgresWalletCapture`, `resolveCapturedWalletPurchase`, `walletPurchaseBasisFingerprint` | `POSTGRES_WALLET_CHANNEL_SCHEMA_SQL` |
| `apps/automation/src/postgres-production-composition.ts` | `createPostgresProductionComposition`, `receivePostgresProductionPriceBatch`, `requestPostgresWalletSignalWake` | `POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL` |
| `apps/automation/src/postgres-service-fact-adapters.ts` | `createPostgresServiceFactAdapters`, `postgresServiceFactFingerprint` | `POSTGRES_SERVICE_FACT_SCHEMA_SQL` |

The constants describe new ordinary permanent tables. They are not executed by
these factories. Install the wallet schema after capture inbox and registered
generations, composition after wallet and signal schemas, and fact schema after
registered generations. Keep the existing v1 schema ledger unchanged. The parent
must include these exact constants in its approved v2 plan, not duplicate the SQL.

`wallet_capture_generation_bindings` references the actual composite revision
key `(source_namespace,source_event_id,semantic_fingerprint)` in
`capture_event_revisions`. Its generation/time index replaces JSON generation
extraction for capture metrics and consumer admission. The source-revision unique
constraint refuses a second generation binding. Capture append, binding insert,
normalization request and collector checkpoint advancement share one fenced UOW.
Existing unverified header generations do not authorize automatic old-row binding.

## Launch and runtime identity

The composition factory accepts an explicit business runtime, expected database,
username, schema, server address/port, service, schema version/fingerprint and
registered generation/activation time. Its probe must match these fields.
Required tables are checked against `pg_class` for ordinary permanent tables;
views, temporary/unlogged tables and missing objects cannot satisfy the check.
No SQLite fallback, generation creation, schema DDL or source acquisition occurs
at construction. The fact-port factory probes the same generation and otherwise
does not write at construction.

Parent-owned `scripts/postgres-service-entry.ts` and CLI guards are the launch
integration path. These hooks do not change the existing CLI implementations,
shared exports or project configuration. The automation-to-wallet module import
requires the parent-owned automation project reference; wallet-monitor must not
import automation back. Formal units must select the pinned same-release entry
script and private approved deployment, not silently launch old SQLite paths.

| Role | `activeStages` | `includePrices` / other poll |
| --- | --- | --- |
| scanner | `token` | `true` |
| automation | `normalization,purchase,fanout,signal` | `false` |
| wallet-analysis | `opportunity,capability` | `false` |
| wallet-monitor | not a consumer composition | `createPostgresWalletChannel().pollOnce` using actual existing RPC collectors |
| historical-backfill | not a consumer composition | `ports.targetedBackfillPoll`, factual prices only |
| console | no worker | read-only trace/metrics; no fact factory or polling |

Default composition stages remain all seven for compatibility. Explicit subsets
must be nonempty, unique and known. Active quotas must be positive, inactive
quotas may be zero, and the sum of active quotas must fit `maximumClaims`.
Rotation is within the active subset; run/claim/time/payload/sample/evidence
budgets remain bounded. Price polling defaults to true only for API compatibility;
the parent must pass false for non-price roles to avoid six duplicate polls.

## Fact-port factory and acquisition boundary

```ts
createPostgresServiceFactAdapters({
  runtime, generationId, maximumProfiles, now,
  sources: {
    leaseMs, maximumProfileAgeMs, maximumFactAgeMs, maximumSafetyAgeMs,
    providerTimeoutMs, maximumResponseBytes, maximumFactPayloadBytes,
  },
});
// Promise<{ profiles, facts, fetch, targetedBackfillPoll, enqueueSourceRequest }>
```

All listed budgets are explicit positive safe integers. `fetchImpl` is an optional
trusted dependency injection for tests; production uses the actual fetch. No
per-process provider allowance is created or reset by startup. Approved provider
origins, limits, imports and shared price-lease rows must already be installed.

`fetch` actually performs RPC requests, but only after a PG row lock, shared
window debit and concurrent-request lease commit. Request failures are charged.
The guard refuses unknown origins and redirects, applies abort/response-size
budgets, and releases its lease after consuming a bounded body. Collector-local
budgets do not replace this global guard. Migration must explicitly preserve the
reviewed old `cooldown_until`; the column is mandatory and has no default. Its
guard runs before window debit or request lease allocation. A 429 response
durably extends shared cooldown from valid `Retry-After` seconds or HTTP-date
before returning the response. Missing/invalid values persist
`POSTGRES_PROVIDER_COOLDOWN_PAUSED` (`9223372036854775807`): an explicit review
pause, not a guessed duration; `PostgresProviderBudgetError.retryAt === null`
reports that state. Startup and window rollover never reset cooldown. Only an
explicit reviewed migration/operations action may clear a review pause. Provider
lease cleanup/retention is also an operational responsibility, not startup work.

**No independent factual acquisition/validation producer is implemented here.**
The other ports read existing approved durable inputs. A migrated attestation or
an independently authorized producer must supply them. `enqueueSourceRequest`
records only an idempotent demand against an approved provider. It does not fetch,
validate, publish a purchase, or assert eligibility. Producer scheduling, fresh
attestation renewal, provenance validation and token mapping remain integration
prerequisites. Indexed HTTP 404 and transfer-only evidence are not purchase proof.

## Approved profiles and source contracts

`profiles.load` reads a bounded, coherent PG cohort plus latest enabled/suspended
profile versions, actual target-channel versions and identity bindings in one
SQL statement. An absent, ambiguous, over-budget or stale cohort defers; an
unverified empty cohort is not reported ready. The complete wallet selection is
required before advancing shared EVM block cursors, so profile overflow must not
silently paginate wallets. FOMO profiles are not selected.

The imported cohort stores the original account/entity/wallet crosswalk and
`legacy_registry_linkage` provenance. Latest state must be approved and current;
ownership bindings may not be fabricated from a wallet address. The target port
reports disabled/suspended profiles as disabled facts. The actual authorization
reader and policy, not this adapter, decide radar eligibility.

Durable inputs use `wallet_service_fact_inputs`, independent
`wallet_service_fact_attestations`, and migration-approved
`wallet_service_fact_validators`. SHA-256 fingerprints bind exact JSON payloads;
they are replay/conflict fingerprints, **not cryptographic proof of truth**.
Validity requires an independently approved validator distinct from the provider,
matching kind/fingerprint, approval provenance and bounded clocks/expiry. Producer
and validator ACL isolation is the trust boundary; granting runtime write access
to these tables defeats it.

| Kind | Subject key | Payload contract |
| --- | --- | --- |
| execution | fingerprint of `[chain,walletAddress,sourceReference,tokenAddress]` | `{canonical:"confirmed_execution",sourceReference,purchase:VerifiedForwardPurchase}`; execution evidence ref equals the persisted validation ref |
| price | producer's immutable canonical subject | `{type:"peak",peak:ForwardPeakEvidence}` or `{type:"market",market:recordMarketInput}`; source ref equals evidence ref |
| source | fingerprint of `[sampleId,executionFingerprint]` | `{sampleId,executionFingerprint,canonical:"confirmed_live_execution",target}` |
| risk | same exact sample subject | `{sampleId,executionFingerprint,verdict:"validated"|"blocked"}` |
| independence | same exact sample subject | `{sampleId,executionFingerprint,independenceKey}` from a real independent-actor assessment |

Canonical chain/token addresses must come from actual execution or an approved
provider mapping. There is no guessed symbol-to-token map. Price facts reuse the
existing `canonicalForwardPeak` and opportunity repository kernels: an actual
trade/candle with stable peak/revision IDs is required. A current market quote
cannot become entry price or a fake historical candle.

The purchase port rechecks current owner/account/profile gates and requires a
durably independently validated actual execution. The channel permits a known
USDT/USDC execution quote/token ratio as nominal USD entry basis, with estimated
amount retained. This is not proof of a contemporaneous USD peg. Injected purchase
quantities, keys and evidence must match the captured execution basis, or an
external persisted verifier basis must bind the full purchase fingerprint and
exact source reference. Missing basis, native/mixed ambiguous spend and missing
owner defer instead of inventing numbers. Real entry is never a current spot price.

The safety port checks the exact current-generation sample/revision and refuses
pending revisions, missing current ownership or missing/expired source, risk or
independence proof. `liveSourceVerified` is derived only after these validations.
Two distinct eligible actor keys, >=50 nominal USD qualifying buys, actual entry
basis and the 15-minute window remain enforced by the existing signal policy.
Manual authorization is not synthesized. Opportunity and capability policy still
uses 30-day observations and distinct-token 3x/5x evidence, without old score or
dust gates. Readiness does not enable gateway delivery.

## Consumer acknowledgements and wakes

Opportunity admission is generation-scoped and fingerprint-matched. A pending
sample intent is acknowledged in the same UOW as a durable idempotent work request;
stale executions are not acknowledged. The existing work repository also performs
this acknowledgement. Purchase receipts, opportunity/capability results and signal
readiness receipts use existing UOW repositories and lease fencing.

Signal jobs distinguish `pending`, `leased`, `idle`, `waiting_source`,
`waiting_threshold` and `expired`. Missing facts wait for an actual event, observe
waits for threshold evidence, and ready/observe do not endlessly requeue on time
alone. Expired 15-minute windows stop. Observation is not reported as applied
readiness progress. Idle/expired lease cleanup is bounded.

Bounded admission deduplicates immutable sample, trade revision, authorization,
capability and peak IDs using `wallet_forward_signal_wake_receipts`. Same-clock
events remain distinct. Wake receipts and job updates commit atomically; a wake
arriving while a lease is running increments `wake_generation` and is preserved
at completion. New independently validated source/risk/independence/profile facts
must call `requestPostgresWalletSignalWake` with their immutable revision ID in
the producer's fact transaction. Omitting this producer hook leaves a waiting job
waiting; there is deliberately no fabricated timer-only source confirmation.

Price batches hold the migration-seeded shared PG lease. Actual fact writes,
fanout requests and exact consumed fact IDs share a UOW with fenced lease release.
Oversized independent price backlogs drain in bounded batches; an opportunity
reader itself does not truncate required evidence into a false complete evaluation.
Peak fanout is a shared evidence service: it may wake other registered generations;
generation-bound consumer claims and receipts remain separate.

## P1 role/ACL distinction for migration coordination

Do not grant all DML on all v2 tables to six runtime users. Offline grants and
cutover/import roles must remain separate from consumer runtime permissions.

| Table family | Runtime allowance | Trusted owner / missing prerequisite |
| --- | --- | --- |
| import ledger, profile cohort/versions, fact validators | SELECT only | migration/approved registry roles; lossless cohort crosswalk and seed plan pending |
| fact inputs / attestations | SELECT only | separate real producers / independent validators; acquisition and proof renewal pending |
| provider budgets | SELECT; UPDATE only `(window_started_at,requests_used,cooldown_until)` | migration owns origins, caps, concurrency, import, initial window and reviewed initial cooldown; no runtime INSERT/DELETE |
| provider leases | SELECT, INSERT; UPDATE only `(released_at)` | retention/cleanup role owns pruning |
| shared price leases | SELECT; UPDATE only `(claim_generation,lease_owner,lease_expires_at)` | migration owns initial rows; no runtime INSERT |
| price consumption | SELECT, INSERT | only factual receiver commits; no runtime DELETE/UPDATE |
| source requests | SELECT, INSERT demand | producer role owns claim/status updates; runtime adapter does not validate demands |
| signal wake intents/receipts/jobs | bounded role-appropriate INSERT/UPDATE and SELECT | actual fact producers enqueue immutable wakes, automation consumes |
| capture generation bindings | SELECT, INSERT | only wallet capture UOW; no runtime rebinding UPDATE/DELETE |

Role-specific existing business tables must follow actual stage write sets, not
schema-wide grants. Console remains SELECT-only. This file describes a grant
contract; it does not apply ACLs. Cooldown updates do not authorize mutation of
provider seed metadata. Reviewed imports must not map unknown old cooldown to zero.

## Remaining acceptance gaps and tests

The parent must complete approved seed/crosswalk migration, permanent schema and
least-privilege role installation, live producer/independent validator contracts,
exact token mapping, producer wake integration, formal six-unit launch/deployment
evidence, and console read/UI parity. A four-stage metrics JSON endpoint plus
forward trace is not a complete console. Historical-backfill must never invoke the
old broad batch miner. Scanner must supply actual price/market evidence without
fallback entry valuation; wallet-analysis must consume actual evaluations rather
than fabricate stable capability. Reorg/canonical execution invalidation requires
the external execution/live-source producer; this adapter does not implement an
RPC reorg reconciliation worker. No full six-service or G20 acceptance is claimed.

The three scoped test files exercise mocks, real repository/policy adapters and
actual existing wallet execution collectors. They cover generation binding order,
missing facts, purchase injection rejection, atomic failures, active stage subsets,
lease fencing, same-clock wake deduplication, source acknowledgement and provider
budget/price consumption boundaries. Type validation uses an isolated temporary
config and bundled Node. These are not six live PG role/concurrency tests. Dedicated
PG integration tests require a separately approved isolated target; absence of
that target is a skip, not production proof.

```sh
node node_modules/vitest/vitest.mjs run \
  apps/wallet-monitor/test/postgres-wallet-channel.test.ts \
  apps/automation/test/postgres-production-composition.test.ts \
  apps/automation/test/postgres-service-fact-adapters.test.ts
```

## Physical producer handoff (bounded wallet-first slice)

`apps/automation/src/postgres-wallet-rpc-producer.ts` exports
`createPostgresSolanaExecutionProducer` and the typed
`PostgresSolanaExecutionCandidate` / `PostgresSolanaExecutionAcquisition` contracts.
This is physical RPC acquisition, not a seeded fact/inbox replay adapter. Its factory
is side-effect-free; `acquire({payload, signal})` refetches the captured signature
using `getGenesisHash`, `getSignatureStatuses`, `getTransaction`, and `getBlock`.
The explicit factory inputs are `generationId`, `activatedAt`, `providerId`,
`expectedGenesisHash`, `rpc`, `profiles`, `maximumProfiles`, `maximumPayloadBytes`,
`maximumRunMs`, and `now`. The `rpc.request(chain, method, params, signal)` port
must use the existing configured wallet RPC transport backed by
`createPostgresServiceFactAdapters(...).fetch`, with migration-reviewed shared
provider budget/origin/cooldown rows. There is no unguarded default transport,
automatic budget seed, RPC connection at startup, or production invocation.

The producer requires finalized successful status, matching transaction slot and
signature, actual block membership/time, and any captured block reference. It
checks the complete enabled/non-suspended approved profile cohort before RPC and
again before returning. It reuses `extractSolanaSwapEvidence`,
`deriveExecutionBasis`, and `preparePostgresWalletCapture`; captured quantities,
entry ratio and existing purchase must match. It keeps stablecoin amounts explicitly
nominal/estimated, rejects mixed/native unsupported quote bases, adds no minimum
purchase or old dust gate, and excludes transactions before the generation. A
finite abort/deadline bounds clients that ignore cancellation; durable PG provider
leases remain the cross-process network concurrency guard.

An acquired candidate contains the actual RPC payloads, reviewed provider/genesis
identity, source reference, current profile, source execution time (`observedAt`),
acquisition clock (`knownAt`), a clock-independent content fingerprint, and
`purchaseCandidate`. It is **not** an independently validated attestation, live
source receipt, risk clearance, independent trader classification, or signal.
The reused swap kernel recognizes opposing balance legs and uses JS numeric token
quantities. These are acquisition/classification inputs, not cryptographic swap
proof or a guarantee of lossless atomic quantities. A trusted publisher must verify
raw balance/decimal and swap semantics; the content hash proves replay integrity,
not truth. No proof-table write privileges are added to runtime services.

The separate approved validator/publisher must persist execution input and
attestation atomically, bind the exact purchase to its actual validation reference,
and use the existing fact-reader subject/fingerprint contracts. Publishing a
sample-bound source/risk/independence change must call
`requestPostgresWalletSignalWake` in the same PG transaction. This producer is not
yet connected to the parent-owned service entry or a durable demand receiver.
Migration-seeded validators, leases, inbox facts, and demand rows do not demonstrate
new physical producer coverage.

### Exact reusable paths and remaining sources

- Solana execution: the new producer above and the existing wallet collectors;
  production still needs approved RPC origin/credentials/genesis binding, persisted
  global budget seed, bounded receiver, and separately authorized validation/publication.
- EVM execution: `packages/collectors/src/evm-swap-evidence.ts` exposes
  `extractEvmSwapEvidence`; wallet-monitor EVM collectors already obtain real logs.
  An independent producer must additionally bind approved chain ID, canonical
  block/receipt success, finalized/confirmation semantics, block-specific token
  decimals and reviewed stable quote mapping. This slice does not implement it.
- Actual price acquisition: `createGeckoTerminalClient` in
  `packages/collectors/src/gecko-terminal-client.ts` exposes `topPool`, `ohlcv`, and
  `trades`, accepting injected `fetch`. `topPool` checks actual token-side mapping;
  OHLCV/trades can supply real post-purchase price evidence. Parent must bind the
  PG-budgeted fetch, approved provider/pool/token/source identity, exact candle/trade
  provenance and independent validation before `receivePostgresProductionPriceBatch`.
  Its local cache/throttle is not the global PG budget. No new price acquisition
  receiver/publisher is connected in this slice.
- `createDefiLlamaPriceClient(...).chart(...)` provides sampled historical USD price
  points, not executed purchase prices or proven candle highs. Existing indexed
  early-trade price interpolation and current market-cap/FDV supply reconstruction
  must not substitute for real entry basis or new historical events.
- Risk: `detectRepeatedBundleRisk` in `apps/automation/src/bundle-risk-detector.ts`
  implements existing 10-second pair clusters (5-second sublabel) and repeated
  distinct-token bundle-risk detection. Its old SQLite worker scans historical
  buys and defaults missing traders to no risk; neither incomplete coverage nor a
  missing pair proves clearance. Its token key lowercases Solana addresses, so a
  direct port would need case-preserving canonical token identity before production.
- Independence: no real positive independence producer was found. Bundle-risk
  absence, wallet/account/entity IDs, fixture acceptance facts, and legacy ability
  scores do not prove independent beneficial actors. An approved ownership/funding
  source with explicit complete coverage and sample-fingerprint-bound provenance
  remains an external requirement; this slice invents no independence key or rule.

All consumption policy remains unchanged: nominal USDT/USDC >=50, actual trade
entry ratio, 30-day opportunity evidence, stable distinct-token 3x/5x capability,
and two independently eligible traders within 15 minutes. Missing producer proof
continues to defer without success receipts. FOMO remains paused, old batch history
is disabled, and gateway delivery remains false. No six-service business acceptance
or production cutover is claimed by this handoff.

## Follow-up: receiver and separately verified execution publication

This bounded follow-up supersedes the earlier statement that no execution
receiver/publisher implementation exists. Formal root/actor deployment integration
and physical external validator coverage remain separate, uncompleted requirements.

`createPostgresWalletExecutionReceiver` in
`apps/automation/src/postgres-wallet-execution-receiver.ts` accepts an explicit
`generationId`, real `producer.acquire`, optional external `validator.validateExecution`
and dedicated `publisher.publish`, `maximumCandidates`, `maximumRunMs`,
`maximumPayloadBytes`, and `now`. It exports `receive({payloads, signal})` for a finite
caller-selected batch and `verifyPurchase` matching the wallet-channel callback.
The parent root can import both modules and set `channel.verifyPurchase` without
introducing wallet-monitor -> automation imports. Wallet collector leases and the
PG-global fetch guard bound source execution; this receiver does not claim to be a
new durable queue scheduler or independently provisioned service. The root owns
bounded batch selection/retry and pending-operation lifecycle. If validator or
publisher is missing, it still calls real acquisition, then returns deferred; it
never acknowledges a positive execution fact from an unsigned inbox record.

`createPostgresExecutionFactPublisher` in
`apps/automation/src/postgres-execution-fact-publisher.ts` requires a separate
approved native UOW, exact database/schema/username/server/generation/schema-ledger
identity, the complete excluded six consumer + migration/seed role list, explicit
statement/lock/validation-age/payload budgets, and external validator public-key,
actor, authorization and reviewed replay-source pins. Actual PG catalog checks
run at startup and every publication: no elevated/inherited consumer role, proof
object owner, temporary/view/unlogged substitution, or forbidden authority DML.
Only INSERT into the existing execution input and attestation tables is used. No
DDL, grants, private signing key, validator seed, cutover activation, or six-role
BusinessRuntime policy changes are introduced.

The external `validateExecution({candidate, signal})` transport must return deferred
or a signed `SignedPostgresExecutionValidation`. Its domain-separated Ed25519
claims bind generation, provider, validator/key, exact candidate fingerprint,
source reference, durable validation reference, checked/expiry clocks, actual
independent replay source reference/fingerprint, and the exact purchase fingerprint.
The publisher verifies the signature, economic fields and source pins, then locks
an active `validator_authority` import/validator binding valid for the proof lifetime.
Source ID inequality is not proof of independent beneficial traders; the reviewed
external validator remains responsible for fetching and validating the referenced
replay evidence. No implementation here signs its own acquisition candidate.

A single native UOW writes `wallet_service_fact_inputs` and
`wallet_service_fact_attestations`, or reconciles an exact immutable duplicate.
An attestation failure rolls back the input. The input payload retains the actual
candidate RPC evidence and signed external validation for audit; its canonical
purchase evidence reference is the signed validation reference. `known_at` uses
the independently checked clock, conservatively after actual acquisition, so a
replay of the same signed proof is stable. The returned external purchase basis
binds the full purchase fingerprint. No risk, independence or source-safety fact is
published. This is not production ACL/concurrency acceptance: tests use actual
crypto plus mocked PG identity/UOW protocols, not a production publisher role.

### Controlled price candidate API

`createPostgresGeckoTerminalPriceProducer` in
`apps/automation/src/postgres-controlled-price-producer.ts` requires explicit
PG-budgeted `fetch`, approved HTTPS origin, timeout/rate/cooldown/run/byte/candle/window/
mapping-freshness budgets, timeframe, aggregate, generation/activation, and clock.
`acquire({generationId,sampleId,executionFingerprint,boughtAt,until,mapping,signal})`
uses the existing real GeckoTerminal client to fetch token pools and OHLCV. A fresh
client per acquisition avoids claiming local cached data as newly collected source
coverage. It checks actual pool/token side/network against the supplied reviewed
mapping, preserves Solana case, excludes pre-purchase and incomplete candles,
checks factual OHLC consistency and conflicting duplicate observations, and returns
only a bounded candle candidate with content fingerprint. It asserts no complete
history coverage, does not use spot price for entry, and writes no price fact or
attestation. The root still needs approved mapping acquisition and independent
price validation/publication before the existing PG price consumer can accept it.
No arbitrary liquidity, anomaly, price-jump, score or dust threshold is introduced.
EVM canonical acquisition/publication remains unimplemented in this slice; existing
`extractEvmSwapEvidence` is reusable but does not replace canonical RPC/decimal proof.

### One explicit approval set still required

- Dedicated publisher actor/role, separately budgeted native runtime, complete
  excluded role mapping, external validator public keys/rotation/revocation and
  authorization provenance; ordinary consumers never receive this membership.
- Actual independently operated replay provider origin/credentials/chain identity,
  durable source proof storage/reference and validator transport. A key pin or
  seeded validator row alone does not demonstrate physical collection coverage.
- Approved price provider/token/pool mapping provenance and independent candle
  validation/publication contract, including explicit freshness/quality budgets.
- Funding/beneficial-owner independence source and adjudication rules: what verified
  ownership/funding linkage constitutes dependence, which common infrastructure
  does not, required coverage/time bounds, conflict handling and proof freshness.
  These business rules are not determined here; account/entity/wallet ID distinction
  and absence of bundle-risk matches are never substituted for them. Missing or
  incomplete evidence remains deferred. No risk-clearance producer is invented.

These are genuine external/user approval requirements, not implementation-ready
booleans. FOMO stays paused; there are no production RPC requests, writes, restart,
commit, old-history miner or new login in this work.

## EVM canonical execution candidate handoff

This section supersedes the earlier statement that EVM acquisition is unimplemented. `createPostgresEvmExecutionProducer` now acquires execution candidates for explicitly configured `eth`, `bsc`, or `base` chains. Independent validation, authorized publication, and service-entry integration remain separate requirements; acquisition alone does not publish a fact or qualify an actor.

The factory requires `generationId`, `activatedAt`, `chain`, `expectedChainId`, `expectedGenesisBlockHash`, `providerId`, `endpoint`, PG-budgeted `fetch`, current approved `profiles`, reviewed `stableQuoteTokens`, `maximumProfiles`, `maximumLogs`, `maximumDecimalsReads`, `maximumRpcRequests`, `maximumPayloadBytes`, `maximumRunMs`, and `now`. It performs no requests at construction. No chain ID, genesis hash, provider budget, signer, or quality threshold is inferred.

Acquisition verifies the configured chain and genesis, successful transaction/receipt consistency, canonical block membership and timestamp, a finalized block witness, and receipt-log provenance. It reuses `extractEvmSwapEvidence`, reads token decimals using canonical block-hash-specific EIP-1898 calls, and derives entry from actual stablecoin/token execution legs. Native or ambiguous mixed spending, mismatched capture quantities, missing metadata, canonical drift, unsupported finality, and quantities not losslessly representable by the existing numeric kernel defer. The amount remains estimated stablecoin nominal value, not an independently proven USD peg. No current-market price becomes entry basis. Current profile ownership and version are checked before and after acquisition.

`createPostgresEvmExecutionDispatcher({ generationId, producers })` accepts only an explicit, nonempty partial registry of `eth`, `bsc`, and `base` producers. Unregistered chains defer, without a default-chain or Solana fallback. Robinhood is not configured or guessed. The receiver accepts this dispatcher through optional `evmProducer`; its existing Solana `producer` remains unchanged. Publisher and validator ports accept the execution-candidate union, but positive publication still requires approved external replay evidence, signed validation, and the dedicated verified publisher actor.

Illustrative parent-owned composition, with all deployment values supplied by reviewed configuration:

```ts
const evmProducer = createPostgresEvmExecutionDispatcher({
  generationId,
  producers: {
    eth: createPostgresEvmExecutionProducer({
      ...approvedEvm.eth,
      generationId,
      activatedAt,
      chain: "eth",
      fetch: ports.fetch,
      profiles: ports.profiles,
      now,
    }),
  },
});
const receiver = createPostgresWalletExecutionReceiver({
  ...approvedReceiverBudgets,
  generationId,
  producer: solanaProducer,
  evmProducer,
  validator: externalValidator,
  publisher: dedicatedPublisher,
  now,
});
```

This is a launch contract, not a claim that the root entrypoint has installed these ports. All RPC calls use the injected PG-global budget/cooldown guard. Providers must support the required finalized and canonical block-specific reads; unsupported acquisition defers rather than downgrading to `latest`. Finite receiver batches and existing collector leases bound work; no new autonomous queue, historical scan, or schema activation is introduced.

### Consolidated external prerequisites

- Approved per-chain RPC origins, provider identities, chain ID and genesis pins, finalized/EIP-1898 access, and sufficient historical reads; exact reviewed global budget/window/concurrency/cooldown migration seeds. No startup reset or guessed Robinhood configuration.
- Explicit deployment quotas, approved profile cohort and ownership bindings, freshness limits, and provider quality parameters. Legacy source flags do not become eligibility.
- A separately provisioned publisher role/native UOW outside the six consumer roles, approved independent replay validator and actual source-proof storage/transport, signer public-key and actor authorization, and revocation policy. A seed, inbox row, or key alone is not new physical acquisition coverage.
- Approved price-provider access and pool/token mappings, plus an independent price-validation/publication path. GeckoTerminal acquisition remains a candidate port, not automatic authority.
- Approved risk, funding, beneficial-owner, and trader-independence sources and adjudication/freshness rules. Distinct account/entity IDs do not prove independence; missing evidence remains deferred. These producers do not generate risk or independence facts.

The existing policy remains unchanged: at least 50 nominal USDT/USDC estimated purchase value with actual execution entry basis, 30-day opportunities, distinct-token 3x/5x capability, and two independently eligible traders within 15 minutes. FOMO remains paused and gateway delivery remains false.

Validation for this bounded batch: seven owned Vitest files passed, 128 tests total (27 EVM tests); both `apps/automation/tsconfig.json` and `apps/automation/tsconfig.test.json` passed with `--noEmit`. These are mocked transport/protocol and actual-kernel tests, not live production RPC or PostgreSQL ACL acceptance.

## Authenticated controlled-price publication handoff

`postgres-price-fact-publisher.ts` and `postgres-price-candidate-receiver.ts` now implement the missing candidate-to-durable-price publication plumbing. This supersedes the earlier missing-publisher statement, but does not supply an external validator, approved mapping, signer, credentials, or a production service entrypoint.

`createPostgresPriceFactPublisher(options)` requires the execution publisher's explicit native `run`, pinned `target`, consumer/migration `forbiddenRoles`, external Ed25519 validator/public-key/actor/source pins, validation-age and payload budgets, statement/lock timeouts, and `now`. Additional required options are `maximumCandles`, `maximumWindowMs`, `maximumMappingAgeMs`, and a bounded `mappings` list. Each entry contains the exact `mapping`, `providerId`, `mappingApprovalRef`, `sourceApprovalRef`, explicitly approved `sourceProofKind`, `candleMs`, `validFrom`, and `validUntil`. The factory snapshots pins and checks actual role, permanent ordinary tables, schema identity, and ACL without business writes. It rechecks identity on each publication.

`priceValidationSigningPayload(claims)` defines domain-separated `address-radar/price-validation/v1` bytes. An external validator supplies `SignedPostgresPriceValidation`: signed generation/provider/sample/execution/candidate fingerprints and candidate acquisition time, source revision, mapping/source approval references, validation reference, checked/expiry times, and a source-basis fingerprint. The separately retained `sourceProof` contains the replayed mapping, interval, source revision, candles, and nonempty actual `rawEvidence`; its fingerprint is authenticated by the signature. Replayed normalized candles must exactly match the candidate. The proof protocol is an explicit deployment approval, not a new inferred source-trust rule. Fixture keys and fixture raw responses in tests are not production source proof.

`publish({ candidate, validation, signal })` locks and checks the actual current purchase sample, generation activation, original execution revision, token/chain, purchase time, and existing sample expiry. It verifies current migration-owned price-validator authority, closed nonoverlapping post-purchase candle bounds, and factual OHLC consistency. Candle high becomes canonical `ForwardPeakEvidence`; it never becomes purchase entry and does not imply liquidity, risk clearance, complete coverage, or trader independence. No spike, liquidity, or risk threshold is introduced.

The native UOW atomically inserts existing `wallet_service_fact_inputs` (`kind='price'`, payload `type='peak'`), matching attestations, and immutable deduplicated signal-wake intents. Raw independent proof, signature, source approval/provenance, complete acquired candidate, sample ID and execution fingerprint remain in durable payload. Exact replays are duplicates; changed data yields immutable revisions; moving validation time/reference alone cannot mint another revision and conflicting immutable payloads fail closed. This does not bypass the existing scanner/historical shared price-consumption lease, canonical peak receipt, or downstream opportunity/capability checks.

`createPostgresPriceCandidateReceiver({ generationId, producer, validator?, publisher?, maximumCandidates, maximumRunMs, maximumPayloadBytes, now })` returns `receive({ requests, signal })`. Requests carry `generationId`, `sampleId`, `executionFingerprint`, `boughtAt`, `until`, and optional `mapping`. The producer port is the actual controlled-price producer; the external validator port is `validatePrice({ candidate, signal })`, returning either `{ status: 'verified', validation }` or `{ status: 'deferred', reasonCode }`. Missing mapping, validator, publisher, or approved source evidence defers; the receiver never self-attests. Batch, byte, deadline and cancellation budgets are explicit. Root owns bounded current-sample selection and retry lifecycle.

Illustrative parent-owned hook, with no invented runtime values:

```ts
const pricePublisher = await createPostgresPriceFactPublisher({
  ...approvedPricePublication,
  run: dedicatedPublisherUow.run,
  now,
});
const priceReceiver = createPostgresPriceCandidateReceiver({
  ...approvedPriceReceiverBudgets,
  generationId,
  producer: controlledPriceProducer,
  validator: externalPriceValidator,
  publisher: pricePublisher,
  now,
});
const report = await priceReceiver.receive({ requests: boundedCurrentSampleRequests, signal });
```

Only approved dedicated-publisher provisioning may add narrow INSERT privileges on `wallet_forward_signal_wake_intents`, alongside existing fact-input/attestation INSERT privileges and required read access to sample/revision/generation and authority tables. No consumer receives authority DML, and no role name or credentials are invented here. UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on proof/wake tables, protected authority/cohort/budget-seed writes, consumer-role membership, schema/database CREATE, privileged roles, owned objects, temporary objects, views and unlogged tables remain forbidden. Popper and Boyle have been given the exact provisioning contract. No new table, DDL export, schema version, or fingerprint is introduced.

External prerequisites remain actual approved provider access and PG-global budget seeds, exact approved mapping/source protocol and freshness intervals, a real independently authenticated replay validator/source-proof acquisition path, approved signer/actor bindings and dedicated native publisher UOW/ACL, plus parent root installation. Risk, funding and beneficial-owner/trader-independence sources and rules remain separate unresolved conditions; publication does not fill them. FOMO stays paused and gateway delivery stays false.

Price-publication batch validation: eight owned Vitest files passed, 165 tests total, including 37 new price publisher/receiver regressions. Automation production and full test TypeScript configs both passed with `--noEmit` (exit 0). The end-to-end regression uses the actual Gecko SDK and execution/price kernels with fixture HTTP responses, real Ed25519 signature verification with fixture keys, and a mock rollback-capable native UOW. This is not independently acquired production proof or live PostgreSQL ACL/SQL acceptance.

An existing execution-publication integration risk discovered while reading the reused pattern has been reported separately to the parent: its validator SQL references `l.import_at`, whereas the exported fact schema defines `imported_at`. The new price publisher uses `l.imported_at`; this bounded price batch does not claim that the existing execution SQL has passed live PostgreSQL acceptance.

Execution-ledger correction: the previously reported publisher SQL mismatch is now fixed from `l.import_at` to the actual `l.imported_at`. A regression extracts the ledger column names from `POSTGRES_SERVICE_FACT_SCHEMA_SQL` and checks every referenced `l.<column>` in the emitted authority query. It failed on the old SQL before the correction and passes afterwards; mocked validator rows were not changed. The latest scoped run passed eight owned files, 166 tests total (12 execution-publisher tests), and both automation production/test `--noEmit` checks exited 0. This verifies the actual exported DDL/SQL contract and protocol tests, not live dedicated-role publication. Boyle has been asked for an existing safe approved private5434 native-UOW publisher fixture, without consumer grant broadening; no such execution-publication result is included here.

Parent price retry selection contract: use bounded actual `forward_purchase_samples` joined by `(trade_id,execution_fingerprint)` to original `forward_trade_revisions`, scoped to the active generation and its activation. Map `sample_id`, `execution_fingerprint`, and `occurred_at` to the receiver's `sampleId`, `executionFingerprint`, and `boughtAt`; supply only the exact reviewed pool/token/source mapping. Set `until` no later than assessment time, existing sample expiry, and the explicitly configured acquisition window. Root must maintain fair bounded retry/lease state keyed by sample, execution revision, source and acquisition window, not repeatedly poll the oldest timestamp-only LIMIT. Deferred/candidate results are not a successful checkpoint; immutable fact IDs and committed publication/duplicate results are the actual retry outcome. This contract was handed to Epicurus directly; the root lookup/retry implementation is not changed by this batch.

## Synthetic native PostgreSQL publication acceptance (2026-10-04)

This receipt supersedes earlier mocked-only publication status. It does not approve
natural wallet/source coverage, funding/risk/independence rules, production cutover,
or six-service business acceptance.

Owned entry points:

- `apps/automation/test/postgres-fact-publication-fixture.ts` exports
  `runPostgresFactPublicationFixture()` and the pure synthetic execution fixture.
- `apps/automation/test/postgres-fact-publication-rehearsal.test.ts` runs the live
  case only with `ADDRESS_RADAR_RUN_FACT_PUBLICATION_REHEARSAL=1`.
- The fixture pins the reviewed guarded lifecycle module digest, acquires a fresh
  isolated 5434 namespace, installs the actual v1/v2 service schema through the
  migration runtime, and uses a distinct limited publisher login with native UOWs.
  It must run serially after the current lifecycle owner explicitly releases the
  slot. An occupied port or failed guard is not bypassed. Old 5433 is never used.

Actual live receipt:

```json
{
  "syntheticOnly": true,
  "productionWrites": false,
  "nonce": "2cda45b034d940f9",
  "database": "radar_rehearsal_2cda45b034d940f9",
  "schema": "radar_rehearsal_2cda45b034d940f9_schema",
  "publisherRole": "radar_rehearsal_2cda45b034d940f9_publisher",
  "schemaVersion": 2,
  "schemaFingerprint": "cecbd7d9218d0a91022c221d1086244fcb5e91cb5de8ac2639e7378c19070ea6",
  "installedVersions": [1, 2],
  "maximumClients": 2,
  "executionPublished": true,
  "executionDuplicate": true,
  "pricePublished": true,
  "priceDuplicate": true,
  "mismatchRejections": 3,
  "authorityScopeRejections": 2,
  "physicalMultiCandleRollback": true,
  "rollbackSqlState": "23514",
  "awaitingCommit": true,
  "commitUncertaintyReconciled": true,
  "nativeCommitCalls": 3,
  "consumerAuthorityWrites": false,
  "physicalReceipts": {"facts": 5, "attestations": 5, "wakes": 4},
  "cleaned": true
}
```

The independent observer read actual committed rows. A later wake constraint
failure rolled back the entire multi-candle publication, not just mocked arrays.
A held native COMMIT kept staged rows invisible and the publish promise unresolved;
a post-COMMIT lost acknowledgement produced uncertainty, with a durable duplicate
receipt on retry. Mismatches covered generation, owner and approved price mapping.
Wrong imported authority scope was rejected for both execution and price.

The signing keys and approval/authority rows were generated only for this private
synthetic fixture. Ed25519 verification authenticates that fixture proof scope;
it does not turn fixture RPC/candle payloads into independently collected natural
chain evidence or production validator approval. No risk or independence facts
were fabricated.

Real PG exposed and corrected two publisher defects without widening authority
DML: canonical host pinning now uses `host(inet_server_addr())`; protected
SELECT-only authority/sample reads no longer request `FOR SHARE`. Instead the
attestation INSERT rechecks current authority (and price sample/revision/generation)
in its SQL statement and requires an actual matching `RETURNING fact_id` receipt.
A missing receipt aborts the whole native UOW. This is statement-level evidence
validation, not an authority-row-lock guarantee against later administrative
revocation; consumer fact reads still revalidate authority/expiry before use.
The execution ledger column is the actual v2 `imported_at`, covered by a DDL/SQL
regression.

The private publisher has INSERT only on `wallet_service_fact_inputs`,
`wallet_service_fact_attestations`, and `wallet_forward_signal_wake_intents`, plus
SELECT on the exact identity/authority/sample tables it reads. It has no authority
UPDATE/INSERT, schema CREATE, consumer membership, or elevated role attributes.
Migration-owned approval/cohort/validator/import rows remain a separate ACL domain.

Scoped results after the publisher fixes:

- Nine owned test files: 171 passed, one live opt-in skipped, no failures.
- Live opt-in file: two passed, exit 0, 80.72 seconds including guarded setup and
  cleanup. The pure synthetic fixture test overlaps the offline suite and is not
  an additional distinct test.
- Automation production and full test TypeScript configurations: both exit 0.
- Root/full-workspace aggregate is parent-owned and must be rerun after code freeze.

```sh
ADDRESS_RADAR_RUN_FACT_PUBLICATION_REHEARSAL=1 node node_modules/vitest/vitest.mjs run apps/automation/test/postgres-fact-publication-rehearsal.test.ts --reporter=dot
```

Remaining external prerequisites are unchanged: approved exact chain/provider and
shared migrated budget/cooldown configuration; current generation/cohort and
ownership bindings; approved token/pool/source mappings; independently authenticated
execution and candle validators with provisioned dedicated roles/keys; and approved
real funding/risk/independence sources and their core rules. Candidate acquisition
and signed publisher plumbing do not substitute for these approvals. Current spot
prices are not entry evidence, distinct trader IDs are not independence proof,
FOMO remains paused, and gateway delivery remains false.
