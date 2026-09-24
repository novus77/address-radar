import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

import type { AddressRadarRepository } from "@address-radar/database";
import {
  createCandidateDiscoveryService,
  createEvmRpcWalletHistoryProvider,
  createSolanaRpcWalletHistoryProvider,
  createWalletAnalysisRuntime,
  openWalletAnalysisStore,
  reconstructWalletPositions,
  runWalletAnalysisService,
} from "../src/index.js";
import type { AnalysisRpcClient, HistoricalEventStore, HistoricalMarketSource } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("runtime accumulates three page-local batches to 300 unique tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "analysis-pages-")); dirs.push(dir);
  const store = openWalletAnalysisStore(join(dir, "db.sqlite"));
  store.enqueue({ analysisId: "pages", chainFamily: "solana", address: "wallet", requestedSamples: 500, createdAt: 1_000 });
  let page = 0;
  const runtime = createWalletAnalysisRuntime({
    store,
    now: () => 2_000,
    providers: { solana: { async collect(request) {
      assert.equal(request.limit, 300);
      const offset = page++ * 100;
      return {
        positions: Array.from({ length: 100 }, (_, index) => position(offset + index)),
        nextCursor: page < 3 ? `page-${page}` : null,
        done: page >= 3,
        provenance: "test",
      };
    } } },
  });

  await runtime.runOnce();
  await runtime.runOnce();
  await runtime.runOnce();

  assert.equal(store.positions("pages").length, 300);
  store.close();
});

test("Solana history uses transaction blockTime when signature blockTime is null", async () => {
  const events = memoryEvents();
  const provider = createSolanaRpcWalletHistoryProvider({
    rpc: { async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "sig", blockTime: null }];
      return stableSwapTransaction(100);
    } },
    market: market(),
    events,
  });
  const result = await provider.collect(historyRequest("null-time"));
  assert.equal(events.events("null-time").length, 1);
  assert.equal(result.positions.length, 1);
});

test("Solana history skips null timestamps without declaring the start reached", async () => {
  const events = memoryEvents();
  const provider = createSolanaRpcWalletHistoryProvider({
    pageSize: 1,
    rpc: { async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "unknown", blockTime: null }];
      return { transaction: { message: { accountKeys: ["wallet"] } }, meta: { preTokenBalances: [], postTokenBalances: [] } };
    } },
    market: market(),
    events,
  });
  const result = await provider.collect(historyRequest("unknown-time"));
  assert.equal(result.done, false);
  assert.equal(result.nextCursor, "unknown");
  assert.match(result.provenance, /missing_block_time=1/);
});

test("EVM history excludes transactions after the frozen to boundary", async () => {
  const events = memoryEvents();
  const rpc: AnalysisRpcClient = { async request(_chain, method, params) {
    if (method === "eth_blockNumber") return "0x1";
    if (method === "eth_getBlockByNumber") {
      const full = params[1] === true;
      return { number: params[0], hash: `hash-${params[0]}`, timestamp: params[0] === "0x0" ? "0x64" : "0xc8", transactions: full && params[0] === "0x1" ? [{ hash: "late", from: "0x1111111111111111111111111111111111111111", to: "router", value: "0x1" }] : [] };
    }
    if (method === "eth_getTransactionReceipt") throw new Error("receipt must not be fetched after to");
    throw new Error(`unexpected ${method}`);
  } };
  const provider = createEvmRpcWalletHistoryProvider({ rpc, chains: ["eth"], market: market(), events, blocksPerPage: 10, confirmationDepth: 0 });
  const result = await provider.collect({ ...historyRequest("window"), address: "0x1111111111111111111111111111111111111111", from: 100_000, to: 150_000 });
  assert.equal(result.positions.length, 0);
});

test("historical reconstruction ignores sells after the frozen to boundary", async () => {
  const positions = await reconstructWalletPositions({
    events: [
      { eventId: "buy", chain: "eth", tokenAddress: "token", side: "buy", tokenAmount: 10, occurredAt: 100, source: "onchain" },
      { eventId: "late-sell", chain: "eth", tokenAddress: "token", side: "sell", tokenAmount: 10, occurredAt: 201, source: "onchain" },
    ],
    market: market(), limit: 300, observedAt: 200,
  });
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.remainingValueUsd, 10);
  assert.equal(positions[0]!.realizedValueUsd, 0);
});

