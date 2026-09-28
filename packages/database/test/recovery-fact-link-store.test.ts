import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createRecoveryFactLinkStore,
  createSourceEnrichmentStore,
  createWalletCoverageStore,
  migrateAddressRadarDatabase,
} from "../src/index.js";

describe("closed-loop fact and coverage stores", () => {
  it("moves recovery fact links to satisfied or terminal states", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const store = createRecoveryFactLinkStore(database);

    expect(store.ensure("job-1", "early_trades", "base:0xabc", 10)).toMatchObject({ status: "pending" });
    expect(store.satisfy("job-1", "early_trades", "base:0xabc", 20)).toMatchObject({
      status: "satisfied", verifiedAt: 20,
    });
    expect(store.ensure("job-2", "market_history", "bsc:0xdef", 30)).toMatchObject({ status: "pending" });
    expect(store.terminal("job-2", "market_history", "bsc:0xdef", "unsupported_provider", 40)).toMatchObject({
      status: "terminal", terminalReason: "unsupported_provider",
    });
    database.close();
  });

  it("keeps wallet coverage and enrichment revisions queryable", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const coverage = createWalletCoverageStore(database);
    const enrichments = createSourceEnrichmentStore(database);

    expect(coverage.upsert({
      identityId: "identity-1", chain: "base", provider: "blockscout",
      status: "degraded", cursor: null, coverageStartAt: null, coverageEndAt: null,
      lastSuccessAt: null, diagnostic: { statusCode: 404 }, updatedAt: 50,
    })).toMatchObject({ status: "degraded", diagnostic: { statusCode: 404 } });

    expect(enrichments.append({
      observationId: "observation-1", amountUsd: 100, priceUsd: 0.5,
      collectedAt: 60, provenance: { provider: "fomo" }, qualityScore: 0.8, createdAt: 60,
    })).toMatchObject({ revision: 1 });
    expect(enrichments.append({
      observationId: "observation-1", amountUsd: 110, priceUsd: 0.55,
      collectedAt: 70, provenance: { provider: "rpc" }, qualityScore: 0.9, createdAt: 70,
    })).toMatchObject({ revision: 2, amountUsd: 110 });
    database.close();
  });
});
