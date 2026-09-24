#!/usr/bin/env bash
set -euo pipefail

database_path="${ADDRESS_RADAR_DATABASE_PATH:-/var/lib/address-radar/address-radar.db}"
backup_root="${ADDRESS_RADAR_BACKUP_DIR:-/var/lib/address-radar/backups}"
retention_days="${ADDRESS_RADAR_BACKUP_RETENTION_DAYS:-14}"
pages_per_step="${ADDRESS_RADAR_BACKUP_PAGES_PER_STEP:-128}"
sleep_ms="${ADDRESS_RADAR_BACKUP_SLEEP_MS:-25}"
timeout_seconds="${ADDRESS_RADAR_BACKUP_TIMEOUT_SECONDS:-1200}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_root}/${timestamp}"
partial="${target}/address-radar.db.partial"
completed="${target}/address-radar.db"

install -d -m 0750 "${target}"
ionice -c2 -n7 nice -n 15 timeout --signal=TERM --kill-after=30s "${timeout_seconds}s" \
  node --input-type=module - "${database_path}" "${partial}" "${pages_per_step}" "${sleep_ms}" <<'NODE'
import { backup, DatabaseSync } from "node:sqlite";
const rate = Number(process.argv[4]);
const sleep = Number(process.argv[5]);
if (!Number.isSafeInteger(rate) || rate < 1 || !Number.isSafeInteger(sleep) || sleep < 0) {
  throw new Error("Backup rate and sleep must be non-negative safe integers");
}
const source = new DatabaseSync(process.argv[2], { readOnly: true });
try { await backup(source, process.argv[3], { rate, sleep }); } finally { source.close(); }
NODE
mv "${partial}" "${completed}"
find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -mtime "+${retention_days}" -exec rm -rf -- {} +
printf '{"status":"ok","backup":"%s"}\n' "${completed}"
