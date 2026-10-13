import { createPostgresMigrationRuntime } from "../../packages/database/src/postgres-migration-runtime.js";
import { authenticatePostgresBusinessNamespaceReceipt, postgresBusinessNamespaceReceiptSigningPayload, type PostgresBusinessProvisionedNamespaceReceipt } from "../../packages/database/src/postgres-business-schema.js";
import { createFullDataPreservationSchemaSql, importFullDataPreservationBundle } from "../../packages/database/src/postgres-full-data-import.js";
import { createReviewedPostgresCohortImportPlan, createReviewedPostgresProviderBudgetSeedPlan, applyReviewedPostgresCohortImportPlanInTransaction, applyReviewedPostgresProviderBudgetSeedPlanInTransaction, postgresCohortImportFingerprint, type PostgresCohortReview, type PostgresProviderBudgetReview, type PostgresCohortTransactionApplyOptions } from "../../apps/automation/src/postgres-cohort-import.js";
import { createMigrationRuntimeCutoverTransitionStore, type DurableCutoverState } from "../../packages/database/src/migration-cutover-coordinator.js";
import type { MigrationProjectionCrosswalk } from "../../packages/database/src/migration-projection-crosswalk.js";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPostgresServiceSchema, installPostgresServiceSchema } from "../../apps/automation/src/postgres-service-schema.js";
import { requestPostgresWalletSignalWake } from "../../apps/automation/src/postgres-production-composition.js";
import { createPostgresServiceFactAdapters } from "../../apps/automation/src/postgres-service-fact-adapters.js";
import { createPostgresWalletChannel } from "../../apps/wallet-monitor/src/postgres-wallet-channel.js";
import { createPostgresBusinessProvisioningPlan, postgresBusinessResourcePolicyFingerprint, POSTGRES_BUSINESS_SERVICES, POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES, type PostgresBusinessService, type PostgresBusinessProvisioningResources } from "../../packages/database/src/postgres-business-provisioning.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createPostgresBusinessRuntime, type PostgresBusinessRuntime } from "../../packages/database/src/postgres-business-driver.js";
import { createPostgresBusinessSchemaPlan, installPostgresBusinessSchema, POSTGRES_BUSINESS_SCHEMA_MODULES,
  POSTGRES_BUSINESS_SCHEMA_PLAN } from "../../packages/database/src/postgres-business-schema.js";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresPool } from "../../packages/database/src/postgres-unit-of-work.js";

type RehearsalPool = PostgresPool & { end(): Promise<void>; on(event: "error", listener: () => void): unknown };
const { Pool } = createRequire(new URL("../../packages/database/package.json", import.meta.url))("pg") as {
  Pool: new (options: Readonly<Record<string, unknown>>) => RehearsalPool;
};
// Synthetic mechanics only, never real-wallet/natural-case or formal migration readiness.
// No acceptance identity reuse, existing-cluster access, HBA/service changes, or production imports.
const enabled = process.env.ADDRESS_RADAR_RUN_BUSINESS_RUNTIME_REHEARSAL === "1";
const sshArguments = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1"];
const host = "ubuntu@152.32.185.240", port = 5434, bin = "/usr/lib/postgresql/16/bin";
let clusterRoot = "", ownershipMarker = "";
const identifier = (value: string) => {
  if (!/^radar_rehearsal_[a-f0-9]{16}(?:_[a-z]+)?$/.test(value)) throw new Error("Unsafe rehearsal identity");
  return '"' + value + '"';
};
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function remote(command: string, input: string, timeout = 15_000): string {
  const result = spawnSync("ssh", [...sshArguments, host, command], {
    input, encoding: "utf8", timeout, maxBuffer: 512 * 1024,
  });
  // Never expose stderr/stdout on failure: diagnostics can contain SQL/credential material.
  if (result.error || result.status !== 0) {
    const reasons: Record<number, string> = {
      73: "BLOCKED: remote MemAvailable is below 1 GiB",
      74: "BLOCKED: remote filesystem free space is below 5 GiB",
      75: "BLOCKED: remote port 5434 is occupied",
      76: "BLOCKED: private artifact directory already exists",
      77: "BLOCKED: capacity, port or PG16 binary preflight is unavailable",
      78: "BLOCKED: rehearsal ownership marker/owner does not match",
      79: "BLOCKED: postmaster PID does not belong to the private rehearsal data directory",
    };
    throw new Error(reasons[result.status ?? -1] ?? "BLOCKED: isolated SSH/runner permission or operation failed");
  }
  return result.stdout.trim();
}
function guardedRoot(): string {
  if (!/^\/tmp\/radar_rehearsal_[a-f0-9]{16}$/.test(clusterRoot) || !ownershipMarker) throw new Error("Missing private cluster identity");
  return `root=${literal(clusterRoot)}
marker=${literal(ownershipMarker)}
test ! -L "$root" && test "$(stat -c %u "$root")" = "$(id -u)" && test -f "$root/owner" && test ! -L "$root/owner" || exit 78
test "$(cat "$root/owner")" = "$marker" || exit 78
`;
}
function createCluster(bootstrapPassword: string) {
  return remote("sudo -n -u postgres sh -s", `set -eu
umask 077
bin=${literal(bin)}
root=${literal(clusterRoot)}
for executable in initdb pg_ctl postgres psql; do test -x "$bin/$executable" || exit 77; done
available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
case "$available" in ''|*[!0-9]*) exit 77;; esac
[ "$available" -ge 1048576 ] || exit 73
free=$(df -Pk /tmp | awk 'NR==2 {print $4}')
case "$free" in ''|*[!0-9]*) exit 77;; esac
[ "$free" -ge 5242880 ] || exit 74
listeners=$(ss -H -ltn 'sport = :5434') || exit 77
[ -z "$listeners" ] || exit 75
[ ! -e "$root" ] && [ ! -L "$root" ] || exit 76
mkdir -m 700 "$root"
printf '%s' ${literal(ownershipMarker)} > "$root/owner"
printf '%s' ${literal(bootstrapPassword)} > "$root/bootstrap-password"
"$bin/initdb" -D "$root/data" -U postgres --auth-local=peer --auth-host=scram-sha-256 --pwfile="$root/bootstrap-password" --no-instructions > "$root/init.log" 2>&1
rm -- "$root/bootstrap-password"
mkdir -m 700 "$root/socket"
cat >> "$root/data/postgresql.conf" <<CONFIG
listen_addresses = '127.0.0.1'
port = 5434
unix_socket_directories = '$root/socket'
unix_socket_permissions = 0700
shared_buffers = '16MB'
work_mem = '1MB'
maintenance_work_mem = '16MB'
autovacuum_work_mem = '16MB'
autovacuum_max_workers = 1
max_connections = 6
max_worker_processes = 0
max_parallel_workers = 0
max_parallel_workers_per_gather = 0
max_wal_size = '64MB'
min_wal_size = '32MB'
temp_file_limit = '16MB'
statement_timeout = '3s'
lock_timeout = '500ms'
idle_in_transaction_session_timeout = '3s'
log_statement = 'none'
log_min_error_statement = 'panic'
log_parameter_max_length_on_error = 0
logging_collector = off
fsync = on
synchronous_commit = on
full_page_writes = on
CONFIG
nice -n 19 "$bin/pg_ctl" -D "$root/data" -w -t 10 -l "$root/postgres.log" start > "$root/start.log" 2>&1
pid=$(head -n 1 "$root/data/postmaster.pid")
priority=$(ps -o ni= -p "$pid" | tr -d ' ')
[ "$priority" = 19 ] || exit 77
printf '%s' "$available:$free"
`, 35_000);
}
function removeCluster() {
  remote("sudo -n -u postgres sh -s", String.raw`set -eu
root=${literal(clusterRoot)}
[ -e "$root" ] || exit 0
${guardedRoot()}
bin=${literal(bin)}
test ! -L "$root/data" || exit 78
if [ -f "$root/data/postmaster.pid" ]; then
  pid=$(head -n 1 "$root/data/postmaster.pid")
  case "$pid" in ''|*[!0-9]*) exit 79;; esac
  if kill -0 "$pid" 2>/dev/null; then
    tr '\000' '\n' < "/proc/$pid/cmdline" | awk -v data="$root/data" -v binary="$bin/postgres" '
      NR==1 {binary_ok=($0==binary)} $0==data {data_ok=1} END {exit !(binary_ok && data_ok)}' || exit 79
    "$bin/pg_ctl" -D "$root/data" -m fast -w -t 10 stop > "$root/stop.log" 2>&1
  fi
fi
if "$bin/pg_ctl" -D "$root/data" status >/dev/null 2>&1; then exit 79; fi
${guardedRoot()}
rm -rf -- "$root"
[ ! -e "$root" ] || exit 78
`, 20_000);
}
function admin(sql: string, database = "postgres"): string {
  if (database !== "postgres") identifier(database);
  guardedRoot();
  return remote(`sudo -n -u postgres ${bin}/psql -X -qAt -h ${clusterRoot}/socket -p ${port} -d ${database} -v ON_ERROR_STOP=1`,
    "SET statement_timeout='3s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='3s';\n"
    + "SET log_statement='none'; SET log_min_error_statement='panic'; SET log_parameter_max_length_on_error=0;\n"
    + `DO $scope$ BEGIN IF current_setting('port')<>'5434' OR current_setting('data_directory')<>${literal(clusterRoot + "/data")}
      THEN RAISE EXCEPTION 'Private rehearsal cluster mismatch'; END IF; END $scope$;\n` + sql);
}
function credentials() {
  const password = randomBytes(32).toString("hex"), salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const stored = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return { password, verifier: `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}` };
}
async function requireUnusedLocalPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", () => reject(new Error("Local port 5434 is occupied or unavailable; no tunnel was changed")));
    listener.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}
