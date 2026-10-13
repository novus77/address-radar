import { describe, expect, it } from "vitest";
import type { PostgresTransaction } from "@address-radar/database";
import { createConfiguredWalletRpcClient } from "../src/rpc.js";
import { createEvmTransferRangeWalletCollector } from "../src/evm-transfer-range-collector.js";
import { createPostgresWalletChannel } from "../src/postgres-wallet-channel.js";

const endpoint = "https://provider.invalid/SECRET";
const address = `0x${"1".repeat(40)}`;
const blockHash = `0x${"2".repeat(64)}`;
const wallet = { address, accountId: "account", entityId: "entity", lifecycle: "active" as const };

function collector(rpc: ReturnType<typeof createConfiguredWalletRpcClient>) {
  return createEvmTransferRangeWalletCollector({ chain: "bsc", rpc,
    decodeReceipt: async () => ({ events: [], hadCandidateTransfer: false }),
    maximumLogs: 10, maximumRequests: 20, maximumPayloadBytes: 65536, maximumRunMs: 1000 });
}
const collectInput = () => ({ wallets: [wallet], checkpoint: () => JSON.stringify({ blockNumber: 100, blockHash }),
  signal: new AbortController().signal });

function rpcError(message: string, code: unknown = -32005, status = 200) {
  return createConfiguredWalletRpcClient({ endpoints: { bsc: { primary: endpoint } }, fetch: async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } }), { status });
  } });
}

