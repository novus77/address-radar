import { generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createPostgresRpcSourceFactCandidateVerifier } from "../src/postgres-rpc-source-fact-candidate.js";
import { createPostgresIndependentExecutionValidator } from "../src/postgres-independent-execution-validator.js";
import { createPostgresSolanaExecutionProducer } from "../src/postgres-wallet-rpc-producer.js";
import { preparePostgresWalletCapture, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";

const at = 100_000, wallet = "11111111111111111111111111111111", token = "TokenCase";
const keys = generateKeyPairSync("ed25519");
async function fixture() {
  const profile: PostgresWalletProfile = {
    wallet: { address: wallet, accountId: "account", entityId: "entity", lifecycle: "active" },
    fact: { entityId: "entity", channel: "wallet", subjectId: wallet, walletFamily: "solana",
      associationConfidence: "confirmed", associationSource: "fixture", walletConfidence: "confirmed", walletSource: "fixture",
      ownerCount: 1, identityEvidenceRef: "identity", ownershipEvidenceRef: "owner", monitoringEnabled: true, suspended: false },
    profileEnabled: true, profileSuspended: false, bindingState: "owned", versionId: "version",
  };
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const balance = (accountIndex: number, mint: string, amount: number) => ({ accountIndex, mint, owner: wallet, uiTokenAmount: { uiAmount: amount } });
  const replies: Record<string, unknown> = {
    getGenesisHash: "genesis", getSignatureStatuses: { value: [{ slot: 5, err: null, confirmationStatus: "finalized" }] },
    getTransaction: { slot: 5, blockTime: 90, transaction: { signatures: ["signature"], message: { accountKeys: [wallet, "program"], instructions: [] } },
      meta: { err: null, fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [999_995_000, 0],
        preTokenBalances: [balance(1, token, 0), balance(2, usdc, 100)], postTokenBalances: [balance(1, token, 100), balance(2, usdc, 40)] } },
    getBlock: { blockhash: "canonical-block", blockTime: 90, signatures: ["signature"] },
  };
  const profiles = { load: vi.fn(async () => ({ status: "ready" as const, profiles: [profile] })) };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: replies[request.method] }));
  });
  const payload = preparePostgresWalletCapture({ generationId: "generation", collectorId: "solana", sessionId: "source",
    chainFamily: "solana", receivedAt: at, profile, executionTrust: "unverified", event: { eventId: "event", chain: "solana",
      walletAddress: wallet, tokenAddress: token, side: "buy", occurredAt: 90_000, amountUsd: null, priceUsd: null,
      marketCapUsd: null, sourceReference: "solana:signature" } }).payload;
  const acquired = await createPostgresSolanaExecutionProducer({ generationId: "generation", activatedAt: 1000, providerId: "source-rpc",
    expectedGenesisHash: "genesis", rpc: { request: async (_chain, method) => structuredClone(replies[method]) }, profiles,
    maximumProfiles: 10, maximumPayloadBytes: 128_000, maximumRunMs: 1000, now: () => at }).acquire({ payload, signal: new AbortController().signal });
  if (acquired.status !== "acquired") throw new Error(acquired.reasonCode);
  const candidate = acquired.candidate;
  const validated = await createPostgresIndependentExecutionValidator({ generationId: "generation", activatedAt: 1000,
    validatorId: "validator", keyId: "key", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    signingKey: { loadPrivateKey: () => keys.privateKey }, reviewedProviderBindings: [{ chain: "solana", sourceProviderId: "source-rpc",
      sourceEndpoint: "https://source.example/rpc", replayProviderId: "replay-rpc", replayEndpoint: "https://independent.example/rpc", expectedGenesisHash: "genesis" }],
    fetch, profiles, maximumProfiles: 10, maximumRpcRequests: 20, maximumLogs: 100, maximumDecimalsReads: 4,
    maximumPayloadBytes: 128_000, maximumRunMs: 1000, validationTtlMs: 60_000, maximumNonces: 10,
    nonce: () => "unique_nonce_0123456789", now: () => at }).validateExecution({ candidate, signal: new AbortController().signal });
  if (validated.status !== "verified") throw new Error(validated.reasonCode);
  fetch.mockClear(); profiles.load.mockClear();
  const purchase = validated.validation.claims.purchase;
  const row: Record<string, unknown> = { sample_id: "sample", generation_id: "generation", execution_fingerprint: "a".repeat(64),
    original_fingerprint: "a".repeat(64), revision_state: "original", entity_id: purchase.entityId, chain: purchase.chain,
    token_address: purchase.tokenAddress, occurred_at: purchase.occurredAt, activated_at: 1000, created_at: 95_000, recorded_at: 95_000,
    execution_key: purchase.executionKey, token_quantity: purchase.tokenQuantity, quote_asset: purchase.quoteAsset,
    quote_amount: purchase.quoteAmount, amount_usd: purchase.amountUsd, entry_price_usd: purchase.entryPriceUsd,
    amount_basis: purchase.amountBasis, amount_estimated: purchase.amountEstimated, ownership_evidence_ref: purchase.ownershipEvidenceRef,
    execution_evidence_ref: purchase.executionEvidenceRef };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("source-candidate-authority")
    ? [{ kind: "execution" }, { kind: "source" }] : [row], rowCount: 1 }));
  const options = { generationId: "generation", activatedAt: 1000, maximumProfiles: 10, maximumPayloadBytes: 128_000,
    maximumValidationAgeMs: 60_000, maximumRunMs: 1000, profiles, now: () => at,
    run: async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query }),
    authority: { validatorId: "validator", keyId: "key", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      sourceProviderId: "source-rpc", replayProviderId: "replay-rpc" } };
  const request = { sampleId: "sample", executionFingerprint: "a".repeat(64), execution: candidate,
    validation: validated.validation, signal: new AbortController().signal };
  return { options, request, row, query, fetch, profiles, profile };
}

