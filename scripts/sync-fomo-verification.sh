#!/bin/sh
set -eu

collector_dir=/var/lib/fomo-radar/data
radar_dir=/var/lib/address-radar/fomo

install -d -m 0750 -o address-radar -g address-radar "$radar_dir"

append_with_cursor() {
  source_file="$1"
  target_file="$2"
  cursor_file="$3"
  owner="$4"
  group="$5"
  [ -f "$source_file" ] || return

  source_size=$(stat -c '%s' "$source_file")
  offset=0
  if [ -f "$cursor_file" ]; then offset=$(cat "$cursor_file"); fi
  case "$offset" in *[!0-9]*|'') offset=0 ;; esac
  if [ "$source_size" -lt "$offset" ]; then offset=0; fi

  if [ "$source_size" -gt "$offset" ]; then
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

append_with_cursor \
  "$radar_dir/token-lookups.ndjson" \
  "$collector_dir/fomo-token-lookups.jsonl" \
  "$radar_dir/.request-sync.cursor" \
  ubuntu ubuntu
