import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const semanticTables = ["fomo_accounts", "wallet_identities", "trader_entities", "entity_wallet_identities", "entity_accounts", "trader_events", "candidate_discoveries", "wallet_identity_conflicts", "monitoring_registry", "wallet_analysis_jobs", "token_aggregation_state", "broadcast_records", "signal_outbox"] as const;
const excludedColumns = new Set(["claimed_at", "claim_token", "lease_expires_at", "recorded_at"]);
const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export interface ShadowTableComparison { readonly table: string; readonly legacyCount: number; readonly currentCount: number; readonly legacyHash: string; readonly currentHash: string; readonly matches: boolean }
export interface ShadowComparisonReport { readonly matches: boolean; readonly tables: readonly ShadowTableComparison[] }

const exists = (database: DatabaseSync, table: string): boolean => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const semanticDigest = (database: DatabaseSync, table: string): { readonly count: number; readonly hash: string } => {
  const columns = (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>).map(row => row.name).filter(column => !excludedColumns.has(column));
  const selected = columns.map(identifier).join(", ");
  const hash = createHash("sha256");
  let count = 0;
  for (const row of database.prepare(`SELECT ${selected} FROM ${identifier(table)} ORDER BY ${selected}`).iterate() as Iterable<Record<string, unknown>>) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    count += 1;
  }
  return Object.freeze({ count, hash: hash.digest("hex") });
};

export function compareShadowState(input: { readonly legacy: string; readonly current: string }): ShadowComparisonReport {
  const legacy = new DatabaseSync(resolve(input.legacy), { readOnly: true });
  const current = new DatabaseSync(resolve(input.current), { readOnly: true });
  try {
    const reports = semanticTables.filter(table => exists(legacy, table) && exists(current, table)).map(table => {
      const legacyDigest = semanticDigest(legacy, table); const currentDigest = semanticDigest(current, table);
      return Object.freeze({ table, legacyCount: legacyDigest.count, currentCount: currentDigest.count, legacyHash: legacyDigest.hash, currentHash: currentDigest.hash, matches: legacyDigest.count === currentDigest.count && legacyDigest.hash === currentDigest.hash });
    });
    return Object.freeze({ matches: reports.every(report => report.matches), tables: Object.freeze(reports) });
  } finally { legacy.close(); current.close(); }
}

function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const legacy = argument("--legacy"); const current = argument("--current");
  if (!legacy || !current) throw new Error("Usage: compare-shadow-state.ts --legacy <path> --current <path>");
  const report = compareShadowState({ legacy, current }); console.log(JSON.stringify(report, null, 2)); if (!report.matches) process.exitCode = 1;
}
