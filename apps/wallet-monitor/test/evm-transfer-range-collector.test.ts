import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@address-radar/collectors";
import { createEvmBlockWalletCollector } from "../src/collectors.js";
import { createEvmTransferRangeWalletCollector, type EvmTransferRangeCollectorOptions,
  type EvmTransferRangeReceiptDecoder, type EvmTransferRangeLog } from "../src/evm-transfer-range-collector.js";
import { createConfiguredWalletRpcClient, type WalletRpcClient } from "../src/rpc.js";
import type { WalletCollectorResult } from "../src/contracts.js";

const walletAddress = "0x1111111111111111111111111111111111111111";
const otherWallet = "0x4444444444444444444444444444444444444444";
const pool = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const h = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const hex = (number: number) => `0x${number.toString(16)}`;
const topic = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
const txHash = h(90_001);
const wallets = [{ address: walletAddress, accountId: "account", entityId: "entity", lifecycle: "active" as const }];
const signal = () => new AbortController().signal;
const cp = (block = 100, blockHash = h(block)) => JSON.stringify({ blockNumber: block, blockHash });
function transfer(address: string, from: string, to: string, amount: number, index: number): EvmTransferRangeLog {
  return { address, topics: [TRANSFER, topic(from), topic(to)], data: h(amount), logIndex: hex(index),
    blockNumber: hex(110), blockHash: h(110), transactionHash: txHash, removed: false };
}
const transfers = [transfer(usdc, walletAddress, pool, 60_000_000, 1), transfer(token, pool, walletAddress, 100_000_000, 2)];

// Exercise the unchanged real decoder through its existing public collector contract until Ohm exports the leaf function.
const legacyDecoder: EvmTransferRangeReceiptDecoder = async input => {
  const number = Number(BigInt(input.receipt.blockNumber));
  const rpc: WalletRpcClient = { async request(chain, method, params) {
    if (method === "eth_blockNumber") return hex(number);
    if (method === "eth_getBlockByNumber") return { number: hex(number), hash: input.receipt.blockHash,
      timestamp: hex(input.occurredAt / 1000), transactions: [input.transaction] };
    if (method === "eth_getTransactionReceipt") return input.receipt;
    return input.rpc.request(chain, method, params, input.signal);
  } };
  const result = await createEvmBlockWalletCollector({ chain: input.chain, rpc, confirmationDepth: 0, maxBlocksPerPoll: 1 })
    .collect({ wallets: [input.wallet], checkpoint: () => null, signal: input.signal });
  if (result.failures?.length) throw new Error("Legacy decoding failed");
  const events = result.partitions.flatMap(partition => partition.events);
  return { events, hadCandidateTransfer: events.length > 0 || Boolean(result.diagnostics?.length) };
};
function fixture(patch: Partial<EvmTransferRangeCollectorOptions> = {}) {
  let now = 1_000;
  const receipt = { transactionHash: txHash, blockNumber: hex(110), blockHash: h(110), status: "0x1", logs: [
    ...transfers, { address: pool, topics: [SWAP], data: "0x", logIndex: "0x3" },
  ] };
  const transaction = { hash: txHash, blockNumber: hex(110), blockHash: h(110), from: walletAddress, to: pool, value: "0x0" };
  const request = vi.fn<WalletRpcClient["request"]>(async (_chain, method, params) => {
    if (method === "eth_blockNumber") return hex(1_000);
    if (method === "eth_getBlockByNumber") {
      const number = Number(BigInt(String(params[0])));
      return { number: hex(number), hash: h(number), timestamp: hex(1000 + number) };
    }
    if (method === "eth_getLogs") {
      const query = params[0] as { fromBlock: string; toBlock: string; topics: readonly unknown[] };
      const direction = query.topics[1] === null ? 2 : 1;
      const allowed = query.topics[direction] as string[];
      return transfers.filter(log => Number(BigInt(log.blockNumber)) >= Number(BigInt(query.fromBlock))
        && Number(BigInt(log.blockNumber)) <= Number(BigInt(query.toBlock)) && allowed.includes(log.topics[direction]!));
    }
    if (method === "eth_getTransactionReceipt") return structuredClone(receipt);
    if (method === "eth_getTransactionByHash") return structuredClone(transaction);
    if (method === "eth_call") return "0x6";
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const decodeReceipt = vi.fn<EvmTransferRangeReceiptDecoder>(legacyDecoder);
  const options: EvmTransferRangeCollectorOptions = { chain: "base", rpc: { request }, decodeReceipt,
    maximumLogs: 100, maximumRequests: 60, maximumPayloadBytes: 1_000_000, maximumRunMs: 1_000, now: () => now, ...patch };
  const collector = createEvmTransferRangeWalletCollector(options);
  const collect = (checkpoint: string | null = cp(), selectedWallets = wallets, callerSignal = signal()) =>
    collector.collect({ wallets: selectedWallets, checkpoint: () => checkpoint, signal: callerSignal });
  return { options, collector, collect, request, decodeReceipt, receipt, transaction, setNow: (value: number) => { now = value; } };
}
function checkpoint(result: WalletCollectorResult): number | null {
  return result.partitions[0] ? JSON.parse(result.partitions[0].nextCheckpoint).blockNumber : null;
}

function httpFixture(reject: (method: string, params: readonly unknown[]) => { code: number; message: string } | undefined,
  patch: Partial<EvmTransferRangeCollectorOptions> = {}, fallback = false) {
  const f = fixture(patch), original = f.request.getMockImplementation()!, errors: unknown[] = [];
  const fakeFetch = vi.fn<FetchLike>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
    const error = reject(request.method, request.params);
    const envelope = error ? { jsonrpc: "2.0", id: request.id, error }
      : { jsonrpc: "2.0", id: request.id,
        result: await original("base", request.method, request.params, init?.signal ?? signal()) };
    return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
  });
  const rpc = createConfiguredWalletRpcClient({ endpoints: { base: { primary: "https://rpc.test/primary",
    ...(fallback ? { fallback: "https://rpc.test/fallback" } : {}) } }, fetch: fakeFetch,
    now: f.options.now!, rateLimitCooldownMs: 30_000 });
  f.request.mockImplementation(async (...args) => {
    try { return await rpc.request(...args); } catch (error) { errors.push(error); throw error; }
  });
  return { ...f, fakeFetch, errors };
}

