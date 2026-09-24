import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { openMonitoringRegistry } from "@address-radar/identity";
import { createConfiguredWalletRpcClient, createEvmBlockWalletCollector, createSolanaWalletCollector, createWalletMonitorRuntime, loadWalletMonitorConfig, openWalletMonitorStore, runWalletMonitorService } from "../src/index.js";

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "wallet-monitor-production-"));
  const path = join(directory, "radar.sqlite");
  const repository = openAddressRadarRepository(path);
  repository.upsertFomoAccount({ accountId: "a", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.ensureTraderEntity({ entityId: "e", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId: "a", entityId: "e", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.attachWallet({ accountId: "a", chainFamily: "evm", address: "0x1111111111111111111111111111111111111111", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.attachWallet({ accountId: "a", chainFamily: "solana", address: "SolanaWallet11111111111111111111111111111", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.close();
  return path;
}

describe("wallet monitor production wiring", () => {
  it("fails preflight without a usable provider and supports RPC fallback", async () => {
    expect(() => loadWalletMonitorConfig({})).toThrow("At least one wallet-monitor RPC endpoint is required");
    expect(() => loadWalletMonitorConfig({ RADAR_RPC_BASE_HTTP_URL: "file:///tmp/rpc" })).toThrow("Invalid RPC endpoint for base");
    const urls: string[] = [];
    const rpc = createConfiguredWalletRpcClient({ endpoints: { base: { primary: "https://primary", fallback: "https://fallback" } }, fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("primary")) return new Response("unavailable", { status: 503 });
      const body = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x2a" });
    } });
    await expect(rpc.request("base", "eth_blockNumber", [], new AbortController().signal)).resolves.toBe("0x2a");
    expect(urls).toEqual(["https://primary", "https://fallback"]);
  });

  it("advances and resumes an EVM partition after a successful empty block", async () => {
    const path = await databasePath();
    const registry = openMonitoringRegistry(path);
    const store = openWalletMonitorStore(path);
    const requestedBlocks: string[] = [];
    const collector = createEvmBlockWalletCollector({ chain: "base", confirmationDepth: 0, maxBlocksPerPoll: 1, rpc: { request: async (_chain, method, params) => {
      if (method === "eth_blockNumber") return "0xa";
      if (method === "eth_getBlockByNumber") { requestedBlocks.push(String(params[0])); return { timestamp: "0x1", transactions: [] }; }
      throw new Error(`unexpected ${method}`);
    } } });
    const runtime = createWalletMonitorRuntime({ registry, store, collectors: [collector], consumer: "monitor", now: () => 10 });
    await runtime.pollOnce();
    await runtime.pollOnce();
    expect(requestedBlocks).toEqual(["0xa"]);
    expect(store.checkpoint("evm:base", "chain:base")).toContain('"blockNumber":10');
    store.close();
    registry.close();
  });

  it("persists a successful empty Solana signature scan per wallet", async () => {
    const path = await databasePath();
    const registry = openMonitoringRegistry(path);
    const store = openWalletMonitorStore(path);
    const collector = createSolanaWalletCollector({ now: () => 50, rpc: { request: async (_chain, method) => method === "getSignaturesForAddress" ? [] : null } });
    const runtime = createWalletMonitorRuntime({ registry, store, collectors: [collector], consumer: "monitor", now: () => 50 });
    await runtime.pollOnce();
    const checkpoint = store.checkpoint("solana", "wallet:SolanaWallet11111111111111111111111111111");
    expect(checkpoint).toContain('"checkedAt":50');
    store.close();
    registry.close();
  });

  it("stops the headless run loop gracefully", async () => {
    const controller = new AbortController();
    let polls = 0;
    await runWalletMonitorService({ signal: controller.signal, intervalMs: 1, pollOnce: async () => { polls += 1; controller.abort(); } });
    expect(polls).toBe(1);
  });
});
