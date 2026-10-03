#!/usr/bin/env bash
set -euo pipefail

# Provision a disposable acceptance namespace, never a business database.
if [[ ${1:-} != --approved-isolated-instance || $EUID -ne 0 ]]; then
  printf 'Run as root with --approved-isolated-instance after operator approval.\n' >&2
  exit 64
fi
paused_pid=${ADDRESS_RADAR_PAUSED_CAPTURE_PID:?Set the paused browser capture PID}
[[ $paused_pid =~ ^[1-9][0-9]*$ ]] || exit 64
unit=postgresql@16-radaracceptance.service
cluster=radaracceptance
port=5433
database=address_radar_acceptance_test
role=address_radar_acceptance
config=/etc/postgresql/16/radaracceptance
data=/var/lib/postgresql/16/radaracceptance
secret_file=/etc/address-radar/postgres-acceptance.env
dropin=/etc/systemd/system/postgresql@16-radaracceptance.service.d
rotation=/etc/logrotate.d/address-radar-postgresql-acceptance
policy=/usr/sbin/policy-rc.d
services=(scanner automation wallet-monitor wallet-analysis historical-backfill console)

exec 9>/var/lock/address-radar-postgres-acceptance.lock
flock -n 9 || { printf 'Another acceptance installation owns the lock.\n' >&2; exit 75; }

business_snapshot() {
  local name pid enabled
  for name in "${services[@]}"; do
    name="address-radar-${name}.service"
    if [[ $(systemctl show "$name" --property=ActiveState --value) != active ]]; then
      printf 'Business service is not active: %s\n' "$name" >&2
      return 73
    fi
    pid=$(systemctl show "$name" --property=MainPID --value) || return 73
    if [[ ! $pid =~ ^[1-9][0-9]*$ ]]; then
      printf 'Business service has no running process: %s\n' "$name" >&2
      return 73
    fi
    enabled=$(tr '\0' '\n' < "/proc/$pid/environ" | awk -F= '$1 == "ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED" {print $2}') || return 73
    if [[ $enabled != false ]]; then
      printf 'Gateway delivery is not explicitly disabled: %s\n' "$name" >&2
      return 73
    fi
    systemctl show "$name" --property=Id,ActiveState,SubState,MainPID,NRestarts || return 73
  done
}
paused_capture() { [[ $(ps -o stat= -p "$paused_pid") == T* ]]; }
baseline=$(business_snapshot) || exit 73
paused_capture
release=$(readlink -f /opt/address-radar/current)
[[ $(df -B1 --output=avail /var/lib | tail -n 1) -gt 3221225472 ]]
[[ $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) -gt 1048576 ]]
command -v logrotate >/dev/null
command -v openssl >/dev/null
for path in "$policy" "$config" "$data" "$secret_file" "$dropin" "$rotation"; do
  if [[ -e $path || -L $path ]]; then
    printf 'Refusing to overwrite existing installation state: %s\n' "$path" >&2
    exit 73
  fi
done
if [[ -n $(ss -H -lnt 'sport = :5433') || -n $(ss -H -lnt 'sport = :5432') ]]; then
  printf 'A PostgreSQL port is already in use; installation requires review.\n' >&2
  exit 73
fi
if command -v pg_lsclusters >/dev/null && [[ -n $(pg_lsclusters --no-header) ]]; then
  printf 'Existing PostgreSQL clusters require a separate installation plan.\n' >&2
  exit 73
fi

plan=$(LC_ALL=C apt-get --simulate --no-install-recommends --no-upgrade install postgresql-16)
printf '%s\n' "$plan"
if ! printf '%s\n' "$plan" | grep -Eq '^0 upgraded, [0-9]+ newly installed, 0 to remove'; then
  printf 'Installation would upgrade or remove existing packages; refusing.\n' >&2
  exit 73
fi

policy_created=0
cluster_created=0
finished=0
policy_hash=''
cleanup() {
  local result=$?
  trap - EXIT
  if (( finished == 0 && cluster_created == 1 )); then
    systemctl stop "$unit" || true
    printf 'Acceptance instance stopped; its files are preserved for inspection.\n' >&2
  fi
  if (( policy_created == 1 )); then
    if [[ -f $policy && $(sha256sum "$policy" | awk '{print $1}') == "$policy_hash" ]]; then
      rm -- "$policy"
    else
      printf 'Temporary service policy changed externally; leaving it untouched.\n' >&2
      result=73
    fi
  fi
  exit "$result"
}
trap cleanup EXIT

# Suppress maintainer-script service starts and needrestart's automatic restarts.
( set -o noclobber; printf '#!/bin/sh\n# Temporary Address Radar acceptance installation policy.\nexit 101\n' > "$policy" )
chmod 0755 "$policy"
policy_hash=$(sha256sum "$policy" | awk '{print $1}')
policy_created=1
install_packages() {
  timeout 300s env NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive LC_ALL=C \
    apt-get -y --no-install-recommends --no-upgrade \
    -o Acquire::Retries=1 -o Acquire::http::Timeout=20 install "$@"
}
install_packages postgresql-common postgresql-client-16
printf '\n# Address Radar: no automatic default cluster during installation.\ncreate_main_cluster = false\n' \
  >> /etc/postgresql-common/createcluster.conf
install_packages postgresql-16
[[ -z $(pg_lsclusters --no-header) ]]
current=$(business_snapshot) || exit 73
[[ $current == "$baseline" ]]
paused_capture

install -d -o postgres -g postgres -m 0750 /var/log/address-radar-postgresql
pg_createcluster --port="$port" --start-conf=manual --locale=C.UTF-8 \
  --datadir="$data" --logfile=/var/log/address-radar-postgresql/acceptance.log \
  --pgoption=include_dir=conf.d 16 "$cluster" -- \
  --auth-local=peer --auth-host=scram-sha-256 --data-checksums
