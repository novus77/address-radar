import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createEvmRpcWalletHistoryProvider, createSolanaRpcWalletHistoryProvider, openHistoricalEventStore } from "../src/index.js";
import type { AnalysisRpcClient, HistoricalMarketSource } from "../src/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const PAIR = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("historical EVM overlap reconciles a replaced block even when replacement is empty", async () => {
  const events = eventStore();
  let replaced = false;
  const provider = createEvmRpcWalletHistoryProvider({ rpc: evmRpc(() => 15, () => replaced), chains: ["eth"], market: market(), events, blocksPerPage: 1, confirmationDepth: 12, reorgLookback: 2 });
  const request = { analysisId: "reorg", address: WALLET, from: 100_000, to: 300_000, limit: 300, cursor: null, signal: new AbortController().signal };
  const first = await provider.collect(request);
  expect(events.events("reorg")).toHaveLength(1);
  replaced = true;
  await provider.collect({ ...request, cursor: first.nextCursor });
  expect(events.events("reorg")).toHaveLength(0);
  events.close();
});

test("historical EVM waits until the default-depth safe head reaches to", async () => {
  const events = eventStore();
  let head = 13;
  const provider = createEvmRpcWalletHistoryProvider({ rpc: evmRpc(() => head, () => true), chains: ["eth"], market: market(), events, blocksPerPage: 100 });
  const request = { analysisId: "tail", address: WALLET, from: 100_000, to: 300_000, limit: 300, cursor: null, signal: new AbortController().signal };
  const waiting = await provider.collect(request);
  expect(waiting.done).toBe(false);
  expect(waiting.nextCursor).not.toBeNull();
  head = 15;
  const completed = await provider.collect({ ...request, cursor: waiting.nextCursor });
  expect(completed.done).toBe(true);
  events.close();
});

test("Solana null transaction persists a pending signature and retries it", async () => {
  const events = eventStore();
  let available = false;
  const provider = createSolanaRpcWalletHistoryProvider({
    pageSize: 1, market: market(), events,
    rpc: { async request(_chain, method, params) {
      if (method === "getSignaturesForAddress") return params[1] && (params[1] as { before?: string }).before ? [] : [{ signature: "pending", blockTime: 100 }];
      return available ? solanaSwap() : null;
    } },
  });
  const request = { analysisId: "solana-pending", address: "wallet", from: 90_000, to: 110_000, limit: 300, cursor: null, signal: new AbortController().signal };
  const waiting = await provider.collect(request);
  expect(waiting.done).toBe(false);
  expect(waiting.nextCursor).not.toBeNull();
  expect(events.events("solana-pending")).toHaveLength(0);
  available = true;
  const completed = await provider.collect({ ...request, cursor: waiting.nextCursor });
  expect(completed.done).toBe(true);
  expect(events.events("solana-pending")).toHaveLength(1);
  events.close();
});

function eventStore() {
  const directory = mkdtempSync(join(tmpdir(), "wallet-history-resume-"));
  directories.push(directory);
  return openHistoricalEventStore(join(directory, "radar.sqlite"));
}
function evmRpc(head: () => number, replaced: () => boolean): AnalysisRpcClient {
  return { async request(_chain, method, params) {
    if (method === "eth_blockNumber") return `0x${head().toString(16)}`;
    if (method === "eth_call") return "0x0";
    if (method === "eth_getTransactionReceipt") return { blockHash: "0xold-1", logs: swapLogs() };
    const block = Number.parseInt(String(params[0]).slice(2), 16);
    const full = params[1] === true;
    const replacement = block === 1 && replaced();
    return { hash: replacement ? "0xnew-1" : `0xold-${block}`, timestamp: `0x${(block * 100).toString(16)}`, transactions: full && block === 1 && !replacement ? [{ hash: "0xtx", from: WALLET, to: PAIR, value: "0x0" }] : [] };
  } };
}
function swapLogs() {
  const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
  return [
    { address: TOKEN, topics: ["0xddf252ad", topic(PAIR), topic(WALLET)], data: "0xa", logIndex: "0x0" },
    { address: USDC, topics: ["0xddf252ad", topic(WALLET), topic(PAIR)], data: "0xa", logIndex: "0x1" },
    { address: PAIR, topics: ["0xd78ad95f"], data: "0x0", logIndex: "0x2" },
  ];
}
function solanaSwap() {
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  return { blockTime: 100, transaction: { message: { accountKeys: ["wallet"] } }, meta: { preTokenBalances: [{ accountIndex: 1, mint: "token", owner: "wallet", uiTokenAmount: { amount: "0", decimals: 0 } }, { accountIndex: 2, mint: usdc, owner: "wallet", uiTokenAmount: { amount: "10", decimals: 0 } }], postTokenBalances: [{ accountIndex: 1, mint: "token", owner: "wallet", uiTokenAmount: { amount: "1", decimals: 0 } }, { accountIndex: 2, mint: usdc, owner: "wallet", uiTokenAmount: { amount: "0", decimals: 0 } }] } };
}
function market(): HistoricalMarketSource { return { async priceAt() { return 1; }, async peakPrice() { return 2; }, async minimumPrice() { return 0.5; }, async firstObservedAt() { return 90_000; } }; }
