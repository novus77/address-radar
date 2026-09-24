import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeAddressRadarSchema } from "../../packages/database/src/schema.js";
import { importLegacyState } from "../../scripts/import-legacy-state.js";

describe("legacy state import", () => {
  it("copies preserved records repeatably and supports dry run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-migration-")); const source = join(directory, "legacy.db"); const target = join(directory, "current.db");
    const database = new DatabaseSync(source); initializeAddressRadarSchema(database);
    database.prepare("INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").run("account-1", "alpha", 1, 2); database.close();
    expect((await importLegacyState({ source, target, dryRun: true })).tableCounts.fomo_accounts).toBe(1);
    await importLegacyState({ source, target }); await importLegacyState({ source, target });
    const current = new DatabaseSync(target); expect((current.prepare("SELECT COUNT(*) AS count FROM fomo_accounts").get() as { count: number }).count).toBe(1); current.close();
  });

  it("refuses identical source and target paths", async () => {
    await expect(importLegacyState({ source: "same.db", target: "same.db" })).rejects.toThrow("must differ");
  });
});
