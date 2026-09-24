import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
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
});
