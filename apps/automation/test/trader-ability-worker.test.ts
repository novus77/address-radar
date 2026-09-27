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
  it("separates discovered, candidate, stable, and degraded ability", async () => {
    const { database, worker } = setup();
    addTrader(database, "discovered");
    addTrader(database, "candidate");
    addTrader(database, "stable");
    addTrader(database, "degraded");
    addSamples(database, "candidate", [2, 2, 0.5, 0, 0.8, 1, 0.4]);
    addSamples(database, "stable", [2, 2, 2, 0.5, 0, 1, 0.8, 0.2]);
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
    expect(latest(database, "degraded")).toMatchObject({ abilityStage: "degraded", validSamples: 0 });
    const snapshotCount = database.prepare(`
      SELECT COUNT(*) AS count FROM trader_repeatable_ability_snapshots WHERE entity_id = 'stable'
    `).get() as { count: number };
    expect(snapshotCount.count).toBe(3);
    database.close();
  });

  it("includes losses and zero returns while rejecting single-token profit concentration", async () => {
    const { database, worker } = setup();
    addTrader(database, "concentrated");
    addSamples(database, "concentrated", [10, 1.2, 1.2, 0.5, 0, 1, 0.8, 0.2]);

    await evaluate(worker, "concentrated");

    const snapshot = latest(database, "concentrated");
    expect(snapshot).toMatchObject({ abilityStage: "candidate", validSamples: 8, successfulDistinctTokens: 3 });
    expect(snapshot.winRate).toBe(3 / 8);
    expect(Number(snapshot.maximumSingleTokenProfitShare)).toBeGreaterThan(0.5);
    expect(JSON.parse(String(snapshot.reasonCodes))).toContain("single_token_profit_concentration");
    database.close();
  });
});

