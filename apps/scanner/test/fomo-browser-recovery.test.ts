import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFomoLiveInbox, initializeFomoLiveInboxSchema } from "@address-radar/database";
import type { MonitoringRegistry } from "@address-radar/identity";
import { createFomoBrowserCollector } from "../src/fomo-browser-collector.js";
import { createFomoLiveCollector } from "../src/fomo-live-collector.js";

const observer = vi.hoisted(() => ({ refresh: vi.fn(), close: vi.fn() }));
vi.mock("../src/fomo-cdp-observer.js", () => ({ createFomoCdpObserver: () => observer }));

describe("FOMO browser recovery", () => {
  let database: DatabaseSync;
  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    initializeFomoLiveInboxSchema(database);
    observer.refresh.mockReset();
    observer.close.mockReset();
  });
  afterEach(() => database.close());

  function fixture() {
    const inbox = createFomoLiveInbox(database);
    const targets = [{ accountId: "account", entityId: "entity", handle: "trader", lifecycle: "active" as const }];
    const registry = { fomoAccounts: () => targets } as unknown as MonitoringRegistry;
    createFomoLiveCollector({ inbox, targets: () => targets }).receive(JSON.stringify({
      type: "data", topicType: "trading_activity",
      payload: { id: "trade", userId: "account", userHandle: "trader", type: "swap_buy",
        tokenAddress: "0x123", networkId: 1, createdAt: "2026-10-02T09:00:00.000Z" },
    }));
    return { inbox, registry };
  }

  it("replays durable messages while debugger discovery is unavailable", async () => {
    const { inbox, registry } = fixture();
    observer.refresh.mockRejectedValue(new Error("debugger unavailable"));
    const collector = createFomoBrowserCollector({ endpoint: "http://127.0.0.1:9222", inbox, registry });
    const batch = await collector.collect();
    expect(batch.status).toBe("unavailable");
    expect(batch.observations).toHaveLength(1);
    expect(inbox.pending(10)).toHaveLength(1);
    expect(collector.diagnostics()).toMatchObject({ connected: false, lastConnectionError: "cdp_unavailable", consecutiveConnectionFailures: 1 });
    await batch.commit!();
    expect(inbox.pending(10)).toHaveLength(0);
    collector.close();
  });

  it("resets transport failure diagnostics after reconnect without proving coverage", async () => {
    const { inbox, registry } = fixture();
    observer.refresh.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(1);
    const collector = createFomoBrowserCollector({ endpoint: "http://127.0.0.1:9222", inbox, registry });
    await collector.collect();
    await collector.collect();
    expect(collector.diagnostics()).toMatchObject({ connected: true, lastConnectionError: null, consecutiveConnectionFailures: 0, coverageComplete: false });
    expect(database.prepare("SELECT count(*) AS count FROM fomo_live_capture_gaps WHERE status='uncovered'").get()?.count).toBeGreaterThan(0);
    collector.close();
  });

  it("does not acknowledge pending events when recovery storage fails", async () => {
    const { inbox, registry } = fixture();
    const broken = { ...inbox, connection: () => { throw new Error("storage unavailable"); } };
    observer.refresh.mockRejectedValue(new Error("offline"));
    const collector = createFomoBrowserCollector({ endpoint: "http://127.0.0.1:9222", inbox: broken, registry });
    await expect(collector.collect()).rejects.toThrow("storage unavailable");
    expect(inbox.pending(10)).toHaveLength(1);
  });
});
