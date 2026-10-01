import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrateAddressRadarDatabase } from "@address-radar/database";

import { createTraderAbilityWorker } from "../src/trader-ability-worker.js";

const DAY_MS = 24 * 60 * 60_000;
const NOW = 40 * DAY_MS;

function setup() {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  const worker = createTraderAbilityWorker({ database, now: () => NOW });
  return { database, worker };
}

function addTrader(database: DatabaseSync, traderId: string): void {
  database.prepare(`
    INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
    VALUES (?, 'candidate', 0, 0, 1, 1)
  `).run(traderId);
}

function addSamples(database: DatabaseSync, traderId: string, returns: readonly number[]): void {
  const sampleStatement = database.prepare(`
    INSERT INTO trader_token_samples(
      sample_id, entity_id, chain, token_address, first_buy_at, last_activity_at,
      weighted_entry_price_usd, weighted_entry_market_cap_usd, total_buy_usd,
      total_sell_usd, realized_value_usd, remaining_cost_usd, launch_at,
      lifecycle_stage_at_entry, source_state, sample_status, exclusion_reason,
      created_at, updated_at
    ) VALUES (?, ?, 'solana', ?, ?, ?, 1, 100000, 100, 0, 0, 100, NULL,
      'new_launch', 'FOMO_ONLY', 'included', NULL, ?, ?)
  `);
  const outcomeStatement = database.prepare(`
    INSERT INTO trader_token_outcomes(
      sample_id, horizon, target_at, observed_at, close_multiple, mfe_multiple,
      mae_multiple, captured_multiple, hit_1_5x, hit_2x, hit_5x, hit_10x,
      time_to_1_5x_ms, time_to_2x_ms, time_to_5x_ms, time_to_10x_ms,
      coverage_status, source, computed_at
    ) VALUES (?, '24h', ?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
      'complete', 'test', ?)
  `);
  returns.forEach((multiple, index) => {
    const firstBuyAt = NOW - 20 * DAY_MS + index * 2 * DAY_MS;
    const sampleId = `${traderId}:sample-${index}`;
    sampleStatement.run(sampleId, traderId, `token-${index}`, firstBuyAt, firstBuyAt, firstBuyAt, firstBuyAt);
    outcomeStatement.run(
      sampleId,
      firstBuyAt + DAY_MS,
      firstBuyAt + DAY_MS,
      multiple,
      Math.max(1, multiple),
      multiple,
      multiple >= 1.5 ? 1 : 0,
      multiple >= 2 ? 1 : 0,
      multiple >= 5 ? 1 : 0,
      multiple >= 10 ? 1 : 0,
      firstBuyAt + DAY_MS,
    );
  });
}

async function evaluate(worker: ReturnType<typeof createTraderAbilityWorker>, traderId: string, evaluatedAt = NOW) {
  return worker.execute({ payload: JSON.stringify({ traderId, evaluatedAt }), cursor: null } as never, new AbortController().signal);
}

function latest(database: DatabaseSync, traderId: string) {
  return database.prepare(`
    SELECT ability_stage AS abilityStage, valid_samples AS validSamples,
      successful_distinct_tokens AS successfulDistinctTokens, win_rate AS winRate,
      sample_span_ms AS sampleSpanMs,
      maximum_single_token_profit_share AS maximumSingleTokenProfitShare,
      reason_codes AS reasonCodes
    FROM trader_repeatable_ability_snapshots
    WHERE entity_id = ? AND window = '30d'
    ORDER BY evaluated_at DESC, snapshot_id DESC
    LIMIT 1
  `).get(traderId) as Record<string, unknown>;
}

