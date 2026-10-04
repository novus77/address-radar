import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAddressRadarDatabase } from "@address-radar/database";
import {
  readOnlyPurchaseDependencyBundle, readOnlyRowProtectionBundle,
  type RowProtectionRequest,
} from "../src/full-data-row-protection.js";
import { readOnlyPurchaseDependencyCoveragePreflight } from "../src/purchase-dependency-coverage-preflight.js";

const DAY = 86_400_000;
const request: RowProtectionRequest = {
  roots: [{ reference: "private-root", reason: "trade_evidence", row: {
    table: "wallet_monitor_observations", key: { source: "solana_rpc", event_id: "private-event" },
  } }],
};

function fixture(run: (database: DatabaseSync, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "radar-purchase-dependency-"));
  const path = join(directory, "source.sqlite");
  const database = new DatabaseSync(path);
  try {
    migrateAddressRadarDatabase(database);
    database.exec("CREATE TABLE IF NOT EXISTS provider_request_gates(provider TEXT PRIMARY KEY,next_request_at INTEGER NOT NULL,cooldown_until INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    database.exec("INSERT INTO trader_entities VALUES('private-entity','probation',1,0,1,1)");
    database.exec("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES('private-account','Private',1,1)");
    database.exec("INSERT INTO wallet_monitor_observations(source,event_id,chain_family,chain,wallet_address,token_address,account_id,entity_id,side,amount_usd,price_usd,occurred_at,collected_at,source_reference) VALUES('solana_rpc','private-event','solana','solana','private-wallet','private-token','private-account','private-entity','buy',50,0.5,100,101,'private-transaction')");
    database.prepare("INSERT INTO wallet_monitor_execution_bases VALUES('solana_rpc','private-event',?,102)").run(JSON.stringify({
      status: "estimated", reason: "nominal_stablecoin_usd", amountBasis: "nominal_stablecoin", amountUsd: 50, priceUsd: 0.5,
    }));
    run(database, path);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}

const input = (asOf = 1_000) => ({ source: "solana_rpc", eventId: "private-event", asOf });

describe("independent bounded purchase dependencies", () => {
  it("keeps the original all-guard reader blocked while a bounded purchase slice fits", () => fixture((database, path) => {
    const insert = database.prepare("INSERT INTO provider_budget_usage VALUES('provider',?,1,100)");
    for (let index = 0; index < 1_100; index++) insert.run(index);
    const legacy = readOnlyRowProtectionBundle(path, request);
    expect(legacy.declaredDependenciesComplete).toBe(false);
    expect(legacy.issues.some(issue => issue.code === "preservation_limit_reached")).toBe(true);
    const isolated = readOnlyPurchaseDependencyBundle(path, request, { maximumRows: 4 });
    expect(isolated.rows).toHaveLength(4);
    expect(isolated.declaredDependenciesComplete).toBe(true);
    expect(isolated.rows.some(row => row.table === "provider_budget_usage")).toBe(false);
    expect(isolated.globalDeliveryAndBudgetGuardsComplete).toBe(false);
    expect(isolated.unresolvedGates).toContain("coherent_global_guard_export_and_target_round_trip");
  }));

  it("does not claim full preservation with missing global tables", () => fixture((database, path) => {
    database.exec("DROP TABLE provider_request_gates");
    const isolated = readOnlyPurchaseDependencyBundle(path, request);
    expect(isolated.declaredDependenciesComplete).toBe(true);
    expect(isolated.globalDeliveryAndBudgetGuardsComplete).toBe(false);
    expect(readOnlyRowProtectionBundle(path, request).globalDeliveryAndBudgetGuardsComplete).toBe(false);
  }));

  it("preserves explicit missing-basis and per-purchase cap blockers", () => fixture((database, path) => {
    database.exec("DELETE FROM wallet_monitor_execution_bases");
    const missing = readOnlyPurchaseDependencyCoveragePreflight(path, input());
    expect(missing.status).toBe("blocked");
    expect(missing.issues).toContainEqual({ code: "missing_required_dependency_row", table: "wallet_monitor_execution_bases" });
    const limited = readOnlyPurchaseDependencyCoveragePreflight(path, input(), { maximumRows: 1 });
    expect(limited.declaredPurchaseDependenciesComplete).toBe(false);
    expect(limited.issues.some(issue => issue.code === "preservation_limit_reached")).toBe(true);
  }));

  it("keeps revision history and consumer requests associated with the exact event", () => fixture((database, path) => {
    database.exec("INSERT INTO trader_execution_heads VALUES('solana_rpc','private-event','private-entity','solana','private-token',2,'fingerprint',102,'applied')");
    for (const revision of [0, 1, 2]) database.prepare("INSERT INTO trader_execution_revisions VALUES('solana_rpc','private-event',?,?,?,102)")
      .run(revision, "fingerprint-" + revision, JSON.stringify({ revision }));
    database.exec("INSERT INTO execution_revision_requests(source,event_id,consumer_type,subject_key,entity_id,token_id,desired_revision,requested_at) VALUES('solana_rpc','private-event','ability_evaluation','private-entity','private-entity','solana:private-token',2,102)");
    const bundle = readOnlyPurchaseDependencyBundle(path, { roots: [{ reference: "revision", reason: "trade_evidence", row: {
      table: "trader_execution_heads", key: { source: "solana_rpc", event_id: "private-event" },
    } }] });
    expect(bundle.declaredDependenciesComplete).toBe(true);
    expect(bundle.rows.filter(row => row.table === "trader_execution_revisions")).toHaveLength(3);
    expect(bundle.rows.filter(row => row.table === "execution_revision_requests")).toHaveLength(1);
  }));

  it("still blocks projected-event reverse lookups without a reviewed index", () => fixture((database, path) => {
    database.exec("UPDATE wallet_monitor_observations SET projected_at=103");
    database.exec("INSERT INTO raw_trader_observations VALUES('observation:onchain:private-event','private-event','private-entity','onchain','solana','private-token','buy',50,100,'private-payload',101)");
    const bundle = readOnlyPurchaseDependencyBundle(path, request);
    expect(bundle.declaredDependenciesComplete).toBe(false);
    expect(bundle.issues.some(issue => issue.code === "unindexed_dependency_lookup" && issue.table === "canonical_trader_event_observations")).toBe(true);
  }));

  it("rejects global-ledger roots and non-trade obligations", () => fixture((_database, path) => {
    expect(() => readOnlyPurchaseDependencyBundle(path, { roots: [{ reference: "guard", reason: "delivery_guard", row: {
      table: "provider_request_gates", key: { provider: "provider" },
    } }] })).toThrow("invalid_purchase_dependency_roots");
    expect(() => readOnlyPurchaseDependencyBundle(path, { roots: [{ ...request.roots[0]!, reason: "unresolved_evidence" }] }))
      .toThrow("invalid_purchase_dependency_roots");
  }));

  it("reports an unfinished 30-day window without a negative opportunity finding", () => fixture((_database, path) => {
    const report = readOnlyPurchaseDependencyCoveragePreflight(path, input());
    expect(report.status).toBe("dependencies_available");
    expect(report.priceCoverage).toMatchObject({ status: "observing_with_coverage_gaps", boughtAt: 100,
      expiresAt: 100 + 30 * DAY, windowClosed: false, independentProviderCoverageVerified: false, noHitOrLossEstablished: false });
    expect(report.priceCoverage?.gaps).toEqual([{ from: 100, to: 1_000 }]);
    expect(report.sameSnapshotGlobalGuardsVerified).toBe(false);
    expect(report.independentlyVerifiedPurchase).toBe(false);
    expect(report.newPurchaseSamplesCreated).toBe(0);
    expect(report.newEligibilityGranted).toBe(false);
    expect(report.productionMigrationReady).toBe(false);
  }));

  it("reports closed-window history gaps and never treats a wallet-range receipt as price coverage", () => fixture((_database, path) => {
    const report = readOnlyPurchaseDependencyCoveragePreflight(path, { ...input(100 + 31 * DAY), claims: [{
      claimId: "wallet-range", provider: "provider", chain: "solana", tokenAddress: "private-token", purpose: "wallet_history",
      claimType: "complete_range", state: "verified", from: 100, to: 100 + 30 * DAY, knownAt: 1_000, evidenceRefs: ["ref"],
    }] });
    expect(report.priceCoverage?.status).toBe("historical_price_gaps");
    expect(report.priceCoverage?.gaps).toEqual([{ from: 100, to: 100 + 30 * DAY }]);
  }));

  it("retains declared coverage separately from independently verified provider evidence", () => fixture((_database, path) => {
    const report = readOnlyPurchaseDependencyCoveragePreflight(path, { ...input(100 + 31 * DAY), claims: [{
      claimId: "price-range", provider: "provider", chain: "solana", tokenAddress: "private-token", purpose: "price_history",
      claimType: "complete_range", state: "verified", from: 100, to: 100 + 30 * DAY, knownAt: 100 + 30 * DAY, evidenceRefs: ["ref"],
    }] });
    expect(report.priceCoverage?.status).toBe("full_window_range_declared");
    expect(report.priceCoverage?.independentProviderCoverageVerified).toBe(false);
    expect(report.productionMigrationReady).toBe(false);
  }));

  it("rejects unknown-as-of clocks without deriving a price window", () => fixture((_database, path) => {
    const report = readOnlyPurchaseDependencyCoveragePreflight(path, input(100));
    expect(report.status).toBe("blocked");
    expect(report.priceCoverage).toBeNull();
    expect(report.issues).toContainEqual({ code: "purchase_observation_not_known_as_of", table: "wallet_monitor_observations" });
  }));

  it("uses the complete source/event key and does not expose private source facts", () => fixture((database, path) => {
    const before = readFileSync(path);
    const report = readOnlyPurchaseDependencyCoveragePreflight(path, input());
    expect(readFileSync(path).equals(before)).toBe(true);
    for (const privateValue of ["private-event", "private-wallet", "private-token", "private-account", "private-entity", "private-transaction", "private-root"]) {
      expect(JSON.stringify(report)).not.toContain(privateValue);
    }
    const other = readOnlyPurchaseDependencyCoveragePreflight(path, { ...input(), source: "other_rpc" });
    expect(other.status).toBe("blocked");
    expect(other.priceCoverage).toBeNull();
    expect(other.sourceEventFingerprint).not.toBe(report.sourceEventFingerprint);
    expect(database.prepare("SELECT count(*) AS count FROM wallet_monitor_observations").get()?.count).toBe(1);
  }));

  it("rejects malformed identity inputs and clocks", () => fixture((_database, path) => {
    for (const invalid of [{ ...input(), source: " " }, { ...input(), eventId: "" }, { ...input(), asOf: -1 }, { ...input(), asOf: NaN }]) {
      expect(() => readOnlyPurchaseDependencyCoveragePreflight(path, invalid)).toThrow("invalid_purchase_dependency_input");
    }
  }));
});
