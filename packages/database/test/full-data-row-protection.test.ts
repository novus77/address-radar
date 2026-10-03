import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAddressRadarDatabase } from "@address-radar/database";
import { readOnlyRowProtectionBundle, summarizeRowProtectionBundle, type RowProtectionRequest } from "../src/full-data-row-protection.js";

const request = (table: string, key: Record<string, string | number>): RowProtectionRequest => ({
  roots: [{ reference: "private-review-reference", reason: "trade_evidence", row: { table, key } }],
});
const fixture = (run: (database: DatabaseSync, path: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), "radar-row-protection-"));
  const path = join(directory, "fixture.sqlite");
  const database = new DatabaseSync(path);
  try {
    migrateAddressRadarDatabase(database);
    // This runtime-owned ledger is initialized separately from legacy migrations.
    database.exec("CREATE TABLE IF NOT EXISTS provider_request_gates(provider TEXT PRIMARY KEY,next_request_at INTEGER NOT NULL,cooldown_until INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    run(database, path);
  }
  finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
};
const identity = (database: DatabaseSync): void => {
  database.prepare("INSERT INTO trader_entities VALUES('entity','probation',1,0,1,1)").run();
  database.prepare("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES('account','Trader',1,1)").run();
};
const wallet = (database: DatabaseSync, source = "solana_rpc", event = "trade"): void => {
  database.prepare("INSERT INTO wallet_monitor_observations(source,event_id,chain_family,chain,wallet_address,token_address,account_id,entity_id,side,amount_usd,price_usd,occurred_at,collected_at,source_reference) VALUES(?,?,'solana','solana','wallet','token','account','entity','buy',50,0.5,100,101,'transaction')").run(source, event);
};
const basis = (database: DatabaseSync, source = "solana_rpc", event = "trade"): void => {
  database.prepare("INSERT INTO wallet_monitor_execution_bases VALUES(?,?,?,102)").run(source, event,
    JSON.stringify({ status: "estimated", reason: "nominal_stablecoin_usd", amountBasis: "nominal_stablecoin", amountUsd: 50, priceUsd: 0.5 }));
};

