import { describe, expect, it, vi } from "vitest";
import { createEvmBlockWalletCollector, decodeEvmTransferRangeReceipt } from "../src/collectors.js";
import { createEvmTransferRangeWalletCollector, type EvmTransferRangeReceiptDecoder } from "../src/evm-transfer-range-collector.js";
import type { WalletRpcClient } from "../src/rpc.js";

const h = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
const topic = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
const wallet = { address: address(1), accountId: "account", entityId: "entity", lifecycle: "active" as const };
const pool = address(2), token = address(3), usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const swap = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
function fixture() {
  const transaction = { hash: h(900), from: wallet.address, to: pool, value: "0x0", blockNumber: "0x6e", blockHash: h(110) };
  const receipt = { transactionHash: transaction.hash, blockNumber: transaction.blockNumber, blockHash: transaction.blockHash,
    status: "0x1", logs: [
      { address: usdc, topics: [transfer, topic(wallet.address), topic(pool)], data: h(60_000_000), logIndex: "0x1" },
      { address: token, topics: [transfer, topic(pool), topic(wallet.address)], data: h(100_000_000), logIndex: "0x2" },
      { address: pool, topics: [swap], data: "0x", logIndex: "0x3" },
    ] };
  const request = vi.fn<WalletRpcClient["request"]>(async () => "0x6");
  const input: Parameters<EvmTransferRangeReceiptDecoder>[0] = { chain: "base", wallet, transaction, receipt,
    occurredAt: 111_000, rpc: { request }, signal: new AbortController().signal };
  return { input, transaction, receipt, request };
}

describe("real EVM range receipt decoder", () => {
  it("uses historical decimals and real execution quantities without block or receipt facade RPCs", async () => {
    const f = fixture(), decoded = await decodeEvmTransferRangeReceipt(f.input);
    expect(decoded.hadCandidateTransfer).toBe(true);
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({ eventId: `base:${h(900)}:1`, side: "buy", amountUsd: 60,
      priceUsd: 0.6, sourceBlockNumber: 110, sourceBlockHash: h(110), occurredAt: 111_000,
      executionBasis: { tokenQuantity: 100, quoteQuantity: 60, amountBasis: "nominal_stablecoin" } });
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const [chain, method, params, signal, kind] of f.request.mock.calls) {
      expect(chain).toBe("base"); expect(method).toBe("eth_call"); expect(params[1]).toBe("0x6e");
      expect(signal).toBe(f.input.signal); expect(kind).toBe("history");
    }
  });

  it("matches the existing full-block collector's event semantics", async () => {
    const f = fixture();
    const rpc: WalletRpcClient = { async request(chain, method, params, signal, kind) {
      if (method === "eth_blockNumber") return "0x6e";
      if (method === "eth_getBlockByNumber") return { hash: h(110), timestamp: "0x6f", transactions: [f.transaction] };
      if (method === "eth_getTransactionReceipt") return f.receipt;
      return f.request(chain, method, params, signal, kind);
    } };
    const result = await createEvmBlockWalletCollector({ chain: "base", rpc, confirmationDepth: 0, maxBlocksPerPoll: 1 }).collect({
      wallets: [wallet], checkpoint: () => null, signal: f.input.signal,
    });
    expect((await decodeEvmTransferRangeReceipt(f.input)).events).toEqual(result.partitions.flatMap(p => p.events));
  });

  it("does not invent execution for failed receipts or plain transfers", async () => {
    const failed = fixture(); failed.receipt.status = "0x0";
    expect(await decodeEvmTransferRangeReceipt(failed.input)).toEqual({ events: [], hadCandidateTransfer: false });
    expect(failed.request).not.toHaveBeenCalled();
    const plain = fixture(); plain.receipt.logs.pop();
    expect(await decodeEvmTransferRangeReceipt(plain.input)).toMatchObject({ events: [], hadCandidateTransfer: true });
  });

  it.each(["number", "hash", "transaction", "status", "clock"])("rejects inconsistent %s binding before RPC", async kind => {
    const f = fixture();
    if (kind === "number") f.transaction.blockNumber = "0x6f";
    if (kind === "hash") f.transaction.blockHash = h(999);
    if (kind === "transaction") f.receipt.transactionHash = h(999);
    if (kind === "status") f.receipt.status = "0x2";
    if (kind === "clock") (f.input as { occurredAt: number }).occurredAt = NaN;
    await expect(decodeEvmTransferRangeReceipt(f.input)).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });

  it("honors an already aborted signal before decoding", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(decodeEvmTransferRangeReceipt({ ...f.input, signal: controller.signal })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["budget", "missing", "abort"])("keeps the range unacknowledged on decoder %s failure", async kind => {
    const f = fixture();
    const request: WalletRpcClient["request"] = async (_chain, method, params) => {
      if (method === "eth_blockNumber") return "0x6e";
      if (method === "eth_getBlockByNumber") return { number: params[0], hash: h(Number(BigInt(String(params[0])))), timestamp: "0x6f" };
      if (method === "eth_getLogs") {
        const direction = (params[0] as { topics: unknown[] }).topics[1] === null ? 2 : 1;
        return f.receipt.logs.filter(log => log.topics[0] === transfer && log.topics[direction] === topic(wallet.address))
          .map(log => ({ ...log, transactionHash: f.transaction.hash, blockNumber: "0x6e", blockHash: h(110) }));
      }
      if (method === "eth_getTransactionReceipt") return f.receipt;
      if (method === "eth_getTransactionByHash") return f.transaction;
      if (method === "eth_call") {
        if (kind === "abort") return new Promise(() => {});
        throw new Error("historical decimals unavailable");
      }
      throw new Error("Unexpected RPC");
    };
    const collector = createEvmTransferRangeWalletCollector({ chain: "base", rpc: { request }, decodeReceipt: decodeEvmTransferRangeReceipt,
      confirmationDepth: 0, maximumRequests: kind === "budget" ? 7 : 20, maximumLogs: 10, maximumPayloadBytes: 100_000,
      maximumRunMs: kind === "abort" ? 20 : 1000 });
    const result = await collector.collect({ wallets: [wallet], checkpoint: () => JSON.stringify({ blockNumber: 109, blockHash: h(109) }),
      signal: f.input.signal });
    expect(result.partitions).toEqual([]); expect(result.failures).toHaveLength(1);
  });
});
