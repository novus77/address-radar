import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { ADDRESS_RADAR_BUSY_TIMEOUT_MS, openAddressRadarDatabase } from "../src/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("shared database connections enable WAL and a production busy timeout", () => {
  const directory = mkdtempSync(join(tmpdir(), "address-radar-connection-"));
  directories.push(directory);
  const database = openAddressRadarDatabase(join(directory, "radar.sqlite"));

  expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
  expect(database.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: ADDRESS_RADAR_BUSY_TIMEOUT_MS });

  database.close();
});
