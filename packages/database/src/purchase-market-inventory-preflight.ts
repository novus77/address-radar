import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FORWARD_OPPORTUNITY_WINDOW_MS } from "@address-radar/domain";

export interface PurchaseMarketInventoryInput {
  source: string;
  eventId: string;
  asOf: number;
}

export interface ReverseLookupIndexPlan {
  status: "already_covered" | "index_required" | "blocked";
  sourceSchemaFingerprint: string;
  coveringIndexes: readonly string[];
  proposedIndexName: string | null;
  createSql: string | null;
  rollbackSql: string | null;
  currentLookupUsesSearch: boolean;
  productionApprovalRequired: true;
  rollbackRequiresDeploymentOwnership: true;
}

export interface PurchaseMarketInventoryReport {
  scope: "purchase_price_point_inventory_and_index_plan_not_coverage_proof";
  status: "inspected" | "blocked";
  sourceEventFingerprint: string;
  capturedAtMs: number;
  reverseLookup: ReverseLookupIndexPlan;
  window: { from: number; until: number; expiresAt: number; closed: boolean } | null;
  marketInventory: {
    scope: "market_observations_only";
    status: "points_present" | "no_stored_points" | "lookup_blocked";
    pointsRead: number;
    moreRows: boolean;
    matchingRowsEnumerated: boolean;
    firstObservedAt: number | null;
    lastObservedAt: number | null;
    positiveFinitePrices: number;
    invalidPrices: number;
    sourceCounts: readonly { sourceFingerprint: string; rows: number }[];
    pointFingerprint: string;
    publicationKnownAsOfVerified: false;
    marketMappingAndQualityVerified: false;
    independentProviderCoverageVerified: false;
  };
  issues: readonly { code: string; table: string }[];
  sameSnapshotGlobalGuardsVerified: false;
  newPurchaseSamplesCreated: 0;
  newEligibilityGranted: false;
  productionMigrationReady: false;
}

export function readOnlyPurchaseMarketInventoryPreflight(
  databasePath: string, input: PurchaseMarketInventoryInput, limits: { maximumRows?: number } = {},
): PurchaseMarketInventoryReport {
  if (!input || typeof input.source !== "string" || !input.source.trim() ||
      typeof input.eventId !== "string" || !input.eventId.trim() || !Number.isSafeInteger(input.asOf) || input.asOf < 0) {
    throw new Error("invalid_purchase_market_inventory_input");
  }
  const maximumRows = limits.maximumRows ?? 1_000;
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 10_000) {
    throw new Error("invalid_purchase_market_inventory_limits");
  }
  const path = realpathSync(databasePath);
  if (!statSync(path).isFile()) throw new Error("purchase_market_source_not_regular_file");
  const database = new DatabaseSync(path, { readOnly: true });
  const issues: PurchaseMarketInventoryReport["issues"][number][] = [];
  const sourceEventFingerprint = hash([input.source, input.eventId]);
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250; BEGIN;");
    const reverseLookup = inspectReverseLookup(database, issues);
    const observationTable = metadata(database, "wallet_monitor_observations");
    const observationColumns = ["side", "chain", "token_address", "occurred_at", "collected_at", "orphaned_at"];
    let window: PurchaseMarketInventoryReport["window"] = null;
    let chain: string | null = null;
    let token: string | null = null;
    const observationIndex = observationTable && findIndex(observationTable, ["source", "event_id"]);
    if (!observationTable || observationColumns.some(name => !observationTable.columns.some(column => column.name === name))) {
      issues.push({ code: "purchase_observation_schema_unreviewed", table: "wallet_monitor_observations" });
    } else if (!observationIndex) {
      issues.push({ code: "purchase_observation_lookup_index_unavailable", table: "wallet_monitor_observations" });
    } else {
      const statement = database.prepare(`SELECT side,chain,token_address,occurred_at,collected_at,orphaned_at
        FROM wallet_monitor_observations INDEXED BY ${quote(observationIndex.name)} WHERE source=? AND event_id=? LIMIT 2`);
      statement.setReadBigInts(true);
      const observations = statement.all(input.source, input.eventId);
      if (observations.length !== 1) {
        issues.push({ code: "purchase_observation_missing", table: "wallet_monitor_observations" });
      } else {
        const observation = observations[0]!;
        const boughtAt = clock(observation.occurred_at);
        const collectedAt = clock(observation.collected_at);
        const expiresAt = boughtAt === null ? null : boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS;
        if (observation.side !== "buy" || observation.orphaned_at !== null || boughtAt === null || collectedAt === null ||
            expiresAt === null || !Number.isSafeInteger(expiresAt) || typeof observation.chain !== "string" ||
            !observation.chain.trim() || typeof observation.token_address !== "string" || !observation.token_address.trim()) {
          issues.push({ code: "purchase_observation_unreviewed", table: "wallet_monitor_observations" });
        } else if (boughtAt > input.asOf || collectedAt > input.asOf) {
          issues.push({ code: "purchase_observation_not_known_as_of", table: "wallet_monitor_observations" });
        } else {
          chain = observation.chain; token = observation.token_address;
          window = { from: boughtAt, until: Math.min(input.asOf, expiresAt), expiresAt, closed: input.asOf >= expiresAt };
        }
      }
    }
    const marketInventory = inventoryPoints(database, chain, token, window, maximumRows, sourceEventFingerprint, issues);
    const report: PurchaseMarketInventoryReport = {
      scope: "purchase_price_point_inventory_and_index_plan_not_coverage_proof",
      status: issues.length ? "blocked" : "inspected", sourceEventFingerprint, capturedAtMs: Date.now(),
      reverseLookup, window, marketInventory, issues,
      sameSnapshotGlobalGuardsVerified: false, newPurchaseSamplesCreated: 0, newEligibilityGranted: false, productionMigrationReady: false,
    };
    database.exec("ROLLBACK;");
    return report;
  } finally { database.close(); }
}

