import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";
import { createAddressConsoleApplication } from "../src/application.js";

describe("workbench v2 API", () => {
  it("returns paginated token aggregates with Chinese qualification explanations", () => {
    const path = join(mkdtempSync(join(tmpdir(), "console-v2-")), "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    repository.saveTokenEvaluation({
      chain: "base",
      tokenAddress: "0xtoken",
      action: "observe",
      signalFamily: "NEW_TOKEN_DISCOVERY",
      lifecycleStage: "launched_0_2h",
      score: 0.6,
      participantCount: 1,
      totalBuyUsd: 500,
      sourceState: "FOMO_ONLY",
      windowMs: 300_000,
      missingConditions: ["distinct_traders:2", "score:0.7"],
      bundleDiagnostics: { rawParticipantCount: 3, independentParticipantCount: 2, bundledParticipantCount: 2, bundledBuyUsd: 300, bundleBuyShare: 0.6, groups: [] },
      updatedAt: 10_000,
    });
    repository.close();
    const application = createAddressConsoleApplication(path);

    expect(application.handle("GET", "/api/v2/token-aggregates")).toMatchObject({
      status: 200,
      body: {
        total: 1,
        page: 1,
        items: [{
          chain: "base",
          tokenAddress: "0xtoken",
          missingConditionLabels: ["还需要 2 名高质量交易员", "综合评分需达到 70%"],
          bundleDiagnostics: { rawParticipantCount: 3, independentParticipantCount: 2, bundledParticipantCount: 2 },
        }],
      },
    });
    application.close();
  });

  it("publishes the backend chain registry and compact summary", () => {
    const application = createAddressConsoleApplication();
    expect(application.handle("GET", "/api/v2/chains")).toMatchObject({
      status: 200,
      body: { items: expect.arrayContaining([expect.objectContaining({ id: "robinhood" })]) },
    });
    expect(application.handle("GET", "/api/v2/workbench/summary")).toMatchObject({
      status: 200,
      body: { addressLibraryCount: 0, candidateCount: 0, aggregatedTokenCount: 0 },
    });
    application.close();
  });

  it("separates observed, milestone, historical, and aggregated token coverage by chain", () => {
    const path = join(mkdtempSync(join(tmpdir(), "console-coverage-")), "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    repository.close();
    const database = openAddressRadarDatabase(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      INSERT INTO trader_events(
        event_id, account_id, entity_id, chain, token_address, side,
        occurred_at, collected_at, source
      ) VALUES
        ('event-1', 'account-1', 'entity-1', 'base', '0xABC', 'buy', 1, 1, 'fomo'),
        ('event-2', 'account-1', 'entity-1', 'base', '0xabc', 'buy', 2, 2, 'fomo'),
        ('event-3', 'account-1', 'entity-1', 'base', '0xDEF', 'buy', 3, 3, 'fomo'),
        ('event-4', 'account-1', 'entity-1', 'solana', 'CaseSensitiveToken', 'buy', 4, 4, 'fomo');
      INSERT INTO token_milestones(
        milestone_id, chain, token_address, market_cap_usd, reached_at, payload
      ) VALUES ('milestone-1', 'base', '0xabc', 100000, 10, '{}');
      INSERT INTO token_aggregation_state(
        token_id, chain, token_address, current_score, peak_score,
        broadcast_count, updated_at
      ) VALUES ('base:0xabc', 'base', '0xabc', 0.7, 0.7, 0, 10);
    `);
    database.close();

    const application = createAddressConsoleApplication(path);
    expect(application.handle("GET", "/api/v2/token-coverage")).toMatchObject({
      status: 200,
      body: {
        items: expect.arrayContaining([
          expect.objectContaining({ chain: "base", observedTokenCount: 2, milestoneTokenCount: 1, historicalAdmittedCount: 0, aggregatedTokenCount: 1 }),
          expect.objectContaining({ chain: "solana", observedTokenCount: 1, milestoneTokenCount: 0, historicalAdmittedCount: 0, aggregatedTokenCount: 0 }),
          expect.objectContaining({ chain: "bsc", observedTokenCount: 0 }),
        ]),
      },
    });
    application.close();
  });
});
