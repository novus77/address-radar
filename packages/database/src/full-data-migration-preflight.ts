import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { MigrationCatalogTable } from "./full-data-migration-manifest.js";

const quoteIdentifier = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

export interface ReadOnlyMigrationCatalog {
  capturedAtMs: number;
  catalog: readonly MigrationCatalogTable[];
  ddlFingerprint: string;
  scope: "schema_metadata_only";
  dataCounts: "not_collected";
  readOnly: true;
}

export function readOnlyFullDataMigrationCatalog(databasePath: string): ReadOnlyMigrationCatalog {
  // Reject memory databases and nonexistent paths rather than creating an empty source.
  const path = realpathSync(databasePath);
  if (!statSync(path).isFile()) throw new Error("migration_source_not_regular_file");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100; BEGIN;");
    const rows = database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 201",
    ).all();
    if (rows.length > 200) throw new Error("migration_catalog_table_limit");
    const catalog: MigrationCatalogTable[] = rows.map((row) => {
      const name = String(row.name);
      const columns = database.prepare("PRAGMA table_info(" + quoteIdentifier(name) + ")").all();
      const foreignKeys = database.prepare("PRAGMA foreign_key_list(" + quoteIdentifier(name) + ")").all();
      const indexes = database.prepare("PRAGMA index_list(" + quoteIdentifier(name) + ")").all();
      if (columns.length > 1000 || foreignKeys.length > 1000 || indexes.length > 1000) {
        throw new Error("migration_catalog_shape_limit");
      }
      return {
        name,
        c: columns.map((column) => String(column.name) + ":" + String(column.type) +
          (Number(column.notnull) ? "!" : "") + (Number(column.pk) ? "#" + String(column.pk) : "")),
        fk: foreignKeys.map((key) => String(key.from) + "->" + String(key.table) + "." +
          String(key.to ?? "") + ":" + String(key.on_delete)),
        ix: indexes.map((index) => {
          const parts = database.prepare("PRAGMA index_info(" + quoteIdentifier(String(index.name)) + ")").all();
          return (Number(index.unique) ? "U" : "I") + ":" + (Number(index.partial) ? "P:" : "") +
            parts.map((part) => String(part.name ?? "<expression>")).join(",");
        }),
      };
    });
    const ddlFingerprint = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const capturedAtMs = Date.now();
    database.exec("ROLLBACK;");
    return { capturedAtMs, catalog, ddlFingerprint, scope: "schema_metadata_only", dataCounts: "not_collected", readOnly: true };
  } finally {
    database.close();
  }
}

