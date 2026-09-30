import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAddressRadarRepository, type AddressRadarRepository } from "@address-radar/database";
import { createConfiguredCollectors } from "../src/collectors.js";
import { parseScannerConfig } from "../src/config.js";
import { createScannerRuntime } from "../src/runtime.js";

describe("configured scanner end to end", () => {
  let repository: AddressRadarRepository | undefined;
  afterEach(() => { repository?.close(); repository = undefined; });
  const saveAbility = (entityId: string) => repository!.saveTraderAbilitySnapshot({
    snapshotId: `ability-${entityId}`, entityId, window: "30d", asOf: 900, strategyVersion: "address-v1",
    rawQuality: 0.9, adjustedQuality: 0.8, sampleConfidence: 0.85, coverageConfidence: 1,
    metrics: {}, components: {}, styles: { HIGH_MULTIPLE: 0.9 }, createdAt: 900,
  });
  it("persists configured file events and emits RadarSignalV1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-e2e-"));
    const eventPath = join(directory, "fomo.jsonl");
    const make = (id: string, handle: string, at: number) => ({ kind: "event", value: { eventType: "fomo.activity.buy", eventId: `event-${id}`, occurredAt: at, payload: { action: "buy", occurredAt: at, usdAmount: 1_000, price: 0.01, marketCap: 100_000, asset: { chain: "solana", tokenAddress: "TokenA" }, trader: { id, handle } } } });
    await writeFile(eventPath, [make("a", "alpha", 1_000), make("b", "beta", 12_000)].map(value => JSON.stringify(value)).join("\n") + "\n");
    repository = openAddressRadarRepository(":memory:");
    for (const [accountId, handle] of [["a", "alpha"], ["b", "beta"]] as const) {
      const entityId = `fomo:${accountId}`;
      repository.upsertFomoAccount({ accountId, handle, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId, lifecycle: "elite", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
      repository.upsertTraderSignalProfile({ entityId, monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: false, updatedAt: 1 });
      saveAbility(entityId);
    }
    const config = parseScannerConfig({ ADDRESS_RADAR_DATABASE_PATH: join(directory, "address.sqlite"), ADDRESS_RADAR_STRATEGY_VERSION: "address-v1", ADDRESS_RADAR_FOMO_EVENT_LOG_PATH: eventPath, ADDRESS_RADAR_FILE_START_AT_END: "false" });
    const runtime = createScannerRuntime({
      repository, collectors: createConfiguredCollectors({ config, repository, now: () => 20_000 }),
      clock: { now: () => 20_000 },
      lifecycleResolver: { resolve: async () => "launched_0_2h" },
      marketProvider: { lookup: async () => ({ chain: "solana", tokenAddress: "TokenA", symbol: "TOK", name: "Token A", imageUrl: null, priceUsd: 0.01, marketCapUsd: 100_000, liquidityUsd: 50_000, createdAt: 500, launchedAt: 900, observedAt: new Date(3_000).toISOString() }) },
      config,
    });
    expect(await runtime.runOnce()).toMatchObject({ collected: 2, accepted: 2, candidateCount: 1 });
    expect(repository.eventsForToken("solana", "TokenA")).toHaveLength(2);
    expect(repository.pendingSignalOutbox().map(row => row.payload)).toEqual([expect.objectContaining({ schemaVersion: "1", signalId: "solana:TokenA", category: "new_token_discovery", broadcastSequence: 1, token: { chain: "solana", contractAddress: "TokenA", symbol: "TOK", name: "Token A", imageUrl: null } })]);
  });

  it.each(["database", "resolver", "aggregation"] as const)("does not acknowledge after %s failure and replays after restart", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-replay-"));
    const eventPath = join(directory, "fomo.jsonl");
    const cursorPath = `${eventPath}.scanner.cursor`;
    const row = { kind: "event", value: { eventType: "fomo.activity.buy", eventId: "event-a", occurredAt: 1_000, payload: { action: "buy", occurredAt: 1_000, usdAmount: 1_000, asset: { chain: "solana", tokenAddress: "TokenA" }, trader: { id: "a", handle: "alpha" } } } };
    await writeFile(eventPath, `${JSON.stringify(row)}\n`);
    repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "a", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "fomo:a", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "a", entityId: "fomo:a", confidence: "confirmed", source: "test", observedAt: 1 });
    saveAbility("fomo:a");
    const config = parseScannerConfig({ ADDRESS_RADAR_DATABASE_PATH: join(directory, "address.sqlite"), ADDRESS_RADAR_STRATEGY_VERSION: "address-v1", ADDRESS_RADAR_FOMO_EVENT_LOG_PATH: eventPath, ADDRESS_RADAR_FILE_START_AT_END: "false" });
    const failingRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (failure === "database" && property === "insertTraderEvent") return () => { throw new Error("database down"); };
        if (failure === "aggregation" && property === "addressSignalEvidenceForToken") return () => { throw new Error("aggregation down"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const failing = createScannerRuntime({
      repository: failingRepository, collectors: createConfiguredCollectors({ config, repository, now: () => 2_000 }), signalSink: { accept: () => undefined }, clock: { now: () => 2_000 },
      lifecycleResolver: { resolve: async () => { if (failure === "resolver") throw new Error("lifecycle down"); return "launched_0_2h"; } },
      config,
    });
    await failing.runOnce();
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(cursorPath, "utf8"))).toMatchObject({ byteOffset: 0 });

    const replay = createScannerRuntime({
      repository, collectors: createConfiguredCollectors({ config, repository, now: () => 3_000 }), signalSink: { accept: () => undefined }, clock: { now: () => 3_000 },
      lifecycleResolver: { resolve: async () => "launched_0_2h" }, config,
    });
    await replay.runOnce();
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(cursorPath, "utf8"))).toMatchObject({ byteOffset: expect.any(Number) });
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(cursorPath, "utf8")).byteOffset).toBeGreaterThan(0);
  });

  it("keeps configured Fomo creation evidence in observation until market launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-created-"));
    const eventPath = join(directory, "fomo.jsonl");
    const make = (id: string, occurredAt: number) => ({ kind: "event", value: { eventType: "fomo.activity.buy", eventId: `event-${id}`, occurredAt, payload: { action: "buy", occurredAt, usdAmount: 1_000, asset: { chain: "solana", tokenAddress: "Prelaunch", createdAt: 1_000 }, trader: { id, handle: id } } } });
    await writeFile(eventPath, [["a", 5_000], ["b", 16_000], ["c", 27_000]].map(([id, occurredAt]) => JSON.stringify(make(String(id), Number(occurredAt)))).join("\n") + "\n");
    repository = openAddressRadarRepository(":memory:");
    for (const id of ["a", "b", "c"]) {
      repository.upsertFomoAccount({ accountId: id, handle: id, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId: `fomo:${id}`, lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId: id, entityId: `fomo:${id}`, confidence: "confirmed", source: "test", observedAt: 1 });
      saveAbility(`fomo:${id}`);
    }
    const config = parseScannerConfig({ ADDRESS_RADAR_DATABASE_PATH: join(directory, "address.sqlite"), ADDRESS_RADAR_STRATEGY_VERSION: "address-v1", ADDRESS_RADAR_FOMO_EVENT_LOG_PATH: eventPath, ADDRESS_RADAR_FILE_START_AT_END: "false" });
    const runtime = createScannerRuntime({ repository, collectors: createConfiguredCollectors({ config, repository, now: () => 30_000 }), clock: { now: () => 30_000 }, lifecycleResolver: { resolve: async input => input.createdAt ? "created" : "unknown" }, config });
    await runtime.runOnce();
    expect(repository.pendingSignalOutbox()).toEqual([]);
  });
});
