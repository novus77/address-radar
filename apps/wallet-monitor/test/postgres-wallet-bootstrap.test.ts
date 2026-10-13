import { describe, expect, it, vi } from "vitest";
import { PostgresCommitUncertainError, type PostgresTransaction } from "@address-radar/database";
import { createPostgresWalletChannel, type PostgresEvmTransferBootstrapAnchor } from "../src/postgres-wallet-channel.js";
import type { WalletCollector, WalletCollectorResult } from "../src/contracts.js";
import { createEvmTransferRangeWalletCollector } from "../src/evm-transfer-range-collector.js";
import { decodeEvmTransferRangeReceipt } from "../src/collectors.js";

const hash = `0x${"a".repeat(64)}`;
const key = "bootstrap:chain:bsc";
const anchor: PostgresEvmTransferBootstrapAnchor = { format: "evm-transfer-bootstrap-v1",
  scope: "erc20_transfer_only", generation: "generation", collector: "evm:bsc",
  fromBlock: 101, boundaryNumber: 100, boundaryHash: hash };
const anchorResult = (value: PostgresEvmTransferBootstrapAnchor = anchor): WalletCollectorResult => ({ partitions: [{
  partitionKey: key, nextCheckpoint: JSON.stringify(value), events: [], canonicalBlocks: [],
}] });
const completed = (): WalletCollectorResult => ({ partitions: [{ partitionKey: "chain:bsc",
  nextCheckpoint: JSON.stringify({ blockNumber: 200, blockHash: hash }), events: [] }] });

function fixture(initial: Record<string, string> = {}) {
  let durable = { ...initial }, failWrite = false, loseLease = false, uncertain: "before" | "after" | null = null;
  const statements: string[] = [];
  const collect = vi.fn<WalletCollector["collect"]>(async () => anchorResult());
  const verifyPurchase = vi.fn();
  const make = (optIn = true, scanner?: WalletCollector, fromBlock = 101) => createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
    async run<T>(operation: (tx: PostgresTransaction) => Promise<T>): Promise<T> {
      let staged: Record<string, string> | null = null;
      const result = await operation({ async query(sql, values = []) {
        statements.push(sql);
        if (sql.includes("RETURNING claim_generation")) return { rows: [{ claim_generation: 1, checkpoints_json: JSON.stringify(durable), lease_expires_at: 260_000 }], rowCount: 1 };
        if (sql.includes("SELECT * FROM wallet_channel_collectors")) return { rows: loseLease ? [] : [{}], rowCount: loseLease ? 0 : 1 };
        if (sql.includes("SET checkpoints_json")) {
          if (failWrite) throw new Error("Checkpoint write failed");
          staged = JSON.parse(String(values[4])) as Record<string, string>;
        }
        return { rows: [], rowCount: 1 };
      } });
      if (staged && uncertain === "before") throw new PostgresCommitUncertainError(new Error("Commit outcome unknown"));
      if (staged) durable = staged;
      if (staged && uncertain === "after") throw new PostgresCommitUncertainError(new Error("Commit reply lost"));
      return result;
    }, collectors: [{ collector: scanner ?? { name: "evm:bsc", chainFamily: "evm", collect }, executionTrust: "rpc_execution",
      ...(optIn ? { bootstrap: { generation: "generation", fromBlock } } : {}) }],
    profiles: { async load() { return { status: "ready", profiles: [] }; } }, verifyPurchase,
    maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, maximumRunMs: 1000, leaseMs: 60_000,
    maximumPayloadBytes: 65536, now: () => 200_000 });
  return { make, collect, statements, verifyPurchase, durable: () => durable,
    failWrite: () => { failWrite = true; }, loseLease: () => { loseLease = true; },
    uncertain: (value: "before" | "after") => { uncertain = value; } };
}