test("EVM history rejects a mixed receipt with unrelated quote transfer", async () => {
  const events = memoryEvents();
  const walletAddress = "0x1111111111111111111111111111111111111111";
  const pairA = "0x2222222222222222222222222222222222222222";
  const pairB = "0x3333333333333333333333333333333333333333";
  const token = "0x4444444444444444444444444444444444444444";
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  const rpc: AnalysisRpcClient = { async request(_chain, method, params) {
    if (method === "eth_blockNumber") return "0x1";
    if (method === "eth_getBlockByNumber") {
      const blockNumber = String(params[0]);
      return { hash: `hash-${blockNumber}`, timestamp: blockNumber === "0x0" ? "0x0" : "0x1", transactions: params[1] === true && blockNumber === "0x1" ? [{ hash: "mixed", from: walletAddress, to: pairA, value: "0x0" }] : [] };
    }
    if (method === "eth_getTransactionReceipt") return { blockHash: "hash-0x1", logs: [
      { address: token, topics: ["0xddf252ad", topic(pairA), topic(walletAddress)], data: "0xa", logIndex: "0x0" },
      { address: usdc, topics: ["0xddf252ad", topic(walletAddress), topic(pairB)], data: "0xa", logIndex: "0x1" },
      { address: pairA, topics: ["0xd78ad95f"], data: "0x0", logIndex: "0x2" },
    ] };
    if (method === "eth_call") throw new Error("unsupported candidate must not be valued");
    throw new Error(`unexpected ${method}`);
  } };
  const provider = createEvmRpcWalletHistoryProvider({ rpc, chains: ["eth"], market: market(), events, confirmationDepth: 0 });
  const result = await provider.collect({ analysisId: "mixed", address: walletAddress, from: 0, to: 1_000, limit: 300, cursor: null, signal: new AbortController().signal });
  assert.equal(result.positions.length, 0);
  assert.match(result.provenance, /skipped_insufficient_swap_evidence=1/);
});

test("duplicate canonical milestones do not create candidate discoveries again", () => {
  let milestoneCalls = 0;
  let discoveryCalls = 0;
  const repository = {
    recordTokenMilestone() { milestoneCalls += 1; return { inserted: milestoneCalls === 1 }; },
    eventsForToken() { return [{ eventId: "buy", accountId: "account", entityId: "entity", chain: "base", tokenAddress: "token", side: "buy", amountUsd: 100, priceUsd: 1, marketCapUsd: 10_000, tokenAgeMs: 1, occurredAt: 500, collectedAt: 500, source: "onchain" }]; },
    saveCandidateDiscovery() { discoveryCalls += 1; },
    candidateDiscoveries() { return []; },
  } as unknown as AddressRadarRepository;
  const service = createCandidateDiscoveryService({ repository });
  const event = { chain: "base", tokenAddress: "token", marketCapUsd: 100_000, reachedAt: 1_000, provenance: { source: "onchain", sourceEventIds: ["event"] } };
  service.observe(event);
  service.observe({ ...event, reachedAt: 2_000, provenance: { source: "onchain", sourceEventIds: ["duplicate"] } });
  assert.equal(milestoneCalls, 2);
  assert.equal(discoveryCalls, 1);
});

test("analysis sleep removes its abort listener after timeout", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  let calls = 0;
  await runWalletAnalysisService({
    signal: controller.signal,
    intervalMs: 0,
    runOnce: async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { processed: false };
    },
  });
  assert.ok(remove.mock.calls.some(([type]) => type === "abort"));
});

function position(index: number) {
  return { tokenId: `solana:token-${index}`, enteredAt: 500, investedUsd: 1, realizedValueUsd: 0, remainingValueUsd: 1, peakValueUsd: 2, holdingDurationMs: 1, maximumDrawdownRatio: 0, earlyEntry: false, largeBuy: false };
}
function historyRequest(analysisId: string) {
  return { analysisId, address: "wallet", from: 90_000, to: 110_000, limit: 300, cursor: null, signal: new AbortController().signal };
}
function stableSwapTransaction(blockTime: number) {
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  return { blockTime, transaction: { message: { accountKeys: ["wallet"] } }, meta: { preTokenBalances: [{ accountIndex: 1, mint: "token", owner: "wallet", uiTokenAmount: { amount: "0", decimals: 0 } }, { accountIndex: 2, mint: usdc, owner: "wallet", uiTokenAmount: { amount: "10", decimals: 0 } }], postTokenBalances: [{ accountIndex: 1, mint: "token", owner: "wallet", uiTokenAmount: { amount: "1", decimals: 0 } }, { accountIndex: 2, mint: usdc, owner: "wallet", uiTokenAmount: { amount: "0", decimals: 0 } }] } };
}
function memoryEvents(): HistoricalEventStore {
  const values: any[] = [];
  return { append(_id, events) { values.push(...events); }, events() { return values; }, close() {} };
}
function market(): HistoricalMarketSource {
  return { async priceAt() { return 1; }, async peakPrice() { return 2; }, async minimumPrice() { return 0.5; }, async firstObservedAt() { return 90_000; } };
}
