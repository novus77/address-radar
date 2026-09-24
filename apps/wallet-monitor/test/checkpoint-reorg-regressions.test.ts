import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { createEvmBlockWalletCollector, createSolanaWalletCollector, openWalletMonitorStore } from "../src/index.js";
import type { WalletRpcClient } from "../src/index.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

test("EVM null block checkpoints only the last fully processed block", async () => {
  const rpc = evmRpc(async (method, params) => {
    if (method === "eth_blockNumber") return "0xc";
    if (method === "eth_getBlockByNumber") {
      const number = Number.parseInt(String(params[0]), 16);
      if (params[1] === false) return block(number, `h${number}`, []);
      if (number === 11) return null;
      return block(number, `h${number}`, []);
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await createEvmBlockWalletCollector({ chain: "base", rpc, confirmationDepth: 0, maxBlocksPerPoll: 3 }).collect({
    wallets: [wallet()],
    checkpoint: () => JSON.stringify({ blockNumber: 9, blockHash: "h9" }),
    signal: new AbortController().signal,
  });
  assert.equal(JSON.parse(result.partitions[0]!.nextCheckpoint).blockNumber, 10);
  assert.equal(result.failures?.[0]?.partitionKey, "chain:base");
});

test("EVM checkpoint hash mismatch rewinds the configured lookback", async () => {
  const requested: number[] = [];
  const rpc = evmRpc(async (method, params) => {
    if (method === "eth_blockNumber") return "0xa";
    if (method === "eth_getBlockByNumber") {
      const number = Number.parseInt(String(params[0]), 16);
      if (params[1] === false) return block(number, number === 10 ? "new-10" : `h${number}`, []);
      requested.push(number);
      return block(number, number === 10 ? "new-10" : `h${number}`, []);
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await createEvmBlockWalletCollector({ chain: "base", rpc, confirmationDepth: 0, maxBlocksPerPoll: 10, reorgLookback: 2 }).collect({
    wallets: [wallet()],
    checkpoint: () => JSON.stringify({ blockNumber: 10, blockHash: "old-10" }),
    signal: new AbortController().signal,
  });
  assert.deepEqual(requested, [8, 9, 10]);
  assert.deepEqual(JSON.parse(result.partitions[0]!.nextCheckpoint), { blockNumber: 10, blockHash: "new-10" });
  assert.deepEqual(result.partitions[0]!.canonicalBlocks?.at(-1), { blockNumber: 10, blockHash: "new-10" });
});

test("Solana null transaction leaves the wallet checkpoint unchanged for restart", async () => {
  const rpc: WalletRpcClient = { async request(_chain, method) {
    if (method === "getSignaturesForAddress") return [{ signature: "missing", blockTime: 100 }];
    if (method === "getTransaction") return null;
    throw new Error(`unexpected ${method}`);
  } };
  const result = await createSolanaWalletCollector({ rpc, batchSize: 1 }).collect({
    wallets: [{ address: "wallet", accountId: "account", entityId: "entity", lifecycle: "active" }],
    checkpoint: (key) => key === "wallet:wallet" ? JSON.stringify({ latestSignature: "old", checkedAt: 1 }) : null,
    signal: new AbortController().signal,
  });
  assert.equal(result.partitions.some((partition) => partition.partitionKey === "wallet:wallet"), false);
  assert.equal(result.failures?.[0]?.partitionKey, "wallet:wallet");
});

test("mixed unrelated EVM transfers in a swap receipt do not form a wallet trade", async () => {
  const pairA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pairB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const pairC = "0xcccccccccccccccccccccccccccccccccccccccc";
  const rpc = evmRpc(async (method, params) => {
    if (method === "eth_blockNumber") return "0x1";
    if (method === "eth_getBlockByNumber") return block(1, "h1", [{ hash: "tx", from: WALLET, to: "router", value: "0x0" }]);
    if (method === "eth_getTransactionReceipt") return { blockHash: "h1", logs: [
      transfer(TOKEN, pairA, WALLET, 1, 0),
      transfer(USDC, WALLET, pairB, 10, 1),
      { address: pairC, topics: ["0xd78ad95f"], data: "0x0" },
    ] };
    throw new Error(`unexpected ${method} ${params}`);
  });
  const result = await createEvmBlockWalletCollector({ chain: "base", rpc, confirmationDepth: 0 }).collect({
    wallets: [wallet()],
    checkpoint: () => null,
    signal: new AbortController().signal,
  });
  assert.equal(result.partitions[0]!.events.length, 0);
  assert.equal(result.diagnostics?.[0]?.reason, "insufficient_swap_evidence");
});

test("canonical replacement orphans observations from the displaced EVM block", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-reorg-"));
  const store = openWalletMonitorStore(join(dir, "db.sqlite"));
  store.persist("evm:base", "chain:base", [observation("old", "old-hash")], JSON.stringify({ blockNumber: 10, blockHash: "old-hash" }), 1, [{ blockNumber: 10, blockHash: "old-hash" }]);
  store.persist("evm:base", "chain:base", [observation("new", "new-hash")], JSON.stringify({ blockNumber: 10, blockHash: "new-hash" }), 2, [{ blockNumber: 10, blockHash: "new-hash" }]);
  assert.deepEqual(store.observations().map((item) => item.eventId), ["new"]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function wallet() {
  return { address: WALLET, accountId: "account", entityId: "entity", lifecycle: "active" as const };
}
function evmRpc(handler: (method: string, params: readonly unknown[]) => Promise<unknown>): WalletRpcClient {
  return { async request(_chain, method, params) { return handler(method, params); } };
}
function block(number: number, hash: string, transactions: readonly any[]) {
  return { number: `0x${number.toString(16)}`, hash, timestamp: "0x64", transactions };
}
function transfer(token: string, from: string, to: string, amount: number, logIndex: number) {
  return { address: token, logIndex: `0x${logIndex.toString(16)}`, topics: [TRANSFER, topic(from), topic(to)], data: `0x${amount.toString(16)}` };
}
function topic(address: string) { return `0x${address.slice(2).padStart(64, "0")}`; }
function observation(eventId: string, sourceBlockHash: string) {
  return { source: "evm:base", eventId, chainFamily: "evm" as const, chain: "base", walletAddress: WALLET, tokenAddress: TOKEN, accountId: "account", entityId: "entity", side: "buy" as const, amountUsd: 1, priceUsd: 1, marketCapUsd: 1, occurredAt: 1, collectedAt: 1, sourceReference: `base:${eventId}`, sourceBlockNumber: 10, sourceBlockHash };
}
