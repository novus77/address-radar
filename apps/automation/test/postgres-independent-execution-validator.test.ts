import { generateKeyPairSync, verify, sign as signExecution } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, sign: vi.fn(actual.sign) };
});
import { createPostgresIndependentExecutionValidator } from "../src/postgres-independent-execution-validator.js";
import { executionValidationSigningPayload, type PostgresExecutionCandidate } from "../src/postgres-execution-fact-publisher.js";
import { createPostgresSolanaExecutionProducer } from "../src/postgres-wallet-rpc-producer.js";
import { createPostgresEvmExecutionProducer } from "../src/postgres-evm-execution-producer.js";
import { preparePostgresWalletCapture, walletPurchaseBasisFingerprint, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";

const at = 100_000, wallet = "11111111111111111111111111111111", mint = "TokenCase";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const profile: PostgresWalletProfile = {
  wallet: { address: wallet, accountId: "account", entityId: "entity", lifecycle: "active" },
  fact: { entityId: "entity", channel: "wallet", subjectId: wallet, walletFamily: "solana",
    associationConfidence: "confirmed", associationSource: "fixture", walletConfidence: "confirmed", walletSource: "fixture",
    ownerCount: 1, identityEvidenceRef: "fixture:identity", ownershipEvidenceRef: "fixture:owner", monitoringEnabled: true, suspended: false },
  profileEnabled: true, profileSuspended: false, bindingState: "owned", versionId: "version",
};
type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const keys = generateKeyPairSync("ed25519");
function fixture() {
  const balance = (accountIndex: number, token: string, amount: number) => ({ accountIndex, mint: token, owner: wallet, uiTokenAmount: { uiAmount: amount } });
  const replies: Record<string, unknown> = {
    getGenesisHash: "genesis", getSignatureStatuses: { value: [{ slot: 5, err: null, confirmationStatus: "finalized" }] },
    getTransaction: { slot: 5, blockTime: 90, transaction: { signatures: ["signature"], message: { accountKeys: [wallet, "candidate-token-account", "quote-token-account"], instructions: [] } },
      meta: { err: null, fee: 5000, preBalances: [1_000_000_000, 0, 0], postBalances: [999_995_000, 0, 0],
        preTokenBalances: [balance(1, mint, 0), balance(2, usdc, 100)], postTokenBalances: [balance(1, mint, 100), balance(2, usdc, 40)] } },
    getBlock: { blockhash: "canonical-block", blockTime: 90, signatures: ["signature"] },
  };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: replies[request.method] }), { status: 200 });
  });
  const load = vi.fn(async () => ({ status: "ready" as const, profiles: [profile] }));
  const options = {
    generationId: "generation", activatedAt: 1000, validatorId: "independent-validator", keyId: "reviewed-key",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    signingKey: { loadPrivateKey: () => keys.privateKey },
    reviewedProviderBindings: [{ chain: "solana" as const, sourceProviderId: "source-rpc", sourceEndpoint: "https://source.example/rpc",
      replayProviderId: "replay-rpc", replayEndpoint: "https://independent.example/rpc", expectedGenesisHash: "genesis" }],
    fetch, profiles: { load }, maximumProfiles: 10, maximumRpcRequests: 20, maximumLogs: 100,
    maximumDecimalsReads: 4, maximumPayloadBytes: 128_000, maximumRunMs: 1000, validationTtlMs: 60_000,
    maximumNonces: 100, nonce: () => "unique_nonce_0123456789", now: () => at,
  };
  async function candidate() {
    const payload = preparePostgresWalletCapture({ generationId: "generation", collectorId: "solana", sessionId: "fixture",
      chainFamily: "solana", receivedAt: at, profile, executionTrust: "unverified", event: { eventId: "event", chain: "solana",
        walletAddress: wallet, tokenAddress: mint, side: "buy", occurredAt: 90_000, amountUsd: null, priceUsd: null,
        marketCapUsd: null, sourceReference: "solana:signature" } }).payload;
    const result = await createPostgresSolanaExecutionProducer({ generationId: "generation", activatedAt: 1000, providerId: "source-rpc",
      expectedGenesisHash: "genesis", rpc: { request: async (_chain, method) => structuredClone(replies[method]) },
      profiles: { load }, maximumProfiles: 10, maximumPayloadBytes: 128_000, maximumRunMs: 1000, now: () => at }).acquire({ payload, signal: new AbortController().signal });
    if (result.status !== "acquired") throw new Error(result.reasonCode);
    return structuredClone(result.candidate) as Mutable<typeof result.candidate>;
  }
  return { options, replies, fetch, load, candidate };
}
const signal = () => new AbortController().signal;