test("binds the existing real RPC replay to the durable revision/current target without another RPC or publication", async () => {
  const f = await fixture();
  const result = await createPostgresRpcSourceFactCandidateVerifier(f.options).verify(f.request);
  expect(result.status).toBe("candidate_ready");
  if (result.status !== "candidate_ready") throw new Error(result.reasonCode);
  expect(result.candidate).toMatchObject({ kind: "source", generationId: "generation", payload: {
    sampleId: "sample", executionFingerprint: "a".repeat(64), target: f.profile.fact,
    canonical: "confirmed_live_execution" }, publication: { status: "deferred", reasonCode: "source_exact_binding_not_independently_attested" } });
  expect(result.candidate.replayEvidence).toEqual(f.request.validation);
  expect(result.candidate).not.toHaveProperty("riskVerdict");
  expect(result.candidate).not.toHaveProperty("independenceKey");
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT"))).toBe(true);
});

test("defers absent configured or durable source authority", async () => {
  const f = await fixture();
  expect(await createPostgresRpcSourceFactCandidateVerifier({ ...f.options, authority: undefined }).verify(f.request))
    .toMatchObject({ status: "deferred", reasonCode: "source_authority_unavailable" });
  expect(f.query).not.toHaveBeenCalled();
  f.query.mockImplementation(async sql => ({ rows: sql.includes("source-candidate-authority") ? [{ kind: "execution" }] : [f.row], rowCount: 1 }));
  expect(await createPostgresRpcSourceFactCandidateVerifier(f.options).verify(f.request))
    .toMatchObject({ status: "deferred", reasonCode: "source_authority_unavailable" });
});

test.each(["sample_id", "generation_id", "execution_fingerprint", "original_fingerprint", "revision_state", "entity_id", "chain",
  "token_address", "occurred_at", "activated_at", "execution_key", "token_quantity", "quote_asset", "quote_amount", "amount_usd",
  "entry_price_usd", "amount_basis", "amount_estimated", "ownership_evidence_ref", "execution_evidence_ref", "created_at", "recorded_at"])(
  "defers an exact durable binding mismatch: %s", async field => {
    const f = await fixture(); f.row[field] = field === "amount_estimated" ? !f.row[field] : "wrong";
    expect((await createPostgresRpcSourceFactCandidateVerifier(f.options).verify(f.request)).status).toBe("deferred");
  });

test.each(["signature", "purchase", "replay-provider", "expired", "future", "fingerprint", "reference", "generation"])(
  "defers unusable replay evidence: %s", async kind => {
    const f = await fixture();
    let validation = structuredClone(f.request.validation);
    if (kind === "signature") validation = { ...validation, signature: "invalid" };
    if (kind === "purchase") (validation.claims.purchase as any).tokenQuantity = "101";
    if (kind === "replay-provider") (validation.claims.sourceBasis as any).providerId = "source-rpc";
    if (kind === "expired") (validation.claims as any).expiresAt = at;
    if (kind === "future") (validation.claims as any).checkedAt = at + 1;
    if (kind === "fingerprint") (validation.claims as any).candidateFingerprint = "b".repeat(64);
    if (kind === "reference") (validation.claims as any).sourceReference = "solana:other";
    if (kind === "generation") (validation.claims as any).generationId = "old";
    expect((await createPostgresRpcSourceFactCandidateVerifier(f.options).verify({ ...f.request, validation })).status).toBe("deferred");
  });

test.each(["suspended", "owner", "version", "changed-during-read"])("defers current target drift: %s", async kind => {
  const f = await fixture();
  const changed = { ...f.profile, ...(kind === "suspended" ? { profileSuspended: true } : { versionId: "other" }),
    fact: { ...f.profile.fact, ...(kind === "owner" ? { ownershipEvidenceRef: "other" } : {}) } };
  if (kind === "changed-during-read") f.profiles.load.mockResolvedValueOnce({ status: "ready", profiles: [f.profile] });
  f.profiles.load.mockResolvedValue({ status: "ready", profiles: [changed] });
  expect((await createPostgresRpcSourceFactCandidateVerifier(f.options).verify(f.request)).status).toBe("deferred");
});

test.each(["abort", "timeout", "regression", "missing", "ambiguous", "bytes"])("fails closed on %s", async kind => {
  const f = await fixture();
  if (kind === "abort") { const controller = new AbortController(); controller.abort(); f.request.signal = controller.signal; }
  if (kind === "timeout") { f.options.maximumRunMs = 5; f.query.mockImplementation(() => new Promise(() => {})); }
  if (kind === "regression") { let reads = 0; f.options.now = () => ++reads > 1 ? at - 1 : at; }
  if (kind === "missing" || kind === "ambiguous") f.query.mockImplementation(async () => ({ rows: kind === "missing" ? [] : [f.row, f.row], rowCount: 2 }));
  if (kind === "bytes") f.options.maximumPayloadBytes = 10;
  expect((await createPostgresRpcSourceFactCandidateVerifier(f.options).verify(f.request)).status).toBe("deferred");
});
