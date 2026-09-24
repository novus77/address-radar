import { expect, test } from "vitest";

import { createEvmBlockWalletCollector } from "../src/collectors.js";

const wallet = Object.freeze({
  address: "0x00000000000000000000000000000000000000aa",
  accountId: "account-a",
  entityId: "entity-a",
  lifecycle: "monitored",
});

test("EVM null receipt preserves the last completed block and restart has no gap", async () => {
  let receiptUnavailable = true;
  const requestedBlocks: number[] = [];
  const collector = createEvmBlockWalletCollector({
    chain: "eth", confirmationDepth: 0, maxBlocksPerPoll: 2,
    rpc: { request: async (_chain: string, method: string, params: readonly unknown[]) => {
      if (method === "eth_blockNumber") return "0xc";
      if (method === "eth_getTransactionReceipt") return receiptUnavailable ? null : { blockHash: "0xblock11", logs: [] };
      const blockNumber = Number.parseInt(String(params[0]).slice(2), 16);
      if (params[1] === false) return { hash: `0xblock${blockNumber}`, timestamp: "0x1", transactions: [] };
      requestedBlocks.push(blockNumber);
      return { hash: `0xblock${blockNumber}`, timestamp: "0x1", transactions: blockNumber === 11 ? [{ hash: "0xtx11", from: wallet.address, to: "0x00000000000000000000000000000000000000bb", value: "0x0" }] : [] };
    } } as never,
  });
  const first = await collector.collect({ wallets: [wallet] as never, checkpoint: () => JSON.stringify({ blockNumber: 10, blockHash: "0xblock10" }), signal: new AbortController().signal });
  expect(JSON.parse(first.partitions[0]!.nextCheckpoint)).toEqual({ blockNumber: 10, blockHash: "0xblock10" });
  expect(first.failures?.[0]?.error).toContain("receipt_unavailable");
  receiptUnavailable = false;
  const second = await collector.collect({ wallets: [wallet] as never, checkpoint: () => first.partitions[0]!.nextCheckpoint, signal: new AbortController().signal });
  expect(JSON.parse(second.partitions[0]!.nextCheckpoint)).toEqual({ blockNumber: 12, blockHash: "0xblock12" });
  expect(requestedBlocks.filter((block) => block === 11)).toHaveLength(2);
});

test("EVM mid-batch abort checkpoints only the preceding completed block", async () => {
  const controller = new AbortController();
  const collector = createEvmBlockWalletCollector({
    chain: "eth", confirmationDepth: 0, maxBlocksPerPoll: 2,
    rpc: { request: async (_chain: string, method: string, params: readonly unknown[]) => {
      if (method === "eth_blockNumber") return "0xb";
      const blockNumber = Number.parseInt(String(params[0]).slice(2), 16);
      if (params[1] === false) return { hash: `0xblock${blockNumber}`, timestamp: "0x1", transactions: [] };
      if (blockNumber === 11) { controller.abort(); throw Object.assign(new Error("shutdown"), { name: "AbortError" }); }
      return { hash: `0xblock${blockNumber}`, timestamp: "0x1", transactions: [] };
    } } as never,
  });
  const result = await collector.collect({ wallets: [wallet] as never, checkpoint: () => JSON.stringify({ blockNumber: 9, blockHash: "0xblock9" }), signal: controller.signal });
  expect(JSON.parse(result.partitions[0]!.nextCheckpoint)).toEqual({ blockNumber: 10, blockHash: "0xblock10" });
  expect(result.failures?.[0]?.error).toBe("aborted");
});
