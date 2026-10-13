#!/usr/bin/env bash
set -euo pipefail
umask 077

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

install -d -m 0750 "${backup_root}"
mkdir -m 0750 "${target}"
trap 'rm -f "${partial}"' EXIT
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ionice -c2 -n7 nice -n 15 timeout "${timeout_seconds}" \
  python3 "${script_dir}/consistent-sqlite-migration.py" snapshot \
    --source "${database_path}" --target "${partial}" \
    --operation-id "backup-${timestamp}" \
    --deadline-seconds "${timeout_seconds}" \
    --minimum-free-bytes "${minimum_free_bytes}" \
    --pages-per-step "${pages_per_step}" --sleep-ms "${sleep_ms}" > "${target}/snapshot.json"

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
  // Migration/maintenance artifacts are not ordinary scheduled backup candidates.
  if (!/^\d{8}T\d{6}Z$/.test(entry.name)) continue;
  const directory = resolve(root, entry.name);
  const protectedMarkers = ["maintenance.json", "manifest.json", "migration-protection.json"];
  let protectedArtifact = false;
  for (const marker of protectedMarkers) {
    try { await stat(join(directory, marker)); protectedArtifact = true; } catch { /* absent marker */ }
  }
  if (protectedArtifact) continue;
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
