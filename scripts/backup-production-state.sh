#!/usr/bin/env bash
set -euo pipefail

database_path="${ADDRESS_RADAR_DATABASE_PATH:-/var/lib/address-radar/address-radar.db}"
backup_root="${ADDRESS_RADAR_BACKUP_DIR:-/var/lib/address-radar/backups}"
retention_days="${ADDRESS_RADAR_BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_root}/${timestamp}"

install -d -m 0750 "${target}"
sqlite3 "${database_path}" ".backup '${target}/address-radar.db'"
find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -mtime "+${retention_days}" -exec rm -rf -- {} +
printf '{"status":"ok","backup":"%s"}\n' "${target}/address-radar.db"
