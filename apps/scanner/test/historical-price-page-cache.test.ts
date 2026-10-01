import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readHistoricalPricePage } from "../src/historical-price-page-cache.js";

const HOUR = 3_600_000;
function fixture(operation: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE market_observations(chain TEXT, token_address TEXT, observed_at INTEGER, price_usd REAL, source TEXT);
    CREATE TABLE token_fact_attempts(attempt_id TEXT, token_id TEXT, fact_type TEXT, provider TEXT, outcome TEXT,
      facts_written INTEGER, coverage_start_at INTEGER, coverage_end_at INTEGER, finished_at INTEGER, payload TEXT);`);
  for (let i = 0; i < 3; i++) database.prepare("INSERT INTO market_observations VALUES (?,?,?,?,?)").run("eth", "0xabc", i * HOUR, 2, "defillama_chart");
  database.prepare("INSERT INTO token_fact_attempts VALUES (?,?,?,?,?,?,?,?,?,?)").run("a", "eth:0xabc", "price_history", "defillama_chart", "partial", 3, 0, 2 * HOUR, 10, JSON.stringify({ confidence: 0.9 }));
  try { operation(database); } finally { database.close(); }
}
const range = { fromAt: 0, toAt: 2 * HOUR };

describe("historical price page cache", () => {
  it("returns complete proven pages without writing progress", () => fixture(database => {
    const result = readHistoricalPricePage(database, "eth:0xabc", range);
    expect(result?.prices).toHaveLength(3);
    expect(result?.confidence).toBe(0.9);
    expect(Object.isFrozen(result?.prices)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS n FROM token_fact_attempts").get()).toEqual({ n: 1 });
  }));
  it.each([
    "DELETE FROM market_observations WHERE observed_at = 3600000",
    "UPDATE market_observations SET source = 'other'",
    "UPDATE token_fact_attempts SET payload = '{}'",
    "UPDATE token_fact_attempts SET payload = 'invalid'",
    "UPDATE token_fact_attempts SET coverage_end_at = 3600000",
    "UPDATE market_observations SET price_usd = 0",
  ])("refetches incomplete or unproven pages: %s", sql => fixture(database => {
    database.exec(sql);
    expect(readHistoricalPricePage(database, "eth:0xabc", range)).toBeNull();
  }));
  it("never shares prices across chains or Solana case variants", () => fixture(database => {
    expect(readHistoricalPricePage(database, "base:0xabc", range)).toBeNull();
    database.exec("UPDATE market_observations SET chain='solana', token_address='AbC'; UPDATE token_fact_attempts SET token_id='solana:AbC'");
    expect(readHistoricalPricePage(database, "solana:AbC", range)?.prices).toHaveLength(3);
    expect(readHistoricalPricePage(database, "solana:abc", range)).toBeNull();
  }));
});
