import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createEvmRpcWalletHistoryProvider,
  createSolanaRpcWalletHistoryProvider,
} from "../src/index.js";
import type {
  AnalysisRpcClient,
  HistoricalEventStore,
  HistoricalMarketSource,
  HistoricalTokenEvent,
} from "../src/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("Solana history accepts a two-leg swap and skips a transfer-only delta", async () => {
  const eventStore = memoryEvents();
  const rpc: AnalysisRpcClient = {
    async request(_chain, method, params) {
      if (method === "getSignaturesForAddress") return [
        { signature: "swap", blockTime: 100 },
        { signature: "transfer", blockTime: 99 },
      ];
      if (method === "getTransaction") return params[0] === "swap"
        ? solanaTransaction(true)
        : solanaTransaction(false);
      throw new Error(`unexpected ${method}`);
    },
  };
  const provider = createSolanaRpcWalletHistoryProvider({ rpc, market: market(), events: eventStore, pageSize: 10 });
  const result = await provider.collect({
    analysisId: "analysis",
    address: WALLET,
    from: 90_000,
    to: 110_000,
    limit: 300,
    cursor: null,
    signal: new AbortController().signal,
  });

  assert.equal(eventStore.events("analysis").length, 1);
  assert.equal(result.positions.length, 1);
  assert.match(result.provenance, /skipped_insufficient_swap_evidence=1/);
});

test("EVM history excludes an arbitrary ERC20 transfer without swap and quote evidence", async () => {
  const eventStore = memoryEvents();
  const rpc: AnalysisRpcClient = {
    async request(_chain, method, params) {
      if (method === "eth_blockNumber") return "0x0";
      if (method === "eth_getBlockByNumber") return {
        timestamp: "0x64",
        transactions: params[1] === true ? [{ hash: "0xhash", from: WALLET, to: TOKEN, value: "0x0" }] : [],
      };
      if (method === "eth_getTransactionReceipt") return {
        logs: [{
          address: TOKEN,
          logIndex: "0x0",
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            addressTopic("0x0000000000000000000000000000000000000000"),
            addressTopic(WALLET),
          ],
          data: "0xde0b6b3a7640000",
        }],
      };
      throw new Error(`unexpected ${method}`);
    },
  };
  const provider = createEvmRpcWalletHistoryProvider({ rpc, chains: ["eth"], market: market(), events: eventStore });
  const result = await provider.collect({
    analysisId: "analysis",
    address: WALLET,
    from: 100_000,
    to: 100_000,
    limit: 300,
    cursor: null,
    signal: new AbortController().signal,
  });

  assert.equal(eventStore.events("analysis").length, 0);
  assert.equal(result.positions.length, 0);
  assert.match(result.provenance, /skipped_insufficient_swap_evidence=1/);
});

function solanaTransaction(includeQuote: boolean) {
  const candidate = (amount: string) => ({ accountIndex: 1, mint: TOKEN, owner: WALLET, uiTokenAmount: { amount, decimals: 0 } });
  const quote = (amount: string) => ({ accountIndex: 2, mint: USDC, owner: WALLET, uiTokenAmount: { amount, decimals: 0 } });
  return {
    transaction: { message: { accountKeys: [WALLET] } },
    meta: {
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000],
      preTokenBalances: includeQuote ? [candidate("0"), quote("10")] : [candidate("0")],
      postTokenBalances: includeQuote ? [candidate("1"), quote("0")] : [candidate("1")],
    },
  };
}

function memoryEvents(): HistoricalEventStore {
  const values: HistoricalTokenEvent[] = [];
  return {
    append(_analysisId, events) { values.push(...events.filter((event) => !values.some((stored) => stored.eventId === event.eventId))); },
    events() { return values; },
    close() {},
  };
}

function market(): HistoricalMarketSource {
  return {
    async priceAt() { return 1; },
    async peakPrice() { return 2; },
    async minimumPrice() { return 0.5; },
    async firstObservedAt() { return 90_000; },
  };
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}
