import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { initializeAddressRadarSchema } from "../packages/database/src/schema.js";

export interface LegacyImportReport { readonly dryRun: boolean; readonly sourceChecksum: string; readonly tableCounts: Readonly<Record<string, number>> }

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const tables = (database: DatabaseSync, schema = "main"): readonly string[] => (database.prepare(`SELECT name FROM ${identifier(schema)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map(row => row.name);
const columns = (database: DatabaseSync, table: string, schema = "main"): readonly string[] => (database.prepare(`PRAGMA ${identifier(schema)}.table_info(${identifier(table)})`).all() as Array<{ name: string }>).map(row => row.name);

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function importLegacyState(input: { readonly source: string; readonly target: string; readonly dryRun?: boolean }): Promise<LegacyImportReport> {
  const sourcePath = resolve(input.source);
  const targetPath = resolve(input.target);
  if (sourcePath === targetPath) throw new Error("Source and target database paths must differ");
  const sourceChecksum = await checksum(sourcePath);
  const target = new DatabaseSync(input.dryRun ? ":memory:" : targetPath);
  try {
    initializeAddressRadarSchema(target);
    target.exec("CREATE TABLE IF NOT EXISTS migration_audit(source_checksum TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, table_counts TEXT NOT NULL) STRICT");
    target.prepare("ATTACH DATABASE ? AS legacy").run(sourcePath);
    const targetTables = new Set(tables(target));
    const tableCounts: Record<string, number> = {};
    try {
      const plans = tables(target, "legacy").flatMap(table => {
        if (!targetTables.has(table) || table === "migration_audit") return [];
        const targetColumns = new Set(columns(target, table));
        const sharedColumns = columns(target, table, "legacy").filter(column => targetColumns.has(column));
        if (sharedColumns.length === 0) return [];
        const count = Number((target.prepare(`SELECT COUNT(*) AS count FROM legacy.${identifier(table)}`).get() as { count: number | bigint }).count);
        tableCounts[table] = count;
        return [{ table, sharedColumns }];
      });
      if (!input.dryRun) {
        target.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
        try {
          for (const { table, sharedColumns } of plans) {
            const selected = sharedColumns.map(identifier).join(", ");
            target.exec(`INSERT OR IGNORE INTO main.${identifier(table)} (${selected}) SELECT ${selected} FROM legacy.${identifier(table)}`);
          }
          target.prepare("INSERT OR REPLACE INTO migration_audit(source_checksum, imported_at, table_counts) VALUES (?, ?, ?)").run(sourceChecksum, Date.now(), JSON.stringify(tableCounts));
          target.exec("COMMIT; PRAGMA foreign_keys = ON");
        } catch (error) {
          target.exec("ROLLBACK; PRAGMA foreign_keys = ON");
          throw error;
        }
      }
    } catch (error) {
      throw error;
    } finally {
      target.exec("DETACH DATABASE legacy");
    }
    return Object.freeze({ dryRun: input.dryRun ?? false, sourceChecksum, tableCounts: Object.freeze(tableCounts) });
  } finally { target.close(); }
}

function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = argument("--source"); const target = argument("--target");
  if (!source || !target) throw new Error("Usage: import-legacy-state.ts --source <path> --target <path> [--dry-run]");
  console.log(JSON.stringify(await importLegacyState({ source, target, dryRun: process.argv.includes("--dry-run") }), null, 2));
}
