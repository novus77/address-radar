#!/bin/bash
set -euo pipefail
archive=$1
release_name=$2
scp -o BatchMode=yes -o ConnectTimeout=10 "$archive" ubuntu@152.32.185.240:/tmp/address-radar-tested-release.tar.gz
ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@152.32.185.240 "sudo -n bash -s -- '$release_name'" <<'REMOTE'
set -euo pipefail
name=$1
previous=$(readlink -f /opt/address-radar/current)
release=/opt/address-radar/releases/$name
[ ! -e "$release" ]
[ "$(df -B1 --output=avail / | tail -1 | tr -d ' ')" -gt 3000000000 ]
services=(address-radar-scanner address-radar-automation address-radar-wallet-monitor address-radar-wallet-analysis address-radar-historical-backfill address-radar-console)
for service in "${services[@]}"; do
  pid=$(systemctl show "$service.service" -p MainPID --value)
  [ "$pid" -gt 0 ]
  tr '\0' '\n' </proc/"$pid"/environ | grep -q '^ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false$'
done
install -d -o address-radar -g address-radar "$release"
tar -xzf /tmp/address-radar-tested-release.tar.gz -C "$release"
cp -al "$previous/node_modules" "$release/node_modules"
for manifest in "$release"/packages/*/package.json "$release"/apps/*/package.json "$release"/contracts/*/package.json; do
  relative=${manifest#"$release"/}; directory=${relative%/package.json}
  if [ -d "$previous/$directory/node_modules" ]; then cp -a "$previous/$directory/node_modules" "$release/$directory/node_modules"; fi
done
chown -R address-radar:address-radar "$release"
sudo -u address-radar bash -c 'cd "$1"; pnpm build' -- "$release" >"/tmp/address-radar-$name-build.log" 2>&1
sudo -u address-radar bash -c 'cd "$1"; ADDRESS_RADAR_DATABASE_PATH=/var/lib/address-radar/address-radar.db ./node_modules/.bin/tsx scripts/migrate-wallet-execution-basis.ts' -- "$release"
printf '%s\n' "$previous" > "$release/previous-release.txt"
rollback() {
  ln -s "$previous" "/opt/address-radar/.rollback-$name"
  mv -Tf "/opt/address-radar/.rollback-$name" /opt/address-radar/current
  for service in "${services[@]}"; do systemctl restart "$service.service"; sleep 1; done
}
trap 'rollback' ERR
ln -s "$release" "/opt/address-radar/.next-$name"
mv -Tf "/opt/address-radar/.next-$name" /opt/address-radar/current
for service in "${services[@]}"; do systemctl restart "$service.service"; sleep 1; done
healthy=false
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 15 http://127.0.0.1:3214/api/v2/operations/data-flow >"/tmp/address-radar-$name-acceptance.json"; then healthy=true; break; fi
  sleep 2
done
[ "$healthy" = true ]
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1],"utf8"));if(r.schemaVersion!=="data-flow-v1")throw Error("Invalid diagnostics");console.log(JSON.stringify({schema:r.schemaVersion,traders:r.ability.evaluatedTraders,chains:r.walletMonitoring.rows.length}));' "/tmp/address-radar-$name-acceptance.json"
for service in "${services[@]}"; do
  systemctl is-active --quiet "$service.service"
  pid=$(systemctl show "$service.service" -p MainPID --value)
  tr '\0' '\n' </proc/"$pid"/environ | grep -q '^ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false$'
  systemctl show "$service.service" -p Id -p ActiveState -p NRestarts
done
python3 - <<'PY'
import sqlite3
connection = sqlite3.connect('file:/var/lib/address-radar/address-radar.db?mode=ro', uri=True)
columns = [row[1] for row in connection.execute('PRAGMA table_info(wallet_monitor_execution_bases)')]
assert columns == ['source', 'event_id', 'basis_json', 'updated_at'], columns
connection.close()
print('execution basis schema: verified')
PY
[ "$(df -B1 --output=avail / | tail -1 | tr -d ' ')" -gt 3000000000 ]
trap - ERR
readlink -f /opt/address-radar/current
REMOTE