async function startTunnel(): Promise<ChildProcess> {
  const child = spawn("ssh", [...sshArguments, "-o", "ExitOnForwardFailure=yes", "-N",
    "-L", "127.0.0.1:5434:127.0.0.1:5434", host], { stdio: "ignore" });
  let failed = false; child.once("error", () => { failed = true; });
  const until = Date.now() + 8_000;
  while (Date.now() < until && !failed && child.exitCode === null && child.signalCode === null) {
    const ready = await new Promise<boolean>(resolve => {
      const socket = connect({ host: "127.0.0.1", port });
      const finish = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
      socket.setTimeout(200, () => finish(false));
    });
    if (ready) { await delay(100); if (!failed && child.exitCode === null && child.signalCode === null) return child; }
    await delay(50);
  }
  child.kill("SIGTERM"); throw new Error("Isolated 5434 tunnel failed; no alternate port or existing tunnel was used");
}
async function stopTunnel(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>(resolve => child.once("close", () => resolve())), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
async function rejection(operation: () => Promise<unknown>, predicate: (error: unknown) => boolean) {
  try { await operation(); } catch (error) { if (predicate(error)) return; throw error; }
  throw new Error("Expected isolated permission/transaction rejection did not occur");
}
const sqlState = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const privilegeRefusal = (error: unknown) => error instanceof Error && error.message.includes("least-privilege");

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : value && typeof value === "object" ? "{" + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,child]) => JSON.stringify(key) + ":" + canonical(child)).join(",") + "}" : JSON.stringify(value);
function preservationFixture(nonce: string) {
  const directory = mkdtempSync(join(tmpdir(),"radar_rehearsal_" + nonce + "_bundle-"));
  const marker = randomBytes(16).toString("hex"); writeFileSync(join(directory,"owner"),marker,{mode:0o600});
  const text = (value: string) => ({storage:"text" as const,value:Buffer.from(value).toString("base64"),encoding:"base64" as const});
  const integer = (value: string) => ({storage:"integer" as const,value});
  const addresses = ["0x"+"aB".repeat(20),"0x"+"cD".repeat(20)];
  const registry = addresses.map((address,index) => ({entity:"synthetic-entity-"+index,account:"synthetic-account-"+index,address,
    association:[text("synthetic-entity-"+index),text("synthetic-account-"+index),text("confirmed"),text("synthetic-registry")],
    wallet:[text("synthetic-account-"+index),text("evm"),text(address),text("confirmed"),text("synthetic-registry")],
    profile:[text("synthetic-entity-"+index),integer(index === 0 ? "1":"0"),integer(index === 0 ? "0":"1"),integer(index === 0 ? "1":"0")]}));
  const tableInputs = [
    {name:"history",columns:["integer_value","real_value","text_value","blob_value","null_value"],rows:[{values:[
      integer("9223372036854775807"),{storage:"real" as const,value:"-0x0.0p+0"},
      {storage:"text" as const,value:"AP8=",encoding:"base64" as const},{storage:"blob" as const,value:"AP8=",encoding:"base64" as const},{storage:"null" as const}]}]},
    {name:"entity_accounts",columns:["entity_id","account_id","confidence","source"],rows:registry.map(row => ({values:row.association}))},
    {name:"wallet_identities",columns:["account_id","chain_family","address","confidence","source"],rows:registry.map(row => ({values:row.wallet}))},
    {name:"trader_profiles",columns:["entity_id","monitoring_enabled","fomo_monitoring_enabled","onchain_monitoring_enabled"],rows:registry.map(row => ({values:row.profile}))},
  ];
  const catalog = {objects:tableInputs.map(table => ({type:"table",name:table.name,tbl_name:table.name,sql:"CREATE TABLE "+table.name+"("+table.columns.join(",")+")"})),
    tables:tableInputs.map(table => ({name:table.name,columns:table.columns.map((name,cid) => [cid,name,"",0,null,0,0]),foreignKeys:[],indexes:[]})),
    sequences:[],pragmas:{encoding:"UTF-8",user_version:0,application_id:0}};
  const operationId = "synthetic-preservation-"+nonce,snapshotSha256=sha("synthetic-source-snapshot-"+nonce),catalogFingerprint=sha(canonical(catalog));
  const chunkBodies = tableInputs.map((table,index) => {
    const file="table-"+String(index).padStart(4,"0")+"-chunk-000000.json";
    const body=canonical({version:1,operationId,snapshotSha256,table:table.name,ordinal:0,startRow:0,rows:table.rows});
    writeFileSync(join(directory,file),body,{mode:0o600});
    return {file,body,table:table.name};
  });
  const manifest = {version:1,operationId,snapshotSha256,snapshotBytes:4096,catalogFingerprint,completed:true,businessActivation:false,
    limits:{maximumChunkBytes:16384,rowsPerChunk:64},catalog,tables:tableInputs.map((table,index) => ({name:table.name,completed:true,rowCount:table.rows.length,
      contentSha256:sha(table.rows.map(row => canonical(row)+"\n").join("")),chunks:[{file:chunkBodies[index]!.file,table:table.name,ordinal:0,startRow:0,rowCount:table.rows.length,sha256:sha(chunkBodies[index]!.body)}]}))};
  const manifestBody=canonical(manifest);writeFileSync(join(directory,"manifest.json"),manifestBody,{mode:0o600});
  const reviewedRoutingSha256=sha("synthetic-routing-"+nonce);
  const crosswalk: MigrationProjectionCrosswalk = {operationId,snapshotSha256,catalogFingerprint,reviewedRoutingSha256,
    rows:registry.flatMap((row,index) => [
      {table:"entity_accounts",rowOrdinal:index,rowBodySha256:sha(canonical({values:row.association})),targetRoute:"identity_review" as const,
        values:Object.fromEntries(tableInputs[1]!.columns.map((name,i) => [name,row.association[i]!])),primaryKey:[text(row.entity),text(row.account)],references:[],status:"historical" as const,grantsBusinessEligibility:false as const},
      {table:"wallet_identities",rowOrdinal:index,rowBodySha256:sha(canonical({values:row.wallet})),targetRoute:"identity_review" as const,
        values:Object.fromEntries(tableInputs[2]!.columns.map((name,i) => [name,row.wallet[i]!])),primaryKey:[text(row.account),text("evm"),text(row.address)],references:[],status:"historical" as const,grantsBusinessEligibility:false as const},
      {table:"trader_profiles",rowOrdinal:index,rowBodySha256:sha(canonical({values:row.profile})),targetRoute:"identity_review" as const,
        values:Object.fromEntries(tableInputs[3]!.columns.map((name,i) => [name,row.profile[i]!])),primaryKey:[text(row.entity)],references:[],status:"historical" as const,grantsBusinessEligibility:false as const},
    ]),identityCohorts:registry.map((row,index) => ({entityId:row.entity,entityKey:"synthetic-source-"+index,lifecycle:"active",suspended:false,manual:false,locked:false,
      profileFlags:{monitoring_enabled:index===0,fomo_monitoring_enabled:index!==0,onchain_monitoring_enabled:index===0},accounts:[text(row.account)],
      wallets:[{family:"evm",comparisonAddress:row.address.toLowerCase(),sourceAddresses:[row.address],confidenceEvidence:[{
        source:{table:"wallet_identities",rowOrdinal:index},value:text("confirmed"),recognized:"confirmed"}]}],status:"historical_coherent",grantsBusinessEligibility:false})),
    issues:[],coverage:{plannedTables:4,plannedRows:7,providedRows:6,providedChunks:3,supportedIdentityTables:[],semanticReferenceRules:0,
      completeSemanticCoverage:false,cohortCountsAreDiagnostic:true},historicalOnly:true,grantsBusinessEligibility:false,sourceWrites:false,databaseWrites:false};
  return {directory,operationId,manifestSha256:sha(manifestBody),manifestBody,chunkBodies,tableInputs,crosswalk,registry,
    cleanup() {if (lstatSync(directory).isSymbolicLink() || readFileSync(join(directory,"owner"),"utf8")!==marker) throw new Error("Private source fixture cleanup guard refused");rmSync(directory,{recursive:true});}};
}
function backupFixture(database: string,schema: string,tables: readonly string[]) {
  identifier(database);identifier(schema);const restored=database+"_restore";identifier(restored);
  if (!schema.startsWith(database+"_") || tables.length<77 || tables.length>100) throw new Error("Private backup fixture scope refused");
  const q=(table:string) => {if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error("Private backup table identifier refused");return '"'+schema+'"."'+table+'"';};
  const paritySql=`SELECT jsonb_build_object('rows',(SELECT jsonb_agg(x ORDER BY table_name) FROM (${tables.map(table =>
    `SELECT ${literal(table)} table_name,count(*)::text row_count,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text COLLATE "C"),'')) digest FROM ${q(table)} t`).join(" UNION ALL ")}) x),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=${literal(schema)} AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated) ORDER BY c.relname,k.conname)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)}),
    'typed',(SELECT jsonb_build_object('cooldown',cooldown_until::text,'requests',requests_used,'origin',origin,'import',import_id) FROM ${q("wallet_service_provider_budgets")} WHERE provider_id='native-provider'),
    'raw',(SELECT encode(row_body,'hex') FROM ${q("full_data_preservation_rows")} WHERE table_name='history'),
    'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY version) FROM ${q("business_schema_ledger")} l))::text;`;
  const before=JSON.parse(admin(paritySql,database));
  admin(`CREATE DATABASE ${identifier(restored)} TEMPLATE template0 CONNECTION LIMIT 2;
    COMMENT ON DATABASE ${identifier(restored)} IS ${literal(ownershipMarker)};
    REVOKE ALL PRIVILEGES ON DATABASE ${identifier(restored)} FROM PUBLIC;`);
  const size=remote("sudo -n -u postgres sh -s",`set -eu
umask 077
${guardedRoot()}
available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
case "$available" in ''|*[!0-9]*) exit 77;; esac
[ "$available" -ge 1048576 ] || exit 73
free=$(df -Pk /tmp | awk 'NR==2 {print $4}')
case "$free" in ''|*[!0-9]*) exit 77;; esac
[ "$free" -ge 5242880 ] || exit 74
bin=${literal(bin)}
for executable in pg_dump pg_restore; do test -x "$bin/$executable" || exit 77; done
[ ! -e "$root/fixture.backup" ] && [ ! -L "$root/fixture.backup" ] || exit 76
ulimit -f 32768
export PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=3000 -c lock_timeout=500 -c work_mem=1024kB'
timeout 25s nice -n 19 "$bin/pg_dump" --no-password --format=custom --host="$root/socket" --port=5434 --dbname=${literal(database)} --file="$root/fixture.backup" > "$root/dump.log" 2>&1
bytes=$(stat -c %s "$root/fixture.backup")
[ "$bytes" -gt 0 ] && [ "$bytes" -le 16777216 ] || exit 77
timeout 25s nice -n 19 "$bin/pg_restore" --no-password --exit-on-error --single-transaction --host="$root/socket" --port=5434 --dbname=${literal(restored)} "$root/fixture.backup" > "$root/restore.log" 2>&1
printf '%s' "$bytes"
`,60000);
  const after=JSON.parse(admin(paritySql,restored));expect(after).toEqual(before);
  expect(JSON.parse(admin(paritySql,database))).toEqual(before);
  expect(after.rows).toHaveLength(tables.length);
  expect(after.typed.cooldown).toBe("9223372036854775807");
  expect(after.raw).toBe(Buffer.from(canonical({values:[{storage:"integer",value:"9223372036854775807"},{storage:"real",value:"-0x0.0p+0"},
    {storage:"text",value:"AP8=",encoding:"base64"},{storage:"blob",value:"AP8=",encoding:"base64"},{storage:"null"}]})).toString("hex"));
  return {tables:tables.length,bytes:Number(size),matched:true};
}

