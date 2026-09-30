import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveObservedMarketSupply } from "../src/observed-market-supply.js";

it("accepts only explicit recent market-cap provenance", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE token_market_snapshots(snapshot_id TEXT,token_id TEXT,source TEXT,observed_at INTEGER,price_usd REAL,market_cap_usd REAL,payload TEXT)");
  const insert = db.prepare("INSERT INTO token_market_snapshots VALUES(?, 'base:0xtoken', 'dexscreener', ?, 2, 200000, ?)");
  insert.run("legacy", 1000, "{}");
  expect(resolveObservedMarketSupply({ database: db, chain: "base", tokenAddress: "0xTOKEN", asOf: 1000 })).toBeNull();
  insert.run("trusted", 1000, '{"marketCapBasis":"market_cap"}');
  expect(resolveObservedMarketSupply({ database: db, chain: "base", tokenAddress: "0xTOKEN", asOf: 1000 })).toMatchObject({ supply: 100000, snapshotId: "trusted", observedAt: 1000 });
  expect(resolveObservedMarketSupply({ database: db, chain: "base", tokenAddress: "0xTOKEN", asOf: 999 })).toBeNull();
  expect(resolveObservedMarketSupply({ database: db, chain: "base", tokenAddress: "0xTOKEN", asOf: 86402000 })).toBeNull();
  db.close();
});
