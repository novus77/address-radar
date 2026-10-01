import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrateWalletExecutionBasis } from "../src/wallet-execution-basis-schema.js";

it("adds execution provenance to an existing database without running legacy migrations", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE wallet_monitor_observations(source TEXT,event_id TEXT,payload TEXT,PRIMARY KEY(source,event_id));
    INSERT INTO wallet_monitor_observations VALUES('solana','old-event','unchanged');`);
  migrateWalletExecutionBasis(database);
  migrateWalletExecutionBasis(database);
  expect(database.prepare("SELECT payload FROM wallet_monitor_observations").get()).toEqual({ payload: "unchanged" });
  expect(database.prepare("SELECT count(*) n FROM wallet_monitor_execution_bases").get()).toEqual({ n: 0 });
  expect(database.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()).toEqual({ n: 2 });
  database.close();
});
