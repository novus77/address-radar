import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAddressRadarDatabase } from "@address-radar/database";
import { readOnlyPurchaseMarketInventoryPreflight } from "../src/purchase-market-inventory-preflight.js";

const DAY = 86_400_000;
const INDEX = "idx_canonical_trader_event_observations_observation_id";
const input = { source: "solana_rpc", eventId: "private-event", asOf: 100 + 31 * DAY };

function fixture(run: (database: DatabaseSync, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "radar-market-inventory-"));
  const path = join(directory, "source.sqlite");
  const database = new DatabaseSync(path);
  try {
    migrateAddressRadarDatabase(database);
    database.exec("INSERT INTO trader_entities VALUES('private-entity','probation',1,0,1,1)");
    database.exec("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES('private-account','Private',1,1)");
    database.exec("INSERT INTO wallet_monitor_observations(source,event_id,chain_family,chain,wallet_address,token_address,account_id,entity_id,side,amount_usd,price_usd,occurred_at,collected_at,source_reference) VALUES('solana_rpc','private-event','solana','solana','private-wallet','private-token','private-account','private-entity','buy',50,0.5,100,101,'private-transaction')");
    run(database, path);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}

function point(database: DatabaseSync, time: number, source = "private-provider", price = 0.5): void {
  database.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES('solana','private-token',?,?,?)")
    .run(time, price, source);
}

