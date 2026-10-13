import { describe, expect, it, vi } from "vitest";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresTransaction } from "@address-radar/database";
import type { WalletCollector } from "../src/contracts.js";
import { createSolanaWalletCollector } from "../src/collectors.js";
import { deriveExecutionBasis } from "../src/execution-basis.js";
import {
  createPostgresWalletChannel, normalizePostgresWalletLease, preparePostgresWalletCapture,
  resolveCapturedWalletPurchase, selectPostgresWalletProfiles,
  walletPurchaseBasisFingerprint,
} from "../src/postgres-wallet-channel.js";

const walletAddress = "11111111111111111111111111111111";
const tokenAddress = "TokenCase";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const profile = {
  wallet: { address: walletAddress, accountId: "account", entityId: "entity", lifecycle: "active" as const },
  fact: { entityId: "entity", channel: "wallet" as const, subjectId: walletAddress, walletFamily: "solana" as const,
    associationConfidence: "confirmed" as const, associationSource: "chain_link", ownerCount: 1,
    walletConfidence: "confirmed" as const, walletSource: "chain_link", identityEvidenceRef: "identity:proof",
    ownershipEvidenceRef: "owner:proof", monitoringEnabled: true, suspended: false },
  profileEnabled: true, profileSuspended: false, bindingState: "owned" as const, versionId: "profile:v1",
};
const basis = deriveExecutionBasis({ successful: true, swapConfirmed: true,
  tokenDeltas: [{ asset: tokenAddress, quantity: 100 }],
  quoteDeltas: [{ asset: usdc, symbol: "USDC", quantity: -60, verifiedStablecoin: true }] });
const event = { eventId: "solana:sig:1", chain: "solana", walletAddress, tokenAddress, side: "buy" as const,
  amountUsd: 60, priceUsd: 0.6, marketCapUsd: null, occurredAt: 100_000,
  sourceReference: "solana:sig", executionBasis: basis };
const prepare = (overrides: Record<string, unknown> = {}) => preparePostgresWalletCapture({
  generationId: "generation", collectorId: "solana", sessionId: "session", chainFamily: "solana",
  receivedAt: 200_000, event, profile, executionTrust: "rpc_execution", ...overrides,
} as Parameters<typeof preparePostgresWalletCapture>[0]);