describe("independent execution RPC replay validator", () => {
  it("replays through the actual producer and signs publisher-compatible claims using independent evidence", async () => {
    const f = fixture(), candidate = await f.candidate();
    const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() });
    expect(result.status).toBe("verified"); if (result.status !== "verified") throw new Error(result.reasonCode);
    expect(f.fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)).method)).toEqual(["getGenesisHash", "getSignatureStatuses", "getTransaction", "getBlock"]);
    expect(f.fetch.mock.calls.every(call => String(call[0]) === "https://independent.example/rpc")).toBe(true);
    const { claims, signature } = result.validation;
    expect(claims).toMatchObject({ generationId: "generation", providerId: "source-rpc", candidateFingerprint: candidate.contentFingerprint,
      sourceReference: candidate.sourceReference, checkedAt: at, expiresAt: at + 60_000,
      sourceBasis: { kind: "independent_rpc_replay", providerId: "replay-rpc" } });
    expect(claims.sourceBasis.contentFingerprint).not.toBe(candidate.contentFingerprint);
    expect(claims.sourceBasis.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(claims.purchase).toEqual({ ...candidate.purchaseCandidate, executionEvidenceRef: claims.validationRef });
    expect(claims.purchaseFingerprint).toBe(walletPurchaseBasisFingerprint(claims.purchase));
    expect(verify(null, executionValidationSigningPayload(claims), keys.publicKey, Buffer.from(signature, "base64"))).toBe(true);
  });

  it("uses the replay fingerprint, never a caller-supplied evidence fingerprint", async () => {
    const f = fixture(), candidate = await f.candidate();
    const producer = createPostgresSolanaExecutionProducer({ generationId: "generation", activatedAt: 1000, providerId: "replay-rpc",
      expectedGenesisHash: "genesis", rpc: { request: async (_chain, method) => structuredClone(f.replies[method]) },
      profiles: f.options.profiles, maximumProfiles: 10, maximumPayloadBytes: 128_000, maximumRunMs: 1000, now: () => at });
    const payload = preparePostgresWalletCapture({ generationId: "generation", collectorId: "independent-validator", sessionId: "replay-rpc",
      chainFamily: "solana", receivedAt: at, profile, executionTrust: "unverified", event: { eventId: "replay", chain: "solana",
        walletAddress: wallet, tokenAddress: mint, side: "buy", occurredAt: 90_000, amountUsd: null, priceUsd: null,
        marketCapUsd: null, sourceReference: "solana:signature", sourceBlockNumber: 5, sourceBlockHash: "canonical-block" } }).payload;
    const replay = await producer.acquire({ payload, signal: signal() });
    const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate: { ...candidate,
      evidence: { signatureStatus: { forged: true }, transaction: { forged: true }, block: { forged: true } } }, signal: signal() });
    expect(result.status).toBe("verified");
    if (result.status === "verified" && replay.status === "acquired") expect(result.validation.claims.sourceBasis.contentFingerprint).toBe(replay.candidate.contentFingerprint);
    else throw new Error("Expected independent replay");
  });

  it.each(["tokenQuantity", "quoteAmount", "amountUsd", "entryPriceUsd", "entityId", "sourceUserId", "executionKey", "ownershipEvidenceRef", "executionEvidenceRef"] as const)(
    "refuses candidate purchase mismatch: %s", async key => {
      const f = fixture(), candidate = await f.candidate();
      const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate: { ...candidate,
        purchaseCandidate: { ...candidate.purchaseCandidate, [key]: "999" } }, signal: signal() });
      expect(result.status).toBe("deferred");
    });
  it.each(["genesis", "block", "slot", "chain", "observedAt", "profile", "generation", "provider", "reference"])("refuses candidate binding mismatch: %s", async field => {
    const f = fixture(), candidate = await f.candidate();
    if (field === "genesis") candidate.genesisHash = "wrong";
    if (field === "block") candidate.blockHash = "wrong";
    if (field === "slot") candidate.slot = 6;
    if (field === "chain") candidate.purchaseCandidate = { ...candidate.purchaseCandidate, chain: "eth" };
    if (field === "observedAt") candidate.observedAt++;
    if (field === "profile") candidate.profile = { ...candidate.profile, versionId: "stale-version" };
    if (field === "generation") candidate.generationId = "old";
    if (field === "provider") candidate.providerId = "unreviewed";
    if (field === "reference") candidate.sourceReference = "solana:other";
    expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
  });
  it.each(["genesis", "quantity", "block", "profile"])("refuses genuinely different independently fetched %s", async field => {
    const f = fixture(), candidate = await f.candidate();
    if (field === "genesis") f.replies.getGenesisHash = "wrong";
    if (field === "quantity") (f.replies.getTransaction as { meta: { postTokenBalances: { uiTokenAmount: { uiAmount: number } }[] } }).meta.postTokenBalances[0]!.uiTokenAmount.uiAmount = 101;
    if (field === "block") f.replies.getBlock = { blockhash: "other", blockTime: 90, signatures: ["signature"] };
    if (field === "profile") f.load.mockResolvedValue({ status: "ready", profiles: [{ ...profile, versionId: "current-version" }] });
    expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
  });
  it.each(["same-provider", "same-endpoint", "missing-bindings", "ttl", "key-type", "public-key"])("rejects unsafe trusted configuration: %s", field => {
    const f = fixture();
    if (field === "same-provider") f.options.reviewedProviderBindings[0]!.replayProviderId = "source-rpc";
    if (field === "same-endpoint") f.options.reviewedProviderBindings[0]!.replayEndpoint = "https://source.example/rpc";
    if (field === "missing-bindings") f.options.reviewedProviderBindings = [];
    if (field === "ttl") f.options.validationTtlMs = 300_001;
    if (field === "key-type") f.options.signingKey.loadPrivateKey = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    if (field === "public-key") f.options.publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => createPostgresIndependentExecutionValidator(f.options)).toThrow();
  });
  it("rejects expired/forward clocks, oversized content and invalid or reused nonces", async () => {
    for (const kind of ["future", "oversize", "nonce", "reuse"]) {
      const f = fixture(), candidate = await f.candidate();
      if (kind === "future") candidate.knownAt = at + 1;
      if (kind === "oversize") candidate.evidence.transaction = "x".repeat(128_001);
      if (kind === "nonce") f.options.nonce = () => "bad";
      const validator = createPostgresIndependentExecutionValidator(f.options);
      if (kind === "reuse") expect((await validator.validateExecution({ candidate, signal: signal() })).status).toBe("verified");
      expect((await validator.validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
    }
  });
  it("fails closed on pre-abort, in-flight abort and transports ignoring cancellation", async () => {
    for (const kind of ["pre", "during", "timeout"]) {
      const f = fixture(), candidate = await f.candidate(), controller = new AbortController();
      f.options.maximumRunMs = 10;
      f.fetch.mockImplementation(async () => { if (kind === "during") controller.abort(); return new Promise<Response>(() => {}); });
      if (kind === "pre") controller.abort();
      const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: controller.signal });
      expect(result.status).toBe("deferred"); if (kind === "pre") expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("does not accept a suspended current profile or caller-injected signing fields", async () => {
    const f = fixture(), candidate = await f.candidate();
    f.load.mockResolvedValue({ status: "ready", profiles: [{ ...profile, profileSuspended: true }] });
    const validator = createPostgresIndependentExecutionValidator(f.options);
    expect((await validator.validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
    f.load.mockResolvedValue({ status: "ready", profiles: [profile] });
    const result = await validator.validateExecution({ candidate: { ...candidate, privateKey: "untrusted", keyId: "untrusted" } as PostgresExecutionCandidate, signal: signal() });
    expect(result.status).toBe("verified"); if (result.status === "verified") expect(result.validation.claims.keyId).toBe("reviewed-key");
  });
});

function evmFixture() {
  const f = fixture(), address = `0x${"11".repeat(20)}`, token = `0x${"22".repeat(20)}`, pool = `0x${"33".repeat(20)}`;
  const hash = `0x${"aa".repeat(32)}`, blockHash = `0x${"bb".repeat(32)}`, genesisHash = `0x${"cc".repeat(32)}`;
  const quote = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
  const word = (value: bigint | number) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  const current: PostgresWalletProfile = { ...profile, wallet: { ...profile.wallet, address },
    fact: { ...profile.fact, subjectId: address, walletFamily: "evm" } };
  const log = (asset: string, topics: string[], data: string, index: number) => ({ address: asset, topics, data,
    logIndex: `0x${index}`, transactionHash: hash, transactionIndex: "0x0", blockHash, blockNumber: "0x20", removed: false });
  const receipt = { transactionHash: hash, from: address, to: pool, status: "0x1", blockHash, blockNumber: "0x20", transactionIndex: "0x0",
    logs: [log(token, [transfer, topic(pool), topic(address)], word(100n * 10n ** 18n), 0),
      log(quote, [transfer, topic(address), topic(pool)], word(60n * 10n ** 6n), 1),
      log(pool, [`0xd78ad95f${"0".repeat(56)}`], "0x", 2)] };
  const replies: Record<string, unknown> = { eth_chainId: "0x1",
    eth_getTransactionByHash: { hash, from: address, to: pool, value: "0x0", blockHash, blockNumber: "0x20", transactionIndex: "0x0" },
    eth_getTransactionReceipt: receipt, genesis: { hash: genesisHash, number: "0x0" },
    canonical: { hash: blockHash, number: "0x20", timestamp: "0x5a", transactions: [hash] },
    finalized: { hash: `0x${"dd".repeat(32)}`, number: "0x30", timestamp: "0x60", transactions: [] } };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)); let result = replies[request.method];
    if (request.method === "eth_getBlockByNumber") result = replies[request.params[0] === "0x0" ? "genesis" : request.params[0] === "finalized" ? "finalized" : "canonical"];
    if (request.method === "eth_call") result = word(request.params[0].to === token ? 18 : 6);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
  });
  const load = vi.fn(async () => ({ status: "ready" as const, profiles: [current] }));
  const binding = { chain: "eth" as const, sourceProviderId: "source-rpc", sourceEndpoint: "https://source.example/rpc",
    replayProviderId: "replay-rpc", replayEndpoint: "https://independent.example/rpc", expectedChainId: "0x1",
    expectedGenesisBlockHash: genesisHash, stableQuoteTokens: [{ address: quote, symbol: "USDC" as const }] };
  const options = { ...f.options, fetch, profiles: { load }, reviewedProviderBindings: [binding] };
  async function candidate() {
    const payload = preparePostgresWalletCapture({ generationId: "generation", collectorId: "eth", sessionId: "source-rpc",
      chainFamily: "evm", receivedAt: at, profile: current, executionTrust: "unverified", event: { eventId: "event", chain: "eth",
        walletAddress: address, tokenAddress: token, side: "buy", occurredAt: 90_000, amountUsd: null, priceUsd: null,
        marketCapUsd: null, sourceReference: `eth:${hash}`, sourceBlockHash: blockHash, sourceBlockNumber: 32 } }).payload;
    const acquired = await createPostgresEvmExecutionProducer({ ...options, ...binding, providerId: "source-rpc",
      endpoint: binding.sourceEndpoint }).acquire({ payload, signal: signal() });
    if (acquired.status !== "acquired") throw new Error(acquired.reasonCode);
    fetch.mockClear(); return structuredClone(acquired.candidate) as Mutable<typeof acquired.candidate>;
  }
  return { options, candidate, fetch, replies, load };
}