describe("safe RPC backoff diagnostics", () => {
  it.each([
    ["rate limit exceeded", "rate_limit", "rpc_json_rate_limited"],
    ["limit exceeded", "ambiguous_limit", "rpc_json_limit_ambiguous"],
  ])("preserves the original typed error through the wallet wrapper: %s", async (message, category, reasonCode) => {
    const rpc = rpcError(message);
    const error = await rpc.request("bsc", "eth_blockNumber", [], new AbortController().signal).catch(value => value);
    expect(error).toMatchObject({ name: "WalletRpcRateLimitError", reasonCode, code: -32005 });
    const result = await collector(rpc).collect(collectInput());
    expect(result.failures?.[0]?.error).toBe("evm_range_provider_backoff");
    expect(result.diagnostics?.[0]).toMatchObject({ reason: "evm_range_rpc_diagnostic",
      rpc: { rpcCategory: category, rpcOrigin: "json_rpc", rpcMethod: "eth_blockNumber", rpcCode: -32005 } });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.partitions).toEqual([]);
  });

  it.each(["SECRET", { secret: "SECRET" }, null, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not copy malformed provider codes: %j", async code => {
      const result = await collector(rpcError("rate limit exceeded", code)).collect(collectInput());
      expect(result.diagnostics?.[0]?.rpc).toMatchObject({ rpcCategory: "rate_limit" });
      expect(result.diagnostics?.[0]?.rpc).not.toHaveProperty("rpcCode");
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });

  it("distinguishes durable budget refusal from a provider RPC response", async () => {
    const rpc = createConfiguredWalletRpcClient({ endpoints: { bsc: { primary: endpoint } }, fetch: async () => {
      throw Object.assign(new Error("Durable provider budget unavailable"), { name: "PostgresProviderBudgetError", retryAt: 123 });
    } });
    const result = await collector(rpc).collect(collectInput());
    expect(result.failures?.[0]?.error).toBe("evm_range_provider_backoff");
    expect(result.diagnostics?.[0]?.rpc).toEqual({ rpcOrigin: "provider_budget", rpcMethod: "eth_blockNumber" });
    expect(result.partitions).toEqual([]);
  });

  it("retains HTTP 429 classification without inventing a JSON-RPC code", async () => {
    const result = await collector(rpcError("SECRET", "SECRET", 429)).collect(collectInput());
    expect(result.diagnostics?.[0]?.rpc).toEqual({ rpcOrigin: "http", rpcCategory: "rate_limit", rpcMethod: "eth_blockNumber" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("projects only closed RPC fields into the existing channel report", async () => {
    const rpc = rpcError("limit exceeded");
    const tx: PostgresTransaction = { async query(sql) {
      if (sql.includes("RETURNING claim_generation")) return { rows: [{ claim_generation: 1,
        checkpoints_json: JSON.stringify({ "chain:bsc": JSON.stringify({ blockNumber: 100, blockHash }) }), lease_expires_at: 61000 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    } };
    const profile = { wallet, fact: { entityId: "entity", channel: "wallet" as const, subjectId: address,
      walletFamily: "evm" as const, associationConfidence: "confirmed" as const, associationSource: "chain_link",
      ownerCount: 1, walletConfidence: "confirmed" as const, walletSource: "chain_link", identityEvidenceRef: "identity",
      ownershipEvidenceRef: "ownership", monitoringEnabled: true, suspended: false }, profileEnabled: true,
      profileSuspended: false, bindingState: "owned" as const, versionId: "v1" };
    const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
      run: operation => operation(tx), profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
      collectors: [{ collector: collector(rpc), executionTrust: "rpc_execution" }], maximumProfiles: 1, maximumEvents: 1,
      collectorQuota: 1, leaseMs: 60000, maximumPayloadBytes: 65536, now: () => 1000 });
    const report = await channel.pollOnce();
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ reasonCode: "evm_range_rpc_diagnostic",
      rpc: { rpcCategory: "ambiguous_limit", rpcOrigin: "json_rpc", rpcMethod: "eth_blockNumber", rpcCode: -32005 } }));
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
});

it("reports a fresh local cooldown without another RPC or stale response metadata", async () => {
  let networkCalls = 0;
  const rpc = createConfiguredWalletRpcClient({ endpoints: { bsc: { primary: endpoint } }, now: () => 1000, fetch: async (_input, init) => {
    networkCalls++;
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      error: { code: -32005, message: "rate limit exceeded" } }));
  } });
  const range = createEvmTransferRangeWalletCollector({ chain: "bsc", rpc,
    decodeReceipt: async () => ({ events: [], hadCandidateTransfer: false }), now: () => 1000,
    maximumLogs: 10, maximumRequests: 20, maximumPayloadBytes: 65536, maximumRunMs: 1000 });
  const first = await range.collect(collectInput());
  expect(first.diagnostics?.[0]?.rpc).toMatchObject({ rpcOrigin: "json_rpc", rpcCategory: "rate_limit", rpcCode: -32005 });
  expect(networkCalls).toBe(1);
  const second = await range.collect(collectInput());
  expect(second.partitions).toEqual([]);
  expect(second.diagnostics).toEqual([{ partitionKey: "chain:bsc", reason: "evm_range_backoff",
    sourceReference: "bsc:retry:31000", rpc: { rpcOrigin: "local_cooldown" } }]);
  expect(networkCalls).toBe(1);

  const tx: PostgresTransaction = { async query(sql) {
    if (sql.includes("RETURNING claim_generation")) return { rows: [{ claim_generation: 1,
      checkpoints_json: "{}", lease_expires_at: 61000 }], rowCount: 1 };
    if (sql.includes("SELECT * FROM wallet_channel_collectors")) return { rows: [{ claim_generation: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "session",
    run: operation => operation(tx), profiles: { async load() { return { status: "ready", profiles: [] }; } },
    collectors: [{ collector: range, executionTrust: "rpc_execution" }], maximumProfiles: 1, maximumEvents: 1,
    collectorQuota: 1, leaseMs: 60000, maximumPayloadBytes: 65536, now: () => 1000 });
  const report = await channel.pollOnce();
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ reasonCode: "evm_range_backoff",
    rpc: { rpcOrigin: "local_cooldown" } }));
  expect(report.failed).toBe(0);
  expect(networkCalls).toBe(1);
});