cluster_created=1
install -d -o postgres -g postgres -m 0750 "$config/conf.d"
cat > "$config/conf.d/address-radar-acceptance.conf" <<'CONFIG'
listen_addresses = '127.0.0.1'
port = 5433
max_connections = 12
shared_buffers = '64MB'
work_mem = '2MB'
maintenance_work_mem = '32MB'
autovacuum_max_workers = 1
autovacuum_work_mem = '16MB'
max_parallel_workers = 0
max_parallel_workers_per_gather = 0
max_parallel_maintenance_workers = 0
temp_file_limit = '64MB'
max_wal_size = '256MB'
min_wal_size = '64MB'
statement_timeout = '30s'
lock_timeout = '5s'
idle_in_transaction_session_timeout = '30s'
password_encryption = 'scram-sha-256'
fsync = on
synchronous_commit = on
full_page_writes = on
logging_collector = off
log_statement = 'none'
log_min_error_statement = 'panic'
log_parameter_max_length_on_error = 0
log_connections = off
log_disconnections = off
CONFIG
cat > "$config/pg_hba.conf" <<'HBA'
local all postgres peer
local address_radar_acceptance_test address_radar_acceptance scram-sha-256
local all all reject
host address_radar_acceptance_test address_radar_acceptance 127.0.0.1/32 scram-sha-256
host all all 0.0.0.0/0 reject
host all all ::0/0 reject
HBA
chown postgres:postgres "$config/pg_hba.conf" "$config/conf.d/address-radar-acceptance.conf"
chmod 0640 "$config/pg_hba.conf" "$config/conf.d/address-radar-acceptance.conf"
install -d -m 0755 "$dropin"
cat > "$dropin/limits.conf" <<'UNIT'
[Service]
MemoryAccounting=true
MemoryHigh=384M
MemoryMax=512M
MemorySwapMax=0
CPUQuota=50%
TasksMax=64
LogRateLimitIntervalSec=30s
LogRateLimitBurst=50
UNIT
cat > "$rotation" <<'ROTATION'
/var/log/address-radar-postgresql/acceptance.log {
    daily
    maxsize 5M
    rotate 3
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su postgres postgres
}
ROTATION
logrotate --debug "$rotation" >/dev/null 2>&1
systemctl daemon-reload
systemctl start "$unit"
pg_isready --host=127.0.0.1 --port="$port" --timeout=5

runuser -u postgres -- psql -X --set=ON_ERROR_STOP=1 --port="$port" --dbname=postgres <<'SQL'
CREATE ROLE address_radar_acceptance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 8;
CREATE DATABASE address_radar_acceptance_test OWNER address_radar_acceptance TEMPLATE template0;
SQL
password=$(openssl rand -hex 32)
# psql encrypts the password client-side, so plaintext never enters a SQL statement.
printf '%s\n%s\n' "$password" "$password" | \
  runuser -u postgres -- psql -X --set=ON_ERROR_STOP=1 --port="$port" --dbname=postgres \
  --command="\\password $role" >/dev/null
if [[ ! -d /etc/address-radar ]]; then
  install -d -m 0750 /etc/address-radar
fi
( umask 077; set -o noclobber; \
  printf 'ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL=postgresql://%s:%s@127.0.0.1:%s/%s\n' \
    "$role" "$password" "$port" "$database" > "$secret_file" )

PGPASSWORD="$password" psql -X --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port="$port" \
  --username="$role" --dbname="$database" <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'Acceptance role has unsafe privileges';
  END IF;
END $$;
BEGIN;
CREATE TABLE acceptance_install_probe (id integer PRIMARY KEY);
INSERT INTO acceptance_install_probe VALUES (1);
DO $$ BEGIN
  IF (SELECT count(*) FROM acceptance_install_probe) <> 1 THEN
    RAISE EXCEPTION 'Transaction probe failed';
  END IF;
END $$;
ROLLBACK;
DO $$ BEGIN
  IF to_regclass('public.acceptance_install_probe') IS NOT NULL THEN
    RAISE EXCEPTION 'Rollback did not remove the acceptance probe';
  END IF;
END $$;
SELECT current_database(), current_user, current_setting('listen_addresses'),
  current_setting('shared_buffers'), current_setting('fsync'), current_setting('synchronous_commit');
SQL
if PGPASSWORD="$password" psql -X --host=127.0.0.1 --port="$port" --username="$role" \
  --dbname=postgres --command='SELECT 1' >/dev/null 2>&1; then
  printf 'Acceptance role unexpectedly accessed the administrative database.\n' >&2
  exit 73
fi
unset password
current=$(business_snapshot) || exit 73
[[ $current == "$baseline" ]]
[[ $(readlink -f /opt/address-radar/current) == "$release" ]]
paused_capture
[[ $(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 http://127.0.0.1:3214/) == 200 ]]
[[ $(systemctl show "$unit" --property=MemoryMax --value) == 536870912 ]]
[[ $(systemctl show "$unit" --property=MemorySwapMax --value) == 0 ]]
[[ $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) -gt 524288 ]]
[[ $(ss -H -lnt 'sport = :5433' | awk '{print $4}') == 127.0.0.1:5433 ]]
systemctl show "$unit" --property=ActiveState,SubState,NRestarts,MemoryCurrent,MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec
printf '%s\n' "$baseline"
free -m
df -h /var/lib
finished=1
printf 'Isolated PostgreSQL acceptance instance provisioned; no business activation or migration performed.\n'