function sqlHarness() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const transaction: PostgresTransaction = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes("SELECT original_fingerprint")) return { rows: [{ original_fingerprint: null, revision_count: 0 }], rowCount: 1 };
    if (sql.includes("SELECT revision_number")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT job_id")) return { rows: [{ job_id: "job" }], rowCount: 1 };
    if (sql.includes("UPDATE wallet_channel_collectors") && sql.includes("RETURNING")) {
      return { rows: [{ claim_generation: 1, checkpoints_json: "{}", lease_expires_at: 260_000 }], rowCount: 1 };
    }
    if (sql.includes("SELECT * FROM wallet_channel_collectors")) return { rows: [{ claim_generation: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  return { transaction, calls };
}

describe("PostgreSQL wallet channel", () => {
  it("selects only enabled, unsuspended, uniquely owned trusted profiles", () => {
    expect(selectPostgresWalletProfiles([profile], "solana")).toEqual([profile]);
    for (const changed of [
      { ...profile, profileEnabled: false }, { ...profile, profileSuspended: true },
      { ...profile, fact: { ...profile.fact, suspended: true } },
      { ...profile, fact: { ...profile.fact, monitoringEnabled: false } },
      { ...profile, bindingState: "conflict" as const },
    ]) expect(selectPostgresWalletProfiles([changed], "solana")).toEqual([]);
    expect(selectPostgresWalletProfiles([profile, { ...profile, wallet: { ...profile.wallet, entityId: "other" },
      fact: { ...profile.fact, entityId: "other" } }], "solana")).toEqual([]);
  });

  it("keeps session and reception metadata outside semantic idempotency", () => {
    const first = prepare();
    const replay = prepare({ receivedAt: 210_000, sessionId: "restart" });
    expect(first.envelope.sourceEventId).toBe(replay.envelope.sourceEventId);
    expect(first.envelope.semanticPayload).toBe(replay.envelope.semanticPayload);
    expect(first.payload.event.sourceReference).toBe("solana:sig");
    expect(first.payload.purchase).toMatchObject({ amountUsd: "60", entryPriceUsd: "0.6", quoteAsset: "USDC",
      amountEstimated: true, amountBasis: "stablecoin_nominal", ownershipEvidenceRef: "owner:proof" });
  });

  it("never promotes spot prices, ambiguous spend, untrusted index transfers or unmatched ownership", () => {
    for (const changed of [
      { executionTrust: "unverified" }, { profile: null },
      { event: { ...event, executionBasis: undefined } },
      { event: { ...event, tokenAddress: "OtherToken" } },
      { event: { ...event, executionBasis: { ...basis, quoteAsset: "unknown" } } },
      { event: { ...event, amountUsd: 999 } },
      { profile: { ...profile, profileEnabled: false } },
    ]) expect(prepare(changed).payload.purchase).toBeNull();
  });

  it("requires explicit per-purchase evidence to enrich indexed input", () => {
    const purchase = { ...prepare().payload.purchase!, executionKey: "transaction:trade:1", executionEvidenceRef: "fixture:external-execution" };
    const externalBasis = { verifierId: "fixture-verifier", evidenceRef: purchase.executionEvidenceRef, generationId: "generation",
      sourceReference: event.sourceReference, executionKey: purchase.executionKey, purchaseFingerprint: walletPurchaseBasisFingerprint(purchase), verifiedAt: 200_000 };
    const enriched = prepare({ executionTrust: "unverified", verifiedPurchase: purchase, externalBasis });
    expect(enriched.payload.purchase?.executionKey).toBe("transaction:trade:1");
    expect(() => prepare({ verifiedPurchase: { ...purchase, entityId: "invented" } })).toThrow(/match/);
    expect(() => prepare({ verifiedPurchase: { ...purchase, entryPriceUsd: "999" }, externalBasis })).toThrow(/basis/);
    expect(() => prepare({ verifiedPurchase: purchase })).toThrow(/actual execution/);
  });

  it("rejects injected prices, quantities and execution IDs inconsistent with the actual collector basis", () => {
    const purchase = prepare().payload.purchase!;
    for (const changed of [{ entryPriceUsd: "999" }, { tokenQuantity: "1" }, { quoteAmount: "999", amountUsd: "999" },
      { executionEvidenceRef: "unproven:reference" }, { executionKey: "invented-execution" }]) {
      expect(() => prepare({ verifiedPurchase: { ...purchase, ...changed } })).toThrow(/actual execution/);
    }
    expect(prepare().payload.entryPriceBasis).toBe("executed_quote_per_token_nominal_usd");
  });

  it("defers other generations and missing execution without a fake purchase", () => {
    expect(resolveCapturedWalletPurchase(prepare().payload, "other")).toMatchObject({ status: "deferred" });
    expect(resolveCapturedWalletPurchase(prepare({ executionTrust: "unverified" }).payload, "generation")).toMatchObject({ status: "deferred" });
    expect(resolveCapturedWalletPurchase(prepare().payload, "generation")).toMatchObject({ status: "verified", purchase: { tokenQuantity: "100" } });
  });

  it("adapts the actual Solana collector without consulting a spot market", async () => {
    const balance = (accountIndex: number, mint: string, amount: number) => ({ accountIndex, mint,
      owner: walletAddress, uiTokenAmount: { uiAmount: amount } });
    const program = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    const collector = createSolanaWalletCollector({ rpc: { async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "sig", blockTime: 100 }];
      if (method === "getTransaction") return { blockTime: 100,
        transaction: { message: { accountKeys: [walletAddress, program], instructions: [{ programId: program }] } },
        meta: { err: null, fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [999_995_000, 0],
          preTokenBalances: [balance(1, tokenAddress, 0), balance(2, usdc, 100)],
          postTokenBalances: [balance(1, tokenAddress, 100), balance(2, usdc, 40)] } };
      throw new Error("Unexpected RPC");
    } }, batchSize: 1, now: () => 200_000 });
    const result = await collector.collect({ wallets: [profile.wallet], checkpoint: () => null, signal: new AbortController().signal });
    const collected = result.partitions.flatMap(partition => partition.events)[0]!;
    expect(prepare({ event: collected }).payload.purchase).toMatchObject({ amountUsd: "60", entryPriceUsd: "0.6" });
  });

  it("commits capture and normalization requests before advancing collector checkpoints", async () => {
    const { transaction, calls } = sqlHarness();
    const collect = vi.fn<WalletCollector["collect"]>(async () => ({ partitions: [{ partitionKey: "wallet", nextCheckpoint: "cursor", events: [event] }] }));
    let commits = 0;
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
      run: async operation => { const value = await operation(transaction); commits++; return value; },
      profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", collect }, executionTrust: "rpc_execution" }],
      maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, leaseMs: 60_000, maximumPayloadBytes: 65536, now: () => 200_000 });
    const result = await channel.pollOnce();
    expect(result.captured).toBe(1);
    expect(commits).toBe(2);
    expect(collect.mock.calls[0]?.[0].wallets).toEqual([profile.wallet]);
    const captureIndex = calls.findIndex(call => call.sql.includes("INSERT INTO capture_event_revisions"));
    const checkpointIndex = calls.findIndex(call => call.sql.includes("SET checkpoints_json"));
    const bindingIndex = calls.findIndex(call => call.sql.includes("INSERT INTO wallet_capture_generation_bindings"));
    expect(captureIndex).toBeGreaterThan(-1);
    expect(checkpointIndex).toBeGreaterThan(captureIndex);
    expect(bindingIndex).toBeGreaterThan(captureIndex);
    expect(bindingIndex).toBeLessThan(checkpointIndex);
    expect(calls[bindingIndex]?.values[0]).toBe("generation");
  });

  it("does not collect a truncated profile snapshot or move its checkpoint", async () => {
    const { transaction, calls } = sqlHarness();
    const collect = vi.fn();
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
      run: operation => operation(transaction), profiles: { async load() { return { status: "deferred", reasonCode: "profile_budget_exceeded" }; } },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", collect }, executionTrust: "rpc_execution" }],
      maximumProfiles: 1, maximumEvents: 1, collectorQuota: 1, leaseMs: 60_000, maximumPayloadBytes: 65536, now: () => 200_000 });
    expect((await channel.pollOnce()).deferred).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    expect(calls.some(call => call.sql.includes("SET checkpoints_json"))).toBe(false);
  });

  it("does not acknowledge a lost lease after staging captures", async () => {
    const { transaction } = sqlHarness();
    const base = transaction.query;
    transaction.query = async (sql, values) => sql.includes("SELECT * FROM wallet_channel_collectors")
      ? { rows: [], rowCount: 0 } : base(sql, values);
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
      run: operation => operation(transaction), profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", async collect() { return { partitions: [{ partitionKey: "wallet", nextCheckpoint: "cursor", events: [event] }] }; } }, executionTrust: "rpc_execution" }],
      maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, leaseMs: 60_000, maximumPayloadBytes: 65536, now: () => 200_000 });
    expect((await channel.pollOnce()).failed).toBe(1);
  });

  it("normalizes unavailable execution as an attributable event without fabricating amount", async () => {
    const prepared = prepare({ executionTrust: "unverified" });
    const calls: string[] = [];
    const tx: PostgresTransaction = { async query(sql, values) {
      calls.push(sql);
      if (sql.includes("SELECT semantic_payload")) return { rows: [{ semantic_payload: prepared.envelope.semanticPayload }], rowCount: 1 };
      if (sql.includes("SELECT j.*")) return { rows: [{ source_namespace: "wallet-chain", source_event_id: prepared.envelope.sourceEventId,
        semantic_fingerprint: "fingerprint", parser_version: "wallet-chain-v1", original_fingerprint: "fingerprint" }], rowCount: 1 };
      if (sql.includes("INSERT INTO capture_normalized_results")) expect(JSON.parse(String(values?.[7])).purchase).toBeNull();
      return { rows: [], rowCount: 1 };
    } };
    expect(await normalizePostgresWalletLease(tx, { jobId: "job", sourceNamespace: "wallet-chain",
      sourceEventId: prepared.envelope.sourceEventId, semanticFingerprint: "fingerprint", parserVersion: "wallet-chain-v1",
      requestedAt: 200_000, owner: "owner", claimGeneration: 1, leaseExpiresAt: 260_000 },
    { now: 200_000, maximumPayloadBytes: 65536 })).toBe(true);
    expect(calls.some(sql => sql.includes("INSERT INTO capture_consumer_intents"))).toBe(true);
  });

  it("strips unexpected provider fields from durable input and rejects credential-bearing provenance", () => {
    const captured = prepare({ event: { ...event, accessToken: "secret", executionBasis: { ...basis, apiKey: "secret" } },
      profile: { ...profile, credential: "secret", wallet: { ...profile.wallet, apiKey: "secret" } } });
    expect(captured.envelope.scrubbedPayload).not.toContain("secret");
    expect(() => prepare({ event: { ...event, sourceReference: "https://user:password@provider.invalid/transaction" } })).toThrow(/credentials/);
  });

  it("supports small execution prices without exponent-form database decimals", () => {
    const tiny = deriveExecutionBasis({ successful: true, swapConfirmed: true,
      tokenDeltas: [{ asset: tokenAddress, quantity: 6_000_000_000 }],
      quoteDeltas: [{ asset: usdc, symbol: "USDC", quantity: -60, verifiedStablecoin: true }] });
    expect(prepare({ event: { ...event, executionBasis: tiny, priceUsd: 0.00000001 } }).payload.purchase?.entryPriceUsd).toBe("0.00000001");
  });

  it("rolls back durable captures when normalization admission fails before the cursor write", async () => {
    const { transaction } = sqlHarness();
    const statements: string[] = [];
    const uow = createPostgresUnitOfWork({ async connect() { return {
      async query(sql, values) {
        statements.push(sql);
        if (sql.includes("INSERT INTO capture_normalization_jobs")) throw new Error("Admission interrupted");
        return transaction.query(sql, values);
      }, release() {},
    }; } }, { statementTimeoutMs: 1000, lockTimeoutMs: 100 });
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session", run: uow.run,
      profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", async collect() {
        return { partitions: [{ partitionKey: "wallet", nextCheckpoint: "cursor", events: [event] }] };
      } }, executionTrust: "rpc_execution" }], maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1,
      leaseMs: 60_000, maximumPayloadBytes: 65536, now: () => 200_000 });
    expect(await channel.pollOnce()).toMatchObject({ captured: 0, failed: 1 });
    expect(statements).toContain("ROLLBACK");
    expect(statements.some(sql => sql.includes("SET checkpoints_json"))).toBe(false);
  });

  it("does not fall back to a numeric basis when an explicit execution verifier defers", async () => {
    const { transaction, calls } = sqlHarness();
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session", run: operation => operation(transaction),
      profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      async verifyPurchase() { return { status: "deferred", reasonCode: "canonicality_unavailable" }; },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", async collect() {
        return { partitions: [{ partitionKey: "wallet", nextCheckpoint: "cursor", events: [event] }] };
      } }, executionTrust: "rpc_execution" }], maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1,
      leaseMs: 60_000, maximumPayloadBytes: 65536, now: () => 200_000 });
    expect((await channel.pollOnce()).captured).toBe(1);
    const revision = calls.find(call => call.sql.includes("INSERT INTO capture_event_revisions"));
    expect(JSON.parse(String(revision?.values[5])).purchase).toBeNull();
  });

  it("rotates a failing collector and bounds asynchronous provider waiting", async () => {
    const { transaction } = sqlHarness();
    const names: string[] = [];
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session", run: operation => operation(transaction),
      profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: ["first", "second"].map(name => ({ collector: { name, chainFamily: "solana" as const,
        async collect(request) {
          names.push(name);
          if (name === "first") return new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
          return { partitions: [] };
        },
      }, executionTrust: "unverified" as const })), maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1,
      leaseMs: 60_000, maximumRunMs: 30, maximumPayloadBytes: 65536, now: () => 200_000 });
    expect((await channel.pollOnce()).failed).toBe(1);
    await channel.pollOnce();
    expect(names).toEqual(["first", "second"]);
  });
});

