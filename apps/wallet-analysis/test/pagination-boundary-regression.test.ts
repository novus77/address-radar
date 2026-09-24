import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createWalletAnalysisRuntime, openWalletAnalysisStore } from "../src/index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("299 saved tokens plus a duplicate and a new token reaches 300 unique tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wallet-analysis-unique-"));
  directories.push(directory);
  const store = openWalletAnalysisStore(join(directory, "radar.sqlite"));
  store.enqueue({ analysisId: "unique-300", chainFamily: "solana", address: "wallet", requestedSamples: 999, createdAt: 10_000 });
  store.savePage("unique-300", Array.from({ length: 299 }, (_, index) => position(index)), "next", "seed", 10_001);
  const runtime = createWalletAnalysisRuntime({
    store,
    now: () => 10_002,
    providers: { solana: { async collect() { return { positions: [position(0), position(299)], nextCursor: null, done: true, provenance: "provider" }; } } },
  });

  await expect(runtime.runOnce()).resolves.toMatchObject({ saved: 1, status: "review_required" });
  expect(store.positions("unique-300")).toHaveLength(300);
  store.close();
});

function position(index: number) {
  return { tokenId: `solana:token-${index}`, enteredAt: 9_000, investedUsd: 1, realizedValueUsd: 0, remainingValueUsd: 1, peakValueUsd: 2, holdingDurationMs: 1, maximumDrawdownRatio: 0, earlyEntry: false, largeBuy: false };
}