interface IndexShape {
  name: string;
  partial: boolean;
  parts: readonly { name: string | null; cid: number; collation: string; descending: boolean }[];
}
interface TableMetadata {
  sql: string;
  columns: readonly { name: string; type: string; notNull: boolean; primaryKey: number }[];
  indexes: readonly IndexShape[];
}
type Issue = PurchaseMarketInventoryReport["issues"][number];
const INDEX_NAME = "idx_canonical_trader_event_observations_observation_id";
const LINK_TABLE = "canonical_trader_event_observations";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

function clock(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "bigint") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function metadata(database: DatabaseSync, table: string): TableMetadata | null {
  const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
  if (typeof schema?.sql !== "string" || !/^CREATE\s+TABLE\b/i.test(schema.sql.trim())) return null;
  const columns = database.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => ({
    name: String(column.name), type: String(column.type).toUpperCase(), notNull: Number(column.notnull) === 1, primaryKey: Number(column.pk),
  }));
  const indexes = database.prepare(`PRAGMA index_list(${quote(table)})`).all().map(index => ({
    name: String(index.name), partial: Number(index.partial) !== 0,
    parts: database.prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`).all()
      .filter(part => Number(part.key) === 1).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map(part => ({
        name: typeof part.name === "string" ? part.name : null, cid: Number(part.cid),
        collation: String(part.coll).toUpperCase(), descending: Number(part.desc) !== 0,
      })),
  }));
  return { sql: schema.sql, columns, indexes };
}

function findIndex(table: TableMetadata, prefix: readonly string[]): IndexShape | null {
  return table.indexes.find(index => !index.partial && prefix.every((name, position) => {
    const part = index.parts[position];
    return part?.name === name && part.cid >= 0 && part.collation === "BINARY" && !part.descending;
  })) ?? null;
}

function inspectReverseLookup(database: DatabaseSync, issues: Issue[]): ReverseLookupIndexPlan {
  const table = metadata(database, LINK_TABLE);
  const plan: ReverseLookupIndexPlan = {
    status: "blocked", sourceSchemaFingerprint: hash(table), coveringIndexes: [],
    proposedIndexName: null, createSql: null, rollbackSql: null, currentLookupUsesSearch: false,
    productionApprovalRequired: true, rollbackRequiresDeploymentOwnership: true,
  };
  const expected = [{ name: "canonical_event_id", primaryKey: 1 }, { name: "observation_id", primaryKey: 2 }];
  if (!table || table.columns.length !== 2 || expected.some(column => !table.columns.some(actual =>
    actual.name === column.name && actual.type === "TEXT" && actual.notNull && actual.primaryKey === column.primaryKey))) {
    issues.push({ code: "reverse_link_schema_unreviewed", table: LINK_TABLE }); return plan;
  }
  const coveringIndexes = table.indexes.filter(index => findIndex({ ...table, indexes: [index] }, ["observation_id"]) !== null)
    .map(index => index.name).sort();
  const queryPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT canonical_event_id,observation_id FROM ${quote(LINK_TABLE)} WHERE observation_id=? LIMIT 2`)
    .all("read-only-plan-placeholder");
  const currentLookupUsesSearch = queryPlan.some(row => typeof row.detail === "string" && /^SEARCH\s/i.test(row.detail));
  if (coveringIndexes.length) return { ...plan, status: "already_covered", coveringIndexes, currentLookupUsesSearch };
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(INDEX_NAME)) {
    issues.push({ code: "reverse_index_name_collision", table: LINK_TABLE }); return { ...plan, currentLookupUsesSearch };
  }
  return { ...plan, status: "index_required", currentLookupUsesSearch, proposedIndexName: INDEX_NAME,
    createSql: `CREATE INDEX ${quote(INDEX_NAME)} ON ${quote(LINK_TABLE)} ("observation_id", "canonical_event_id");`,
    rollbackSql: `DROP INDEX ${quote(INDEX_NAME)};` };
}