describe("PostgreSQL wallet collector lifecycle", () => {
  function lifecycleChannel(collect: WalletCollector["collect"], overrides: Partial<Parameters<typeof createPostgresWalletChannel>[0]> = {}) {
    const harness = sqlHarness();
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
      run: operation => operation(harness.transaction), profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", collect }, executionTrust: "rpc_execution" }],
      maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, leaseMs: 60_000,
      maximumRunMs: 120, maximumPayloadBytes: 65536, now: () => 200_000, ...overrides });
    return { ...harness, channel };
  }

  it("drains cooperative cancellation before releasing the database lease and keeps completed partitions", async () => {
    let busy = false;
    const f = lifecycleChannel(async request => {
      busy = true;
      await new Promise<void>(resolve => request.signal.addEventListener("abort", () => {
        setTimeout(() => { busy = false; resolve(); }, 5);
      }, { once: true }));
      return { partitions: [{ partitionKey: "wallet", nextCheckpoint: "completed-prefix", events: [] }],
        failures: [{ partitionKey: "wallet", error: "aborted" }] };
    }, { run: async operation => {
      if (busy) throw new Error("PostgreSQL business pending operation budget exhausted");
      return operation(f.transaction);
    } });
    for (let poll = 0; poll < 4; poll++) {
      expect(await f.channel.pollOnce()).toMatchObject({ failed: 1, attempted: 1 });
      expect(busy).toBe(false);
    }
    expect(f.calls.filter(call => call.sql.includes("SET checkpoints_json"))).toHaveLength(4);
    expect(f.calls.find(call => call.sql.includes("SET checkpoints_json"))?.values[4]).toBe('{"wallet":"completed-prefix"}');
  });

  it("does not acquire or release another lease while a timed-out read still owns database work", async () => {
    let finish!: (value: { partitions: [] }) => void;
    const f = lifecycleChannel(async () => new Promise(resolve => { finish = resolve; }), { maximumRunMs: 20 });
    expect(await f.channel.pollOnce()).toMatchObject({ failed: 1, captured: 0 });
    const statements = f.calls.length;
    expect(await f.channel.pollOnce()).toMatchObject({ deferred: 1, attempted: 0 });
    expect(f.calls).toHaveLength(statements);
    expect(f.calls.some(call => call.sql.includes("SET lease_owner=NULL") || call.sql.includes("SET checkpoints_json"))).toBe(false);
    finish({ partitions: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.some(call => call.sql.includes("SET checkpoints_json"))).toBe(false);
  });

  it("propagates an uncertain capture commit instead of returning a successful poll", async () => {
    const uncertain = new PostgresCommitUncertainError(new Error("commit transport lost"));
    let commits = 0;
    const f = lifecycleChannel(async () => ({ partitions: [] }), { run: async operation => {
      const result = await operation(f.transaction);
      if (++commits === 2) throw uncertain;
      return result;
    } });
    await expect(f.channel.pollOnce()).rejects.toBe(uncertain);
    expect(commits).toBe(2);
  });

  it("does not hide a late uncertain read transaction behind its timeout", async () => {
    let fail!: (error: unknown) => void;
    const uncertain = new PostgresCommitUncertainError(new Error("provider lease commit lost"));
    const f = lifecycleChannel(async () => new Promise((_resolve, reject) => { fail = reject; }), { maximumRunMs: 20 });
    expect(await f.channel.pollOnce()).toMatchObject({ failed: 1 });
    fail(uncertain);
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(f.channel.pollOnce()).rejects.toBe(uncertain);
  });
});

