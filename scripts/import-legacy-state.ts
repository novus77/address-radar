import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { initializeAddressRadarSchema } from "../packages/database/src/schema.js";

export interface LegacyImportReport { readonly dryRun: boolean; readonly sourceChecksum: string; readonly tableCounts: Readonly<Record<string, number>> }

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const tables = (database: DatabaseSync): readonly string[] => (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
const columns = (database: DatabaseSync, table: string): readonly string[] => (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>).map(row => row.name);

export async function importLegacyState(input: { readonly source: string; readonly target: string; readonly dryRun?: boolean }): Promise<LegacyImportReport> {
  const sourcePath = resolve(input.source);
  const targetPath = resolve(input.target);
  if (sourcePath === targetPath) throw new Error("Source and target database paths must differ");
  const sourceChecksum = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(input.dryRun ? ":memory:" : targetPath);
  try {
    initializeAddressRadarSchema(target);
    target.exec("CREATE TABLE IF NOT EXISTS migration_audit(source_checksum TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, table_counts TEXT NOT NULL) STRICT");
    const targetTables = new Set(tables(target));
    const tableCounts: Record<string, number> = {};
    target.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      for (const table of tables(source)) {
        if (!targetTables.has(table) || table === "migration_audit") continue;
        const targetColumns = new Set(columns(target, table));
        const sharedColumns = columns(source, table).filter(column => targetColumns.has(column));
        if (sharedColumns.length === 0) continue;
        const selected = sharedColumns.map(identifier).join(", ");
        const rows = source.prepare(`SELECT ${selected} FROM ${identifier(table)}`).all() as Array<Record<string, unknown>>;
        const placeholders = sharedColumns.map(() => "?").join(", ");
        const insert = target.prepare(`INSERT OR IGNORE INTO ${identifier(table)} (${selected}) VALUES (${placeholders})`);
        for (const row of rows) insert.run(...sharedColumns.map(column => row[column] as never));
        tableCounts[table] = rows.length;
      }
      target.prepare("INSERT OR REPLACE INTO migration_audit(source_checksum, imported_at, table_counts) VALUES (?, ?, ?)").run(sourceChecksum, Date.now(), JSON.stringify(tableCounts));
      target.exec("COMMIT; PRAGMA foreign_keys = ON");
    } catch (error) {
      target.exec("ROLLBACK; PRAGMA foreign_keys = ON");
      throw error;
    }
    return Object.freeze({ dryRun: input.dryRun ?? false, sourceChecksum, tableCounts: Object.freeze(tableCounts) });
  } finally { source.close(); target.close(); }
}

function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = argument("--source"); const target = argument("--target");
  if (!source || !target) throw new Error("Usage: import-legacy-state.ts --source <path> --target <path> [--dry-run]");
  console.log(JSON.stringify(await importLegacyState({ source, target, dryRun: process.argv.includes("--dry-run") }), null, 2));
}
