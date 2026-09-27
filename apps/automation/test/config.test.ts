import { describe, expect, it } from "vitest";

import { loadAutomationConfig } from "../src/config.js";

describe("automation config", () => {
  it("loads the approved safe defaults with execution disabled", () => {
    expect(loadAutomationConfig({})).toMatchObject({
      enabled: false,
      enabledJobTypes: [],
      traderLightweightBatchSize: 10,
      traderDeepBackfillConcurrency: 2,
      tokenMiningConcurrency: 2,
      solanaHistoryConcurrency: 1,
      solanaWalletBatchSize: 3,
      identityExportBatchSize: 25,
      identityExportIntervalMs: 43_200_000,
      backfillWindowDays: 60,
      backfillMaximumTokens: 300,
      evidenceMinimumBuyUsd: 50,
      historyStartAt: Date.parse("2026-08-09T16:00:00.000Z"),
      recentTokenShare: 0.7,
      historicalTokenShare: 0.3,
      existingTraderShare: 0.4,
      tokenMiningShare: 0.4,
      repairShare: 0.2,
      gatewayDeliveryEnabled: false,
    });
  });

  it("rejects invalid booleans, limits, and resource shares", () => {
    expect(() => loadAutomationConfig({ ADDRESS_RADAR_AUTOMATION_ENABLED: "yes" }))
      .toThrow(/automation enabled/i);
    expect(() => loadAutomationConfig({ ADDRESS_RADAR_BACKFILL_MAX_TOKENS: "0" }))
      .toThrow(/backfill maximum tokens/i);
    expect(() => loadAutomationConfig({
      ADDRESS_RADAR_EXISTING_TRADER_SHARE: "0.5",
      ADDRESS_RADAR_TOKEN_MINING_SHARE: "0.5",
      ADDRESS_RADAR_REPAIR_SHARE: "0.5",
    })).toThrow(/resource shares/i);
    expect(() => loadAutomationConfig({
      ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES: "initial_wallet_backfill,unknown_job",
    })).toThrow(/unsupported automation job types/i);
  });

  it("loads a deduplicated production job allowlist", () => {
    expect(loadAutomationConfig({
      ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES: "trader_lightweight_evaluation, initial_wallet_backfill,trader_lightweight_evaluation",
    }).enabledJobTypes).toEqual([
      "trader_lightweight_evaluation",
      "initial_wallet_backfill",
    ]);
  });
});