describe("bounded row-level preservation", () => {
  it("keeps composite execution keys distinct and never invents a purchase or eligibility", () => fixture((database, path) => {
    identity(database); wallet(database); basis(database);
    wallet(database, "another_rpc"); basis(database, "another_rpc");
    const bundle = readOnlyRowProtectionBundle(path, request("wallet_monitor_execution_bases", { source: "solana_rpc", event_id: "trade" }));
    expect(bundle.declaredDependenciesComplete).toBe(true);
    expect(bundle.rows.filter((row) => row.table === "wallet_monitor_observations")).toHaveLength(1);
    expect(bundle.rows.find((row) => row.table === "wallet_monitor_observations")!.values.source)
      .toEqual({ storage: "text", value: "solana_rpc" });
    expect(bundle.rows.map((row) => row.table)).toEqual(expect.arrayContaining(["trader_entities", "fomo_accounts"]));
    expect(bundle.newPurchaseSamplesCreated).toBe(0);
    expect(bundle.newEligibilityGranted).toBe(false);
    expect(bundle.productionMigrationReady).toBe(false);
  }));

  it("reports a missing execution basis instead of treating an observation as complete", () => fixture((database, path) => {
    identity(database); wallet(database);
    const bundle = readOnlyRowProtectionBundle(path, request("wallet_monitor_observations", { source: "solana_rpc", event_id: "trade" }));
    expect(bundle.declaredDependenciesComplete).toBe(false);
    expect(bundle.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_required_dependency_row", table: "wallet_monitor_execution_bases" }),
    ]));
  }));

  it("preserves revision zero, every later revision and consumer requests", () => fixture((database, path) => {
    identity(database); wallet(database); basis(database);
    database.exec("INSERT INTO trader_execution_heads VALUES('solana_rpc','trade','entity','solana','token',2,'fingerprint',102,'applied')");
    for (const revision of [0, 1, 2]) {
      database.prepare("INSERT INTO trader_execution_revisions VALUES('solana_rpc','trade',?,?,?,102)")
        .run(revision, "fingerprint-" + revision, JSON.stringify({ revision, privatePayload: "preserve-this" }));
    }
    database.exec("INSERT INTO execution_revision_requests(source,event_id,consumer_type,subject_key,entity_id,token_id,desired_revision,requested_at) VALUES('solana_rpc','trade','ability_evaluation','entity','entity','solana:token',2,102)");
    const bundle = readOnlyRowProtectionBundle(path, request("trader_execution_heads", { source: "solana_rpc", event_id: "trade" }));
    expect(bundle.declaredDependenciesComplete).toBe(true);
    expect(bundle.rows.filter((row) => row.table === "trader_execution_revisions")).toHaveLength(3);
    expect(bundle.rows.filter((row) => row.table === "execution_revision_requests")).toHaveLength(1);
    expect(bundle.edges.map((edge) => edge.relation)).toEqual(expect.arrayContaining(["current_revision", "revision_history", "revision_consumers"]));
  }));

  it("blocks a revision head whose current revision is absent", () => fixture((database, path) => {
    database.exec("INSERT INTO trader_execution_heads VALUES('solana_rpc','trade','entity','solana','token',1,'fingerprint',102,'applied')");
    const bundle = readOnlyRowProtectionBundle(path, request("trader_execution_heads", { source: "solana_rpc", event_id: "trade" }));
    expect(bundle.declaredDependenciesComplete).toBe(false);
    expect(bundle.issues.some((entry) => entry.code === "missing_required_dependency_row" && entry.table === "trader_execution_revisions")).toBe(true);
  }));

  it("does not scan a reverse canonical reference without an index", () => fixture((database, path) => {
    identity(database);
    database.exec("INSERT INTO raw_trader_observations VALUES('raw','trade','entity','onchain','solana','token','buy',50,100,'private-payload',101)");
    const bundle = readOnlyRowProtectionBundle(path, request("raw_trader_observations", { observation_id: "raw" }));
    expect(bundle.declaredDependenciesComplete).toBe(false);
    expect(bundle.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unindexed_dependency_lookup", table: "canonical_trader_event_observations" }),
    ]));
  }));

  it("can prove the same reverse reference on an isolated indexed fixture", () => fixture((database, path) => {
    identity(database);
    database.exec("CREATE INDEX isolated_observation_reverse ON canonical_trader_event_observations(observation_id)");
    database.exec("INSERT INTO raw_trader_observations VALUES('raw','trade','entity','onchain','solana','token','buy',50,100,'private-payload',101)");
    database.exec("INSERT INTO canonical_trader_events VALUES('canonical','entity','solana','token','buy',50,100,'ONCHAIN_ONLY',101)");
    database.exec("INSERT INTO canonical_trader_event_observations VALUES('canonical','raw')");
    const bundle = readOnlyRowProtectionBundle(path, request("canonical_trader_events", { canonical_event_id: "canonical" }));
    expect(bundle.declaredDependenciesComplete).toBe(true);
    expect(bundle.rows.filter((row) => row.table === "canonical_trader_event_observations")).toHaveLength(1);
    expect(bundle.rows.filter((row) => row.table === "raw_trader_observations")).toHaveLength(1);
  }));

  it("preserves legacy aggregates but explicitly refuses a per-purchase completeness claim", () => fixture((database, path) => {
    identity(database);
    database.exec("INSERT INTO trader_token_samples VALUES('sample','entity','solana','token',100,101,0.5,NULL,50,0,0,50,NULL,'unknown','confirmed','included',NULL,101,101)");
    const bundle = readOnlyRowProtectionBundle(path, {
      roots: [{ reference: "legacy-window", reason: "legacy_aggregate_preservation", row: { table: "trader_token_samples", key: { sample_id: "sample" } } }],
    });
    expect(bundle.rows.some((row) => row.table === "trader_token_samples")).toBe(true);
    expect(bundle.declaredDependenciesComplete).toBe(false);
    expect(bundle.issues.some((entry) => entry.code === "legacy_aggregate_requires_per_purchase_reconstruction")).toBe(true);
  }));

  it("preserves all delivery and shared-budget rows, including old cooldowns", () => fixture((database, path) => {
    identity(database);
    database.prepare("INSERT INTO provider_request_gates VALUES('provider',100,200,300)").run();
    database.prepare("INSERT INTO provider_budget_usage VALUES('provider',100,42,300)").run();
    // Model a damaged source snapshot without weakening normal fixture constraints.
    database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("INSERT INTO economic_evidence_consumption VALUES('economic-key','missing-broadcast',100)");
    } finally { database.exec("PRAGMA foreign_keys = ON"); }
    const bundle = readOnlyRowProtectionBundle(path, request("trader_entities", { entity_id: "entity" }));
    expect(bundle.rows.map((row) => row.table)).toEqual(expect.arrayContaining([
      "provider_request_gates", "provider_budget_usage", "economic_evidence_consumption",
    ]));
    expect(bundle.issues.some((entry) => entry.table === "broadcast_records" && entry.code === "missing_required_dependency_row")).toBe(true);
    expect(bundle.globalDeliveryAndBudgetGuardsComplete).toBe(false);
  }));

  it("marks row and byte limits as incomplete and does not read past the preservation budget", () => fixture((database, path) => {
    identity(database); wallet(database); basis(database);
    const query = request("wallet_monitor_execution_bases", { source: "solana_rpc", event_id: "trade" });
    const limitedRows = readOnlyRowProtectionBundle(path, query, { maximumRows: 1 });
    expect(limitedRows.declaredDependenciesComplete).toBe(false);
    expect(limitedRows.rows.length).toBeLessThanOrEqual(1);
    expect(limitedRows.issues.some((entry) => entry.code === "preservation_limit_reached")).toBe(true);
    const limitedBytes = readOnlyRowProtectionBundle(path, query, { maximumBytes: 1 });
    expect(limitedBytes.rows).toHaveLength(0);
    expect(limitedBytes.declaredDependenciesComplete).toBe(false);
  }));

  it("requires complete primary keys and never accepts an unknown source table", () => fixture((database, path) => {
    identity(database); wallet(database); basis(database);
    expect(readOnlyRowProtectionBundle(path, request("wallet_monitor_execution_bases", { event_id: "trade" })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "root_requires_complete_primary_key" })]));
    expect(() => readOnlyRowProtectionBundle(path, request("unknown_table", { id: "1" }))).toThrow("invalid_row_protection_root");
    expect(() => readOnlyRowProtectionBundle(path, request("trader_entities", { entity_id: Number.MAX_SAFE_INTEGER + 1 })))
      .toThrow("invalid_row_protection_root");
  }));

  it("retains exact integer, real, null and payload representations without exposing them in summaries", () => fixture((database, path) => {
    identity(database);
    database.exec("INSERT INTO source_observations VALUES('source-row','fixture','source-event','solana',100,101,1,'secret-raw-payload',0.8,'fixture','private-provenance','fingerprint',1)");
    database.exec("INSERT INTO source_observation_enrichments VALUES('source-row',1,NULL,0.125,9007199254740993,NULL,0.9,101)");
    const before = readFileSync(path);
    const bundle = readOnlyRowProtectionBundle(path, request("source_observations", { observation_id: "source-row" }));
    expect(readFileSync(path).equals(before)).toBe(true);
    const enrichment = bundle.rows.find((row) => row.table === "source_observation_enrichments")!;
    expect(enrichment.values.collected_at).toEqual({ storage: "integer", value: "9007199254740993" });
    expect(enrichment.values.price_usd).toEqual({ storage: "real", value: "0.125" });
    expect(enrichment.values.amount_usd).toEqual({ storage: "null" });
    expect(JSON.stringify(summarizeRowProtectionBundle(bundle))).not.toContain("secret-raw-payload");
    expect(JSON.stringify(summarizeRowProtectionBundle(bundle))).not.toContain("private-review-reference");
    expect(readOnlyRowProtectionBundle(path, request("source_observations", { observation_id: "source-row" })).fingerprint).toBe(bundle.fingerprint);
  }));
});
