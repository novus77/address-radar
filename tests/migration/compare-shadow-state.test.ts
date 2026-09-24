import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeAddressRadarSchema } from "../../packages/database/src/schema.js";
import { compareShadowState } from "../../scripts/compare-shadow-state.js";

describe("shadow state comparison", () => {
  it("detects semantic equality and differences", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-compare-")); const legacy = join(directory, "legacy.db"); const current = join(directory, "current.db");
    for (const path of [legacy, current]) { const database = new DatabaseSync(path); initializeAddressRadarSchema(database); const insert = database.prepare("INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)"); for (const id of path === legacy ? ["2", "1"] : ["1", "2"]) insert.run(`account-${id}`, `alpha-${id}`, 1, 2); database.close(); }
    expect(compareShadowState({ legacy, current }).matches).toBe(true);
    const database = new DatabaseSync(current); database.prepare("UPDATE fomo_accounts SET handle = ? WHERE account_id = ?").run("beta", "account-1"); database.close();
    expect(compareShadowState({ legacy, current }).matches).toBe(false);
  });
});
