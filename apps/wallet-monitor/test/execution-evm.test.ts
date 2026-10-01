import { expect, it } from "vitest";
import { createEvmBlockWalletCollector } from "../src/collectors.js";
import type { WalletRpcClient } from "../src/rpc.js";

const wallet = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const transfer = (address: string, from: string, to: string, amount: bigint, logIndex: string) => ({
  address, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(from), topic(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`, logIndex,
});
async function collect(failed = false) {
  const rpc: WalletRpcClient = { async request(_chain, method, params) {
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getBlockByNumber") return { hash: "block", timestamp: "0x64",
      transactions: [{ hash: "transaction", from: wallet, to: pool, value: "0x0" }] };
    if (method === "eth_getTransactionReceipt") return { status: failed ? "0x0" : "0x1", blockHash: "block", logs: [
      transfer(usdc, wallet, pool, 60_000_000n, "0x1"),
      transfer(token, pool, wallet, 100_000_000n, "0x2"),
      { address: pool, topics: ["0xd78ad95f"], data: "0x" },
    ] };
    if (method === "eth_call") {
      expect(params[1]).toBe("0xe");
      return "0x6";
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  const result = await createEvmBlockWalletCollector({ chain: "eth", rpc, maxBlocksPerPoll: 1,
    market: { async lookup() { return { chain: "eth", tokenAddress: token, priceUsd: 999,
      marketCapUsd: 9_000_000, liquidityUsd: 1000, observedAt: new Date(200_000).toISOString() }; } },
  }).collect({ wallets: [{ address: wallet, accountId: "account", entityId: "entity", lifecycle: "active" }],
    checkpoint: () => null, signal: new AbortController().signal });
  return result.partitions.flatMap((partition) => partition.events);
}
it("derives EVM entry from receipt transfers and historical-block decimals", async () => {
  const events = await collect();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ amountUsd: 60, priceUsd: 0.6, marketCapUsd: null,
    executionBasis: { status: "estimated", amountBasis: "nominal_stablecoin" } });
});
it("does not emit failed EVM execution as a purchase", async () => {
  expect(await collect(true)).toHaveLength(0);
});