describe("bounded ERC20 Transfer range collector", () => {
  it("queries a default 512-block interval with separate from/to filters and reuses the real receipt decoder", async () => {
    const f = fixture(), result = await f.collect();
    expect(result.failures).toBeUndefined(); expect(checkpoint(result)).toBe(612);
    const queries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs").map(([, , params]) => params[0]);
    expect(queries).toEqual([
      { fromBlock: "0x65", toBlock: "0x264", topics: [TRANSFER, [topic(walletAddress)], null] },
      { fromBlock: "0x65", toBlock: "0x264", topics: [TRANSFER, null, [topic(walletAddress)]] },
    ]);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getTransactionReceipt")).toHaveLength(1);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getTransactionByHash")).toHaveLength(1);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_call")).toHaveLength(2);
    expect(result.partitions[0]!.events[0]).toMatchObject({ side: "buy", amountUsd: 60, priceUsd: 0.6, sourceBlockNumber: 110,
      sourceBlockHash: h(110), executionBasis: { amountBasis: "nominal_stablecoin" } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ reason: "erc20_transfer_observations_only" }));
    expect(JSON.stringify(result)).not.toContain("nonhit"); expect(JSON.stringify(result)).not.toContain("coverage_complete");
  });

  it("advances an empty 512-block range using seven RPCs instead of per-block requests", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => method === "eth_getLogs" ? [] : original(chain, method, params, signal));
    const result = await f.collect(); expect(checkpoint(result)).toBe(612);
    expect(f.request).toHaveBeenCalledTimes(7); expect(f.decodeReceipt).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getBlockByNumber").every(([, , params]) => params[1] === false)).toBe(true);
  });

  it("honors confirmation depth and caps a range at the safe head", async () => {
    const f = fixture(); expect(checkpoint(await f.collect(cp(990)))).toBe(998);
  });

  it("uses a bounded initial range without claiming historical completeness", async () => {
    const f = fixture(); expect(checkpoint(await f.collect(null))).toBe(998);
    const query = f.request.mock.calls.find(([, method]) => method === "eth_getLogs")![2][0] as { fromBlock: string };
    expect(query.fromBlock).toBe(hex(487));
  });

  it.each([1_000, 1_200])("retains bootstrap start after budget exhaustion with subsequent head %s", async nextHead => {
    const f = fixture({ maximumRequests: 7 }), original = f.request.getMockImplementation()!;
    let head = 1_000;
    f.receipt.blockNumber = hex(500); f.receipt.blockHash = h(500);
    f.transaction.blockNumber = hex(500); f.transaction.blockHash = h(500);
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_blockNumber") return hex(head);
      if (method === "eth_getLogs") {
        const query = params[0] as { fromBlock: string; toBlock: string; topics: readonly unknown[] };
        const direction = query.topics[1] === null ? 2 : 1, allowed = query.topics[direction] as string[];
        return Number(BigInt(query.fromBlock)) <= 500 && Number(BigInt(query.toBlock)) >= 500
          ? transfers.filter(log => allowed.includes(log.topics[direction]!)).map(log => ({ ...log, blockNumber: hex(500), blockHash: h(500) })) : [];
      }
      return original(chain, method, params, signal);
    });
    const first = await f.collect(null);
    expect(first.partitions).toEqual([]); expect(first.failures?.[0]?.error).toBe("evm_range_request_budget_exceeded");
    expect(f.request).toHaveBeenCalledTimes(7);
    head = nextHead; f.setNow(2_000);
    const second = await f.collect(null);
    expect(second.partitions).toEqual([]); expect(second.failures?.[0]?.error).toBe("evm_range_request_budget_exceeded");
    expect(f.request).toHaveBeenCalledTimes(14);
    const queries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs");
    expect(queries[0]![2][0]).toMatchObject({ fromBlock: hex(487), toBlock: hex(998) });
    expect(queries[2]![2][0]).toMatchObject({ fromBlock: hex(487), toBlock: hex(742) });
  });

  it("retains bootstrap intent when a returned batch has not been committed", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!; let head = 1_000;
    f.request.mockImplementation(async (chain, method, params, signal) =>
      method === "eth_blockNumber" ? hex(head) : original(chain, method, params, signal));
    expect(checkpoint(await f.collect(null))).toBe(998);
    head = 1_200;
    expect(checkpoint(await f.collect(null))).toBe(998);
    const queries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs");
    expect(queries[2]![2][0]).toMatchObject({ fromBlock: hex(487), toBlock: hex(998) });
    expect(checkpoint(await f.collect(cp(998)))).toBe(1_198);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")[4]![2][0])
      .toMatchObject({ fromBlock: hex(999), toBlock: hex(1_198) });
  });

  it("recovers from a committed checkpoint in a fresh collector instance", async () => {
    const first = fixture(), batch = await first.collect(null);
    const saved = batch.partitions[0]!.nextCheckpoint;
    const restarted = fixture(), original = restarted.request.getMockImplementation()!;
    restarted.request.mockImplementation(async (chain, method, params, signal) =>
      method === "eth_blockNumber" ? hex(1_200) : original(chain, method, params, signal));
    expect(checkpoint(await restarted.collect(saved))).toBe(1_198);
    expect(restarted.request.mock.calls.find(([, method]) => method === "eth_getLogs")![2][0])
      .toMatchObject({ fromBlock: hex(999), toBlock: hex(1_198) });
  });

  it("persists bootstrap intent separately before any log scan or completed checkpoint", async () => {
    const f = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const result = await f.collect(null);
    expect(f.request.mock.calls.map(([, method]) => method)).toEqual(["eth_blockNumber", "eth_getBlockByNumber"]);
    expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0]).toMatchObject({ partitionKey: "bootstrap:chain:base", events: [], canonicalBlocks: [] });
    expect(JSON.parse(result.partitions[0]!.nextCheckpoint)).toEqual({ format: "evm-transfer-bootstrap-v1",
      generation: "generation-c", collector: "evm:base", fromBlock: 487, boundaryNumber: 486,
      boundaryHash: h(486), scope: "erc20_transfer_only" });
    expect(f.decodeReceipt).not.toHaveBeenCalled();
  });

  it("loads the committed bootstrap after restart and retains its start across head advance and budget shrink", async () => {
    const first = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const anchor = (await first.collect(null)).partitions[0]!.nextCheckpoint;
    const f = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 }, maximumRequests: 7 });
    const original = f.request.getMockImplementation()!;
    f.receipt.blockNumber = hex(500); f.receipt.blockHash = h(500);
    f.transaction.blockNumber = hex(500); f.transaction.blockHash = h(500);
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_blockNumber") return hex(1_200);
      if (method === "eth_getLogs") return transfers.map(log => ({ ...log, blockNumber: hex(500), blockHash: h(500) }))
        .filter(log => { const q = params[0] as { topics: readonly unknown[] };
          const direction = q.topics[1] === null ? 2 : 1; return (q.topics[direction] as string[]).includes(log.topics[direction]!); });
      return original(chain, method, params, signal);
    });
    const collect = () => f.collector.collect({ wallets, signal: signal(),
      checkpoint: key => key === "bootstrap:chain:base" ? anchor : null });
    expect((await collect()).partitions).toEqual([]);
    f.setNow(2_000);
    expect((await collect()).partitions).toEqual([]);
    const queries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs");
    expect(queries[0]![2][0]).toMatchObject({ fromBlock: hex(487), toBlock: hex(998) });
    expect(queries[2]![2][0]).toMatchObject({ fromBlock: hex(487), toBlock: hex(742) });
  });

  it("recreates the same anchor after an uncommitted first batch and restart with an advanced head", async () => {
    const first = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const uncommitted = await first.collect(null);
    const restarted = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const original = restarted.request.getMockImplementation()!;
    restarted.request.mockImplementation(async (chain, method, params, signal) =>
      method === "eth_blockNumber" ? hex(1_200) : original(chain, method, params, signal));
    const retry = await restarted.collect(null);
    expect(retry.partitions).toEqual(uncommitted.partitions);
    expect(restarted.request.mock.calls.map(([, method]) => method)).toEqual(["eth_blockNumber", "eth_getBlockByNumber"]);
    expect(retry.partitions[0]!.partitionKey).toBe("bootstrap:chain:base");
  });

  it("rejects a stored anchor that conflicts with the configured sealed floor", async () => {
    const first = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const anchor = (await first.collect(null)).partitions[0]!.nextCheckpoint;
    const restarted = fixture({ bootstrap: { generation: "generation-c", fromBlock: 488 } });
    const result = await restarted.collector.collect({ wallets, signal: signal(),
      checkpoint: key => key === "bootstrap:chain:base" ? anchor : null });
    expect(result.partitions).toEqual([]);
    expect(result.failures?.[0]?.error).toBe("evm_range_invalid_bootstrap_anchor");
    expect(restarted.request.mock.calls.some(([, method]) => method === "eth_getLogs")).toBe(false);
  });

  it("refuses moving-tail fallback when a sealed floor is missing or invalid", () => {
    const f = fixture();
    for (const fromBlock of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => createEvmTransferRangeWalletCollector({ ...f.options,
        bootstrap: { generation: "generation-c", fromBlock } } as unknown as EvmTransferRangeCollectorOptions)).toThrow();
    }
  });

  it("does not move a sealed floor backward when the safe head has not reached it", async () => {
    const f = fixture({ bootstrap: { generation: "generation-c", fromBlock: 999 } });
    const result = await f.collect(null);
    expect(result.partitions).toEqual([]);
    expect(result.failures?.[0]?.error).toBe("evm_range_head_behind_bootstrap_anchor");
    expect(f.request.mock.calls.map(([, method]) => method)).toEqual(["eth_blockNumber"]);
  });

  it("scans only on the poll that reads a committed bootstrap", async () => {
    const f = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const anchor = (await f.collect(null)).partitions[0]!.nextCheckpoint;
    const result = await f.collector.collect({ wallets, signal: signal(),
      checkpoint: key => key === "bootstrap:chain:base" ? anchor : null });
    expect(result.failures).toBeUndefined(); expect(checkpoint(result)).toBe(998);
    expect(result.partitions[0]!.partitionKey).toBe("chain:base");
  });

  it.each(["generation", "collector", "scope", "boundary", "hash", "extra"])("rejects invalid bootstrap binding: %s", async kind => {
    const f = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const anchor = JSON.parse((await f.collect(null)).partitions[0]!.nextCheckpoint);
    if (kind === "generation") anchor.generation = "other";
    if (kind === "collector") anchor.collector = "evm:bsc";
    if (kind === "scope") anchor.scope = "coverage_complete";
    if (kind === "boundary") anchor.boundaryNumber++;
    if (kind === "hash") anchor.boundaryHash = h(9999);
    if (kind === "extra") anchor.completed = true;
    const result = await f.collector.collect({ wallets, signal: signal(),
      checkpoint: key => key === "bootstrap:chain:base" ? JSON.stringify(anchor) : null });
    expect(result.partitions).toEqual([]); expect(result.failures).toHaveLength(1);
    expect(f.request.mock.calls.some(([, method]) => method === "eth_getLogs")).toBe(false);
  });

  it("does not rebootstrap a completed checkpoint or consult a stale bootstrap", async () => {
    const f = fixture({ bootstrap: { generation: "generation-c", fromBlock: 487 } });
    const result = await f.collector.collect({ wallets, signal: signal(), checkpoint: key => {
      expect(key).toBe("chain:base"); return cp();
    } });
    expect(result.failures).toBeUndefined(); expect(checkpoint(result)).toBe(612);
    expect(result.partitions[0]!.partitionKey).toBe("chain:base");
  });

  it("deduplicates a self-transfer appearing in both direction queries", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    const self = transfer(token, walletAddress, walletAddress, 1, 4); f.receipt.logs.push(self);
    f.request.mockImplementation(async (chain, method, params, signal) => method === "eth_getLogs" ? [self] : original(chain, method, params, signal));
    f.decodeReceipt.mockResolvedValue({ events: [], hadCandidateTransfer: false });
    expect(checkpoint(await f.collect())).toBe(612);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getTransactionReceipt")).toHaveLength(1);
    expect(f.decodeReceipt).toHaveBeenCalledTimes(1);
  });

  it("chunks wallet topic OR lists without putting wallet addresses in the contract address filter", async () => {
    const f = fixture({ maximumWalletsPerQuery: 1 }); f.decodeReceipt.mockResolvedValue({ events: [], hadCandidateTransfer: false });
    await f.collect(cp(), [...wallets, { ...wallets[0]!, address: otherWallet, accountId: "other-account" }]);
    const queries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs"); expect(queries).toHaveLength(4);
    for (const [, , params] of queries) expect(params[0]).not.toHaveProperty("address");
  });

  it.each(["receipt", "transaction", "header"])("does not cross the cursor with a missing %s", async missing => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) =>
      (missing === "receipt" && method === "eth_getTransactionReceipt") || (missing === "transaction" && method === "eth_getTransactionByHash")
      || (missing === "header" && method === "eth_getBlockByNumber" && params[0] === hex(110)) ? null : original(chain, method, params, signal));
    const result = await f.collect(); expect(result.partitions).toEqual([]); expect(result.failures).toHaveLength(1);
  });

  it("never advances on missing historical decimals even if the original decoder catches the RPC error", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => { if (method === "eth_call") throw new Error("decimals unavailable"); return original(chain, method, params, signal); });
    expect((await f.collect()).partitions).toEqual([]);
  });

  it("does not publish a partially decoded range or cross a later missing receipt", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!, laterHash = h(90_002);
    const later = transfers.map(log => ({ ...log, transactionHash: laterHash, blockNumber: hex(111), blockHash: h(111) }));
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getTransactionReceipt" && params[0] === laterHash) return null;
      const value = await original(chain, method, params, signal);
      if (method === "eth_getLogs" && Array.isArray(value)) {
        const query = params[0] as { topics: readonly unknown[] };
        const direction = query.topics[1] === null ? 2 : 1;
        const allowed = query.topics[direction] as string[];
        return [...value, ...later.filter(log => allowed.includes(log.topics[direction]!))];
      }
      return value;
    });
    const result = await f.collect();
    expect(f.decodeReceipt).toHaveBeenCalledTimes(1);
    expect(result.partitions).toEqual([]); expect(checkpoint(result)).toBeNull();
    expect(result.failures?.[0]?.error).toBe(`receipt_unavailable:${laterHash}`);
  });

  it("shrinks oversize ranges within the same bounded request/time budget", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getLogs") {
        const query = params[0] as { fromBlock: string; toBlock: string };
        if (Number(BigInt(query.toBlock)) - Number(BigInt(query.fromBlock)) + 1 > 128) throw Object.assign(new Error("RPC range limit"), { code: -32005, reasonCode: "rpc_range_limit" });
      }
      return original(chain, method, params, signal);
    });
    expect(checkpoint(await f.collect())).toBe(228); expect(f.request.mock.calls.length).toBeLessThanOrEqual(60);
  });

  it("does not skip saturated one-block logs", async () => {
    const f = fixture({ rangeSize: 1, maximumLogs: 1 });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => method === "eth_getLogs" ? [transfers[0]!] : original(chain, method, params, signal));
    expect((await f.collect()).partitions).toEqual([]);
  });

  it("backs off 429 without a same-poll retry and honors the provider retryAt", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getLogs") throw Object.assign(new Error("429"), { name: "WalletRpcRateLimitError", retryAt: 50_000 });
      return original(chain, method, params, signal);
    });
    expect((await f.collect()).failures?.[0]?.error).toBe("evm_range_provider_backoff");
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(1);
    const calls = f.request.mock.calls.length; f.setNow(49_999); expect((await f.collect()).partitions).toEqual([]); expect(f.request).toHaveBeenCalledTimes(calls);
    f.request.mockImplementation(original); f.setNow(50_000); expect(checkpoint(await f.collect())).toBe(612);
  });

  it("does not reset the request budget when a range is adaptively retried", async () => {
    const f = fixture({ maximumRequests: 7 }), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getLogs") throw Object.assign(new Error("RPC range limit"), { code: -32005, reasonCode: "rpc_range_limit" });
      return original(chain, method, params, signal);
    });
    expect((await f.collect()).partitions).toEqual([]); expect(f.request.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("stops an exhausted poll and shrinks only the subsequent range without losing its cursor", async () => {
    const f = fixture({ maximumRequests: 7 }), original = f.request.getMockImplementation()!;
    f.receipt.blockNumber = hex(400); f.receipt.blockHash = h(400);
    f.transaction.blockNumber = hex(400); f.transaction.blockHash = h(400);
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getLogs") {
        const query = params[0] as { fromBlock: string; toBlock: string; topics: readonly unknown[] };
        const direction = query.topics[1] === null ? 2 : 1, allowed = query.topics[direction] as string[];
        return Number(BigInt(query.fromBlock)) <= 400 && Number(BigInt(query.toBlock)) >= 400
          ? transfers.filter(log => allowed.includes(log.topics[direction]!)).map(log => ({ ...log, blockNumber: hex(400), blockHash: h(400) })) : [];
      }
      return original(chain, method, params, signal);
    });
    const first = await f.collect();
    expect(first.partitions).toEqual([]); expect(first.failures?.[0]?.error).toBe("evm_range_request_budget_exceeded");
    expect(f.request).toHaveBeenCalledTimes(7);
    const firstQueries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs");
    expect(firstQueries).toHaveLength(2);
    expect(firstQueries[0]![2][0]).toMatchObject({ fromBlock: hex(101), toBlock: hex(612) });
    f.setNow(2_000);
    const second = await f.collect();
    expect(second.failures).toBeUndefined(); expect(checkpoint(second)).toBe(356);
    expect(f.request).toHaveBeenCalledTimes(14);
    const secondQueries = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs").slice(2);
    expect(secondQueries).toHaveLength(2);
    expect(secondQueries[0]![2][0]).toMatchObject({ fromBlock: hex(101), toBlock: hex(356) });
  });

  it.each([
    ["head", 2_000], ["head", 2_001], ["final-anchor", 2_000], ["final-anchor", 2_001],
  ] as const)("rejects injected elapsed expiry during %s at %s before the timer fires", async (phase, clock) => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maximumRunMs: 1_000 }), original = f.request.getMockImplementation()!;
      let anchors = 0;
      f.request.mockImplementation(async (chain, method, params, signal) => {
        const value = await original(chain, method, params, signal);
        if ((phase === "head" && method === "eth_blockNumber")
          || (phase === "final-anchor" && method === "eth_getBlockByNumber" && params[0] === hex(612) && ++anchors === 2)) {
          f.setNow(clock);
        }
        return value;
      });
      const result = await f.collect();
      expect(result.partitions).toEqual([]); expect(result.failures?.[0]?.error).toBe("evm_range_deadline_exceeded");
      if (phase === "head") expect(f.request).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("permits a complete range just inside the explicit elapsed budget", async () => {
    const f = fixture({ maximumRunMs: 1_000 }), original = f.request.getMockImplementation()!; let anchors = 0;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      const value = await original(chain, method, params, signal);
      if (method === "eth_getBlockByNumber" && params[0] === hex(612) && ++anchors === 2) f.setNow(1_999);
      return value;
    });
    expect(checkpoint(await f.collect())).toBe(612);
  });

  it("does not mistake rate-limit exceeded text for an oversized range", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getLogs") throw Object.assign(new Error("429 rate limit exceeded"), { status: 429, code: -32005 });
      return original(chain, method, params, signal);
    });
    expect((await f.collect()).failures?.[0]?.error).toBe("evm_range_provider_backoff");
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(1);
  });

  it("rewinds the configured lookback on a checkpoint hash mismatch", async () => {
    const f = fixture({ reorgLookback: 2, rangeSize: 3 });
    expect(checkpoint(await f.collect(cp(100, h(9999))))).toBe(100);
    const query = f.request.mock.calls.find(([, method]) => method === "eth_getLogs")![2][0] as { fromBlock: string; toBlock: string };
    expect(query).toMatchObject({ fromBlock: hex(98), toBlock: hex(100) });
  });

  it("rejects a reorg between range discovery and final canonical anchor validation", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!; let seen = 0;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      const value = await original(chain, method, params, signal);
      if (method === "eth_getBlockByNumber" && params[0] === hex(612) && ++seen === 2) return { ...(value as object), hash: h(9999) };
      return value;
    });
    expect((await f.collect()).failures?.[0]?.error).toBe("evm_range_canonical_mismatch");
  });

  it.each(["receipt-block", "receipt-log", "transaction", "removed", "filter"])("rejects inconsistent discovery/proof: %s", async kind => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    if (kind === "receipt-block") f.receipt.blockHash = h(999);
    if (kind === "receipt-log") f.receipt.logs.splice(0, 1);
    if (kind === "transaction") f.transaction.blockHash = h(999);
    f.request.mockImplementation(async (chain, method, params, signal) => {
      const value = await original(chain, method, params, signal);
      if (method === "eth_getLogs" && Array.isArray(value) && value.length) {
        if (kind === "removed") return value.map(item => ({ ...item, removed: true }));
        if (kind === "filter") return value.map(item => ({ ...item, topics: [TRANSFER, topic(pool), topic(pool)] }));
      }
      return value;
    });
    expect((await f.collect()).partitions).toEqual([]);
  });

  it("honors caller abort before any RPC", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect((await f.collect(cp(), wallets, controller.signal)).partitions).toEqual([]); expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["identical-duplicate", "conflicting-duplicate", "swap-duplicate", "missing-unrelated-index",
    "null-index", "numeric-index", "negative-index", "unsafe-index", "descending", "gap"])(
    "rejects the whole receipt before decode and checkpoint advancement: %s", async kind => {
      const f = fixture(), original = f.request.getMockImplementation()!;
      const malformed = structuredClone(f.receipt) as unknown as { logs: Record<string, unknown>[] };
      if (kind === "identical-duplicate") malformed.logs.splice(1, 0, { ...malformed.logs[0]! });
      if (kind === "conflicting-duplicate") malformed.logs.splice(1, 0, { ...malformed.logs[0]!, data: h(120_000_000) });
      if (kind === "swap-duplicate") malformed.logs[2]!.logIndex = "0x2";
      if (kind === "missing-unrelated-index") delete malformed.logs[2]!.logIndex;
      if (kind === "null-index") malformed.logs[2]!.logIndex = null;
      if (kind === "numeric-index") malformed.logs[2]!.logIndex = 3;
      if (kind === "negative-index") malformed.logs[2]!.logIndex = "-1";
      if (kind === "unsafe-index") malformed.logs[2]!.logIndex = "0x20000000000000";
      if (kind === "descending") [malformed.logs[0], malformed.logs[1]] = [malformed.logs[1]!, malformed.logs[0]!];
      if (kind === "gap") { malformed.logs[1]!.logIndex = "0x3"; malformed.logs[2]!.logIndex = "0x4"; }
      f.request.mockImplementation(async (chain, method, params, signal) =>
        method === "eth_getTransactionReceipt" ? malformed : original(chain, method, params, signal));
      const result = await f.collect();
      expect(result.partitions).toEqual([]); expect(checkpoint(result)).toBeNull(); expect(result.failures).toHaveLength(1);
      expect(f.decodeReceipt).not.toHaveBeenCalled();
      expect(f.request.mock.calls.some(([, method]) => method === "eth_call")).toBe(false);
    });

  it("accepts consecutive nonzero block-global log indices without changing real decoder quantities", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.receipt.logs = f.receipt.logs.map(log => ({ ...log, logIndex: hex(Number(BigInt(log.logIndex)) + 40) }));
    f.request.mockImplementation(async (chain, method, params, signal) => {
      const value = await original(chain, method, params, signal);
      return method === "eth_getLogs" && Array.isArray(value)
        ? value.map(log => ({ ...log, logIndex: hex(Number(BigInt(log.logIndex)) + 40) })) : value;
    });
    const result = await f.collect();
    expect(result.failures).toBeUndefined(); expect(checkpoint(result)).toBe(612);
    expect(result.partitions[0]!.events[0]).toMatchObject({ amountUsd: 60, priceUsd: 0.6 });
    expect(f.decodeReceipt).toHaveBeenCalledTimes(1);
  });

  it("bounds ignored RPC aborts and retains outstanding capacity", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maximumRunMs: 20 }); f.request.mockImplementation(async () => new Promise(() => {}));
      const work = f.collect(); await vi.advanceTimersByTimeAsync(20);
      expect((await work).failures?.[0]?.error).toBe("evm_range_aborted_or_timed_out");
      expect((await f.collect()).failures?.[0]?.error).toBe("evm_range_busy"); expect(f.request).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("bounds ignored decoder aborts without starting more work", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maximumRunMs: 20 }); f.decodeReceipt.mockImplementation(async () => new Promise(() => {}));
      const work = f.collect(); await vi.advanceTimersByTimeAsync(20);
      expect((await work).partitions).toEqual([]); expect((await f.collect()).failures?.[0]?.error).toBe("evm_range_busy");
      expect(f.decodeReceipt).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(["ambiguous", "generic-oversize", "string-code", "explicit-rate", "http-rate"])(
    "does not halve or advance an unconfirmed range rejection: %s", async kind => {
      const f = fixture(), original = f.request.getMockImplementation()!;
      const error = kind === "ambiguous" ? Object.assign(new Error("RPC unavailable"), { code: -32005 })
        : kind === "generic-oversize" ? new Error("response limit exceeded")
        : kind === "string-code" ? Object.assign(new Error("RPC range limit"), { code: "-32005", reasonCode: "rpc_range_limit" })
        : kind === "explicit-rate" ? Object.assign(new Error("rate limit exceeded"), { code: -32005, reasonCode: "rpc_range_limit" })
        : Object.assign(new Error("RPC range limit"), { code: -32005, reasonCode: "rpc_range_limit", status: 429 });
      f.request.mockImplementation(async (chain, method, params, signal) => {
        if (method === "eth_getLogs") throw error;
        return original(chain, method, params, signal);
      });
      const first = await f.collect();
      expect(first.partitions).toEqual([]);
      if (["ambiguous", "explicit-rate", "http-rate"].includes(kind)) {
        expect(first.failures?.[0]?.error).toBe("evm_range_provider_backoff");
      }
      expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain(error.message);
      f.setNow(2_000); f.request.mockImplementation(original);
      expect(checkpoint(await f.collect())).toBe(612);
      expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")[1]![2][0])
        .toMatchObject({ fromBlock: hex(101), toBlock: hex(612) });
    });

  it("does not halve a typed range error from a receipt or abandon the original range", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getTransactionReceipt") throw Object.assign(new Error("RPC range limit"), {
        code: -32005, reasonCode: "rpc_range_limit" });
      return original(chain, method, params, signal);
    });
    const first = await f.collect(); expect(first.partitions).toEqual([]);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(2);
    f.setNow(2_000); f.request.mockImplementation(original);
    expect(checkpoint(await f.collect())).toBe(612);
  });

  it("does not reset elapsed time while halving a precisely classified range", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_getLogs") {
        f.setNow(2_000);
        throw Object.assign(new Error("RPC range limit"), { code: -32005, reasonCode: "rpc_range_limit" });
      }
      return original(chain, method, params, signal);
    });
    const result = await f.collect();
    expect(result.partitions).toEqual([]); expect(result.failures?.[0]?.error).toBe("evm_range_deadline_exceeded");
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(1);
  });

  it("halves a real HTTP 200 range response after JsonRpcClient and wallet wrapper sanitization without fallback", async () => {
    const providerMessage = "query returned more than 10,000 results";
    const f = httpFixture((method, params) => {
      if (method !== "eth_getLogs") return undefined;
      const range = params[0] as { fromBlock: string; toBlock: string };
      return Number(BigInt(range.toBlock)) - Number(BigInt(range.fromBlock)) + 1 > 128
        ? { code: -32005, message: providerMessage } : undefined;
    }, {}, true);
    const result = await f.collect();
    expect(result.failures).toBeUndefined(); expect(checkpoint(result)).toBe(228);
    expect(f.errors).toHaveLength(2);
    for (const error of f.errors) {
      expect(error).toMatchObject({ name: "JsonRpcResponseError", code: -32005, reasonCode: "rpc_range_limit" });
      expect((error as Error).message).not.toContain(providerMessage);
    }
    const ranges = f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")
      .map(([, , params]) => params[0] as { fromBlock: string; toBlock: string });
    expect(ranges).toEqual([
      { fromBlock: hex(101), toBlock: hex(612), topics: [TRANSFER, [topic(walletAddress)], null] },
      { fromBlock: hex(101), toBlock: hex(356), topics: [TRANSFER, [topic(walletAddress)], null] },
      { fromBlock: hex(101), toBlock: hex(228), topics: [TRANSFER, [topic(walletAddress)], null] },
      { fromBlock: hex(101), toBlock: hex(228), topics: [TRANSFER, null, [topic(walletAddress)]] },
    ]);
    expect(f.fakeFetch.mock.calls.every(([url]) => url === "https://rpc.test/primary")).toBe(true);
    expect(f.request.mock.calls.length).toBeLessThanOrEqual(f.options.maximumRequests);
    expect(JSON.stringify(result)).not.toContain(providerMessage);
  });

  it.each(["limit exceeded", "rate limit exceeded"])(
    "does not halve or advance on a real HTTP 200 ambiguous/rate response: %s", async providerMessage => {
      let rejecting = true;
      const f = httpFixture(method => method === "eth_getLogs" && rejecting
        ? { code: -32005, message: providerMessage } : undefined);
      const first = await f.collect();
      expect(first.partitions).toEqual([]); expect(checkpoint(first)).toBeNull();
      expect(first.failures?.[0]?.error).toBe("evm_range_provider_backoff");
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toMatchObject({ name: "WalletRpcRateLimitError", retryAt: 31_000 });
      expect((f.errors[0] as Error).message).not.toContain(providerMessage);
      expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(1);
      const used = f.fakeFetch.mock.calls.length; f.setNow(30_999);
      expect((await f.collect()).partitions).toEqual([]); expect(f.fakeFetch).toHaveBeenCalledTimes(used);
      rejecting = false; f.setNow(31_000);
      expect(checkpoint(await f.collect())).toBe(612);
      expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")[1]![2][0])
        .toMatchObject({ fromBlock: hex(101), toBlock: hex(612) });
      expect(JSON.stringify(first)).not.toContain(providerMessage);
    });

  it("shares the original request budget across real HTTP range errors and never publishes an exhausted cursor", async () => {
    const f = httpFixture(method => method === "eth_getLogs"
      ? { code: -32005, message: "block range is too wide" } : undefined, { maximumRequests: 7 });
    const result = await f.collect();
    expect(result.partitions).toEqual([]); expect(checkpoint(result)).toBeNull();
    expect(result.failures?.[0]?.error).toBe("evm_range_request_budget_exceeded");
    expect(f.fakeFetch).toHaveBeenCalledTimes(7); expect(f.request).toHaveBeenCalledTimes(7);
    for (const [, method, params] of f.request.mock.calls) {
      if (method === "eth_getLogs") expect(params[0]).toMatchObject({ fromBlock: hex(101) });
    }
  });

  it("shares the original deadline across a real sanitized HTTP range error and its adaptive retry", async () => {
    let expire = () => {};
    const f = httpFixture(method => {
      if (method !== "eth_getLogs") return undefined;
      expire(); return { code: -32005, message: "eth_getLogs is limited to a 128 blocks range" };
    });
    expire = () => f.setNow(2_000);
    const result = await f.collect();
    expect(result.partitions).toEqual([]); expect(checkpoint(result)).toBeNull();
    expect(result.failures?.[0]?.error).toBe("evm_range_deadline_exceeded");
    expect(f.fakeFetch).toHaveBeenCalledTimes(4);
    expect(f.request.mock.calls.filter(([, method]) => method === "eth_getLogs")).toHaveLength(1);
    expect(f.errors[0]).toMatchObject({ name: "JsonRpcResponseError", code: -32005, reasonCode: "rpc_range_limit" });
  });

  it("requires explicit budgets and an original decoder port", () => {
    const f = fixture();
    expect(() => createEvmTransferRangeWalletCollector({ ...f.options, maximumRequests: 0 })).toThrow();
    expect(() => createEvmTransferRangeWalletCollector({ ...f.options, rangeSize: 513 })).toThrow();
    expect(() => createEvmTransferRangeWalletCollector({ ...f.options, decodeReceipt: undefined } as unknown as EvmTransferRangeCollectorOptions)).toThrow();
  });
});
