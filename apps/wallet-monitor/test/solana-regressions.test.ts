import assert from "node:assert/strict";
import { test } from "vitest";

import { createSolanaWalletCollector } from "../src/index.js";
import type { WalletCollectorResult, WalletRpcClient } from "../src/index.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "Token111111111111111111111111111111111111";

const wallets = (count: number) => Array.from({ length: count }, (_, index) => ({
  address: `wallet-${index}`,
  accountId: `account-${index}`,
  entityId: `entity-${index}`,
  lifecycle: "active" as const,
}));

const applyCheckpoints = (checkpoints: Map<string, string>, result: WalletCollectorResult) => {
  for (const partition of result.partitions) {
    checkpoints.set(partition.partitionKey, partition.nextCheckpoint);
  }
};

test("Solana scheduling rotates fairly beyond batchSize", async () => {
  const observed: string[] = [];
  const rpc: WalletRpcClient = {
    async request(_chain, method, params) {
      if (method === "getSignaturesForAddress") {
        observed.push(String(params[0]));
        return [];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const collector = createSolanaWalletCollector({ rpc, batchSize: 2 });
  const checkpoints = new Map<string, string>();

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const result = await collector.collect({
      wallets: wallets(5),
      checkpoint: (partition) => checkpoints.get(partition) ?? null,
      signal: new AbortController().signal,
    });
    applyCheckpoints(checkpoints, result);
  }

  assert.deepEqual(observed, ["wallet-0", "wallet-1", "wallet-2", "wallet-3", "wallet-4", "wallet-0"]);
  assert.equal(JSON.parse(checkpoints.get("schedule") ?? "{}").nextIndex, 1);
});

test("Solana pagination persists intermediate state and closes the whole backlog without gaps", async () => {
  const signatureRequests: unknown[][] = [];
  const rpc: WalletRpcClient = {
    async request(_chain, method, params) {
      if (method === "getSignaturesForAddress") {
        signatureRequests.push([...params]);
        const options = params[1] as { before?: string };
        return options.before === "sig-2"
          ? [{ signature: "sig-1", blockTime: 101 }]
          : [{ signature: "sig-3", blockTime: 103 }, { signature: "sig-2", blockTime: 102 }];
      }
      if (method === "getTransaction") {
        const signature = String(params[0]);
        return swapTransaction(signature, Number(signature.at(-1)) + 100);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const collector = createSolanaWalletCollector({ rpc, batchSize: 1, signatureLimit: 2, now: () => 104_000 });
  const checkpoints = new Map<string, string>([[
    "wallet:wallet-0",
    JSON.stringify({ latestSignature: "old", checkedAt: 100 }),
  ]]);
  const eventIds: string[] = [];

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const result = await collector.collect({
      wallets: wallets(1),
      checkpoint: (partition) => checkpoints.get(partition) ?? null,
      signal: new AbortController().signal,
    });
    eventIds.push(...result.partitions.flatMap((partition) => partition.events.map((event) => event.eventId)));
    applyCheckpoints(checkpoints, result);
    if (cycle === 0) {
      const intermediate = JSON.parse(checkpoints.get("wallet:wallet-0") ?? "{}");
      assert.equal(intermediate.latestSignature, "old");
      assert.deepEqual(intermediate.backlog, { newestSignature: "sig-3", before: "sig-2" });
    }
  }

  assert.deepEqual(signatureRequests.map((request) => request[1]), [
    { limit: 2, until: "old" },
    { limit: 2, until: "old", before: "sig-2" },
  ]);
  assert.deepEqual(eventIds.sort(), ["solana:sig-1:1", "solana:sig-2:1", "solana:sig-3:1"]);
  assert.deepEqual(JSON.parse(checkpoints.get("wallet:wallet-0") ?? "{}"), {
    latestSignature: "sig-3",
    checkedAt: 104_000,
  });
});

test("Solana transfer-only balance changes are skipped with a diagnostic", async () => {
  const rpc: WalletRpcClient = {
    async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "transfer", blockTime: 100 }];
      if (method === "getTransaction") return transferTransaction();
      throw new Error(`unexpected ${method}`);
    },
  };
  const collector = createSolanaWalletCollector({ rpc, batchSize: 1 });
  const result = await collector.collect({
    wallets: wallets(1),
    checkpoint: () => null,
    signal: new AbortController().signal,
  });

  assert.equal(result.partitions.flatMap((partition) => partition.events).length, 0);
  assert.equal(result.diagnostics?.[0]?.reason, "insufficient_swap_evidence");
});

test("Solana claim plus fee-only native decrease is not treated as a buy", async () => {
  const rpc: WalletRpcClient = {
    async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "claim", blockTime: 100 }];
      if (method === "getTransaction") return claimTransaction();
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await createSolanaWalletCollector({ rpc, batchSize: 1 }).collect({
    wallets: wallets(1),
    checkpoint: () => null,
    signal: new AbortController().signal,
  });

  assert.equal(result.partitions.flatMap((partition) => partition.events).length, 0);
  assert.equal(result.diagnostics?.[0]?.reason, "insufficient_swap_evidence");
});

test("Solana native swap recognizes a fee-adjusted SOL leg only with a known swap program", async () => {
  const rpc: WalletRpcClient = {
    async request(_chain, method) {
      if (method === "getSignaturesForAddress") return [{ signature: "native-swap", blockTime: 100 }];
      if (method === "getTransaction") return nativeSwapTransaction();
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await createSolanaWalletCollector({ rpc, batchSize: 1 }).collect({
    wallets: wallets(1),
    checkpoint: () => null,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result.partitions.flatMap((partition) => partition.events).map((event) => event.side), ["buy"]);
});

function swapTransaction(signature: string, blockTime: number) {
  return {
    blockTime,
    transaction: { message: { accountKeys: ["wallet-0"] } },
    meta: {
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000],
      preTokenBalances: [
        tokenBalance(1, TOKEN, "wallet-0", 0),
        tokenBalance(2, USDC, "wallet-0", 10),
      ],
      postTokenBalances: [
        tokenBalance(1, TOKEN, "wallet-0", 1),
        tokenBalance(2, USDC, "wallet-0", 0),
      ],
    },
    signature,
  };
}

function transferTransaction() {
  return {
    blockTime: 100,
    transaction: { message: { accountKeys: ["wallet-0"] } },
    meta: {
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000],
      preTokenBalances: [tokenBalance(1, TOKEN, "wallet-0", 0)],
      postTokenBalances: [tokenBalance(1, TOKEN, "wallet-0", 1)],
    },
  };
}

function claimTransaction() {
  return {
    blockTime: 100,
    transaction: { message: { accountKeys: ["wallet-0"], instructions: [] } },
    meta: {
      fee: 5_000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [tokenBalance(1, TOKEN, "wallet-0", 0)],
      postTokenBalances: [tokenBalance(1, TOKEN, "wallet-0", 1)],
    },
  };
}

function nativeSwapTransaction() {
  return {
    blockTime: 100,
    transaction: {
      message: {
        accountKeys: ["wallet-0", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
        instructions: [{ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }],
      },
    },
    meta: {
      fee: 5_000,
      preBalances: [1_000_000_000, 0],
      postBalances: [899_995_000, 0],
      preTokenBalances: [tokenBalance(1, TOKEN, "wallet-0", 0)],
      postTokenBalances: [tokenBalance(1, TOKEN, "wallet-0", 1)],
    },
  };
}

function tokenBalance(accountIndex: number, mint: string, owner: string, amount: number) {
  return { accountIndex, mint, owner, uiTokenAmount: { uiAmount: amount } };
}