function typedValue(value: unknown): unknown {
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "number") return ["real", Object.is(value, -0) ? "-0" : value.toString()];
  if (typeof value === "string") return ["text", value];
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
  return ["null"];
}

function inventoryPoints(
  database: DatabaseSync, chain: string | null, token: string | null,
  window: PurchaseMarketInventoryReport["window"], maximumRows: number, sourceEventFingerprint: string, issues: Issue[],
): PurchaseMarketInventoryReport["marketInventory"] {
  const pointDigest = createHash("sha256").update(JSON.stringify(["market_observations_only", sourceEventFingerprint, window]));
  const empty: PurchaseMarketInventoryReport["marketInventory"] = {
    scope: "market_observations_only", status: "lookup_blocked", pointsRead: 0, moreRows: false, matchingRowsEnumerated: false,
    firstObservedAt: null, lastObservedAt: null, positiveFinitePrices: 0, invalidPrices: 0, sourceCounts: [],
    pointFingerprint: pointDigest.copy().digest("hex"), publicationKnownAsOfVerified: false,
    marketMappingAndQualityVerified: false, independentProviderCoverageVerified: false,
  };
  if (chain === null || token === null || window === null) return empty;
  const table = metadata(database, "market_observations");
  const expected = { chain: "TEXT", token_address: "TEXT", observed_at: "INTEGER", price_usd: "REAL", source: "TEXT" };
  if (!table || Object.entries(expected).some(([name, type]) => !table.columns.some(column => column.name === name && column.type === type && column.notNull))) {
    issues.push({ code: "market_schema_unreviewed", table: "market_observations" }); return empty;
  }
  const index = findIndex(table, ["chain", "token_address", "observed_at", "source"]);
  if (!index) { issues.push({ code: "market_lookup_index_unavailable", table: "market_observations" }); return empty; }
  const sql = `SELECT observed_at,price_usd,source FROM market_observations INDEXED BY ${quote(index.name)}
    WHERE chain=? AND token_address=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at,source LIMIT ?`;
  const parameters = [chain, token, window.from, window.until, maximumRows + 1] as const;
  const queryPlan = database.prepare("EXPLAIN QUERY PLAN " + sql).all(...parameters);
  if (!queryPlan.some(row => typeof row.detail === "string" && /^SEARCH\s/i.test(row.detail)) ||
      queryPlan.some(row => typeof row.detail === "string" && /TEMP B-TREE|^SCAN\s/i.test(row.detail))) {
    issues.push({ code: "market_lookup_plan_unbounded", table: "market_observations" }); return empty;
  }
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  let pointsRead = 0; let moreRows = false; let positiveFinitePrices = 0; let invalidPrices = 0;
  let firstObservedAt: number | null = null; let lastObservedAt: number | null = null;
  const sourceCounts = new Map<string, number>();
  for (const row of statement.iterate(...parameters)) {
    if (pointsRead === maximumRows) { moreRows = true; break; }
    pointsRead++;
    const observedAt = clock(row.observed_at);
    if (observedAt === null) issues.push({ code: "market_point_clock_unreviewed", table: "market_observations" });
    else { firstObservedAt ??= observedAt; lastObservedAt = observedAt; }
    if (typeof row.price_usd === "number" && Number.isFinite(row.price_usd) && row.price_usd > 0) positiveFinitePrices++;
    else invalidPrices++;
    const sourceFingerprint = hash(typedValue(row.source));
    sourceCounts.set(sourceFingerprint, (sourceCounts.get(sourceFingerprint) ?? 0) + 1);
    pointDigest.update(JSON.stringify([typedValue(row.observed_at), typedValue(row.price_usd), typedValue(row.source)]));
  }
  return { ...empty, status: pointsRead ? "points_present" : "no_stored_points", pointsRead, moreRows,
    matchingRowsEnumerated: !moreRows, firstObservedAt, lastObservedAt, positiveFinitePrices, invalidPrices,
    sourceCounts: [...sourceCounts].sort(([a], [b]) => a.localeCompare(b)).map(([sourceFingerprint, rows]) => ({ sourceFingerprint, rows })),
    pointFingerprint: pointDigest.digest("hex") };
}
