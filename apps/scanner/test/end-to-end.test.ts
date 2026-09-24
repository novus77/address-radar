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
  it("persists configured file events and emits RadarSignalV1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-e2e-"));
    const eventPath = join(directory, "fomo.jsonl");
    const make = (id: string, handle: string, at: number) => ({ kind: "event", value: { eventType: "fomo.activity.buy", eventId: `event-${id}`, occurredAt: at, payload: { action: "buy", occurredAt: at, usdAmount: 1_000, price: 0.01, marketCap: 100_000, asset: { chain: "solana", tokenAddress: "TokenA" }, trader: { id, handle } } } });
    await writeFile(eventPath, [make("a", "alpha", 1_000), make("b", "beta", 1_001)].map(value => JSON.stringify(value)).join("\n") + "\n");
    repository = openAddressRadarRepository(":memory:");
    for (const [accountId, handle] of [["a", "alpha"], ["b", "beta"]] as const) {
      const entityId = `fomo:${accountId}`;
      repository.upsertFomoAccount({ accountId, handle, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId, lifecycle: "elite", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
      repository.upsertTraderSignalProfile({ entityId, monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: false, updatedAt: 1 });
    }
    const config = parseScannerConfig({ ADDRESS_RADAR_DATABASE_PATH: join(directory, "address.sqlite"), ADDRESS_RADAR_STRATEGY_VERSION: "address-v1", ADDRESS_RADAR_FOMO_EVENT_LOG_PATH: eventPath, ADDRESS_RADAR_FILE_START_AT_END: "false" });
    const emitted: unknown[] = [];
    const runtime = createScannerRuntime({
      repository, collectors: createConfiguredCollectors({ config, repository, now: () => 3_000 }),
      signalSink: { accept: values => { emitted.push(...values); } }, clock: { now: () => 3_000 },
      lifecycleResolver: { resolve: async () => "launched_0_2h" },
      marketProvider: { lookup: async () => ({ chain: "solana", tokenAddress: "TokenA", symbol: "TOK", name: "Token A", imageUrl: null, priceUsd: 0.01, marketCapUsd: 100_000, liquidityUsd: 50_000, createdAt: 500, launchedAt: 900, observedAt: new Date(3_000).toISOString() }) },
      config,
    });
    expect(await runtime.runOnce()).toMatchObject({ collected: 2, accepted: 2, candidateCount: 1 });
    expect(repository.eventsForToken("solana", "TokenA")).toHaveLength(2);
    expect(emitted).toEqual([expect.objectContaining({ schemaVersion: "1", signalId: "solana:TokenA", category: "new_token_discovery", broadcastSequence: 1, token: { chain: "solana", contractAddress: "TokenA", symbol: "TOK", name: "Token A", imageUrl: null } })]);
  });
});
