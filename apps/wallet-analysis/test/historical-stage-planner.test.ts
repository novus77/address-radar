import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCandidateHistoryStore, openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";
import { createHistoricalStagePlanner } from "../src/historical-stage-planner.js";

const directories: string[] = [];
const START = Date.parse("2026-08-10T00:00:00.000Z");

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("historical stage planner", () => {
  it("advances verified tokens despite failed universe partitions and excludes pending tokens", () => {
    const directory = mkdtempSync(join(tmpdir(), "historical-stage-planner-"));
    directories.push(directory);
    const path = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    const database = openAddressRadarDatabase(path);
    const history = createCandidateHistoryStore(database);
    for (const address of ["0xgood", "0xpending"]) history.saveHistoricalToken({ tokenId: `base:${address}`, chain: "base", tokenAddress: address, symbol: "MEME", imageUrl: null, firstTradeAt: START, firstReached1mAt: START + 1, peakMarketCapUsd: 2_000_000, source: "test", sourceQueryId: null, provenance: {} });
    database.prepare("UPDATE historical_token_verifications SET status = 'confirmed', exact_ca_match = 1, history_available = 1 WHERE token_id = 'base:0xgood'").run();
    history.saveMilestoneCrossing({ milestoneId: "base:0xgood:500000", tokenId: "base:0xgood", marketCapUsd: 500_000, crossedAt: START + 2, precision: "exact", source: "test", sourceEventIds: ["m"], strategyVersion: "v3" });
    database.prepare(`INSERT INTO historical_backfill_partitions(partition_id,query_kind,chain,day_start,day_end,token_addresses,status,execution_id,next_offset,row_count,attempt_count,watermark,next_retry_at,lease_expires_at,last_error,created_at,updated_at,completed_at) VALUES ('failed-universe','token_universe','base',?,?,'[]','failed',NULL,0,0,1,NULL,0,NULL,'provider_error',1,1,NULL)`).run(START, START + 100);

    const planner = createHistoricalStagePlanner({
      database,
      repository,
      historyStore: history,
      chains: ["base"],
      startAt: START,
      now: () => START + 24 * 60 * 60_000,
    });
    const result = planner.plan();
    database.exec(`
      CREATE TRIGGER reject_redundant_partition_insert
      BEFORE INSERT ON historical_backfill_partitions
      BEGIN
        SELECT RAISE(ABORT, 'redundant partition insert');
      END;
    `);
    expect(() => planner.plan()).not.toThrow();
    const restartedPlanner = createHistoricalStagePlanner({
      database,
      repository,
      historyStore: history,
      chains: ["base"],
      startAt: START,
      now: () => START + 24 * 60 * 60_000,
    });
    expect(() => restartedPlanner.plan()).not.toThrow();

    expect(result).toMatchObject({ milestoneTokenCount: 1, earlyTradeTokenCount: 1 });
    const partitions = repository.historicalBackfillPartitions().filter(item => item.queryKind !== "token_universe");
    expect(partitions).toHaveLength(2);
    expect(partitions.map(item => [item.queryKind, item.tokenAddresses])).toEqual([
      ["milestone_crossings", ["0xgood"]],
      ["pre_milestone_trades", ["0xgood"]],
    ]);
    expect(history.milestoneCrossings("base:0xgood")).toEqual(expect.arrayContaining([
      expect.objectContaining({ marketCapUsd: 1_000_000, crossedAt: START + 1, source: "historical_token_first_reached_1m" }),
    ]));
    database.close();
    repository.close();
  });
});
