#!/bin/sh
set -eu
repo=${ADDRESS_RADAR_FIXTURE_REPO:?fixture repository required}
bundle=${ADDRESS_RADAR_RECOVERY_BUNDLE:?formal fixture bundle required}
import_cli=${ADDRESS_RADAR_FIXTURE_IMPORT:?formal source import CLI required}
probe_cli=${ADDRESS_RADAR_FIXTURE_PROBE:?formal source probe CLI required}
release=${ADDRESS_RADAR_FIXTURE_RELEASE:-/private/tmp/source-fixture-release-20261011}
generator=${ADDRESS_RADAR_FIXTURE_GENERATOR:-/private/tmp/source-fixture-waiting-generator-20261011.mjs}
scope=/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef
name=radar-execute-fixture-$$
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    docker exec "$name" sh -c 'cat /tmp/postgres.log; cat /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/pids.events /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max' || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$name" --network none --memory 3g --cpus 1 --pids-limit 512 \
 --env "SYSTEMD_UNIT_PATH=$scope/units:/etc/systemd/system:/usr/lib/systemd/system:/lib/systemd/system" \
 --tmpfs /var/lib/postgresql/data:rw,uid=999,gid=999,mode=0700 --cgroupns private \
 --cap-add SYS_ADMIN --cap-add SYS_PTRACE --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
 --security-opt no-new-privileges --entrypoint /bin/sh address-radar-source-execute-isolated:node24-20261011 \
 -ec 'mount -o remount,rw /sys/fs/cgroup; exec /sbin/init --log-target=console --log-level=warning' >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break;; esac
  sleep 1
done
docker exec "$name" mkdir -p "$scope/tools/scripts/test" "$scope/bin" "$scope/units"
host_namespaces=$(docker run --rm --network none --pid host --read-only --cap-drop ALL --cap-add SYS_PTRACE --memory 32m --pids-limit 16 --entrypoint /bin/sh address-radar-source-execute-isolated:node24-20261011 -ec 'for name in pid mnt net; do readlink /proc/1/ns/$name; done')
docker exec -i "$name" sh -c 'cat > /tmp/fixture-host-namespaces' <<EOF
$host_namespaces
EOF
container_id=$(docker inspect --format '{{.Id}}' "$name")
docker exec -i "$name" env -u SYSTEMD_UNIT_PATH python3 - "$container_id" "$scope" <<'PY'
import json,os,re,sys
from pathlib import Path
container_id,scope=sys.argv[1:]
assert re.fullmatch('[a-f0-9]{64}',container_id)
names=('pid','mnt','net')
host=Path('/tmp/fixture-host-namespaces').read_text().splitlines()
assert len(host)==3
proof={'protocol':'address-only-disposable-launch-v1','containerId':container_id,
       'machineId':Path('/etc/machine-id').read_text().strip(),
       'namespaces':{name:os.readlink('/proc/self/ns/'+name) for name in names},
       'hostNamespaces':dict(zip(names,host))}
path=Path(scope)/'runtime-proof.json'
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as output:json.dump(proof,output,sort_keys=True)
PY
for file in address-only-native-fence.py address-only-pg-reconcile.py activate-address-only-postgres.py run-address-only-native-controller.py execute-pg-source-replacement.py rotate-address-only-migrator.py activate-production-postgres-migrator.py source-replacement-controller-adapter.py run-pg-source-replacement.py pg-source-replacement-fence.py activate-address-only-configured.py; do
 docker cp "$repo/scripts/$file" "$name:$scope/tools/scripts/"
