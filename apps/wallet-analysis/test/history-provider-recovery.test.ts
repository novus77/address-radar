import { describe, expect, it } from "vitest";

import { createEvmRpcWalletHistoryProvider, createSolanaRpcWalletHistoryProvider, type AnalysisRpcClient, type HistoricalEventStore, type HistoricalMarketSource } from "../src/history.js";

const market: HistoricalMarketSource = {
  priceAt: async () => null,
  peakPrice: async () => null,
  minimumPrice: async () => null,
  firstObservedAt: async () => null,
};

const events: HistoricalEventStore = {
  append() {},
  events: () => [],
  close() {},
};

describe("wallet history provider recovery", () => {
  it("requests Solana versioned transactions up to version 1", async () => {
    const calls: Array<{ method: string; params: readonly unknown[] }> = [];
    const rpc: AnalysisRpcClient = {
      async request(_chain, method, params) {
        calls.push({ method, params });
        if (method === "getSignaturesForAddress") return [{ signature: "signature", blockTime: 1 }];
        if (method === "getTransaction") return { blockTime: 1, meta: null, transaction: { message: { accountKeys: [] } } };
        throw new Error(`Unexpected method: ${method}`);
      },
    };
    const provider = createSolanaRpcWalletHistoryProvider({ rpc, market, events });

    await provider.collect({ analysisId: "analysis", address: "wallet", from: 0, to: 2_000, limit: 1, cursor: null, signal: new AbortController().signal });

    expect(calls.find(call => call.method === "getTransaction")?.params[1]).toMatchObject({ maxSupportedTransactionVersion: 1 });
  });

  it("continues EVM history from the earliest retained block", async () => {
    const requestedBlocks: number[] = [];
    const rpc: AnalysisRpcClient = {
      async request(_chain, method, params) {
        if (method === "eth_blockNumber") return "0x78";
        if (method !== "eth_getBlockByNumber") throw new Error(`Unexpected method: ${method}`);
        const blockNumber = Number.parseInt(String(params[0]).slice(2), 16);
        requestedBlocks.push(blockNumber);
        if (blockNumber < 80) throw new Error(`pruned history unavailable: requested ${blockNumber}, earliest available 80`);
        return { hash: `0x${blockNumber}`, timestamp: `0x${blockNumber.toString(16)}`, transactions: [] };
      },
    };
    const provider = createEvmRpcWalletHistoryProvider({ rpc, chains: ["base"], market, events, blocksPerPage: 10, confirmationDepth: 0 });

    const result = await provider.collect({ analysisId: "analysis", address: "0x1111111111111111111111111111111111111111", from: 1_000, to: 120_000, limit: 10, cursor: null, signal: new AbortController().signal });

    expect(Math.min(...requestedBlocks.filter(block => block >= 80))).toBeGreaterThanOrEqual(80);
    expect(result.provenance).toContain("history_truncated=1");
  });
});
