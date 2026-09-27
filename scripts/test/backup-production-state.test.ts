import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createWalFixture(rowCount: number) {
  const root = mkdtempSync(join(tmpdir(), "address-radar-backup-"));
  temporaryDirectories.push(root);

  const databasePath = join(root, "address-radar.db");
  const backupRoot = join(root, "backups");
  mkdirSync(backupRoot);

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE observations (
      observation_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    BEGIN IMMEDIATE;
  `);
  const insert = database.prepare(
    "INSERT INTO observations (observation_id, payload) VALUES (?, ?)",
  );
  for (let index = 1; index <= rowCount; index += 1) {
    insert.run(index, `payload-${index}-${"x".repeat(128)}`);
  }
  database.exec("COMMIT");
  return { backupRoot, database, databasePath, root };
}

function createPortableCommandWrappers(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const commands = {
    ionice: "while [[ $1 == -* ]]; do shift; done\nexec \"$@\"\n",
    nice: "if [[ $1 == -n ]]; then shift 2; fi\nexec \"$@\"\n",
    timeout:
      "while [[ $1 == --* ]]; do shift; done\nshift\nexec \"$@\"\n",
  };
  for (const [name, body] of Object.entries(commands)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
    chmodSync(path, 0o755);
  }
  return bin;
}

function findBackups(backupRoot: string, suffix: string) {
  return readdirSync(backupRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => resolve(entry.parentPath, entry.name));
}

describe("backup-production-state", () => {
  it("creates a complete offline snapshot without leaving a partial backup", () => {
    const fixture = createWalFixture(25_000);
    const scriptPath = resolve("scripts/backup-production-state.sh");
    const wrapperBin = createPortableCommandWrappers(fixture.root);

    const result = spawnSync(
      "bash",
      [scriptPath],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          ADDRESS_RADAR_BACKUP_DIR: fixture.backupRoot,
          ADDRESS_RADAR_BACKUP_RETENTION_DAYS: "14",
          ADDRESS_RADAR_DATABASE_PATH: fixture.databasePath,
          PATH: `${wrapperBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const completedFiles = findBackups(fixture.backupRoot, "address-radar.db");
    const partialFiles = findBackups(fixture.backupRoot, ".partial");
    expect(completedFiles).toHaveLength(1);
    expect(partialFiles).toHaveLength(0);

    const backup = new DatabaseSync(completedFiles[0]!, { readOnly: true });
    const count = backup
      .prepare("SELECT COUNT(*) AS count FROM observations")
      .get() as { count: number };
    const quickCheck = backup.prepare("PRAGMA quick_check").get() as Record<string, string>;
    backup.close();

    expect(count.count).toBe(25_000);
    expect(Object.values(quickCheck)[0]).toBe("ok");
    expect(
      !existsSync(`${fixture.databasePath}-wal`) ||
        statSync(`${fixture.databasePath}-wal`).size === 0,
    ).toBe(true);
    fixture.database.close();
  });
});
