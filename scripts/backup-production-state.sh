#!/usr/bin/env bash
set -euo pipefail

database_path="${ADDRESS_RADAR_DATABASE_PATH:-/var/lib/address-radar/address-radar.db}"
backup_root="${ADDRESS_RADAR_BACKUP_DIR:-/var/lib/address-radar/backups}"
retention_days="${ADDRESS_RADAR_BACKUP_RETENTION_DAYS:-14}"
pages_per_step="${ADDRESS_RADAR_BACKUP_PAGES_PER_STEP:-256}"
sleep_ms="${ADDRESS_RADAR_BACKUP_SLEEP_MS:-25}"
timeout_seconds="${ADDRESS_RADAR_BACKUP_TIMEOUT_SECONDS:-300}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_root}/${timestamp}"
partial="${target}/address-radar.db.partial"
completed="${target}/address-radar.db"

for value_name in retention_days pages_per_step timeout_seconds; do
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
find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -mtime "+${retention_days}" -exec rm -rf -- {} +
printf '{"status":"ok","backup":"%s"}\n' "${completed}"
