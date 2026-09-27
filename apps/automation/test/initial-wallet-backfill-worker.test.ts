import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAddressRadarDatabase } from "@address-radar/database";
import { openWalletAnalysisStore } from "@address-radar/wallet-analysis";
import { afterEach, describe, expect, it } from "vitest";

import { createInitialWalletBackfillWorker } from "../src/initial-wallet-backfill-worker.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("initial wallet backfill worker", () => {
  it("hands a resolved wallet to analysis exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-automation-"));
    directories.push(directory);
    const databasePath = join(directory, "address-radar.sqlite");
    const store = openWalletAnalysisStore(databasePath);
    const worker = createInitialWalletBackfillWorker({
      store,
      now: () => 10_000,
    });
    const idempotencyKey =
      "initial-wallet-backfill:trader-1:evm:0xaabb:60d:300:trader-backfill-v1";
    const job = {
      idempotencyKey,
      payload: JSON.stringify({
        traderId: "trader-1",
        accountId: "account-1",
        chainFamily: "evm",
        address: "0xaabb",
        windowDays: 60,
        maximumTokens: 300,
      }),
    } as Parameters<typeof worker.execute>[0];

    await worker.execute(job, new AbortController().signal);
    await worker.execute(job, new AbortController().signal);

    expect(store.job(idempotencyKey)).toMatchObject({
      analysisId: idempotencyKey,
      chainFamily: "evm",
      address: "0xaabb",
      requestedSamples: 300,
      status: "collecting",
    });
    store.close();

    const database = openAddressRadarDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM wallet_analysis_jobs WHERE analysis_id = ?",
        )
        .get(idempotencyKey),
    ).toEqual({ count: 1 });
    database.close();
  });
});
