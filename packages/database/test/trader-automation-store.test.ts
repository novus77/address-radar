import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTraderAutomationStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "../src/index.js";

const databasePath = () => join(
  mkdtempSync(join(tmpdir(), "trader-automation-store-")),
  "radar.sqlite",
);

describe("trader automation store", () => {
  it("keeps a suspended trader in lightweight collection when policy is lightweight", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    database.prepare(`
      INSERT INTO trader_entities(
        entity_id, lifecycle, manual, locked, created_at, updated_at
      ) VALUES ('trader-lightweight', 'suspended', 0, 0, 1, 1)
    `).run();
    const store = createTraderAutomationStore(database);

    store.saveState({
      traderId: "trader-lightweight",
      tier: "T3",
      coverageState: "unseen",
      monitoringPolicy: "lightweight",
      lastCoveredAt: null,
      nextEvaluationAt: 100,
      strategyVersion: "test-v1",
      updatedAt: 1,
    });

    expect(store.state("trader-lightweight")).toMatchObject({
      coverageState: "unseen",
      monitoringPolicy: "lightweight",
      tier: "T3",
    });
    database.close();
  });

  it("does not mutate performance lifecycle while updating coverage", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    database.prepare(`
      INSERT INTO trader_entities(
        entity_id, lifecycle, manual, locked, created_at, updated_at
      ) VALUES ('trader-coverage', 'degraded', 0, 0, 1, 1)
    `).run();
    const store = createTraderAutomationStore(database);
    store.saveState({
      traderId: "trader-coverage",
      tier: "T2",
      coverageState: "queued",
      monitoringPolicy: "periodic",
      lastCoveredAt: null,
      nextEvaluationAt: 100,
      strategyVersion: "test-v1",
      updatedAt: 1,
    });

    store.updateCoverage("trader-coverage", {
      coverageState: "current",
      lastCoveredAt: 200,
      nextEvaluationAt: 300,
      strategyVersion: "test-v2",
      updatedAt: 200,
    });

    expect(store.state("trader-coverage")).toMatchObject({
      coverageState: "current",
      lastCoveredAt: 200,
      nextEvaluationAt: 300,
      strategyVersion: "test-v2",
    });
    expect(database.prepare(
      "SELECT lifecycle FROM trader_entities WHERE entity_id = 'trader-coverage'",
    ).get()).toEqual({ lifecycle: "degraded" });
    database.close();
  });
});
