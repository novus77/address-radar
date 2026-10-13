#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run on the private fixture host only. Never modify production resource settings.
if [[ $# != 2 ]]; then
  printf '%s\n' 'Usage: run-full-preservation-rehearsal.sh /absolute/private/config.json external-config-sha256' >&2
  exit 2
fi
: "${NODE_BINARY:?Explicit Node 24 binary required}"
: "${TSX_IMPORT:?Explicit reviewed tsx loader required}"
[[ "${NODE_BINARY}" = /* && "${TSX_IMPORT}" = /* && "$1" = /* ]]
command -v ionice >/dev/null
command -v nice >/dev/null
command -v timeout >/dev/null
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec ionice -c3 nice -n19 timeout --signal=TERM --kill-after=10s 3600s \
  "${NODE_BINARY}" --max-old-space-size=96 --import "${TSX_IMPORT}" \
  "${script_dir}/rehearse-postgres-full-preservation.ts" --config "$1" --config-sha256 "$2"