describe("trader ability worker", () => {
  it("preserves verified historical recurrence after recent purchases age out", async () => {
    const { database, worker } = setup();
    addTrader(database, "historical");
    addSamples(database, "historical", [5, 5]);
    await evaluate(worker, "historical");
    expect(database.prepare("SELECT tag FROM trader_tags WHERE entity_id = 'historical' AND category = 'ability'").all())
      .toEqual([{ tag: "ability.historical_repeated_high_multiple_discovery" }]);
    await evaluate(worker, "historical", NOW + 31 * DAY_MS);
    expect(latest(database, "historical").abilityStage).toBe("discovered");
    expect(database.prepare("SELECT tag FROM trader_tags WHERE entity_id = 'historical' AND category = 'ability'").all())
      .toEqual([{ tag: "ability.historical_repeated_high_multiple_discovery" }]);
    database.close();
  });

  it("does not finish the daily scan when backpressure shrinks the batch", async () => {
    const { database } = setup();
    for (const id of ["scan-a", "scan-b", "scan-c"]) {
      addTrader(database, id);
      addSamples(database, id, [3]);
    }
    const enqueued: unknown[] = [];
    const jobs = {
      activeCount: () => 999,
      activeJobForSubject: () => null,
      enqueue: (job: unknown) => enqueued.push(job),
    };
    const worker = createTraderAbilityWorker({ database, jobs: jobs as never, now: () => NOW });
    const result = await worker.execute({ payload: JSON.stringify({ mode: "dispatch" }), cursor: null } as never, new AbortController().signal);
    expect(result).toMatchObject({ status: "checkpoint", retryAt: NOW });
    expect(JSON.parse(String((result as { cursor: string }).cursor)).lastTraderId).toBe("scan-b");
    expect(enqueued).toHaveLength(2);
    database.close();
  });

  it("records opportunity stages without demoting an inactive trader as a loss", async () => {
    const { database, worker } = setup();
    addTrader(database, "discovered");
    addTrader(database, "candidate");
    addTrader(database, "stable");
    addTrader(database, "degraded");
    addSamples(database, "candidate", [2, 2, 0.5, 0, 0.8, 1, 0.4]);
    addSamples(database, "stable", [3, 3, 3, 0.5, 0, 1, 0.8, 0.2]);
    database.prepare(`
      INSERT INTO trader_repeatable_ability_snapshots(
        snapshot_id, entity_id, window, ability_stage, bundle_risk_state,
        total_samples, valid_samples, successful_distinct_tokens, win_rate,
        sample_span_ms, maximum_single_token_profit_share, bundle_distinct_token_count,
        reason_codes, strategy_version, evaluated_at
      ) VALUES ('old-stable', 'degraded', '30d', 'stable', 'none', 8, 8, 3, 0.5,
        ?, 0.33, 0, '[]', 'test', ?)
    `).run(14 * DAY_MS, NOW - DAY_MS);

    await evaluate(worker, "discovered");
    await evaluate(worker, "candidate");
    await evaluate(worker, "stable");
    await evaluate(worker, "degraded");

    expect(latest(database, "discovered")).toMatchObject({ abilityStage: "discovered", validSamples: 0 });
    expect(latest(database, "candidate")).toMatchObject({ abilityStage: "candidate", validSamples: 7 });
    expect(latest(database, "stable")).toMatchObject({
      abilityStage: "stable",
      validSamples: 8,
      successfulDistinctTokens: 3,
      sampleSpanMs: 14 * DAY_MS,
    });
    expect(latest(database, "degraded")).toMatchObject({ abilityStage: "discovered", validSamples: 0 });
    const snapshotCount = database.prepare(`
      SELECT COUNT(*) AS count FROM trader_repeatable_ability_snapshots WHERE entity_id = 'stable'
    `).get() as { count: number };
    expect(snapshotCount.count).toBe(1);
    database.close();
  });

  it("keeps one exceptional opportunity from establishing distinct-token recurrence", async () => {
    const { database, worker } = setup();
    addTrader(database, "concentrated");
    addSamples(database, "concentrated", [10, 1.2, 1.2, 0.5, 0, 1, 0.8, 0.2]);

    await evaluate(worker, "concentrated");

    const snapshot = latest(database, "concentrated");
    expect(snapshot).toMatchObject({ abilityStage: "candidate", validSamples: 8, successfulDistinctTokens: 1 });
    expect(snapshot.winRate).toBe(1);
    expect(Number(snapshot.maximumSingleTokenProfitShare)).toBeGreaterThan(0.5);
    expect(JSON.parse(String(snapshot.reasonCodes))).toContain("opportunity_recurrence_not_yet_confirmed");
    database.close();
  });

  it("recognizes two unsold 5x opportunities without the old sample or span gates", async () => {
    const { database, worker } = setup();
    addTrader(database, "unsold");
    addSamples(database, "unsold", [0.8, 0.8]);
    database.prepare("UPDATE trader_token_outcomes SET mfe_multiple = 5, captured_multiple = NULL WHERE sample_id LIKE 'unsold:%'").run();
    await evaluate(worker, "unsold");
    const snapshot = latest(database, "unsold");
    expect(snapshot).toMatchObject({ abilityStage: "stable", successfulDistinctTokens: 2, validSamples: 2 });
    expect(JSON.parse(String(snapshot.reasonCodes))).toContain("repeated_high_multiple_discovery");
    database.close();
  });

  it("does not invent opportunity evidence from fixed close values without MFE", async () => {
    const { database, worker } = setup();
    addTrader(database, "missing");
    addSamples(database, "missing", [10, 10, 10]);
    database.prepare("UPDATE trader_token_outcomes SET mfe_multiple = NULL WHERE sample_id LIKE 'missing:%'").run();
    await evaluate(worker, "missing");
    expect(latest(database, "missing")).toMatchObject({ abilityStage: "candidate", validSamples: 0, successfulDistinctTokens: 0 });
    expect(JSON.parse(String(latest(database, "missing").reasonCodes))).toContain("opportunity_data_missing");
    database.close();
  });
});
