import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTokenLifecycleResolver } from "@address-radar/aggregation";
import { openAddressRadarRepository } from "@address-radar/database";
import { createConfiguredCollectors } from "../src/collectors.js";
import { createScannerRuntime } from "../src/runtime.js";

const config = (path: string) => ({ databasePath: ":memory:", strategyVersion: "address-v1", signalThreshold: 0.7, minimumPurchaseUsd: 0, minimumAggregateBuyUsd: 0, allowedChains: ["solana"], excludedTokenIds: [], pollIntervalMs: 1_000, fomoFilePaths: [path], onchainFilePath: null, onchainRpcEndpoint: null, onchainRpcMethod: "events", fileStartAtEnd: false, marketBaseUrl: null });
const line = (eventId: string) => JSON.stringify({ kind: "event", value: { eventId, eventType: "fomo.activity.buy", payload: { action: "buy", occurredAt: 1_000, usdAmount: 1_000, tokenCreatedAt: 500, asset: { chain: "solana", tokenAddress: "TokenA" }, trader: { id: "account-a", handle: "alpha" } } } });

describe("scanner production boundaries", () => {
  it("quarantines a malformed middle line, persists later events, advances, and deduplicates on restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-dlq-"));
    const path = join(directory, "fomo.jsonl");
    await writeFile(path, `${line("event-a")}\nnot-json\n${line("event-b")}\n`);
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "account-a", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-a", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "account-a", entityId: "entity-a", confidence: "confirmed", source: "test", observedAt: 1 });
    const collectors = createConfiguredCollectors({ config: config(path), repository, now: () => 2_000 });
    const runtime = createScannerRuntime({ repository, collectors, clock: { now: () => 2_000 }, config: config(path) });
    await runtime.runOnce();
    expect(repository.eventsForToken("solana", "TokenA").map(event => event.eventId)).toEqual(["event-a", "event-b"]);
    expect(repository.collectorDeadLetters(path)).toHaveLength(1);
    const restarted = createConfiguredCollectors({ config: config(path), repository, now: () => 3_000 });
    expect((await restarted[0]!.collect() as { observations: readonly unknown[] }).observations).toEqual([]);
    expect(repository.collectorDeadLetters(path)).toHaveLength(1);
    repository.close();
  });

  it("quarantines a schema-invalid Fomo line and advances without duplicate DLQ entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-schema-dlq-"));
    const path = join(directory, "fomo.jsonl");
    await writeFile(path, `${line("event-a")}\n{}\n${line("event-b")}\n`);
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "account-a", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-a", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "account-a", entityId: "entity-a", confidence: "confirmed", source: "test", observedAt: 1 });
    const scannerConfig = config(path);
    await createScannerRuntime({ repository, collectors: createConfiguredCollectors({ config: scannerConfig, repository, now: () => 2_000 }), clock: { now: () => 2_000 }, config: scannerConfig }).runOnce();
    expect(repository.eventsForToken("solana", "TokenA").map(event => event.eventId)).toEqual(["event-a", "event-b"]);
    expect(repository.collectorDeadLetters(path)).toEqual([expect.objectContaining({ error: "fomo_schema_invalid", rawPayload: "{}" })]);
    const restarted = createConfiguredCollectors({ config: scannerConfig, repository, now: () => 3_000 });
    expect((await restarted[0]!.collect() as { observations: readonly unknown[] }).observations).toEqual([]);
    expect(repository.collectorDeadLetters(path)).toHaveLength(1);
    repository.close();
  });

  it("quarantines a schema-invalid on-chain line and advances without duplicate DLQ entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-onchain-dlq-"));
    const path = join(directory, "onchain.jsonl");
    await writeFile(path, "{}\n");
    const repository = openAddressRadarRepository(":memory:");
    const scannerConfig = { ...config("unused"), fomoFilePaths: [], onchainFilePath: path };
    const monitoringRegistry = { wallets: () => [], version: () => 1 } as never;
    await createScannerRuntime({ repository, collectors: createConfiguredCollectors({ config: scannerConfig, repository, monitoringRegistry, now: () => 2_000 }), clock: { now: () => 2_000 }, config: scannerConfig }).runOnce();
    expect(repository.collectorDeadLetters(path)).toEqual([expect.objectContaining({ error: "onchain_schema_invalid", rawPayload: "{}" })]);
    const restarted = createConfiguredCollectors({ config: scannerConfig, repository, monitoringRegistry, now: () => 3_000 });
    expect((await restarted[0]!.collect() as { observations: readonly unknown[] }).observations).toEqual([]);
    expect(repository.collectorDeadLetters(path)).toHaveLength(1);
    repository.close();
  });

  it("uses one market lookup per token and isolates unavailable launch evidence", async () => {
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "a", handle: "a", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "e", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "a", entityId: "e", confidence: "confirmed", source: "test", observedAt: 1 });
    const lookup = vi.fn(async (_chain: string, tokenAddress: string) => { if (tokenAddress === "Broken") throw new Error("unavailable"); return null; });
    const event = (eventId: string, tokenAddress: string) => ({ eventId, accountId: "a", entityId: "e", chain: "solana", tokenAddress, side: "buy" as const, amountUsd: 1_000, priceUsd: null, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" as const });
    const runtime = createScannerRuntime({ repository, collectors: [{ collect: async () => ({ status: "ready" as const, observations: [{ createdAt: 500, event: event("broken-a", "Broken") }, { createdAt: 500, event: event("broken-b", "Broken") }, { createdAt: 500, event: event("created", "Token") }] }) }], clock: { now: () => 2_000 }, config: config("unused"), marketProvider: { lookup }, lifecycleResolver: createTokenLifecycleResolver({}) });
    await runtime.runOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(repository.addressSignalEvidenceForToken("solana", "Broken", 0).map(item => item.lifecycleStage)).toEqual(["unknown", "unknown"]);
    expect(repository.addressSignalEvidenceForToken("solana", "Token", 0)[0]?.lifecycleStage).toBe("created");
    repository.close();
  });

  it("passes ready market launch evidence into the production lifecycle resolver with one lookup", async () => {
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "a", handle: "a", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "e", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "a", entityId: "e", confidence: "confirmed", source: "test", observedAt: 1 });
    const lookup = vi.fn(async () => ({ chain: "solana", tokenAddress: "Token", symbol: null, name: null, imageUrl: null, priceUsd: null, marketCapUsd: null, liquidityUsd: null, createdAt: null, launchedAt: 900, observedAt: new Date(2_000).toISOString() }));
    const event = (eventId: string) => ({ eventId, accountId: "a", entityId: "e", chain: "solana", tokenAddress: "Token", side: "buy" as const, amountUsd: 1_000, priceUsd: null, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" as const });
    await createScannerRuntime({ repository, collectors: [{ collect: async () => ({ status: "ready" as const, observations: [{ event: event("launched-a") }, { event: event("launched-b") }] }) }], clock: { now: () => 2_000 }, config: config("unused"), marketProvider: { lookup }, lifecycleResolver: createTokenLifecycleResolver({}) }).runOnce();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(repository.addressSignalEvidenceForToken("solana", "Token", 0).map(item => item.lifecycleStage)).toEqual(["launched_0_2h", "launched_0_2h"]);
    repository.close();
  });
});
