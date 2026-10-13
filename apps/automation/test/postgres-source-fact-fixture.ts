import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { createPostgresRpcSourceFactCandidateVerifier } from "../src/postgres-rpc-source-fact-candidate.js";
import { createPostgresIndependentExecutionValidator } from "../src/postgres-independent-execution-validator.js";
import { createPostgresSolanaExecutionProducer } from "../src/postgres-wallet-rpc-producer.js";
import { preparePostgresWalletCapture, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";

const at = 100_000, wallet = "11111111111111111111111111111111", token = "TokenCase";
const keys = generateKeyPairSync("ed25519");
export async function sourceRpcFixture() {
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