describe("durable opted-in EVM bootstrap intent", () => {
  it("atomically persists only the anchor, then exposes it to a restarted collector before scan completion", async () => {
    const f = fixture();
    expect(await f.make().pollOnce()).toMatchObject({ captured: 0, failed: 0 });
    expect(f.durable()).toEqual({ [key]: JSON.stringify(anchor) });
    expect(f.durable()["chain:bsc"]).toBeUndefined(); expect(f.verifyPurchase).not.toHaveBeenCalled();
    expect(f.statements.some(sql => sql.includes("INSERT INTO capture_"))).toBe(false);
    f.collect.mockImplementation(async input => {
      expect(input.checkpoint(key)).toBe(JSON.stringify(anchor));
      expect(input.checkpoint("chain:bsc")).toBeNull(); return completed();
    });
    expect(await f.make().pollOnce()).toMatchObject({ failed: 0 });
    expect(f.durable()).toEqual({ [key]: JSON.stringify(anchor), "chain:bsc": completed().partitions[0]!.nextCheckpoint });
  });

  it("preserves every committed cursor while storing or replaying an identical anchor", async () => {
    const cursors = { "chain:bsc": JSON.stringify({ blockNumber: 150, blockHash: hash }), schedule: "saved" };
    const f = fixture(cursors);
    expect(await f.make().pollOnce()).toMatchObject({ failed: 0 });
    expect(await f.make().pollOnce()).toMatchObject({ failed: 0 });
    expect(f.durable()).toEqual({ ...cursors, [key]: JSON.stringify(anchor) });
  });

  it("rejects anchor replacement and preserves the original bytes", async () => {
    const f = fixture({ [key]: JSON.stringify(anchor) });
    f.collect.mockResolvedValue(anchorResult({ ...anchor, fromBlock: 102, boundaryNumber: 101 }));
    expect(await f.make().pollOnce()).toMatchObject({ failed: 1, captured: 0 });
    expect(f.durable()).toEqual({ [key]: JSON.stringify(anchor) });
    expect(f.statements.some(sql => sql.includes("SET checkpoints_json"))).toBe(false);
  });

  it.each(["generation", "collector", "chain", "scope", "kind", "format", "floor", "boundary", "hash", "extra"])(
    "rejects an invalid %s binding", async kind => {
      const f = fixture(), value = structuredClone(anchor) as unknown as Record<string, unknown>;
      if (kind === "generation") value.generation = "other";
      if (kind === "collector") value.collector = "evm:base";
      if (kind === "chain") value.chain = "base";
      if (kind === "scope") value.scope = "coverage_complete";
      if (kind === "kind") value.kind = "completed";
      if (kind === "format") value.format = 2;
      if (kind === "floor") value.fromBlock = -1;
      if (kind === "boundary") value.boundaryNumber = 99;
      if (kind === "hash") value.boundaryHash = "fake";
      if (kind === "extra") value.authority = "native";
      f.collect.mockResolvedValue(anchorResult(value as unknown as PostgresEvmTransferBootstrapAnchor));
      expect(await f.make().pollOnce()).toMatchObject({ failed: 1 }); expect(f.durable()).toEqual({});
    });

  it.each(["events", "completed", "duplicate", "failure", "boundary", "key"])("refuses a non-anchor-only result: %s", async kind => {
    const f = fixture(), result = structuredClone(anchorResult()) as { partitions: Array<{
      partitionKey: string; nextCheckpoint: string; events: unknown[]; canonicalBlocks?: readonly unknown[] }>;
      failures?: Array<{ partitionKey: string; error: string }> };
    if (kind === "events") result.partitions[0]!.events.push({ eventId: "uncommitted" });
    if (kind === "completed") result.partitions.push({ ...completed().partitions[0]!, events: [] });
    if (kind === "duplicate") result.partitions.push(result.partitions[0]!);
    if (kind === "failure") result.failures = [{ partitionKey: "chain:bsc", error: "failed" }];
    if (kind === "boundary") result.partitions[0]!.canonicalBlocks = [{ blockNumber: 100, blockHash: hash }];
    if (kind === "key") result.partitions[0]!.partitionKey = "bootstrap:chain:base";
    f.collect.mockResolvedValue(result as WalletCollectorResult);
    expect(await f.make().pollOnce()).toMatchObject({ failed: 1 }); expect(f.durable()).toEqual({});
    expect(f.verifyPurchase).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in both for new and already persisted anchors", async () => {
    const f = fixture(); expect(await f.make(false).pollOnce()).toMatchObject({ failed: 1 }); expect(f.durable()).toEqual({});
    const stored = fixture({ [key]: JSON.stringify(anchor) });
    expect(await stored.make(false).pollOnce()).toMatchObject({ failed: 1 }); expect(stored.collect).not.toHaveBeenCalled();
  });

  it("rejects malformed durable anchors before invoking the scanner", async () => {
    const f = fixture({ [key]: JSON.stringify({ ...anchor, generation: "other" }) });
    expect(await f.make().pollOnce()).toMatchObject({ failed: 1 }); expect(f.collect).not.toHaveBeenCalled();
  });

  it("requires durable bootstrap before the first completed range and rejects completion below its floor", async () => {
    const f = fixture(); f.collect.mockResolvedValue(completed());
    expect(await f.make().pollOnce()).toMatchObject({ failed: 1 }); expect(f.durable()).toEqual({});
    const stored = fixture({ [key]: JSON.stringify(anchor) });
    stored.collect.mockResolvedValue({ partitions: [{ partitionKey: "chain:bsc", events: [],
      nextCheckpoint: JSON.stringify({ blockNumber: 100, blockHash: hash }) }] });
    expect(await stored.make().pollOnce()).toMatchObject({ failed: 1 }); expect(stored.durable()["chain:bsc"]).toBeUndefined();
  });

  it.each(["write", "lease"])("does not persist an anchor after %s failure", async kind => {
    const f = fixture(); if (kind === "write") f.failWrite(); else f.loseLease();
    expect(await f.make().pollOnce()).toMatchObject({ failed: 1, captured: 0 }); expect(f.durable()).toEqual({});
  });

  it.each(["before", "after"] as const)("propagates uncertain commit %s durability without reporting completion", async when => {
    const f = fixture(); f.uncertain(when);
    await expect(f.make().pollOnce()).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.durable()["chain:bsc"]).toBeUndefined();
    expect(f.durable()[key]).toBe(when === "after" ? JSON.stringify(anchor) : undefined);
  });

  it("integrates the real scanner ABI and resumes from its durable floor after restart and head advance", async () => {
    let head = 1000;
    const calls: Array<{ method: string; params: readonly unknown[] }> = [];
    const hex = (value: number) => `0x${value.toString(16)}`;
    const rpc = { async request(_chain: string, method: string, params: readonly unknown[]) {
      calls.push({ method, params });
      if (method === "eth_blockNumber") return hex(head);
      if (method === "eth_getBlockByNumber") return { number: params[0], hash, timestamp: "0x64" };
      if (method === "eth_getLogs") return [];
      throw new Error("Unexpected RPC");
    } };
    const scanner = () => createEvmTransferRangeWalletCollector({ chain: "bsc", rpc, bootstrap: { generation: "generation", fromBlock: 487 },
      decodeReceipt: decodeEvmTransferRangeReceipt, maximumRequests: 20, maximumLogs: 10,
      maximumPayloadBytes: 65536, maximumRunMs: 1000 });
    const f = fixture();
    // Profile selection is irrelevant to checkpoint durability; supply a trusted enabled EVM cohort to the real scanner.
    const actual = scanner();
    const withWallet: WalletCollector = { ...actual, collect: input => actual.collect({ ...input,
      wallets: [{ address: `0x${"1".repeat(40)}`, accountId: "account", entityId: "entity", lifecycle: "active" }] }) };
    expect(await f.make(true, withWallet, 487).pollOnce()).toMatchObject({ failed: 0, captured: 0 });
    expect(calls.some(call => call.method === "eth_getLogs")).toBe(false);
    const saved = f.durable()[key]!;
    expect(JSON.parse(saved)).toEqual({ format: "evm-transfer-bootstrap-v1", generation: "generation", collector: "evm:bsc",
      fromBlock: 487, boundaryNumber: 486, boundaryHash: hash, scope: "erc20_transfer_only" });
    expect(f.durable()["chain:bsc"]).toBeUndefined();
    head = 1200;
    const restarted = scanner();
    const restartedWithWallet: WalletCollector = { ...restarted, collect: input => restarted.collect({ ...input,
      wallets: [{ address: `0x${"1".repeat(40)}`, accountId: "account", entityId: "entity", lifecycle: "active" }] }) };
    expect(await f.make(true, restartedWithWallet, 487).pollOnce()).toMatchObject({ failed: 0, captured: 0 });
    const query = calls.find(call => call.method === "eth_getLogs")!.params[0] as { fromBlock: string; toBlock: string };
    expect(query).toMatchObject({ fromBlock: hex(487), toBlock: hex(998) });
    expect(f.durable()[key]).toBe(saved);
    expect(JSON.parse(f.durable()["chain:bsc"]!)).toEqual({ blockNumber: 998, blockHash: hash });
  });
  it.each([100, 102])("rejects a new or persisted anchor differing from sealed floor: %s", async fromBlock => {
    const value = { ...anchor, fromBlock, boundaryNumber: fromBlock - 1 };
    const fresh = fixture(); fresh.collect.mockResolvedValue(anchorResult(value));
    expect(await fresh.make().pollOnce()).toMatchObject({ failed: 1 }); expect(fresh.durable()).toEqual({});
    const saved = JSON.stringify(value), persisted = fixture({ [key]: saved });
    expect(await persisted.make().pollOnce()).toMatchObject({ failed: 1 });
    expect(persisted.collect).not.toHaveBeenCalled(); expect(persisted.durable()).toEqual({ [key]: saved });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("requires an explicit positive safe sealed floor: %s", fromBlock => {
    expect(() => fixture().make(true, undefined, fromBlock)).toThrow("Explicit supported EVM bootstrap registration required");
  });
});
