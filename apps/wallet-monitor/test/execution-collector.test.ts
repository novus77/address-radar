import { describe, expect, it } from "vitest";
import { createSolanaWalletCollector } from "../src/collectors.js";
import type { WalletRpcClient } from "../src/rpc.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const balance = (accountIndex: number, mint: string, amount: number) => ({
  accountIndex, mint, owner: "wallet", uiTokenAmount: { uiAmount: amount },
});

async function collect(options: { failed?: boolean; ambiguous?: boolean; native?: boolean; repeated?: boolean; mixed?: boolean } = {}) {
  const rpc: WalletRpcClient = {
    async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "sig", blockTime: 100 }];
      if (method === "getTransaction") return {
        blockTime: 100,
        transaction: { message: { accountKeys: ["wallet", PROGRAM], instructions: [{ programId: PROGRAM }] } },
        meta: {
          err: options.failed ? { InstructionError: [0, "Custom"] } : null,
          fee: 5000, preBalances: [1_000_000_000, 0],
          postBalances: [options.native || options.mixed ? 899_995_000 : 999_995_000, 0],
          preTokenBalances: [balance(1, "TokenCase", 0), ...options.native ? [] : [balance(2, USDC, 100)],
            ...options.ambiguous ? [balance(3, "OtherToken", 0)] : [],
            ...options.repeated ? [balance(4, "TokenCase", 0)] : []],
          postTokenBalances: [balance(1, "TokenCase", 100), ...options.native ? [] : [balance(2, USDC, 40)],
            ...options.ambiguous ? [balance(3, "OtherToken", 20)] : [],
            ...options.repeated ? [balance(4, "TokenCase", 100)] : []],
        },
      };
      throw new Error(`Unexpected RPC method ${method}`);
    },
  };
  const result = await createSolanaWalletCollector({
    rpc, batchSize: 1, now: () => 200_000,
    market: { async lookup() { return {
      chain: "solana", tokenAddress: "TokenCase", priceUsd: 999,
      marketCapUsd: 9_000_000, liquidityUsd: 1000, observedAt: new Date(200_000).toISOString(),
    }; } },
  }).collect({
    wallets: [{ address: "wallet", accountId: "account", entityId: "entity", lifecycle: "active" }],
    checkpoint: () => null, signal: new AbortController().signal,
  });
  return result.partitions.flatMap((partition) => partition.events);
}

describe("Solana execution valuation", () => {
  it("uses actual stablecoin spend and token quantity rather than current market prices", async () => {
    const events = await collect();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ amountUsd: 60, priceUsd: 0.6, marketCapUsd: null,
      occurredAt: 100_000, executionBasis: { status: "estimated", amountBasis: "nominal_stablecoin" } });
  });
  it("does not value failed transactions", async () => {
    expect(await collect({ failed: true })).toHaveLength(0);
  });
  it("does not reuse the same spend for multiple received tokens", async () => {
    const events = await collect({ ambiguous: true });
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ amountUsd: null, priceUsd: null, marketCapUsd: null });
  });
  it("keeps native swaps unvalued when no historical quote valuation exists", async () => {
    const events = await collect({ native: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ amountUsd: null, priceUsd: null, marketCapUsd: null });
  });
});

it("does not repeat the full quote amount across accounts for the same token", async () => {
  const events = await collect({ repeated: true });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ amountUsd: 60, priceUsd: 0.3 });
});
it("does not pretend partial stablecoin spend covers mixed native payment", async () => {
  const events = await collect({ mixed: true });
  expect(events[0]).toMatchObject({ amountUsd: null, priceUsd: null });
});
