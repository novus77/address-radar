import assert from "node:assert/strict";
import test from "node:test";

import { loadWalletMonitorConfig } from "../src/config.js";
import { createProviderBudget } from "../src/provider-budget.js";
import { createConfiguredWalletRpcClient } from "../src/rpc.js";

test("provider budget keeps realtime and history capacity independent", async () => {
  let now = 0;
  const waits: number[] = [];
  const budget = createProviderBudget({
    realtime: { capacity: 1, refillPerSecond: 1 },
    history: { capacity: 1, refillPerSecond: 0.5 },
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  const signal = new AbortController().signal;

  await budget.acquire("realtime", signal);
  await budget.acquire("history", signal);
  assert.deepEqual(waits, []);

  await budget.acquire("realtime", signal);
  assert.deepEqual(waits, [1_000]);
  assert.equal(budget.snapshot().history.tokens, 0);
});

test("provider cooldown applies globally while another chain remains isolated", async () => {
  let now = 1_000;
  const waits: number[] = [];
  const budget = createProviderBudget({
    realtime: { capacity: 3, refillPerSecond: 3 },
    history: { capacity: 1, refillPerSecond: 1 },
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  budget.rateLimited(6_000);

  await budget.acquire("history", new AbortController().signal);
  assert.deepEqual(waits, [5_000]);
  assert.equal(budget.snapshot().cooldownUntil, 6_000);
  assert.equal(budget.snapshot().rateLimitCount, 1);
});

test("wallet RPC switches to fallback, honors Retry-After, and does not pause EVM", async () => {
  let now = 0;
  const waits: number[] = [];
  const calls: string[] = [];
  let primarySolanaCalls = 0;
  const budget = createProviderBudget({
    realtime: { capacity: 3, refillPerSecond: 3 },
    history: { capacity: 1, refillPerSecond: 1 },
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const requestId = Number(JSON.parse(String(init?.body ?? "{}") || "{}").id ?? 1);
    calls.push(url);
    if (url === "https://sol-primary.example") {
      primarySolanaCalls += 1;
      if (primarySolanaCalls === 1) {
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "2" },
        });
      }
      return rpcResponse("primary-ok", requestId);
    }
    if (url === "https://sol-fallback.example") return rpcResponse("fallback-ok", requestId);
    if (url === "https://eth.example") return rpcResponse("eth-ok", requestId);
    throw new Error(`Unexpected endpoint: ${url}`);
  };
  const rpc = createConfiguredWalletRpcClient({
    endpoints: {
      solana: {
        primary: "https://sol-primary.example",
        fallback: "https://sol-fallback.example",
      },
      eth: { primary: "https://eth.example" },
    },
    budgets: { solana: budget },
    fetch: fetcher as never,
    now: () => now,
    rateLimitCooldownMs: 30_000,
  });
  const signal = new AbortController().signal;

  assert.equal(await rpc.request("solana", "getSlot", [], signal), "fallback-ok");
  assert.equal(await rpc.request("eth", "eth_blockNumber", [], signal), "eth-ok");
  assert.deepEqual(waits, []);

  assert.equal(await rpc.request("solana", "getSlot", [], signal), "primary-ok");
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(calls, [
    "https://sol-primary.example",
    "https://sol-fallback.example",
    "https://eth.example",
    "https://sol-primary.example",
  ]);
});

test("Solana rotating batch defaults to three", () => {
  const config = loadWalletMonitorConfig({
    RADAR_RPC_SOLANA_HTTP_URL: "https://solana.example",
  });
  assert.equal(config.solanaBatchSize, 3);
});

function rpcResponse(result: unknown, id: number): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}
