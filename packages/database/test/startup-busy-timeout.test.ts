import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { configureAddressRadarDatabase } from "../src/connection.js";

it("installs the busy handler before a potentially locking WAL initialization", () => {
  let busyHandlerInstalled = false;
  const calls: string[] = [];
  const database = { exec(sql: string) {
    calls.push(sql);
    if (sql.includes("journal_mode") && !busyHandlerInstalled) throw new Error("database is locked");
    if (sql.includes("busy_timeout")) busyHandlerInstalled = true;
  } } as unknown as DatabaseSync;
  expect(configureAddressRadarDatabase(database)).toBe(database);
  expect(calls[0]).toContain("busy_timeout");
});
