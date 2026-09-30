#!/usr/bin/env bash
set -euo pipefail

database_path="${ADDRESS_RADAR_DATABASE_PATH:-/var/lib/address-radar/address-radar.db}"
backup_root="${ADDRESS_RADAR_BACKUP_DIR:-/var/lib/address-radar/backups}"
retention_days="${ADDRESS_RADAR_BACKUP_RETENTION_DAYS:-14}"
maximum_backups="${ADDRESS_RADAR_BACKUP_MAX_COUNT:-8}"
minimum_free_bytes="${ADDRESS_RADAR_BACKUP_MIN_FREE_BYTES:-3221225472}"
pages_per_step="${ADDRESS_RADAR_BACKUP_PAGES_PER_STEP:-256}"
sleep_ms="${ADDRESS_RADAR_BACKUP_SLEEP_MS:-25}"
timeout_seconds="${ADDRESS_RADAR_BACKUP_TIMEOUT_SECONDS:-300}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_root}/${timestamp}"
partial="${target}/address-radar.db.partial"
completed="${target}/address-radar.db"

for value_name in retention_days maximum_backups minimum_free_bytes pages_per_step timeout_seconds; do
  value="${!value_name}"
  if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Invalid positive integer for %s: %s\n' "${value_name}" "${value}" >&2
    exit 64
  fi
done

if ! [[ "${sleep_ms}" =~ ^[0-9]+$ ]]; then
  printf 'Invalid non-negative integer for sleep_ms: %s\n' "${sleep_ms}" >&2
  exit 64
fi

install -d -m 0750 "${target}"
trap 'rm -f "${partial}"' EXIT

node --input-type=module - "${database_path}" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2]);
try {
  const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (Number(result.busy) !== 0) {
    throw new Error(`WAL checkpoint remained busy: ${JSON.stringify(result)}`);
  }
} finally {
  database.close();
}
NODE

set +e
ionice -c2 -n7 nice -n 15 timeout "${timeout_seconds}" \
  cp --reflink=auto --sparse=always "${database_path}" "${partial}"
copy_status=$?
set -e

if (( copy_status != 0 )); then
  rm -f "${partial}"
  if (( copy_status == 124 || copy_status == 137 )); then
    exit "${copy_status}"
  fi

  ionice -c2 -n7 nice -n 15 timeout "${timeout_seconds}" \
    node --input-type=module - \
      "${database_path}" \
      "${partial}" \
      "${pages_per_step}" \
      "${sleep_ms}" <<'NODE'
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

const sourcePath = process.argv[2];
const targetPath = process.argv[3];
const pagesPerStep = Number.parseInt(process.argv[4], 10);
const sleepMs = Number.parseInt(process.argv[5], 10);

const database = new DatabaseSync(sourcePath, { readOnly: true });
let pageSize;
try {
  pageSize = Number(Object.values(database.prepare("PRAGMA page_size").get())[0]);
} finally {
  database.close();
}

if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
  throw new Error(`Invalid SQLite page size: ${pageSize}`);
}

const chunkSize = pageSize * pagesPerStep;
const source = await open(sourcePath, "r");
const target = await open(targetPath, "wx", 0o640);
let position = 0;

try {
  const buffer = Buffer.allocUnsafe(chunkSize);
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }

    await target.write(buffer, 0, bytesRead, position);
    position += bytesRead;

    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }
  await target.sync();
} finally {
  await Promise.allSettled([source.close(), target.close()]);
}
NODE
fi

node --input-type=module - "${partial}" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const result = database.prepare("PRAGMA quick_check").get();
  if (Object.values(result)[0] !== "ok") {
    throw new Error(`Backup integrity check failed: ${JSON.stringify(result)}`);
  }
} finally {
  database.close();
}
NODE

mv "${partial}" "${completed}"
retention_summary="$(node --input-type=module - \
  "${backup_root}" "${retention_days}" "${maximum_backups}" \
  "${minimum_free_bytes}" "${target}" <<'NODE'
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";

const [rootInput, retentionDaysInput, maximumBackupsInput, minimumFreeBytesInput, protectedInput] = process.argv.slice(2);
const root = resolve(rootInput);
const protectedDirectory = resolve(protectedInput);
const retentionMs = Number(retentionDaysInput) * 24 * 60 * 60_000;
const maximumBackups = Number(maximumBackupsInput);
const minimumFreeBytes = Number(minimumFreeBytesInput);
const now = Date.now();
const entries = await readdir(root, { withFileTypes: true });
const backups = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(root, entry.name);
  try {
    const metadata = await stat(join(directory, "address-radar.db"));
    backups.push({ directory, modifiedAt: metadata.mtimeMs });
  } catch { /* incomplete directories are retained for operator inspection */ }
}
backups.sort((left, right) => right.modifiedAt - left.modifiedAt || left.directory.localeCompare(right.directory));
const removed = [];
for (let index = 0; index < backups.length; index += 1) {
  const backup = backups[index];
  if (backup.directory === protectedDirectory) continue;
  if (index >= maximumBackups || now - backup.modifiedAt > retentionMs) {
    await rm(backup.directory, { recursive: true, force: true });
    removed.push(backup.directory);
  }
}
let remaining = backups.filter(item => !removed.includes(item.directory));
let filesystem = await statfs(root);
let freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
while (freeBytes < minimumFreeBytes && remaining.length > 1) {
  const candidate = [...remaining]
    .filter(item => item.directory !== protectedDirectory)
    .sort((left, right) => left.modifiedAt - right.modifiedAt)[0];
  if (!candidate) break;
  await rm(candidate.directory, { recursive: true, force: true });
  removed.push(candidate.directory);
  remaining = remaining.filter(item => item.directory !== candidate.directory);
  filesystem = await statfs(root);
  freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
}
process.stdout.write(JSON.stringify({ retained: remaining.length, removed, freeBytes }));
NODE
)"
printf '{"status":"ok","backup":"%s","retention":%s}\n' "${completed}" "${retention_summary}"