function actualMutationSql(): string[] {
  const names = ["../../apps/automation/src/postgres-production-composition.ts", "../../apps/automation/src/postgres-service-fact-adapters.ts",
    "../../apps/wallet-monitor/src/postgres-wallet-channel.ts"];
  const queries = new Set<string>();
  for (const name of names) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    // Static literal query corpus only; runtime interpolation must not be executed as fixture SQL.
    for (const match of source.matchAll(/\.query\(\s*(`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
      const literalSql = match[1]!;
      const sql = literalSql.startsWith("\"") ? JSON.parse(literalSql) as string : literalSql.slice(1,-1);
      if (!sql.includes("\$" + "{") && /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+wallet_(?:channel|capture_generation|forward_signal|service)_/i.test(sql)) queries.add(sql);
    }

  }
  if (queries.size < 20) throw new Error("Actual support mutation corpus is incomplete");
  return [...queries];
}

describe.skipIf(!enabled)("private ephemeral PG16 actual v2 restricted-role rehearsal", () => {
  it("installs actual 17-table v2, executes app mutations and rejects direct/inherited authority ACLs", async () => {
    await requireUnusedLocalPort();
    const nonce = randomBytes(8).toString("hex"), database = "radar_rehearsal_" + nonce;
    clusterRoot = "/tmp/" + database;
    ownershipMarker = "address-radar ephemeral runtime rehearsal " + nonce + " " + randomBytes(16).toString("hex");
    const migrator = database + "_migrator", dormant = database + "_dormant", inherited = database + "_inherited";
    const suffix = { scanner:"scanner",automation:"automation","wallet-monitor":"monitor","wallet-analysis":"analysis","historical-backfill":"backfill",console:"console" };
    const serviceRoles = Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, database + "_" + suffix[service]])) as Record<PostgresBusinessService,string>;
    const writer = serviceRoles.scanner, reader = serviceRoles.console;
    const loginRoles = [migrator,...Object.values(serviceRoles)], roles = [...loginRoles,dormant,inherited]; roles.forEach(identifier);
    const secrets = new Map(loginRoles.map(role => [role, credentials()]));
    const bootstrapPassword = randomBytes(32).toString("hex");
    let tunnel: ChildProcess | undefined, migrationPool: RehearsalPool | undefined, adminPool: RehearsalPool | undefined;
    let runtime: PostgresBusinessRuntime | undefined;
    let nativeMigration: ReturnType<typeof createPostgresMigrationRuntime> | undefined;
    let sourceFixture: ReturnType<typeof preservationFixture> | undefined;
    let stage = "ephemeral cluster RAM/disk/port/runner preflight", cleanupNeeded = false, failure: Error | undefined;
    const startedAt = Date.now();
    const advance = (next: string) => { stage=next;console.info("Private PG16 stage",next,"elapsedMs="+(Date.now()-startedAt)); };
    const emergencyCleanup = () => { try { if (cleanupNeeded) removeCluster(); } catch { /* Preserve guarded artifacts on refusal. */ } try { sourceFixture?.cleanup(); } catch { /* Preserve unowned artifacts. */ } tunnel?.kill("SIGTERM"); };
    process.once("exit",emergencyCleanup);
    const evidence = { roles:0, supportTables:0, explainedMutations:0, directAuthorityRejects:0, reachableAuthorityRejects:0,
      budgetAclRejects:0, appMutationCommits:0, readonlyDenied:false, physicalRollback:false, fingerprint:"", capacity:"", cleaned:false,
      preservation:null as null | {tables:number;rows:number;chunks:number;rollback:boolean;uncertainReconciled:boolean;typedBytesPreserved:boolean},
      nativeImport:null as null | {schemaContract:boolean;rollbackWithMarker:boolean;physicalCommitBeforeAck:boolean;uncertainReconciled:boolean;profiles:number;cooldown:string;physicalCommits:number},
      backup:null as null | {tables:number;bytes:number;matched:boolean} };
    const url = (role: string) => `postgresql://${role}:${secrets.get(role)!.password}@127.0.0.1:5434/${database}`;
    const schema = database + "_schema", generation = "radar-rehearsal-" + nonce;
    const q = (table: string) => '"' + schema + '"."' + table + '"';
    const pool = () => new Pool({ connectionString:url(migrator),max:1,connectionTimeoutMillis:2000,
      idleTimeoutMillis:500,query_timeout:3000,options:"-c search_path=pg_catalog -c statement_timeout=3000 -c lock_timeout=500" });
    const definition = createPostgresServiceSchema(), { plan, trustedModules } = definition;
    const options = (service: PostgresBusinessService) => ({
      connectionString:url(serviceRoles[service]),target:{ database,username:serviceRoles[service],schema,generation,service },
      access:service === "console" ? "read" as const : "runtime" as const,schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,ssl:false as const,
      maximumConnections:1,serviceConnectionBudgets:{ [service]:1 },serverMaximumConnections:6,reservedConnections:5,
      maximumPendingOperations:0,connectionTimeoutMs:2000,idleTimeoutMs:500,statementTimeoutMs:3000,lockTimeoutMs:500,
      idleTransactionTimeoutMs:10000,shutdownTimeoutMs:2000,workMemKb:1024,
    });
    const verifiedObservers = new WeakSet<object>();
    const queryAdmin = async (sql: string, values: readonly unknown[] = []) => {
      if (!adminPool) throw new Error("Private admin observer is not connected");
      const client = await adminPool.connect();
      try {
        if (!verifiedObservers.has(client)) {
        const scope = (await client.query("SELECT current_setting('port') port,current_setting('data_directory') data,current_database() database")).rows[0];
        if (scope?.port !== "5434" || scope.data !== clusterRoot + "/data" || scope.database !== database) throw new Error("Private admin observer scope mismatch");
        verifiedObservers.add(client);
        }
        return await client.query(sql,[...values]);
      } finally { client.release(); }
    };
    try {
      cleanupNeeded = true;
      evidence.capacity = createCluster(bootstrapPassword);
      advance("private cluster identity and fixed resource envelope");
      const settings = JSON.parse(admin(`SELECT json_build_object('port',current_setting('port'),'maximum',current_setting('max_connections'),
        'buffers',current_setting('shared_buffers'),'workMem',current_setting('work_mem'),'data',current_setting('data_directory'),
        'databases',(SELECT json_agg(datname ORDER BY datname) FROM pg_database));`));
      expect(settings).toEqual({ port:"5434",maximum:"6",buffers:"16MB",workMem:"1MB",data:clusterRoot + "/data",databases:["postgres","template0","template1"] });
      advance("private fresh roles and database provisioning");
      admin("BEGIN;\n" + roles.map(role => `CREATE ROLE ${identifier(role)} ${loginRoles.includes(role) ? "LOGIN" : "NOLOGIN"}
        NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1
        ${loginRoles.includes(role) ? "PASSWORD " + literal(secrets.get(role)!.verifier) : ""};
        COMMENT ON ROLE ${identifier(role)} IS ${literal(ownershipMarker)};`).join("\n") + "\nCOMMIT;");
      admin(`CREATE DATABASE ${identifier(database)} TEMPLATE template0 CONNECTION LIMIT 2;
        COMMENT ON DATABASE ${identifier(database)} IS ${literal(ownershipMarker)};
        REVOKE ALL PRIVILEGES ON DATABASE ${identifier(database)} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(migrator)};`);
      admin(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(migrator)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
        CREATE SCHEMA "${schema}" AUTHORIZATION ${identifier(migrator)};
        REVOKE CREATE,TEMPORARY ON DATABASE ${identifier(database)} FROM ${identifier(migrator)};
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${identifier(migrator)};`,database);
      tunnel = await startTunnel();
      advance("dedicated non-superuser migrator actual schema v1/v2 installation");
      migrationPool = pool(); migrationPool.on("error",() => undefined);
      const pins=JSON.parse(admin(`SELECT json_build_object('databaseOid',d.oid::text,'namespaceOid',n.oid::text,'ownerOid',n.nspowner::text,
        'systemIdentifier',(SELECT system_identifier::text FROM pg_catalog.pg_control_system())) FROM pg_database d CROSS JOIN pg_namespace n
        WHERE d.datname=current_database() AND n.nspname=${literal(schema)};`,database));
      const systemIdentifier=String(pins.systemIdentifier);
      const migrationTarget={database,username:migrator,schema,generation,service:"migration",serverAddress:"127.0.0.1",serverPort:5434,
        schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,systemIdentifier};
      const authority=generateKeyPairSync("ed25519"),issuedAt=Date.now();
      const receipt:PostgresBusinessProvisionedNamespaceReceipt={version:1,purpose:"provisioned-empty-business-namespace",receiptId:"synthetic-namespace/"+nonce,
        signerKeyId:"synthetic-fixture-authority",approvalRef:"synthetic-rehearsal/"+nonce,database,databaseOid:pins.databaseOid,schema,namespaceOid:pins.namespaceOid,
        owner:migrator,ownerOid:pins.ownerOid,generation,service:"migration",schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,systemIdentifier,
        issuedAt,expiresAt:issuedAt+900000};
      const provisionedNamespaceApproval=authenticatePostgresBusinessNamespaceReceipt({receipt,
        signatureBase64:sign(null,Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(receipt)),authority.privateKey).toString("base64")},
        {signerKeyId:receipt.signerKeyId,publicKeyPem:authority.publicKey.export({type:"spki",format:"pem"}).toString(),maximumReceiptAgeMs:900000,clock:Date.now});
      nativeMigration=createPostgresMigrationRuntime({pool:migrationPool,target:migrationTarget,
        capability:{mode:"isolated",purpose:"schema_install",approvalRef:receipt.approvalRef,planSha256:plan.fingerprint,expiresAtMs:Date.now()+180000},
        limits:{operationTimeoutMs:60000,connectionTimeoutMs:2000,statementTimeoutMs:3000,lockTimeoutMs:500,maximumSqlStatements:2000,workMemKb:1024,closeTimeoutMs:2000},clock:Date.now,
        assertAuthorized:async request => {if (request.capability.mode!=="isolated" || request.target.database!==database || request.target.schema!==schema
          || request.target.systemIdentifier!==systemIdentifier || request.capability.planSha256!==plan.fingerprint || request.capability.approvalRef!==receipt.approvalRef) throw new Error("Synthetic schema approval binding refused");}});
      const executor=nativeMigration;
      const install={target:{database,username:migrator,schema,generation,service:"migration"},approval:"approved-provisioned-business-schema" as const,
        approvalRef:receipt.approvalRef,provisionedNamespaceApproval};
      expect(plan.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
      expect((await installPostgresServiceSchema(executor,install)).appliedVersions).toEqual([1,2]);
      expect((await installPostgresServiceSchema(executor,install)).status).toBe("already-installed");
      expect(definition.supportTables).toHaveLength(17);
      evidence.fingerprint = plan.fingerprint;
      const fixtureAt = Date.now(), provider = "synthetic-provider";
      // Known synthetic seed only, not a cohort importer or evidence producer proof.
      await executor.run(async tx => {
        await tx.query(`INSERT INTO ${q("forward_strategy_generations")} VALUES($1,$2)`,[generation,fixtureAt]);
        await tx.query(`INSERT INTO ${q("wallet_service_import_ledger")}
          (import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at)
          VALUES($1,$2,$3,$4,'provider_contract',$5)`,["synthetic-import",generation,"synthetic-only", "a".repeat(64),fixtureAt]);
        await tx.query(`INSERT INTO ${q("wallet_service_provider_budgets")}
          (generation_id,provider_id,origin,import_id,window_started_at,window_ms,maximum_requests,requests_used,maximum_concurrency,cooldown_until)
          VALUES($1,$2,'https://synthetic.invalid','synthetic-import',$3,60000,10,0,1,$4)`,[generation,provider,fixtureAt,String(fixtureAt-1)]);
        await tx.query(`INSERT INTO ${q("wallet_service_price_leases")}(generation_id) VALUES($1)`,[generation]);
        await tx.query(`INSERT INTO ${q("wallet_service_fact_inputs")}
          (fact_id,generation_id,kind,subject_key,payload,fingerprint,source_ref,provider_id,observed_at,known_at)
          VALUES('synthetic-price',$1,'price','synthetic','{}',$2,'synthetic-only',$3,$4,$4)`,[generation,"a".repeat(64),provider,fixtureAt]);
      });
      await nativeMigration.close();nativeMigration=undefined; migrationPool = undefined;
      // Offline policy fixture, NOT a measured production capacity result or a 6-service simultaneous launch.
      const resources = { pools:Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service,{instances:1,maximumConnections:1}])),
        serverMaximumConnections:12,postgresReservedConnections:3,otherHostConnections:0,migrationConnections:1,operatorConnections:1,backupConnections:1,
        maximumPendingOperations:0,connectionTimeoutMs:2000,idleTimeoutMs:500,statementTimeoutMs:3000,lockTimeoutMs:500,
        idleTransactionTimeoutMs:10000,shutdownTimeoutMs:2000,workMemKb:1024,maximumMeasurementAgeMs:60000 } as PostgresBusinessProvisioningResources;
      const now = new Date().toISOString();
      const provisioning = createPostgresBusinessProvisioningPlan({ database,schema,generation,migratorRole:migrator,serviceRoles,resources,
        schemaPlan:plan,trustedModules,now,capacity:{status:"measured",hostId:"synthetic-policy-fixture",measurementRef:"synthetic-only/not-production-capacity",
          resourcePolicyFingerprint:postgresBusinessResourcePolicyFingerprint(resources),measuredAt:now,validUntil:new Date(Date.now()+60000).toISOString(),
          availableRamBytes:"1073741824",measuredPeakRamBytes:"16777216",ramMarginBytes:"16777216",
          availableDiskBytes:"5368709120",measuredPeakDiskBytes:"16777216",measuredPeakWalBytes:"67108864",measuredPeakTempBytes:"16777216",diskMarginBytes:"16777216" }});
      admin(provisioning.phases.find(phase => phase.id === "post-schema-grants")!.statements.join("\n")
        + `\nREVOKE CREATE,TEMPORARY ON DATABASE ${identifier(database)} FROM ${identifier(migrator)};
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${identifier(migrator)};`,database);
      adminPool = new Pool({host:"127.0.0.1",port,database,user:"postgres",password:bootstrapPassword,max:1,
        connectionTimeoutMillis:2000,idleTimeoutMillis:500,query_timeout:3000,options:"-c statement_timeout=3000 -c lock_timeout=500"});
      adminPool.on("error",() => undefined);
      const installed = await queryAdmin("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND c.relpersistence='p'",[schema]);
      expect(definition.supportTables.every(table => installed.rows.some(row => row.relname === table))).toBe(true);
      evidence.supportTables = definition.supportTables.length;
      const mutations = actualMutationSql();
      const exact = (fragment: string) => {
        const matches = mutations.filter(sql => sql.includes(fragment));
        if (matches.length !== 1) throw new Error("Ambiguous actual mutation fixture statement: " + fragment);
        return matches[0]!;
      };
      advance("six distinct restricted role probes and actual SQL planning under production grants");
      for (const service of POSTGRES_BUSINESS_SERVICES) {
        advance("restricted role SQL contract: "+service);
        runtime = createPostgresBusinessRuntime(options(service));
        expect((await runtime.probe()).serverPort).toBe(5434); evidence.roles++;
        if (service !== "console") {
          // EXPLAIN without ANALYZE validates every captured real app mutation's schema and ACL, without provider calls.
          await runtime.run(async tx => {
            for (const sql of mutations) {
              const maximum = Math.max(0,...[...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
              await tx.query("EXPLAIN " + sql,Array(maximum).fill(null));
              evidence.explainedMutations++;
            }
          });
        } else {
          await rejection(() => runtime!.run(tx => tx.query(exact("INSERT INTO wallet_forward_signal_wake_intents"),[generation,"denied","ethereum","synthetic",fixtureAt])),
            error => ["25006","42501"].includes(sqlState(error)));
          evidence.readonlyDenied = true;
        }
        await runtime.close(); runtime = undefined;
      }
      advance("actual wallet collector poll and durable capture binding/checkpoint");
      runtime = createPostgresBusinessRuntime(options("wallet-monitor"));
      const channel = createPostgresWalletChannel({ run:runtime.run,generationId:generation,ownerId:"synthetic-owner",sessionId:"synthetic-session",
        collectors:[{executionTrust:"unverified",collector:{name:"synthetic-collector",chainFamily:"evm",
          async collect() { return { partitions:[{partitionKey:"synthetic",nextCheckpoint:"1",events:[{
            eventId:"synthetic-event",chain:"ethereum",walletAddress:"0x"+"1".repeat(40),tokenAddress:"0x"+"2".repeat(40),
            side:"buy",amountUsd:1,priceUsd:1,marketCapUsd:1,occurredAt:fixtureAt,sourceReference:"synthetic-only" }]}] }; } }}],
        profiles:{async load() {return {status:"ready",profiles:[]};}},maximumProfiles:1,maximumEvents:1,collectorQuota:1,
        leaseMs:10000,maximumPayloadBytes:16384,maximumRunMs:10000,now:() => fixtureAt });
      const polled = await channel.pollOnce(); expect(polled.failed).toBe(0); expect(polled.captured).toBe(1);
      expect((await queryAdmin(`SELECT count(*)::text count FROM ${q("wallet_capture_generation_bindings")}`)).rows).toEqual([{count:"1"}]);
      evidence.appMutationCommits++;
      await runtime.close(); runtime = createPostgresBusinessRuntime(options("automation"));
      advance("actual composition wake intent/receipt/upsert/dispatch transaction");
      await runtime.run(async tx => {
        await requestPostgresWalletSignalWake(tx,{generationId:generation,chain:"ethereum",tokenAddress:"synthetic",sourceKey:"synthetic-wake",now:fixtureAt});
        await tx.query(exact("INSERT INTO wallet_forward_signal_wake_receipts"),[generation,"fact","synthetic-wake","ethereum","synthetic",fixtureAt]);
        const job = exact("INSERT INTO wallet_forward_signal_jobs");
        await tx.query(job,[generation,"ethereum","synthetic",fixtureAt]);
        await tx.query(job,[generation,"ethereum","synthetic",fixtureAt+1]);
        await tx.query(exact("UPDATE wallet_forward_signal_wake_intents SET status='dispatched'"),[generation,"synthetic-wake","ethereum","synthetic"]);
      });
      expect((await queryAdmin(`SELECT status,wake_generation::text wake_generation FROM ${q("wallet_forward_signal_jobs")}`)).rows).toEqual([{status:"pending",wake_generation:"2"}]);
      expect((await queryAdmin(`SELECT status FROM ${q("wallet_forward_signal_wake_intents")}`)).rows).toEqual([{status:"dispatched"}]);
      evidence.appMutationCommits++;
      advance("physical rollback before durable wake acknowledgement");
      await rejection(() => runtime!.run(async tx => {
        await requestPostgresWalletSignalWake(tx,{generationId:generation,chain:"ethereum",tokenAddress:"synthetic",sourceKey:"rolled-back",now:fixtureAt});
        throw new Error("synthetic rollback");
      }),error => error instanceof Error && error.message === "synthetic rollback");
      expect((await queryAdmin(`SELECT count(*)::text count FROM ${q("wallet_forward_signal_wake_intents")} WHERE source_key='rolled-back'`)).rows).toEqual([{count:"0"}]);
      evidence.physicalRollback = true;
      advance("actual fact adapter provider debit/lease/release/429 cooldown/source request");
      const adapter = await createPostgresServiceFactAdapters({runtime,generationId:generation,maximumProfiles:1,now:() => fixtureAt,
        sources:{leaseMs:10000,maximumProfileAgeMs:10000,maximumFactAgeMs:10000,maximumSafetyAgeMs:10000,
          providerTimeoutMs:2000,maximumResponseBytes:1024,maximumFactPayloadBytes:1024,
          fetchImpl:async () => new Response("synthetic-429",{status:429,headers:{"Retry-After":"1"}})} });
      await adapter.enqueueSourceRequest({providerId:provider,kind:"price",subjectKey:"synthetic",signal:new AbortController().signal});
      expect((await adapter.fetch("https://synthetic.invalid/rpc")).status).toBe(429);
      const budgetRow = (await queryAdmin(`SELECT requests_used,cooldown_until::text cooldown_until,origin,maximum_requests,window_ms,maximum_concurrency,import_id FROM ${q("wallet_service_provider_budgets")}`)).rows[0]!;
      expect(budgetRow).toEqual({requests_used:1,cooldown_until:String(fixtureAt+1000),origin:"https://synthetic.invalid",maximum_requests:10,window_ms:60000,maximum_concurrency:1,import_id:"synthetic-import"});
      await rejection(() => adapter.fetch("https://synthetic.invalid/rpc"),error => error instanceof Error && error.name === "PostgresProviderBudgetError");
      expect((await adapter.facts.prices({generationId:generation,asOf:fixtureAt,limit:1,signal:new AbortController().signal})).status).toBe("deferred");
      await runtime.run(tx => tx.query(exact("INSERT INTO wallet_service_price_consumption"),[generation,"synthetic-price",fixtureAt]));
      evidence.appMutationCommits++;
      await runtime.close(); runtime = createPostgresBusinessRuntime(options("scanner"));
      advance("direct and SET-reachable inherited protected-table and budget ACL rejection");
      await queryAdmin(`GRANT ${identifier(inherited)} TO ${identifier(dormant)} WITH INHERIT TRUE, SET FALSE;
        GRANT ${identifier(dormant)} TO ${identifier(writer)} WITH INHERIT FALSE, SET TRUE;
        GRANT USAGE ON SCHEMA "${schema}" TO ${identifier(dormant)},${identifier(inherited)};
        GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO ${identifier(dormant)},${identifier(inherited)};`);
      const reachable = (await queryAdmin("SELECT pg_has_role($1,$2,'SET') reachable,pg_has_role($1,$3,'SET') inner_reachable",[writer,dormant,inherited])).rows[0];
      expect(reachable).toEqual({reachable:true,inner_reachable:false});
      for (const role of [writer,inherited]) {
        for (const table of POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES) {
          advance("authority ACL "+(role===writer ? "direct: " : "SET/inherited: ")+table);
          const column = (await queryAdmin("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum LIMIT 1",[q(table)])).rows[0]!.attname;
          for (const privilege of ["UPDATE",`UPDATE("${column}")`]) {
            await queryAdmin(`GRANT ${privilege} ON TABLE ${q(table)} TO ${identifier(role)}`);
            await rejection(() => runtime!.probe(),privilegeRefusal);
            await queryAdmin(`REVOKE ${privilege} ON TABLE ${q(table)} FROM ${identifier(role)}`);
            if (role === writer) evidence.directAuthorityRejects++; else evidence.reachableAuthorityRejects++;
          }
        }
        advance("immutable budget ACL "+(role===writer ? "direct" : "SET/inherited"));
        const columns = (await queryAdmin("SELECT attname,atthasdef FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",[q("wallet_service_provider_budgets")])).rows;
        expect(columns.find(row => row.attname === "cooldown_until")!.atthasdef).toBe(false);
        for (const column of columns.filter(row => !["window_started_at","requests_used","cooldown_until"].includes(String(row.attname)))) {
          await rejection(() => runtime!.run(tx => tx.query(`UPDATE ${q("wallet_service_provider_budgets")} SET "${column.attname}"="${column.attname}" WHERE false`)),error => sqlState(error)==="42501");
          await queryAdmin(`GRANT UPDATE("${column.attname}") ON TABLE ${q("wallet_service_provider_budgets")} TO ${identifier(role)}`);
          await rejection(() => runtime!.probe(),privilegeRefusal);
          await queryAdmin(`REVOKE UPDATE("${column.attname}") ON TABLE ${q("wallet_service_provider_budgets")} FROM ${identifier(role)}`);
          evidence.budgetAclRejects++;
        }
        for (const privilege of ["INSERT","UPDATE","DELETE","INSERT(requests_used)","REFERENCES(requests_used)"]) {
          await queryAdmin(`GRANT ${privilege} ON TABLE ${q("wallet_service_provider_budgets")} TO ${identifier(role)}`);
          await rejection(() => runtime!.probe(),privilegeRefusal);
          await queryAdmin(`REVOKE ${privilege} ON TABLE ${q("wallet_service_provider_budgets")} FROM ${identifier(role)}`);
          evidence.budgetAclRejects++;
        }
      }
      await queryAdmin(`REVOKE ${identifier(dormant)} FROM ${identifier(writer)};`);
      await runtime.probe();
      advance("fake schema ledger view runtime/installer refusal");
      await queryAdmin(`BEGIN;ALTER TABLE ${q("business_schema_ledger")} RENAME TO rehearsal_original_ledger;
        CREATE VIEW ${q("business_schema_ledger")} AS SELECT * FROM ${q("rehearsal_original_ledger")};
        GRANT SELECT ON TABLE ${q("business_schema_ledger")} TO ${identifier(writer)},${identifier(reader)};COMMIT;`);
      await rejection(() => runtime!.probe(),error => error instanceof Error && error.message.includes("permanent ordinary tables"));
      await runtime.close();runtime = undefined;
      await adminPool.end();adminPool = undefined;
      migrationPool = pool();migrationPool.on("error",() => undefined);
      await rejection(() => installPostgresServiceSchema(createPostgresUnitOfWork(migrationPool!,{statementTimeoutMs:3000,lockTimeoutMs:500}),install),
        error => error instanceof Error && error.message.includes("permanent ordinary tables"));
      await migrationPool.end();migrationPool=undefined;
      admin(`BEGIN;DROP VIEW ${q("business_schema_ledger")};ALTER TABLE ${q("rehearsal_original_ledger")} RENAME TO business_schema_ledger;COMMIT;`,database);
      advance("dedicated migration runtime and lossless preservation physical commit/failure replay");
      adminPool=new Pool({host:"127.0.0.1",port,database,user:"postgres",password:bootstrapPassword,max:1,
        connectionTimeoutMillis:2000,idleTimeoutMillis:500,query_timeout:3000,options:"-c statement_timeout=3000 -c lock_timeout=500"});adminPool.on("error",() => undefined);
      sourceFixture=preservationFixture(nonce);
      let fault:"none"|"afterRows"|"chunkCommitLoss"|"holdMarkerCommit"|"markerCommitLoss"="none",faultApplied=false;
      let chunkTouched=false,markerTouched=false,physicalCommits=0;
      let releaseHeldCommit: (() => void)|undefined,notifyHeldCommit: (() => void)|undefined;
      let holdPromise:Promise<void>|undefined;
      const tracedPoolForPhase=():PostgresPool & {end():Promise<void>} => {
      const rawMigrationPool=pool();rawMigrationPool.on("error",() => undefined);
      migrationPool=rawMigrationPool;
      return {end:() => rawMigrationPool.end(),async connect() {
        const client=await rawMigrationPool.connect();
        return {release:error => client.release(error),
          on(event:string,listener:(error:Error) => void) { (client as unknown as {on(event:string,listener:(error:Error) => void):unknown}).on(event,listener);return this; },
          removeListener(event:string,listener:(error:Error) => void) { (client as unknown as {removeListener(event:string,listener:(error:Error) => void):unknown}).removeListener(event,listener);return this; },
          async query(sql,values) {
          if (sql==="BEGIN") {chunkTouched=false;markerTouched=false;}
          const result=await client.query(sql,values);
          if (sql.includes("preservation:insertChunk")) chunkTouched=true;
          if (/INSERT INTO.*migration_cutover_transitions/s.test(sql)) markerTouched=true;
          if (fault==="afterRows" && !faultApplied && sql.includes("preservation:insertRows")) {faultApplied=true;throw new Error("synthetic rows failure after physical INSERT");}
          if (sql==="COMMIT") {
            physicalCommits++;
            if (!faultApplied && ((fault==="chunkCommitLoss" && chunkTouched)||(fault==="markerCommitLoss" && markerTouched))) {
              faultApplied=true;throw new Error("synthetic lost response after physical COMMIT");
            }
            if (fault==="holdMarkerCommit" && markerTouched && !faultApplied) {faultApplied=true;notifyHeldCommit?.();await holdPromise;}
          }
          return result;
        }};
      }};
      };
      const authorizedPlans=new Set<string>();
      const makeMigration=(planSha256:string) => {
        authorizedPlans.add(planSha256);
        return createPostgresMigrationRuntime({pool:tracedPoolForPhase(),target:migrationTarget,
          capability:{mode:"isolated",purpose:"business_import",approvalRef:"synthetic-rehearsal/"+nonce,planSha256,expiresAtMs:Date.now()+180000},
          limits:{operationTimeoutMs:60000,connectionTimeoutMs:2000,statementTimeoutMs:3000,lockTimeoutMs:500,maximumSqlStatements:2000,workMemKb:1024,closeTimeoutMs:2000},clock:Date.now,
          assertAuthorized:async request => {if (request.capability.mode!=="isolated" || request.target.systemIdentifier!==systemIdentifier
            || request.target.database!==database || request.target.schema!==schema || request.target.username!==migrator || !authorizedPlans.has(request.capability.planSha256)) throw new Error("Synthetic migration approval binding refused");}});
      };
      nativeMigration=makeMigration(sourceFixture.manifestSha256);
      expect((await nativeMigration.probe()).username).toBe(migrator);
      await nativeMigration.run(async tx => {for (const ddl of createFullDataPreservationSchemaSql(schema)) await tx.query(ddl);});
      const fullImport=() => importFullDataPreservationBundle({bundleDirectory:sourceFixture!.directory,unitOfWork:nativeMigration!,target:{database,role:migrator,schema},
        executionBudget:{deadlineAtMs:Date.now()+120000,maximumTransactionMs:15000,maximumQueriesPerTransaction:200,maximumTotalQueries:4000},
        limits:{maxManifestBytes:65536,maxChunkBytes:16384,maxRowBytes:4096,maxTables:4,maxChunks:4,maxRows:7,maxTotalBytes:131072,maxSnapshotBytes:4096}});
      fault="afterRows";faultApplied=false;
      await rejection(fullImport,error => error instanceof Error && error.message==="synthetic rows failure after physical INSERT");
      expect(faultApplied).toBe(true);
      expect((await queryAdmin(`SELECT (SELECT count(*)::text FROM ${q("full_data_preservation_rows")}) rows,(SELECT count(*)::text FROM ${q("full_data_preservation_chunks")}) chunks,
        (SELECT completed FROM ${q("full_data_preservation_operations")}) completed`)).rows).toEqual([{rows:"0",chunks:"0",completed:false}]);
      fault="chunkCommitLoss";faultApplied=false;
      await rejection(fullImport,error => error instanceof PostgresCommitUncertainError);expect(faultApplied).toBe(true);
      expect((await queryAdmin(`SELECT (SELECT count(*)::text FROM ${q("full_data_preservation_rows")}) rows,(SELECT count(*)::text FROM ${q("full_data_preservation_chunks")}) chunks`)).rows).toEqual([{rows:"1",chunks:"1"}]);
      fault="none";const imported=await fullImport();expect(imported).toMatchObject({completed:true,totalTables:4,totalRows:7,totalChunks:4,committedChunks:3,resumedChunks:1,grantsBusinessEligibility:false});
      const replayed=await fullImport();expect(replayed).toMatchObject({committedChunks:0,resumedChunks:4,totalRows:7});
      for (const table of sourceFixture.tableInputs) {
        const bodies=(await queryAdmin(`SELECT row_body FROM ${q("full_data_preservation_rows")} WHERE table_name=$1 ORDER BY row_ordinal`,[table.name])).rows;
        expect(bodies.map(row => (row.row_body as Buffer).toString("utf8"))).toEqual(table.rows.map(canonical));
      }
      expect((await queryAdmin(`SELECT manifest_body,completed FROM ${q("full_data_preservation_operations")}`)).rows[0]).toEqual({manifest_body:Buffer.from(sourceFixture.manifestBody),completed:true});
      evidence.preservation={tables:4,rows:7,chunks:4,rollback:true,uncertainReconciled:true,typedBytesPreserved:true};
      advance("Mendel native cohort/provider schema contracts and real transition-store same-transaction marker");
      const importedAt=Date.now(),hash="a".repeat(64);
      const cohortPlan=(index:number) => {
        const row=sourceFixture!.registry[index]!;
        const review:PostgresCohortReview={version:1,importId:"native-cohort-"+index,approvalRef:"synthetic-rehearsal/"+nonce,
          actorId:"synthetic-approved-migration",actorAuthorizationRef:"synthetic-cohort-authorization",
          source:{operationId:sourceFixture!.operationId,snapshotSha256:sourceFixture!.crosswalk.snapshotSha256,catalogFingerprint:sourceFixture!.crosswalk.catalogFingerprint,
            reviewedRoutingSha256:sourceFixture!.crosswalk.reviewedRoutingSha256,manifestSha256:sourceFixture!.manifestSha256,
            crosswalkSha256:postgresCohortImportFingerprint(sourceFixture!.crosswalk),databaseEncoding:"UTF-8"},generationId:generation,sourceWatermark:importedAt-1000,importedAt,
          allowlist:[{entityId:row.entity,family:"evm",address:row.address,accountId:row.account,associationRow:{table:"entity_accounts",rowOrdinal:index},
            walletRow:{table:"wallet_identities",rowOrdinal:index},identityEvidenceRef:"synthetic-identity:"+index,ownershipEvidenceRef:"synthetic-ownership:"+index,effectiveAt:importedAt-1000,knownAt:importedAt-1000}]};
        return createReviewedPostgresCohortImportPlan({crosswalk:sourceFixture!.crosswalk,review,trustedReviewSha256:postgresCohortImportFingerprint(review)});
      };
      const firstPlan=cohortPlan(0),secondPlan=cohortPlan(1);
      advance("native cohort plans pinned; creating provider plan/transition store");
      const providerReview:PostgresProviderBudgetReview={version:1,importId:"native-provider-seed",approvalRef:"synthetic-rehearsal/"+nonce,generationId:generation,importedAt,
        contractRef:"synthetic-provider-contract",budgets:[{providerId:"native-provider",origin:"https://native.invalid",windowStartedAt:importedAt,windowMs:60000,maximumRequests:7,
          requestsUsed:2,maximumConcurrency:1,cooldownUntil:"9223372036854775807"}]};
      const providerPlan=createReviewedPostgresProviderBudgetSeedPlan({review:providerReview,trustedReviewSha256:postgresCohortImportFingerprint(providerReview)});
      const jointPlanHash=sha([firstPlan.planSha256,secondPlan.planSha256,providerPlan.planSha256].join(":"));
      await nativeMigration.close();nativeMigration=undefined;migrationPool=undefined;
      nativeMigration=makeMigration(jointPlanHash);
      const {systemIdentifier: _systemIdentifier,...target}=migrationTarget;
      const allowedNativePlans=new Set([firstPlan.planSha256,secondPlan.planSha256,providerPlan.planSha256]);
      const nativeOptions=(plan:typeof firstPlan|typeof providerPlan) => ({capability:{kind:"isolated" as const,purpose:plan.kind,authorizationRef:plan.approvalRef,target,
        planSha256:plan.planSha256,expiresAtMs:Date.now()+120000},assertAuthorized:async (request: Parameters<PostgresCohortTransactionApplyOptions["assertAuthorized"]>[0]) => {
          if (!allowedNativePlans.has(request.planSha256) || request.capability.kind!=="isolated" || request.generationId!==generation
            || request.capability.target.database!==database || request.capability.target.schema!==schema || request.approvalRef!=="synthetic-rehearsal/"+nonce) throw new Error("Synthetic native approval refused");},
        budget:{deadlineAtMs:Date.now()+120000,maximumTransactionMs:30000,maximumQueriesPerTransaction:400,maximumTotalQueries:2000,maximumTransactions:1,recordsPerTransaction:1,maximumImportLagMs:600000}});
      const cutoverTarget={database,schema,schemaSha256:plan.fingerprint,releaseSha256:hash,generation,serverAddress:"127.0.0.1",serverPort:5434,systemIdentifier};
      const store=createMigrationRuntimeCutoverTransitionStore({runtime:nativeMigration,target:cutoverTarget,statementTimeoutMs:3000,lockTimeoutMs:500,clock:() => new Date().toISOString()});
      const scope=(sourceKey:string) => ({sourceKey,target:cutoverTarget,deadline:new Date(Date.now()+60000).toISOString(),maximumLockMs:500,maximumSqlStatements:1000,signal:undefined});
      const state=(receiptHash:string,invalid=false):DurableCutoverState => ({version:1,revision:1,phase:"postgres-written",binding:{} as DurableCutoverState["binding"],
        policySha256:hash,planSha256:receiptHash,activationEnabled:invalid as false,preparation:null as unknown as DurableCutoverState["preparation"],snapshotTables:[],
        firstPostgresWrite:{writeId:"synthetic-first-write",receiptSha256:receiptHash,providerGuardSha256:hash,deliveryGuardSha256:hash,recordedAt:new Date().toISOString()},journal:[]});
      const firstKey=sha("synthetic-marker-first-"+nonce),secondKey=sha("synthetic-marker-uncertain-"+nonce);
      advance("native cohort/provider plus intentionally invalid marker CHECK rollback");
      await rejection(() => store.run(scope(firstKey),async tx => {
        await applyReviewedPostgresCohortImportPlanInTransaction(firstPlan,{...nativeOptions(firstPlan),transaction:tx.postgres});
        await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(providerPlan,{...nativeOptions(providerPlan),transaction:tx.postgres});
        await tx.save(0,state(jointPlanHash,true));
      }),error => sqlState(error)==="23514");
      expect((await queryAdmin(`SELECT (SELECT count(*)::text FROM ${q("wallet_service_profile_cohort")}) profiles,
        (SELECT count(*)::text FROM ${q("wallet_service_provider_budgets")} WHERE provider_id='native-provider') providers,
        (SELECT count(*)::text FROM ${q("migration_cutover_transitions")}) markers`)).rows).toEqual([{profiles:"0",providers:"0",markers:"0"}]);
      advance("native cohort/provider plus marker physical commit before acknowledgement");
      fault="holdMarkerCommit";faultApplied=false;holdPromise=new Promise(resolve => {releaseHeldCommit=resolve;});
      const commitSeen=new Promise<void>(resolve => {notifyHeldCommit=resolve;});let acknowledged=false;
      const pending=store.run(scope(firstKey),async tx => {
        const profiles=await applyReviewedPostgresCohortImportPlanInTransaction(firstPlan,{...nativeOptions(firstPlan),transaction:tx.postgres});
        const budgets=await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(providerPlan,{...nativeOptions(providerPlan),transaction:tx.postgres});
        expect(profiles).toMatchObject({stagedProfiles:1,commitState:"pending_parent_commit",grantsBusinessEligibility:false});
        expect(budgets).toMatchObject({stagedBudgets:1,commitState:"pending_parent_commit"});
        await tx.save(0,state(jointPlanHash));return {profiles,budgets};
      }).then(result => {acknowledged=true;return result;});
      // Observe physical commit independently while its response is intentionally held, not a network outage claim.
      await Promise.race([commitSeen,pending.then(() => {throw new Error("Commit hold was not reached");})]);
      try {
        expect(acknowledged).toBe(false);
        expect((await queryAdmin(`SELECT (SELECT count(*)::text FROM ${q("wallet_service_profile_cohort")}) profiles,
          (SELECT count(*)::text FROM ${q("migration_cutover_transitions")}) markers`)).rows).toEqual([{profiles:"1",markers:"1"}]);
      } finally {releaseHeldCommit!();}
      await pending;expect(acknowledged).toBe(true);
      advance("native second cohort/marker lost commit response and reconciliation");
      fault="markerCommitLoss";faultApplied=false;
      await rejection(() => store.run(scope(secondKey),async tx => {
        await applyReviewedPostgresCohortImportPlanInTransaction(secondPlan,{...nativeOptions(secondPlan),transaction:tx.postgres});await tx.save(0,state(secondPlan.planSha256));
      }),error => error instanceof PostgresCommitUncertainError);expect(faultApplied).toBe(true);
      fault="none";
      const reconciled=await store.run(scope(secondKey),async tx => {
        const marker=await tx.load();expect(marker?.planSha256).toBe(secondPlan.planSha256);
        const result=await applyReviewedPostgresCohortImportPlanInTransaction(secondPlan,{...nativeOptions(secondPlan),transaction:tx.postgres});
        expect(result).toMatchObject({stagedProfiles:0,checkedExistingProfiles:1,commitState:"pending_parent_commit"});return result;
      });
      expect(reconciled.checkedExistingProfiles).toBe(1);
      const profiles=(await queryAdmin(`SELECT subject_key,profile_payload FROM ${q("wallet_service_profile_cohort")} ORDER BY subject_key`)).rows;
      expect(profiles).toHaveLength(2);expect(profiles.map(row => row.profile_payload).sort()).toEqual([firstPlan.profiles[0]!.profilePayload,secondPlan.profiles[0]!.profilePayload].sort());
      expect((await queryAdmin(`SELECT enabled,suspended FROM ${q("wallet_service_profile_versions")} ORDER BY subject_key`)).rows).toEqual([{enabled:true,suspended:false},{enabled:false,suspended:false}]);
      expect((await queryAdmin(`SELECT count(*)::text count FROM ${q("migration_cutover_transitions")}`)).rows).toEqual([{count:"2"}]);
      evidence.nativeImport={schemaContract:true,rollbackWithMarker:true,physicalCommitBeforeAck:true,uncertainReconciled:true,profiles:2,
        cooldown:"9223372036854775807",physicalCommits};
      await nativeMigration.close();nativeMigration=undefined;migrationPool=undefined;
      const backupTables=(await queryAdmin("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname",[schema])).rows.map(row => String(row.relname));
      await adminPool.end();adminPool=undefined;
      advance("bounded custom pg_dump/pg_restore to fresh same-nonce fixture and all-table/type/ledger parity");
      evidence.backup=backupFixture(database,schema,backupTables);

    } catch (error) {
      const blocked = error instanceof Error && error.message.startsWith("BLOCKED:") ? "; " + error.message : "";
      const nestedCodes=error instanceof AggregateError ? error.errors.map(sqlState).filter(Boolean).join(",") : "";
      const publicReason=error instanceof Error && /^(?:PostgreSQL migration rejected:|postgres_cohort_import_|full_data_preservation_|Synthetic|Ambiguous actual|Actual support|Commit hold)/.test(error.message) ? "; reason="+error.message : "";
      const category=error instanceof Error ? "; category="+error.name+(nestedCodes ? "; nestedSQLSTATE="+nestedCodes : "")+publicReason : "";
      failure = new Error("Isolated actual v2 rehearsal failed at " + stage + "; run=" + nonce + blocked + category + (sqlState(error) ? "; SQLSTATE="+sqlState(error) : ""));
    } finally {
      let cleanupFailed = false;
      for (const close of [() => runtime?.close(),async () => {if (nativeMigration) {await nativeMigration.close();migrationPool=undefined;} else await migrationPool?.end();},() => adminPool?.end()]) {
        try { await close(); } catch {cleanupFailed = true;}
      }
      try {sourceFixture?.cleanup();} catch {cleanupFailed=true;}
      if (tunnel) await stopTunnel(tunnel);
      if (cleanupNeeded) {try {removeCluster();evidence.cleaned=true;} catch {cleanupFailed=true;}}
      if (!cleanupFailed) process.off("exit",emergencyCleanup);
      if (cleanupFailed) throw new Error("Owned ephemeral cluster cleanup could not be confirmed; preserve run="+nonce+(failure ? "; "+failure.message : ""));
    }
    // Only counts, public schema digest and observed capacity. Never SQL, URLs or credentials.
    console.info("Private PG16 rehearsal evidence",JSON.stringify(evidence));
    if (failure) throw failure;
  },900000);
});
