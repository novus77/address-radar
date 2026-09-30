#!/bin/sh
set -eu

collector_dir=/var/lib/fomo-radar/data
radar_dir=/var/lib/address-radar/fomo
status_file="$radar_dir/fomo-sync-status.json"

install -d -m 0750 -o address-radar -g address-radar "$radar_dir"

append_with_cursor() {
  source_file="$1"
  target_file="$2"
  cursor_file="$3"
  owner="$4"
  group="$5"
  sync_source_size=0
  sync_appended_bytes=0
  sync_cursor_offset=0
  [ -f "$source_file" ] || return 0

  source_size=$(stat -c '%s' "$source_file")
  offset=0
  if [ -f "$cursor_file" ]; then offset=$(cat "$cursor_file"); fi
  case "$offset" in *[!0-9]*|'') offset=0 ;; esac
  if [ "$source_size" -lt "$offset" ]; then offset=0; fi
  sync_source_size="$source_size"
  sync_cursor_offset="$offset"

  if [ "$source_size" -gt "$offset" ]; then
    sync_appended_bytes=$((source_size - offset))
    touch "$target_file"
    tail -c "+$((offset + 1))" "$source_file" >> "$target_file"
    chown "$owner:$group" "$target_file"
    chmod 0640 "$target_file"
  fi

  temporary_cursor="${cursor_file}.tmp.$$"
  printf '%s\n' "$source_size" > "$temporary_cursor"
  chown address-radar:address-radar "$temporary_cursor"
  chmod 0640 "$temporary_cursor"
  mv -f "$temporary_cursor" "$cursor_file"
}

append_with_cursor \
  "$collector_dir/fomo-token-lookup-results.jsonl" \
  "$radar_dir/token-lookup-results.ndjson" \
  "$radar_dir/.result-sync.cursor" \
  address-radar address-radar
result_source_size="$sync_source_size"
result_bytes_copied="$sync_appended_bytes"
result_previous_offset="$sync_cursor_offset"

append_with_cursor \
  "$radar_dir/token-lookups.ndjson" \
  "$collector_dir/fomo-token-lookups.jsonl" \
  "$radar_dir/.request-sync.cursor" \
  ubuntu ubuntu
request_source_size="$sync_source_size"
request_bytes_copied="$sync_appended_bytes"
request_previous_offset="$sync_cursor_offset"

generated_at_ms=$(($(date +%s) * 1000))
temporary_status="${status_file}.tmp.$$"
printf '{\n  "generatedAt": %s,\n  "requestSourceSize": %s,\n  "requestPreviousOffset": %s,\n  "requestBytesCopied": %s,\n  "resultSourceSize": %s,\n  "resultPreviousOffset": %s,\n  "resultBytesCopied": %s\n}\n' \
  "$generated_at_ms" \
  "$request_source_size" \
  "$request_previous_offset" \
  "$request_bytes_copied" \
  "$result_source_size" \
  "$result_previous_offset" \
  "$result_bytes_copied" > "$temporary_status"
chown address-radar:address-radar "$temporary_status"
chmod 0640 "$temporary_status"
mv -f "$temporary_status" "$status_file"