describe("independent EVM replay and technical limits", () => {
  it("uses actual EVM receipt/block/decimals RPC and a distinct provider without equating provider fingerprints", async () => {
    const f = evmFixture(), candidate = await f.candidate();
    const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() });
    expect(result.status).toBe("verified"); if (result.status !== "verified") throw new Error(result.reasonCode);
    expect(result.validation.claims.purchase).toMatchObject({ chain: "eth", tokenQuantity: "100", quoteAmount: "60", entryPriceUsd: "0.6" });
    expect(result.validation.claims.sourceBasis.contentFingerprint).not.toBe(candidate.contentFingerprint);
    expect(f.fetch.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(f.fetch.mock.calls.every(call => String(call[0]) === "https://independent.example/rpc")).toBe(true);
    expect(verify(null, executionValidationSigningPayload(result.validation.claims), keys.publicKey,
      Buffer.from(result.validation.signature, "base64"))).toBe(true);
  });
  it.each(["chain", "genesis", "quantity", "profile"])("rejects independent EVM %s mismatch", async kind => {
    const f = evmFixture(), candidate = await f.candidate();
    if (kind === "chain") f.replies.eth_chainId = "0x2";
    if (kind === "genesis") f.replies.genesis = { hash: `0x${"ee".repeat(32)}`, number: "0x0" };
    if (kind === "quantity") (f.replies.eth_getTransactionReceipt as { logs: { data: string }[] }).logs[0]!.data = `0x${(101n * 10n ** 18n).toString(16).padStart(64, "0")}`;
    if (kind === "profile") f.load.mockResolvedValue({ status: "ready", profiles: [{ ...profile, wallet: { ...profile.wallet,
      address: candidate.profile.wallet.address }, fact: candidate.profile.fact, versionId: "changed" }] });
    expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
  });
  it("rejects missing budgets rather than supplying permissive defaults", () => {
    const f = fixture();
    for (const budget of ["maximumRunMs", "maximumPayloadBytes", "maximumRpcRequests", "validationTtlMs", "maximumNonces"] as const) {
      expect(() => createPostgresIndependentExecutionValidator({ ...f.options, [budget]: undefined } as unknown as Parameters<typeof createPostgresIndependentExecutionValidator>[0])).toThrow();
    }
  });
  it("bounds RPC count, streaming bytes, nonce storage and maximum TTL", async () => {
    for (const kind of ["requests", "stream", "nonces", "ttl"]) {
      const f = fixture(), candidate = await f.candidate();
      if (kind === "requests") f.options.maximumRpcRequests = 1;
      if (kind === "stream") f.fetch.mockImplementation(async () => new Response("x".repeat(f.options.maximumPayloadBytes + 1)));
      if (kind === "nonces") { f.options.maximumNonces = 1; let count = 0; f.options.nonce = () => `unique_nonce_${String(++count).padStart(16, "0")}`; }
      if (kind === "ttl") f.options.validationTtlMs = 300_000;
      const validator = createPostgresIndependentExecutionValidator(f.options);
      if (kind === "nonces") expect((await validator.validateExecution({ candidate, signal: signal() })).status).toBe("verified");
      const result = await validator.validateExecution({ candidate, signal: signal() });
      if (kind === "ttl") {
        expect(result.status).toBe("verified"); if (result.status === "verified") expect(result.validation.claims.expiresAt - result.validation.claims.checkedAt).toBe(300_000);
      } else expect(result.status).toBe("deferred");
      if (kind === "requests") expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects clock regression and absolute deadline exhaustion without resetting time after RPC", async () => {
    for (const kind of ["regress", "deadline"]) {
      const f = fixture(), candidate = await f.candidate(); let clock = at;
      f.options.now = () => clock;
      const original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (url, init) => {
        const result = await original(url, init); clock = kind === "regress" ? at - 1 : at + f.options.maximumRunMs; return result;
      });
      expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  });
});