done
docker cp "$repo/scripts/test/execute-source-complete-job-fixture.py" "$name:$scope/tools/scripts/test/"
docker cp "$repo/scripts/test/scope-source-controller-fixture.py" "$name:$scope/tools/scripts/test/"
docker cp "$repo/scripts/test/prepare-source-execute-native-environment.py" "$name:$scope/tools/scripts/test/"
docker cp "$repo/scripts/test/execute-source-native-recovery.test.py" "$name:$scope/tools/scripts/test/"
docker cp "$release" "$name:$scope/release"
docker cp "$generator" "$name:$scope/tools/waiting-generator.mjs"
docker cp "$bundle" "$name:$scope/tools/fixture.mjs"
docker cp "$import_cli" "$name:$scope/tools/import.mjs"
docker cp "$probe_cli" "$name:$scope/tools/probe.mjs"
docker cp /private/tmp/execute-source-material-fixture-20261011g.mjs "$name:$scope/tools/materials.mjs"
docker cp /private/tmp/execute-source-preflight-fixture-20261011a.mjs "$name:$scope/tools/preflight.mjs"
docker exec "$name" sh -ec '
scope=/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef
chown -R root:root "$scope"; chmod 755 "$scope" "$scope/units" "$scope/bin"; chmod 700 "$scope/tools"
cp /usr/bin/sleep "$scope/bin/sleep"; cp /usr/local/bin/node "$scope/bin/node"; cp /usr/bin/python3 "$scope/bin/python3"
chmod 555 "$scope/bin/python3" "$scope/bin/sleep" "$scope/bin/node" "$scope/release" "$scope/release/scripts"
# Docker VM tmpfs lacks socket POSIX ACLs. Bind only the private container overlay
# overlay directory at the unchanged controller path; never mount host data.
install -d -m 0711 "$scope/socket-runtime" /run/address-radar-activation
mount --bind "$scope/socket-runtime" /run/address-radar-activation
chmod 444 "$scope/release/pg.mjs" "$scope/release/scripts/"*.mjs
printf "FIXTURE_ONLY=true\n" > "$scope/initial.env"; chmod 644 "$scope/initial.env"
chmod 600 "$scope/tools/waiting-generator.mjs" "$scope/tools/fixture.mjs"; chmod 600 "$scope/tools/scripts/activate-production-postgres-migrator.py"
chmod 600 "$scope/tools/probe.mjs" "$scope/tools/materials.mjs"; chmod 444 "$scope/tools/import.mjs" "$scope/tools/preflight.mjs"
test "$("$scope/bin/node" --version)" = v24.19.0
useradd --system --no-create-home address-radar
useradd --system --no-create-home address-radar-wallet
install -d -o postgres -g postgres /run/postgresql
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/data --auth-local=peer --auth-host=scram-sha-256 >/dev/null
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/data -l /tmp/postgres.log -w start >/dev/null
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -c "CREATE ROLE radar_migrator_0123456789abcdef LOGIN NOINHERIT CONNECTION LIMIT 1 PASSWORD '\''isolated-fixture-password'\'';" -c "CREATE DATABASE radar_rehearsal_0123456789abcdef OWNER radar_migrator_0123456789abcdef;"
runuser -u postgres -- psql -X -d radar_rehearsal_0123456789abcdef -v ON_ERROR_STOP=1 -c "GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO radar_migrator_0123456789abcdef;"
for service in scanner automation wallet_monitor wallet_analysis historical_backfill console; do
 runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -c "CREATE ROLE radar_0123456789abcdef_$service LOGIN NOINHERIT CONNECTION LIMIT 1 PASSWORD '\''isolated-password'\'';" >/dev/null
done
"$scope/bin/node" "$scope/tools/fixture.mjs" --schema-fingerprint > /tmp/schema-fingerprint
runuser -u postgres -- psql -X -At -c "SELECT system_identifier FROM pg_catalog.pg_control_system()" > /tmp/systemid
"$scope/bin/node" --input-type=module -e '\''import fs from "node:fs";import crypto from "node:crypto";const j={protocol:"address-only-isolated-recovery-fixture-v1",database:"radar_rehearsal_0123456789abcdef",schema:"radar_rehearsal_0123456789abcdef",username:"radar_migrator_0123456789abcdef",generation:"isolated-recovery-0123456789abcdef",schemaFingerprint:fs.readFileSync("/tmp/schema-fingerprint","utf8").trim(),systemIdentifier:fs.readFileSync("/tmp/systemid","utf8").trim(),password:"isolated-fixture-password",operationId:"isolated-recovery-fixture",output:"/tmp/committed.json"};const raw=JSON.stringify(j);fs.writeFileSync("/tmp/job.json",raw,{mode:384});fs.writeFileSync("/tmp/job.sha",crypto.createHash("sha256").update(raw).digest("hex"));'\''
"$scope/bin/node" "$scope/tools/fixture.mjs" --job /tmp/job.json --job-sha256 "$(cat /tmp/job.sha)"
runuser -u postgres -- psql -X -d radar_rehearsal_0123456789abcdef -v ON_ERROR_STOP=1 -c "ALTER DATABASE radar_rehearsal_0123456789abcdef OWNER TO postgres; REVOKE ALL ON DATABASE radar_rehearsal_0123456789abcdef FROM PUBLIC; GRANT CONNECT ON DATABASE radar_rehearsal_0123456789abcdef TO radar_migrator_0123456789abcdef; REVOKE ALL ON SCHEMA public FROM PUBLIC;"
for service in scanner automation wallet_monitor wallet_analysis historical_backfill console; do
 runuser -u postgres -- psql -X -d radar_rehearsal_0123456789abcdef -v ON_ERROR_STOP=1 -c "GRANT CONNECT ON DATABASE radar_rehearsal_0123456789abcdef TO radar_0123456789abcdef_$service; GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO radar_0123456789abcdef_$service;" >/dev/null
done
env -u SYSTEMD_UNIT_PATH python3 "$scope/tools/scripts/test/scope-source-controller-fixture.py"
ADDRESS_RADAR_EXECUTE_NATIVE_RECOVERY=1 env -u SYSTEMD_UNIT_PATH python3 "$scope/tools/scripts/test/execute-source-native-recovery.test.py"
'
