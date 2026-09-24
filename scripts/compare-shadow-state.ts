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
const semanticRows = (database: DatabaseSync, table: string): readonly Record<string, unknown>[] => {
  const rows = database.prepare(`SELECT * FROM ${identifier(table)}`).all() as Array<Record<string, unknown>>;
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !excludedColumns.has(key)))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
};
const hash = (rows: readonly Record<string, unknown>[]): string => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

export function compareShadowState(input: { readonly legacy: string; readonly current: string }): ShadowComparisonReport {
  const legacy = new DatabaseSync(resolve(input.legacy), { readOnly: true });
  const current = new DatabaseSync(resolve(input.current), { readOnly: true });
  try {
    const reports = semanticTables.filter(table => exists(legacy, table) && exists(current, table)).map(table => {
      const legacyRows = semanticRows(legacy, table); const currentRows = semanticRows(current, table);
      const legacyHash = hash(legacyRows); const currentHash = hash(currentRows);
      return Object.freeze({ table, legacyCount: legacyRows.length, currentCount: currentRows.length, legacyHash, currentHash, matches: legacyRows.length === currentRows.length && legacyHash === currentHash });
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