describe("bounded sanitized PostgreSQL wallet poll diagnostics", () => {
  function diagnosticChannel(collect: WalletCollector["collect"], overrides: Partial<Parameters<typeof createPostgresWalletChannel>[0]> = {}) {
    const harness = sqlHarness();
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
      run: operation => operation(harness.transaction), profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: [{ collector: { name: "solana", chainFamily: "solana", collect }, executionTrust: "rpc_execution" }],
      maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, leaseMs: 60_000,
      maximumPayloadBytes: 65536, now: () => 200_000, ...overrides });
    return { ...harness, channel };
  }
  const secret = "https://user:password@private.example/rpc?api-key=SECRET";

  it.each(["evm_range_request_budget_exceeded", "evm_range_provider_backoff", "evm_range_logs_saturated",
    "evm_range_deadline_exceeded", "evm_range_aborted_or_timed_out", "evm_range_invalid_checkpoint",
    "evm_range_receipt_log_index_duplicate", "evm_range_rpc_or_decoder_unavailable", "evm_range_backoff"])(
    "preserves the fixed reviewed range reason %s",async reason=>{
      const f=diagnosticChannel(async()=>({partitions:[],failures:[{partitionKey:"chain:base",error:reason}]}));
      const result=await f.channel.pollOnce();
      expect(result.diagnostics[0]?.reasonCode).toBe(reason);expect(result.failed).toBe(1);
    });
  it.each(["evm_range_unreviewed", "evm_range_busy:SECRET", "evm_range_busy\nSECRET"])(
    "refuses arbitrary or suffixed range diagnostic text %s",async reason=>{
      const f=diagnosticChannel(async()=>({partitions:[],diagnostics:[{partitionKey:"chain:base",reason,sourceReference:secret}]}));
      const result=await f.channel.pollOnce();
      expect(result.diagnostics[0]?.reasonCode).toBe("unknown_failure");
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });

  it("keeps partial failures and observations without changing capture or checkpoint acknowledgement", async () => {
    const f = diagnosticChannel(async () => ({ partitions: [{ partitionKey: "wallet", nextCheckpoint: "cursor", events: [event] }],
      failures: [{ partitionKey: `wallet:${walletAddress}`, error: `HTTP 429 ${secret}` }],
      diagnostics: [{ partitionKey: `wallet:${walletAddress}`, reason: "insufficient_swap_evidence", sourceReference: `solana:${secret}` }] }));
    const result = await f.channel.pollOnce();
    expect(result).toMatchObject({ captured: 1, failed: 1, attempted: 1, diagnosticsDropped: 0,
      diagnostics: [{ kind: "collector_failure", collector: "solana", chainFamily: "solana", stage: "collect",
        partitionKind: "wallet", reasonCode: "rpc_rate_limited" },
      { kind: "collector_diagnostic", reasonCode: "insufficient_swap_evidence" }] });
    expect(f.calls.some(call => call.sql.includes("SET checkpoints_json") && call.values.includes(JSON.stringify({ wallet: "cursor" })))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(walletAddress);
  });

  it.each([
    ["WalletRpcRateLimitError", undefined, "rpc_rate_limited"],
    ["PostgresProviderBudgetError", undefined, "provider_budget_unavailable"],
    ["Error", "42501", "database_permission_denied"],
    ["Error", "57014", "database_query_cancelled"],
    ["PostgresCommitUncertainError", undefined, "commit_uncertain"],
    ["TimeoutError", undefined, "timeout"],
    ["Error", undefined, "unknown_failure"],
  ])("classifies outer %s/%s without exposing the exception", async (name, code, reasonCode) => {
    const error = Object.assign(new Error(secret), { name, code });
    const f = diagnosticChannel(async () => { throw error; });
    const result = await f.channel.pollOnce();
    expect(result).toMatchObject({ captured: 0, failed: 1, attempted: 1,
      diagnostics: [{ kind: "exception", stage: "collect", reasonCode }] });
    expect(f.calls.some(call => call.sql.includes("SET checkpoints_json"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["profiles", "commit"] as const)("retains the failing %s stage", async stage => {
    const f = diagnosticChannel(async () => ({ partitions: [] }), stage === "profiles"
      ? { profiles: { async load() { throw new Error(secret); } } } : {});
    if (stage === "commit") {
      const query = f.transaction.query;
      f.transaction.query = (sql, values) => {
        if (sql.includes("SELECT * FROM wallet_channel_collectors")) throw new Error("Wallet collector lease lost");
        return query(sql, values);
      };
    }
    const result = await f.channel.pollOnce();
    expect(result).toMatchObject({ failed: 1, captured: 0,
      diagnostics: [{ stage, reasonCode: stage === "commit" ? "collector_lease_lost" : "unknown_failure" }] });
    expect(f.calls.some(call => call.sql.includes("SET checkpoints_json"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("bounds diagnostic logs while preserving the complete failure count", async () => {
    const f = diagnosticChannel(async () => ({ partitions: [],
      failures: Array.from({ length: 40 }, () => ({ partitionKey: secret, error: secret })),
      diagnostics: [{ partitionKey: secret, reason: secret, sourceReference: secret }] }));
    const result = await f.channel.pollOnce();
    expect(result.failed).toBe(40);
    expect(result.diagnostics).toHaveLength(32);
    expect(result.diagnosticsDropped).toBe(9);
    expect(result.diagnostics.every(item => item.reasonCode === "unknown_failure" && item.partitionKind === "other")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("classifies bounded collector timeout without advancing a checkpoint", async () => {
    const f = diagnosticChannel(async () => new Promise<never>(() => {}), { maximumRunMs: 10 });
    const result = await f.channel.pollOnce();
    expect(result).toMatchObject({ captured: 0, failed: 1, diagnostics: [{ stage: "collect", reasonCode: "timeout" }] });
    expect(f.calls.some(call => call.sql.includes("SET checkpoints_json"))).toBe(false);
  });

  it("never logs unreviewed collector names, diagnostic strings or source references", async () => {
    const f = diagnosticChannel(async () => ({ partitions: [] }), {
      collectors: [{ executionTrust: "unverified", collector: { name: secret, chainFamily: "solana", async collect() {
        return { partitions: [], diagnostics: [{ partitionKey: secret, reason: secret, sourceReference: secret }] };
      } } }],
    });
    const result = await f.channel.pollOnce();
    expect(result.diagnostics).toEqual([{ kind: "collector_diagnostic", collector: "other", chainFamily: "solana",
      stage: "collect", partitionKind: "other", reasonCode: "unknown_failure" }]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

it("preserves a local durable cooldown refusal through the real Solana collector string boundary",async()=>{
  const rpc={request:vi.fn(async()=>{throw Object.assign(new Error("Durable provider budget unavailable"),{name:"PostgresProviderBudgetError"});})};
  const collector=createSolanaWalletCollector({rpc,batchSize:1,signatureLimit:1}),h=sqlHarness();
  const channel=createPostgresWalletChannel({generationId:"generation",ownerId:"worker",sessionId:"fixture",
    collectors:[{collector,executionTrust:"unverified"}],profiles:{load:async()=>({status:"ready",profiles:[profile]})},
    maximumProfiles:10,maximumEvents:10,collectorQuota:1,leaseMs:60_000,maximumPayloadBytes:65_536,maximumRunMs:1000,
    now:()=>200_000,run:async operation=>operation(h.transaction)});
  const report=await channel.pollOnce();
  expect(report).toMatchObject({captured:0,failed:1,diagnostics:[{kind:"collector_failure",reasonCode:"provider_budget_unavailable"}]});
  expect(rpc.request).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(report)).not.toContain(walletAddress);
});