describe("read-only reverse index and stored price-point planning", () => {
  it("proposes a nonunique covering index and ownership-gated rollback without executing either", () => fixture((database, path) => {
    const before = readFileSync(path);
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.reverseLookup).toMatchObject({ status: "index_required", proposedIndexName: INDEX,
      productionApprovalRequired: true, rollbackRequiresDeploymentOwnership: true, currentLookupUsesSearch: false });
    expect(report.reverseLookup.createSql).toBe(`CREATE INDEX "${INDEX}" ON "canonical_trader_event_observations" ("observation_id", "canonical_event_id");`);
    expect(report.reverseLookup.rollbackSql).toBe(`DROP INDEX "${INDEX}";`);
    expect(database.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(INDEX)).toBeUndefined();
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(report.productionMigrationReady).toBe(false);
    expect(report.newEligibilityGranted).toBe(false);
    expect(report.newPurchaseSamplesCreated).toBe(0);
  }));

  it("recognizes an existing full reverse prefix and does not propose its removal", () => fixture((database, path) => {
    database.exec("CREATE INDEX reviewed_reverse ON canonical_trader_event_observations(observation_id,canonical_event_id)");
    const plan = readOnlyPurchaseMarketInventoryPreflight(path, input).reverseLookup;
    expect(plan.status).toBe("already_covered");
    expect(plan.coveringIndexes).toContain("reviewed_reverse");
    expect(plan.currentLookupUsesSearch).toBe(true);
    expect(plan.createSql).toBeNull();
    expect(plan.rollbackSql).toBeNull();
  }));

  it("does not accept a partial reverse index", () => fixture((database, path) => {
    database.exec("CREATE INDEX partial_reverse ON canonical_trader_event_observations(observation_id) WHERE canonical_event_id='subset'");
    expect(readOnlyPurchaseMarketInventoryPreflight(path, input).reverseLookup.status).toBe("index_required");
  }));

  it("does not accept expression or incompatible collation prefixes", () => fixture((database, path) => {
    database.exec("CREATE INDEX expression_reverse ON canonical_trader_event_observations(lower(observation_id))");
    database.exec("CREATE INDEX folded_reverse ON canonical_trader_event_observations(observation_id COLLATE NOCASE)");
    expect(readOnlyPurchaseMarketInventoryPreflight(path, input).reverseLookup.status).toBe("index_required");
  }));

  it("blocks a globally colliding proposed index name instead of using IF NOT EXISTS", () => fixture((database, path) => {
    database.exec(`CREATE INDEX "${INDEX}" ON market_observations(chain)`);
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.reverseLookup.status).toBe("blocked");
    expect(report.reverseLookup.createSql).toBeNull();
    expect(report.reverseLookup.rollbackSql).toBeNull();
    expect(report.issues).toContainEqual({ code: "reverse_index_name_collision", table: "canonical_trader_event_observations" });
  }));

  it("blocks unreviewed reverse-table column drift", () => fixture((database, path) => {
    database.exec("ALTER TABLE canonical_trader_event_observations ADD COLUMN unreviewed TEXT");
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.reverseLookup.status).toBe("blocked");
    expect(report.issues).toContainEqual({ code: "reverse_link_schema_unreviewed", table: "canonical_trader_event_observations" });
  }));

  it("inventories only matching stored points inside the closed purchase window", () => fixture((database, path) => {
    point(database, 99); point(database, 100); point(database, 200); point(database, 100 + 30 * DAY);
    point(database, 101 + 30 * DAY);
    database.exec("INSERT INTO market_observations VALUES('base','private-token',200,1,'other-chain')");
    database.exec("INSERT INTO market_observations VALUES('solana','other-token',200,1,'other-token')");
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.window).toEqual({ from: 100, until: 100 + 30 * DAY, expiresAt: 100 + 30 * DAY, closed: true });
    expect(report.marketInventory).toMatchObject({ status: "points_present", pointsRead: 3, matchingRowsEnumerated: true,
      moreRows: false, firstObservedAt: 100, lastObservedAt: 100 + 30 * DAY, positiveFinitePrices: 3,
      publicationKnownAsOfVerified: false, marketMappingAndQualityVerified: false, independentProviderCoverageVerified: false });
  }));

  it("separates an open window and an empty local point store from absent provider history", () => fixture((_database, path) => {
    const report = readOnlyPurchaseMarketInventoryPreflight(path, { ...input, asOf: 1_000 });
    expect(report.window).toEqual({ from: 100, until: 1_000, expiresAt: 100 + 30 * DAY, closed: false });
    expect(report.marketInventory).toMatchObject({ scope: "market_observations_only", status: "no_stored_points",
      pointsRead: 0, matchingRowsEnumerated: true, independentProviderCoverageVerified: false });
  }));

  it("detects another page without claiming complete enumeration at the row limit", () => fixture((database, path) => {
    point(database, 100); point(database, 200); point(database, 300);
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input, { maximumRows: 2 });
    expect(report.marketInventory).toMatchObject({ pointsRead: 2, moreRows: true, matchingRowsEnumerated: false,
      firstObservedAt: 100, lastObservedAt: 200 });
  }));

  it("does not scan a market table without a full ordinary lookup prefix", () => fixture((database, path) => {
    database.exec("DROP TABLE market_observations");
    database.exec("CREATE TABLE market_observations(chain TEXT NOT NULL,token_address TEXT NOT NULL,observed_at INTEGER NOT NULL,price_usd REAL NOT NULL,source TEXT NOT NULL)");
    database.exec("CREATE INDEX partial_market ON market_observations(chain,token_address,observed_at,source) WHERE price_usd>0");
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.marketInventory.status).toBe("lookup_blocked");
    expect(report.marketInventory.matchingRowsEnumerated).toBe(false);
    expect(report.issues).toContainEqual({ code: "market_lookup_index_unavailable", table: "market_observations" });
  }));

  it("does not turn invalid or unreviewed price points into coverage evidence", () => fixture((database, path) => {
    database.exec("PRAGMA ignore_check_constraints=ON");
    try { point(database, 100, "private-provider", 0); point(database, 200, "private-provider", -1); }
    finally { database.exec("PRAGMA ignore_check_constraints=OFF"); }
    const inventory = readOnlyPurchaseMarketInventoryPreflight(path, input).marketInventory;
    expect(inventory.invalidPrices).toBe(2);
    expect(inventory.positiveFinitePrices).toBe(0);
    expect(inventory.independentProviderCoverageVerified).toBe(false);
  }));

  it("does not derive a known-as-of window from future collected observations", () => fixture((_database, path) => {
    const report = readOnlyPurchaseMarketInventoryPreflight(path, { ...input, asOf: 100 });
    expect(report.window).toBeNull();
    expect(report.marketInventory.status).toBe("lookup_blocked");
    expect(report.issues).toContainEqual({ code: "purchase_observation_not_known_as_of", table: "wallet_monitor_observations" });
  }));

  it("does not derive a buy window for sells or orphaned observations", () => fixture((database, path) => {
    database.exec("UPDATE wallet_monitor_observations SET side='sell'");
    expect(readOnlyPurchaseMarketInventoryPreflight(path, input).window).toBeNull();
    database.exec("UPDATE wallet_monitor_observations SET side='buy',orphaned_at=103");
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.window).toBeNull();
    expect(report.issues).toContainEqual({ code: "purchase_observation_unreviewed", table: "wallet_monitor_observations" });
  }));

  it("matches the complete source/event key and redacts provider and token identities", () => fixture((database, path) => {
    point(database, 100); point(database, 200, "private-second-provider");
    const report = readOnlyPurchaseMarketInventoryPreflight(path, input);
    expect(report.marketInventory.sourceCounts).toHaveLength(2);
    for (const privateValue of ["private-event", "private-token", "private-wallet", "private-provider", "private-second-provider", "private-transaction"]) {
      expect(JSON.stringify(report)).not.toContain(privateValue);
    }
    const missing = readOnlyPurchaseMarketInventoryPreflight(path, { ...input, source: "other_rpc" });
    expect(missing.window).toBeNull();
    expect(missing.issues).toContainEqual({ code: "purchase_observation_missing", table: "wallet_monitor_observations" });
  }));

  it("rejects invalid inputs and unsafe diagnostic row caps", () => fixture((_database, path) => {
    for (const invalid of [{ ...input, source: " " }, { ...input, eventId: "" }, { ...input, asOf: -1 }, { ...input, asOf: NaN }]) {
      expect(() => readOnlyPurchaseMarketInventoryPreflight(path, invalid)).toThrow("invalid_purchase_market_inventory_input");
    }
    for (const maximumRows of [0, -1, 10_001, NaN]) {
      expect(() => readOnlyPurchaseMarketInventoryPreflight(path, input, { maximumRows })).toThrow("invalid_purchase_market_inventory_limits");
    }
  }));
});
