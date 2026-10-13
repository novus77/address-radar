import assert from "node:assert/strict";
import { test } from "vitest";

import { createSolanaWalletCollector } from "../src/index.js";
import type { WalletCollectorResult, WalletRpcClient } from "../src/index.js";
import { loadWalletMonitorConfig } from "../src/config.js";

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

test("Solana rate limiting preserves the failed wallet schedule cursor", async () => {
  const rpc: WalletRpcClient = {
    async request(_chain, method) {
      if (method === "getSignaturesForAddress") {
        const error = new Error("provider cooldown");
        error.name = "WalletRpcRateLimitError";
        throw error;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const collector = createSolanaWalletCollector({ rpc, batchSize: 1 });
  const result = await collector.collect({
    wallets: wallets(2),
    checkpoint: (partition) => partition === "schedule"
      ? JSON.stringify({ nextIndex: 0 })
      : JSON.stringify({ latestSignature: "stable", checkedAt: 100 }),
    signal: new AbortController().signal,
  });

  const schedule = result.partitions.find((partition) => partition.partitionKey === "schedule");
  assert.equal(JSON.parse(schedule?.nextCheckpoint ?? "{}").nextIndex, 0);
  assert.equal(result.partitions.some((partition) => partition.partitionKey === "wallet:wallet-0"), false);
  assert.equal(result.failures?.[0]?.partitionKey, "wallet:wallet-0");
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

test("Solana transaction lookup supports version one transactions", async () => {
  let transactionOptions: unknown;
  const rpc: WalletRpcClient = {
    async request(_chain, method, params) {
      if (method === "getSignaturesForAddress") return [{ signature: "versioned", blockTime: 100 }];
      if (method === "getTransaction") {
        transactionOptions = params[1];
        return swapTransaction("versioned", 100);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  await createSolanaWalletCollector({ rpc, batchSize: 1 }).collect({
    wallets: wallets(1),
    checkpoint: () => null,
    signal: new AbortController().signal,
  });

  assert.deepEqual(transactionOptions, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 });
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

test("Solana signature page size is explicitly configurable and bounded", () => {
  const base = { RADAR_RPC_SOLANA_HTTP_URL: "https://solana.example" };
  assert.equal(loadWalletMonitorConfig(base).solanaSignatureLimit, 100);
  assert.equal(loadWalletMonitorConfig({ ...base, ADDRESS_RADAR_SOLANA_SIGNATURE_LIMIT: "10" }).solanaSignatureLimit, 10);
  for (const value of ["0", "-1", "1.5", "1001", "NaN"]) {
    assert.throws(() => loadWalletMonitorConfig({ ...base, ADDRESS_RADAR_SOLANA_SIGNATURE_LIMIT: value }));
  }
  const rpc: WalletRpcClient = { async request() { return []; } };
  for (const signatureLimit of [0, -1, 1.5, 1001]) assert.throws(() => createSolanaWalletCollector({ rpc, signatureLimit }));
  for (const activatedAt of [-1, 1.5, NaN, Infinity]) assert.throws(() => createSolanaWalletCollector({ rpc, activatedAt }));
});

test("Solana forward boundary excludes old transactions and closes a full page with explicit scope evidence", async () => {
  const lookedUp: string[] = [];
  const rpc: WalletRpcClient = { async request(_chain, method, params) {
    if (method === "getSignaturesForAddress") return [
      { signature: "after", blockTime: 102 }, { signature: "equal", blockTime: 101 }, { signature: "old", blockTime: 100 },
    ];
    lookedUp.push(String(params[0]));
    return swapTransaction(String(params[0]), params[0] === "after" ? 102 : 101);
  } };
  const result = await createSolanaWalletCollector({ rpc, activatedAt: 101_000, signatureLimit: 3, now: () => 104_000 }).collect({
    wallets: wallets(1), checkpoint: () => null, signal: new AbortController().signal,
  });
  assert.deepEqual(lookedUp, ["equal", "after"]);
  const partition = result.partitions.find(p => p.partitionKey === "wallet:wallet-0")!;
  assert.deepEqual(partition.events.map(event => event.occurredAt), [101_000, 102_000]);
  assert.deepEqual(JSON.parse(partition.nextCheckpoint), { latestSignature: "after", checkedAt: 104_000,
    scope: { kind: "forward-only", activatedAt: 101_000,
      baseline: { kind: "before-activation", signature: "old", blockTime: 100 } } });
});

test("Solana forward pagination retains committed backlog and replays an uncommitted page without loss", async () => {
  const queries: Array<Record<string, unknown>> = [];
  const lookedUp: string[] = [];
  const rpc: WalletRpcClient = { async request(_chain, method, params) {
    if (method === "getSignaturesForAddress") {
      const query = params[1] as Record<string, unknown>; queries.push(query);
      return query.before === "sig-2" ? [{ signature: "sig-1", blockTime: 101 }, { signature: "old", blockTime: 100 }]
        : [{ signature: "sig-3", blockTime: 103 }, { signature: "sig-2", blockTime: 102 }];
    }
    lookedUp.push(String(params[0])); return swapTransaction(String(params[0]), Number(String(params[0]).at(-1)) + 100);
  } };
  const collector = createSolanaWalletCollector({ rpc, activatedAt: 101_000, signatureLimit: 2, batchSize: 1, now: () => 104_000 });
  const checkpoints = new Map<string, string>([["wallet:wallet-0", JSON.stringify({ latestSignature: "prior", checkedAt: 99_000 })]]);
  const poll = () => collector.collect({ wallets: wallets(1), checkpoint: key => checkpoints.get(key) ?? null, signal: new AbortController().signal });
  const first = await poll();
  const replay = await poll();
  assert.deepEqual(replay, first);
  applyCheckpoints(checkpoints, first);
  const partial = JSON.parse(checkpoints.get("wallet:wallet-0")!);
  assert.equal(partial.latestSignature, "prior");
  assert.deepEqual(partial.backlog, { newestSignature: "sig-3", before: "sig-2" });
  assert.equal(partial.scope.baseline, null);
  const last = await poll(); applyCheckpoints(checkpoints, last);
  assert.deepEqual([...first.partitions, ...last.partitions].flatMap(p => p.events.map(e => e.eventId)).sort(),
    ["solana:sig-1:1", "solana:sig-2:1", "solana:sig-3:1"]);
  const closed = JSON.parse(checkpoints.get("wallet:wallet-0")!);
  assert.equal(closed.latestSignature, "sig-3"); assert.equal(closed.backlog, undefined);
  assert.equal(closed.scope.baseline.signature, "old");
  assert.deepEqual(queries.at(-1), { limit: 2, until: "prior", before: "sig-2" });
  assert.equal(lookedUp.includes("old"), false);
});

test("Solana unknown signature times defer without moving the wallet cursor or fetching transactions", async () => {
  for (const blockTime of [undefined, null, NaN, -1, 100.5]) {
    const methods: string[] = [];
    const rpc: WalletRpcClient = { async request(_chain, method) {
      methods.push(method); return [{ signature: "new", blockTime: 102 }, { signature: "unknown", blockTime }];
    } };
    const result = await createSolanaWalletCollector({ rpc, activatedAt: 101_000 }).collect({
      wallets: wallets(1), checkpoint: () => null, signal: new AbortController().signal,
    });
    assert.equal(result.partitions.some(p => p.partitionKey.startsWith("wallet:")), false);
    assert.equal(result.failures?.[0]?.error, "signature_time_unavailable");
    assert.deepEqual(methods, ["getSignaturesForAddress"]);
  }
});

test("Solana forward scope drift and inconsistent transaction times defer rather than skip observed events", async () => {
  for (const mode of ["scope", "transaction", "ordering"] as const) {
    const methods: string[] = [];
    const rpc: WalletRpcClient = { async request(_chain, method) {
      methods.push(method);
      if (method === "getSignaturesForAddress") return mode === "ordering"
        ? [{ signature: "old", blockTime: 100 }, { signature: "new", blockTime: 102 }]
        : [{ signature: "new", blockTime: 102 }];
      return swapTransaction("new", 100);
    } };
    const result = await createSolanaWalletCollector({ rpc, activatedAt: 101_000 }).collect({
      wallets: wallets(1), checkpoint: key => mode === "scope" && key.startsWith("wallet:")
        ? JSON.stringify({ latestSignature: "prior", checkedAt: 100_000,
          scope: { kind: "forward-only", activatedAt: 100_000, baseline: null } }) : null,
      signal: new AbortController().signal,
    });
    assert.equal(result.partitions.some(p => p.partitionKey.startsWith("wallet:")), false);
    assert.equal(result.failures?.length, 1);
    if (mode === "scope") assert.deepEqual(methods, []);
  }
});

test("Solana old-only baselines and empty ranges remain explicit while batch-one scheduling stays fair", async () => {
  const selected: string[] = [];
  const rpc: WalletRpcClient = { async request(_chain, method, params) {
    assert.equal(method, "getSignaturesForAddress"); selected.push(String(params[0]));
    return params[0] === "wallet-0" ? [{ signature: "old", blockTime: 100 }] : [];
  } };
  const collector = createSolanaWalletCollector({ rpc, activatedAt: 101_000, batchSize: 1, signatureLimit: 1 });
  const checkpoints = new Map<string, string>();
  for (let i = 0; i < 2; i++) applyCheckpoints(checkpoints, await collector.collect({
    wallets: wallets(2), checkpoint: key => checkpoints.get(key) ?? null, signal: new AbortController().signal,
  }));
  assert.deepEqual(selected, ["wallet-0", "wallet-1"]);
  assert.equal(JSON.parse(checkpoints.get("wallet:wallet-0")!).scope.baseline.kind, "before-activation");
  assert.deepEqual(JSON.parse(checkpoints.get("wallet:wallet-1")!).scope.baseline,
    { kind: "range-exhausted", untilSignature: null });
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