it("forbids transport redirects from the explicitly reviewed replay endpoint", async () => {
  const f = fixture(), candidate = await f.candidate(), original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    expect(init?.redirect).toBe("error");
    return original(url, init);
  });
  const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() });
  expect(result.status).toBe("verified");
});

it("does not accumulate abandoned requests when a transport permanently ignores abort", async () => {
  const f = fixture(), candidate = await f.candidate(); f.options.maximumRunMs = 10;
  f.fetch.mockImplementation(async () => new Promise<Response>(() => {}));
  const validator = createPostgresIndependentExecutionValidator(f.options);
  expect((await validator.validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let count = 0; count < 3; count++) {
    expect(await validator.validateExecution({ candidate, signal: signal() })).toEqual({ status: "deferred", reasonCode: "validator_busy" });
  }
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("actively cancels an RPC response stream with a permanently pending read on timeout", async () => {
  const f = fixture(), candidate = await f.candidate(); f.options.maximumRunMs = 10;
  const cancelled = vi.fn();
  f.fetch.mockImplementation(async () => new Response(new ReadableStream({
    pull: () => new Promise<void>(() => {}), cancel: cancelled,
  })));
  expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("rejects a transport response redirected to the original source endpoint", async () => {
  const f = fixture(), candidate = await f.candidate(), original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    Object.defineProperties(response, { redirected: { value: true }, url: { value: "https://source.example/rpc" } });
    return response;
  });
  expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
});

it("retains the outstanding quota for a profile repository that ignores cancellation", async () => {
  const f = fixture(), candidate = await f.candidate(); f.options.maximumRunMs = 10;
  f.load.mockImplementation(async () => new Promise(() => {}));
  const validator = createPostgresIndependentExecutionValidator(f.options);
  expect((await validator.validateExecution({ candidate, signal: signal() })).status).toBe("deferred");
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await validator.validateExecution({ candidate, signal: signal() })).toEqual({ status: "deferred", reasonCode: "validator_busy" });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("never invokes signing when the trusted clock synchronously aborts at the signing boundary", async () => {
  const f = fixture(), candidate = await f.candidate(), controller = new AbortController(); let armed = false;
  f.options.nonce = () => { armed = true; return "unique_nonce_0123456789"; };
  f.options.now = () => { if (armed) controller.abort(); return at; };
  vi.mocked(signExecution).mockClear();
  const result = await createPostgresIndependentExecutionValidator(f.options).validateExecution({ candidate, signal: controller.signal });
  expect(result.status).toBe("deferred");
  expect(signExecution).not.toHaveBeenCalled();
});

describe("independent replay supported Solana versions",()=>{
  it.each([2,"0",null])("does not sign a replay returning unsupported version %j",async version=>{
    const f=fixture(),candidate=await f.candidate();
    f.replies.getTransaction={...f.replies.getTransaction as object,version};
    vi.mocked(signExecution).mockClear();
    expect(await createPostgresIndependentExecutionValidator(f.options).validateExecution({candidate,signal:signal()}))
      .toEqual({status:"deferred",reasonCode:"execution_transaction_mismatch"});
    expect(signExecution).not.toHaveBeenCalled();expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("replays parsed v0 lookup keys using the same explicit maximum version one and independent endpoint",async()=>{
    const f=fixture(),original=f.replies.getTransaction as {transaction:{message:Record<string,unknown>}};
    f.replies.getTransaction={...original,version:0,transaction:{...original.transaction,message:{...original.transaction.message,
      accountKeys:[{pubkey:wallet,source:"transaction",signer:true},{pubkey:"program",source:"lookupTable",signer:false}]}}};
    const candidate=await f.candidate();
    expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({candidate,signal:signal()})).status).toBe("verified");
    const request=JSON.parse(String(f.fetch.mock.calls[2]![1]?.body));
    expect(request.method).toBe("getTransaction");
    expect(request.params).toEqual(["signature",{commitment:"finalized",encoding:"jsonParsed",maxSupportedTransactionVersion:1}]);
    expect(f.fetch.mock.calls.every(call=>String(call[0])==="https://independent.example/rpc")).toBe(true);
  });
});

describe("independent v1 replay",()=>{
  it.each(["valid","malformed","lookup"])("only signs independently replayed valid v1 JSON: %s",async fault=>{
    const f=fixture(),tx=f.replies.getTransaction as {transaction:{message:Record<string,unknown>}};
    Object.assign(tx,{version:1});
    tx.transaction.message.transactionConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};
    const candidate=await f.candidate();
    if(fault==="malformed")tx.transaction.message.transactionConfig={computeUnitLimit:"30000"};
    if(fault==="lookup")tx.transaction.message.addressTableLookups=[{accountKey:"lookup"}];
    vi.mocked(signExecution).mockClear();
    const result=await createPostgresIndependentExecutionValidator(f.options).validateExecution({candidate,signal:signal()});
    expect(result.status).toBe(fault==="valid"?"verified":"deferred");
    if(fault!=="valid"){expect(result).toEqual({status:"deferred",reasonCode:"execution_transaction_mismatch"});expect(signExecution).not.toHaveBeenCalled();}
    for(const call of f.fetch.mock.calls){const request=JSON.parse(String(call[1]?.body));
      if(request.method==="getTransaction"||request.method==="getBlock")expect(request.params[1].maxSupportedTransactionVersion).toBe(1);}
  });
});

const invalidV1Indices=[-1,0.5,3,Number.MAX_SAFE_INTEGER+1,"1",null,undefined];
const indexLocations=["preToken","postToken","outerProgram","outerAccount","innerProgram","innerAccount"] as const;
function corruptV1Index(tx: {transaction:{message:Record<string,unknown>};meta:Record<string,unknown>},location:string,index:unknown){
  if(location==="preToken"||location==="postToken"){
    const key=location==="preToken"?"preTokenBalances":"postTokenBalances";
    const balances=structuredClone(tx.meta[key]) as Array<Record<string,unknown>>;balances[0]!.accountIndex=index;tx.meta[key]=balances;return;
  }
  const instruction=location.endsWith("Program")?{programIdIndex:index,accounts:[0,1,2]}:{programIdIndex:0,accounts:[index]};
  if(location.startsWith("outer"))tx.transaction.message.instructions=[instruction];
  else tx.meta.innerInstructions=[{index:0,instructions:[instruction]}];
}

describe("independent v1 replay index bounds",()=>{
  for(const location of indexLocations)it.each(invalidV1Indices)("does not sign "+location+" index %j",async index=>{
    const f=fixture(),tx=f.replies.getTransaction as {transaction:{message:Record<string,unknown>};meta:Record<string,unknown>};
    Object.assign(tx,{version:1});tx.transaction.message.transactionConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};
    const candidate=await f.candidate();corruptV1Index(tx,location,index);vi.mocked(signExecution).mockClear();
    expect(await createPostgresIndependentExecutionValidator(f.options).validateExecution({candidate,signal:signal()})).toEqual({status:"deferred",reasonCode:"execution_transaction_mismatch"});
    expect(signExecution).not.toHaveBeenCalled();expect(f.fetch).toHaveBeenCalledTimes(3);
  });
});

it("signs actual independent v1 replay with legally null inner instructions",async()=>{
  const f=fixture(),tx=f.replies.getTransaction as {transaction:{message:Record<string,unknown>};meta:Record<string,unknown>};
  Object.assign(tx,{version:1});tx.transaction.message.transactionConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};
  const candidate=await f.candidate();Object.assign(tx.meta,{innerInstructions:null});vi.mocked(signExecution).mockClear();
  expect((await createPostgresIndependentExecutionValidator(f.options).validateExecution({candidate,signal:signal()})).status).toBe("verified");
  expect(signExecution).toHaveBeenCalledTimes(1);expect(f.fetch).toHaveBeenCalledTimes(4);
});

it("reports replay RPC budget failure through the safe optional observer without signing",async()=>{
  const f=fixture(),candidate=await f.candidate(),onRpcDiagnostic=vi.fn();
  f.fetch.mockRejectedValueOnce(Object.assign(new Error("private endpoint"),{name:"PostgresProviderBudgetError",budgetReason:"concurrency"}));
  const result=await createPostgresIndependentExecutionValidator({...f.options,onRpcDiagnostic}).validateExecution({candidate,signal:signal()});
  expect(result).toEqual({status:"deferred",reasonCode:"execution_rpc_provider_budget_unavailable"});
  expect(onRpcDiagnostic).toHaveBeenCalledWith(expect.objectContaining({method:"getGenesisHash",budgetReason:"concurrency"}));
  expect(JSON.stringify(onRpcDiagnostic.mock.calls)).not.toContain("private");
});
