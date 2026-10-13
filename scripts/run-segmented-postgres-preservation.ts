import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createPostgresUnitOfWork, type PostgresPool, type PostgresResult, type PostgresClient } from "../packages/database/src/postgres-unit-of-work.js";
import { verifyFullDataPreservationManifest, withFullDataPreservationSourceReader } from "../packages/database/src/postgres-full-data-import.js";
import { importStagedFullDataPreservationSegment } from "../packages/database/src/postgres-staged-full-data-import.js";
import { verifyStagedFullDataPreservationSegment, finalizeStagedFullDataPreservation,
  createStagedPreservationCompletionSchemaSql, type StagedPreservationFreezeBinding, type StagedPreservationFreezePorts,
  type StagedPreservationArtifactTrust, type StagedPreservationParityArtifact } from "../packages/database/src/postgres-staged-preservation-parity.js";
import { calibratePreservationChunk } from "./calibrate-postgres-preservation-chunk.js";
import type { PreservationRehearsalConfig } from "./rehearse-postgres-full-preservation.js";
import { createPacedPreservationSourceReader, immutablePreservationDirectory } from "./preservation-source-reader.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => { throw new Error("segmented_entry_" + code); };
function requireValue(value: unknown, code: string): asserts value { if (!value) fail(code); }
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const segmentedSourcePins = Object.freeze({ manifestSha256: "d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c",
  snapshotSha256: "d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7",
  catalogFingerprint: "6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5", tables: 141, rows: 6023033, chunks: 1548 });
export interface SegmentedEntryConfig {
  version: 2; nonce: string; stage: "calibrate" | "import" | "verify" | "finalize"; sessionId: string;
  connection: { host: "127.0.0.1"; port: 5434; database: string; username: string; password: string; systemIdentifier: string };
  host: "127.0.0.1"; port: 5434; database: string; username: string; systemIdentifier: string;
  invocation: SegmentedInvocation;
  schema: string; runnerSha256: string; sourceReaderSha256: string; authorityModuleSha256: string;
  selection?: { startChunkIndex: number; endChunkIndexExclusive: number };
  binding?: StagedPreservationFreezeBinding;
  freezeBarrier?: { backendPid: number; epoch: string };
  proofFiles?: readonly { name: string; artifactSha256: string }[];
  proofRequests?: readonly string[];
  calibrationTarget?: PreservationRehearsalConfig["target"];
}
export interface SegmentedInvocation { requestNonce: string; deadlineAtMs: number; timeoutMs: number }
export interface SegmentedEntryTrust {
  freeze: StagedPreservationFreezePorts;
  evidence?: StagedPreservationArtifactTrust;
  readArtifact?: (name: string, expectedSha256: string) => Promise<Uint8Array>;
}
export function validateSegmentedEntry(config: SegmentedEntryConfig, invocation: SegmentedInvocation, now = Date.now()) {
  requireValue(config?.version === 2 && /^[a-f0-9]{16}$/.test(config.nonce) && /^[a-f0-9]{16}$/.test(invocation.requestNonce), "identity");
  requireValue(["calibrate", "import", "verify", "finalize"].includes(config.stage) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.sessionId), "stage");
  requireValue(integer(invocation.timeoutMs, 10001, config.stage === "calibrate" ? 180000 : 900000) && integer(invocation.deadlineAtMs, now + 10001, now + invocation.timeoutMs), "budget");
  const database = "radar_rehearsal_" + config.nonce;
  const role = database + (["calibrate","import"].includes(config.stage) ? "_migrator" : config.stage === "verify" ? "_verifier" : "_finalizer");
  requireValue(config.connection?.host === "127.0.0.1" && config.connection.port === 5434 && config.connection.database === database &&
    config.schema === database + "_schema" && config.connection.username === role && /^[0-9]{1,20}$/.test(config.connection.systemIdentifier) &&
    /^[a-f0-9]{64}$/.test(config.connection.password), "target");
  requireValue(config.host === config.connection.host && config.port === config.connection.port && config.database === config.connection.database &&
    config.username === config.connection.username && config.systemIdentifier === config.connection.systemIdentifier, "credential_binding");
  requireValue([config.runnerSha256, config.sourceReaderSha256, config.authorityModuleSha256].every(isHash), "code_pins");
  if (["import","verify"].includes(config.stage)) requireValue(config.selection && integer(config.selection.startChunkIndex, 0, 1547) &&
    integer(config.selection.endChunkIndexExclusive, config.selection.startChunkIndex + 1, 1548), "selection");
  if (["verify","finalize"].includes(config.stage)) {
    const b = config.binding;
    requireValue(b && b.sessionId === config.sessionId && b.snapshotSha256 === segmentedSourcePins.snapshotSha256 &&
      b.manifestSha256 === segmentedSourcePins.manifestSha256 && b.target.database === database && b.target.schema === config.schema &&
      b.target.endpoint === "127.0.0.1:5434" && b.target.systemIdentifier === config.connection.systemIdentifier && isHash(b.freezeEvidenceSha256), "freeze_binding");
  }
  if (config.stage === "finalize" && !config.proofRequests) requireValue(Array.isArray(config.proofFiles) && config.proofFiles.length > 0 && config.proofFiles.length <= 1548 &&
    new Set(config.proofFiles.map(p => p.name)).size === config.proofFiles.length && config.proofFiles.every(p => /^[a-f0-9]{16}-verify\.proof\.json$/.test(p.name) && isHash(p.artifactSha256)), "proof_files");
  if (config.proofRequests) requireValue(config.stage === "finalize" && config.proofRequests.length > 0 && config.proofRequests.length <= 1548 &&
    new Set(config.proofRequests).size === config.proofRequests.length && config.proofRequests.every(x => /^[a-f0-9]{16}$/.test(x)), "proof_requests");
  return config;
}


export const finalizerLedgerPolicy = Object.freeze({
  full_data_preservation_operations: { operation: "UPDATE", columns: ["completed"] },
  full_data_preservation_tables: { operation: "UPDATE", columns: ["verified_chunk_count", "verified_manifest_sha256", "verified_row_count"] },
  full_data_preservation_staged_completions: { operation: "INSERT", columns: ["boundary_sha256", "freeze_epoch", "manifest_sha256", "operation_id", "proofs_sha256", "session_id", "snapshot_sha256"] },
});
const preservationRelations = ["full_data_preservation_chunks", "full_data_preservation_operations", "full_data_preservation_rows", "full_data_preservation_staged_completions", "full_data_preservation_tables"];

/** Native catalogue/session checks. Establishing and retaining the owner barrier is a separate adapter obligation. */
export async function measureSegmentedDatabaseAuthority(client: PostgresClient, config: SegmentedEntryConfig) {
  requireValue(["verify","finalize"].includes(config.stage) && config.freezeBarrier && integer(config.freezeBarrier.backendPid, 1, 2147483647) &&
    config.freezeBarrier.epoch === config.binding?.freezeEpoch, "native_barrier_required");
  const result = await client.query(`WITH actor AS (SELECT * FROM pg_roles WHERE rolname=current_user),
    relations AS (SELECT c.oid,c.relname,n.nspname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f'))
    SELECT current_database() AS database,session_user AS username,current_user AS role,pg_backend_pid() AS backend_pid,
      inet_server_addr()::text AS address,inet_server_port() AS port,current_setting('transaction_read_only') AS readonly,
      EXISTS(SELECT 1 FROM actor WHERE rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS unsafe_attributes,
      (SELECT count(*)::int FROM pg_auth_members WHERE member=(SELECT oid FROM actor)) AS memberships,
      (SELECT count(*)::int FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM actor) AND deptype='o') AS owned_objects,
      has_database_privilege(current_user,current_database(),'CREATE') OR has_database_privilege(current_user,current_database(),'TEMP') OR
        EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(current_user,oid,'CREATE')) AS create_paths,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS callable_user_functions,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND (has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'UPDATE'))) AS writable_sequences,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',r.nspname,'relation',r.relname,'select',has_table_privilege(current_user,r.oid,'SELECT'),
        'table_writes',ARRAY(SELECT v FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v WHERE has_table_privilege(current_user,r.oid,v)),
        'column_writes',COALESCE((SELECT jsonb_agg(jsonb_build_object('operation',v,'column',a.attname) ORDER BY v,a.attname)
          FROM pg_attribute a CROSS JOIN unnest(ARRAY['INSERT','UPDATE','REFERENCES']) v WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,r.oid,a.attnum,v)), '[]'::jsonb)) ORDER BY r.nspname,r.relname) FROM relations r), '[]'::jsonb) AS relations,
      EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND datname=current_database() AND usename='postgres' AND application_name=$3) AS barrier_session,
      (SELECT count(DISTINCT c.relname)::int FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE l.pid=$2 AND l.granted AND n.nspname=$1 AND ((c.relname IN ('full_data_preservation_chunks','full_data_preservation_rows') AND l.mode='ShareRowExclusiveLock') OR
        (c.relname IN ('full_data_preservation_operations','full_data_preservation_tables','full_data_preservation_staged_completions') AND l.mode='RowShareLock'))) AS barrier_relations,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid NOT IN (pg_backend_pid(),$2) AND usename NOT IN ($4,$5)) AS other_sessions
    `, [config.schema, config.freezeBarrier.backendPid, "radar-preservation-freeze-" + config.nonce + "-" + config.freezeBarrier.epoch,
      config.connection.database + "_verifier", config.connection.database + "_finalizer"]);
  const row = result.rows[0];
  requireValue(result.rows.length === 1 && row && row.database === config.connection.database && row.username === config.connection.username && row.role === row.username &&
    integer(row.backend_pid,1,2147483647) && row.address === "127.0.0.1" && row.port === 5434 && row.readonly === (config.stage === "verify" ? "on" : "off"), "native_session");
  requireValue(row.unsafe_attributes === false && row.memberships === 0 && row.owned_objects === 0 && row.create_paths === false &&
    row.callable_user_functions === 0 && row.writable_sequences === 0, "native_reachable_authority");
  requireValue(row.barrier_session === true && row.barrier_relations === 5 && row.other_sessions === 0, "native_barrier_missing");
  requireValue(Array.isArray(row.relations), "native_catalogue");
  const selected = new Set<string>();
  for (const value of row.relations as {schema:string;relation:string;select:boolean;table_writes:string[];column_writes:{operation:string;column:string}[]}[]) {
    requireValue(Array.isArray(value.table_writes) && Array.isArray(value.column_writes), "native_catalogue");
    const allowed = value.schema === config.schema && preservationRelations.includes(value.relation);
    if (allowed) { requireValue(value.select === true, "native_select_acl"); selected.add(value.relation); }
    else requireValue(value.select === false, "native_extra_select");
    requireValue(value.table_writes.length === 0, "native_table_write_acl");
    const policy = config.stage === "finalize" && allowed ? finalizerLedgerPolicy[value.relation as keyof typeof finalizerLedgerPolicy] : undefined;
    const expected = policy ? policy.columns.map(column => ({ operation:policy.operation,column })) : [];
    const actual = value.column_writes.map(grant => {
      requireValue(grant && Object.keys(grant).length === 2 && typeof grant.operation === "string" && typeof grant.column === "string", "native_column_write_acl");
      return [grant.operation, grant.column];
    }).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const wanted = expected.map(grant => [grant.operation, grant.column]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    requireValue(JSON.stringify(actual) === JSON.stringify(wanted), "native_column_write_acl");
  }
  requireValue(selected.size === 5, "native_missing_relation");
  return { catalogueSha256: digest(JSON.stringify(row)), catalogue: row, observedAtMs: Date.now(), nativeSession: { database:row.database, username:row.username,
    backendPid:row.backend_pid, address:row.address, port:row.port, transactionReadOnly:row.readonly === "on" }, barrierBackendPid:config.freezeBarrier.backendPid };
}


export interface CrossWindowFreeze {
  readonly backendPid: number; readonly epoch: string; readonly identitySha256: string; readonly systemIdentifier: string; readonly database: string;
  measure(): Promise<{ backendPid: number; epoch: string; identitySha256: string; observedAtMs: number; systemIdentifier: string; database: string }>;
  close(): Promise<void>;
}
/** Retains one real owner connection and one transaction across maintenance windows.
 * The lifecycle callback must await close before releasing this connection or fixture.
 * Loss of this connection/transaction invalidates the epoch; it is never reconnected.
 */
export async function createCrossWindowFreezeBarrier(control: PostgresClient, config: SegmentedEntryConfig,
  { deadlineAtMs, timeoutMs = 180000 }: { deadlineAtMs: number; timeoutMs?: number }): Promise<CrossWindowFreeze> {
  const started = performance.now(), continuityUntil = performance.now() + deadlineAtMs - Date.now(); let closed = false, failed = false, stable = "";
  requireValue(/^[a-f0-9]{16}$/.test(config.nonce) && config.schema === "radar_rehearsal_" + config.nonce + "_schema" &&
    config.connection.database === "radar_rehearsal_" + config.nonce && config.binding?.freezeEpoch &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.binding.freezeEpoch) && integer(timeoutMs,10001,180000), "freeze_scope");
  const schema = '"' + config.schema + '"', database = '"' + config.connection.database + '"';
  const importer = '"' + config.connection.database + '_migrator"';
  const epoch = config.binding.freezeEpoch;
  const application = "radar-preservation-freeze-" + config.nonce + "-" + epoch;
  const check = () => requireValue(!closed && !failed && Date.now() < deadlineAtMs && performance.now() < continuityUntil, "freeze_continuity_lost");
  const setup = async (text: string, values?: unknown[]) => {
    requireValue(performance.now()-started < timeoutMs-10000 && Date.now()+10000 < deadlineAtMs, "freeze_setup_deadline");
    return control.query(text,values);
  };
  try {
    const identity = await setup(`SELECT current_database() AS database,current_user AS role,session_user AS username,
      pg_backend_pid() AS pid,current_setting('port')::int AS port,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
    const owner = identity.rows[0];
    requireValue(identity.rows.length===1 && owner?.database===config.connection.database && owner.role==="postgres" && owner.username==="postgres" &&
      owner.superuser===true && owner.port===5434 && owner.system_identifier===config.connection.systemIdentifier && integer(owner.pid,1,2147483647), "freeze_owner_session");
    await setup("SELECT set_config('idle_in_transaction_session_timeout','0',false)");
    await setup("BEGIN");
    await setup("SELECT set_config('statement_timeout','60000',true),set_config('lock_timeout','5000',true)");
    await setup("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[application]);
    await setup("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",[config.connection.database]);
    // Parent provisions verifier/finalizer roles and their exact ACL before invoking this freeze.
    // Completion DDL is explicit and occurs before the immutable epoch, never during verification.
    const completion = await setup("SELECT to_regclass($1)::text AS relation",[config.schema+".full_data_preservation_staged_completions"]);
    if (!completion.rows[0]?.relation) await setup(createStagedPreservationCompletionSchemaSql(config.schema));
    await setup("ALTER SCHEMA " + schema + " OWNER TO postgres");
    for (const relation of preservationRelations) await setup("ALTER TABLE " + schema + "." + relation + " OWNER TO postgres");
    await setup("ALTER ROLE " + importer + " NOLOGIN");
    await setup("REVOKE CONNECT,CREATE,TEMPORARY ON DATABASE " + database + " FROM PUBLIC," + importer);
    await setup("REVOKE ALL ON SCHEMA " + schema + " FROM " + importer);
    await setup("REVOKE ALL ON ALL TABLES IN SCHEMA " + schema + " FROM " + importer);
    await setup("COMMIT");
    // Start a new committed-ACL epoch. Its locks, not an acknowledgement boolean, exclude raw data writes.
    await setup("BEGIN");
    await setup("SELECT set_config('statement_timeout','60000',true),set_config('lock_timeout','5000',true),set_config('application_name',$1,false)",[application]);
    await setup("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[application]);
    await setup("LOCK TABLE " + schema + ".full_data_preservation_chunks," + schema + ".full_data_preservation_rows IN SHARE ROW EXCLUSIVE MODE");
    await setup("LOCK TABLE " + schema + ".full_data_preservation_operations," + schema + ".full_data_preservation_tables," + schema + ".full_data_preservation_staged_completions IN ROW SHARE MODE");
    const inspect = async () => {
      check();
      // Statistics snapshots can otherwise stay cached for this retained transaction.
      await control.query("SELECT pg_stat_clear_snapshot()");
      const result = await control.query(`SELECT pg_backend_pid() AS pid,current_database() AS database,current_user AS role,
        (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
        (SELECT xact_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_start,
        (SELECT application_name FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS application,
        (SELECT count(*)::int FROM pg_roles WHERE rolname=$2 AND rolcanlogin) AS importer_login,
        (SELECT count(*)::int FROM pg_roles WHERE rolcanlogin AND has_database_privilege(oid,current_database(),'CONNECT') AND rolname NOT IN ('postgres',$3,$4)) AS unapproved_login_roles,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename NOT IN ($3,$4)) AS other_sessions,
        (SELECT count(DISTINCT c.relname)::int FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE l.pid=pg_backend_pid() AND l.granted AND n.nspname=$1 AND ((c.relname IN ('full_data_preservation_chunks','full_data_preservation_rows') AND l.mode='ShareRowExclusiveLock') OR
          (c.relname IN ('full_data_preservation_operations','full_data_preservation_tables','full_data_preservation_staged_completions') AND l.mode='RowShareLock'))) AS locks`,
        [config.schema,config.connection.database+"_migrator",config.connection.database+"_verifier",config.connection.database+"_finalizer"]);
      const measured = result.rows[0];
      requireValue(measured,"freeze_native_continuity");
      requireValue(result.rows.length===1 && measured.pid===owner.pid && measured.database===owner.database && measured.role==="postgres" &&
        measured.system_identifier===owner.system_identifier && typeof measured.transaction_start==="string" && measured.transaction_start.length>0 &&
        measured.application===application && measured.importer_login===0 && measured.unapproved_login_roles===0 && measured.other_sessions===0 && measured.locks===5, "freeze_native_continuity");
      const identitySha256 = digest(JSON.stringify({nonce:config.nonce,database:measured.database,systemIdentifier:measured.system_identifier,
        backendPid:measured.pid,transactionStart:measured.transaction_start,application:measured.application,epoch}));
      requireValue(!stable || stable===identitySha256,"freeze_epoch_changed"); stable=identitySha256;
      return {backendPid:Number(owner.pid),epoch,identitySha256,observedAtMs:Date.now(),systemIdentifier:String(measured.system_identifier),database:String(measured.database)};
    };
    const first = await inspect();
    return Object.freeze({ ...first, async measure() {
      try { return await inspect(); } catch(error) { failed=true; throw error; }
    }, async close() {
      if(closed)return; closed=true;
      try { await control.query("ROLLBACK"); } finally { control.release(failed ? new Error("segmented_entry_freeze_continuity_lost") : undefined); }
    } });
  } catch(error) {
    failed=true;
    try { await control.query("ROLLBACK"); } finally { control.release(error instanceof Error ? error : new Error("segmented_entry_freeze_failed")); }
    throw error;
  }
}


function canonicalAuthority(value: unknown): string {
  if (value===null || typeof value!=="object") return JSON.stringify(value);
  if (Array.isArray(value)) return "["+value.map(canonicalAuthority).join(",")+"]";
  return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonicalAuthority((value as Record<string,unknown>)[key])).join(",")+"}";
}
async function nativeFilePin(path: string, root: string, maximum: number) {
  const bytes = await protectedFile(path,root,maximum);
  const handle = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat(), reread=await handle.readFile(), after=await handle.stat();
    requireValue(before.dev===after.dev && before.ino===after.ino && before.mtimeMs===after.mtimeMs && before.ctimeMs===after.ctimeMs &&
      digest(bytes)===digest(reread),"authority_file_race");
    return {bytes,pin:{identity:[before.dev,before.ino],sha256:digest(bytes)}};
  } finally {await handle.close();}
}
/** Generates helper AuthorityV2 only from a native credential session and retained native owner barrier.
 * Caller publishes these bytes under the verified control writer lock, never as artifact code/config after seal.
 */
export async function generateManagedDatabaseAuthority(configPath: string, executionPath: string, recordSha256: string,
  credentialSession: PostgresClient, barrier: CrossWindowFreeze, fileSource?: {
    artifact(path: string): Promise<{ bytes: Buffer; pin: { identity: number[]; sha256: string } }>;
    execution(): Promise<{ path: string; identity: number[]; sha256: string }>;
    invocation?: SegmentedInvocation;
  }) {
  const match=/^\/var\/lib\/address-radar-rehearsal-artifacts\/([a-f0-9]{16})\/([A-Za-z0-9_-]+\.json)$/.exec(configPath);
  requireValue(match && isHash(recordSha256) && executionPath==="/usr/bin/python3", "authority_scope");
  const root="/var/lib/address-radar-rehearsal-artifacts/"+match[1];
  const artifact = fileSource?.artifact ?? ((path: string) => nativeFilePin(path,root,2097152));
  const stored=await artifact(configPath), config=JSON.parse(stored.bytes.toString("utf8")) as SegmentedEntryConfig;
  requireValue(stored.bytes.length<=1048576 && digest(stored.bytes)===stored.pin.sha256,"authority_config_pin");
  validateSegmentedEntry(config,fileSource?.invocation ?? config.invocation);
  requireValue(config.nonce===match[1] && ["verify","finalize"].includes(config.stage), "authority_role");
  const before=await barrier.measure();
  config.freezeBarrier = { backendPid: before.backendPid, epoch: before.epoch };
  config.binding = {...config.binding!,freezeEvidenceSha256:before.identitySha256};
  requireValue(config.freezeBarrier?.backendPid===before.backendPid && config.freezeBarrier.epoch===before.epoch &&
    config.connection.systemIdentifier===before.systemIdentifier && config.connection.database===before.database,"authority_barrier_binding");
  const measured=await measureSegmentedDatabaseAuthority(credentialSession,config), after=await barrier.measure();
  requireValue(before.identitySha256===after.identitySha256,"authority_barrier_changed");
  const adapterPath=root+"/segmented-runner.mjs", adapter=await artifact(adapterPath);
  requireValue(adapter.pin.sha256===config.runnerSha256,"authority_adapter_pin");
  // Interpreter binaries are root protected but need not be mode 0600 like credential/code artifacts.
  let executionPin;
  if (fileSource) { executionPin=await fileSource.execution(); requireValue(/^\/usr\/bin\/python3(?:\.[0-9]+)?$/.test(executionPin.path) && isHash(executionPin.sha256) && executionPin.identity.length===2 && executionPin.identity.every(value=>integer(value,0,Number.MAX_SAFE_INTEGER)),"authority_execution_pin"); }
  else {
  const actualExecution=await realpath(executionPath);
  for(let directory=dirname(actualExecution);directory!=="/";directory=dirname(directory)) {
    const info=await lstat(directory);requireValue(info.isDirectory() && info.uid===0 && !(info.mode&0o022),"authority_execution_ancestor");
  }
  const executable=await open(actualExecution,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const info=await executable.stat();requireValue(info.isFile() && info.uid===0 && info.nlink===1 && !(info.mode&0o022) && info.size<=268435456,"authority_execution_pin");
    executionPin={path:actualExecution,identity:[info.dev,info.ino],sha256:digest(await executable.readFile())};
  } finally {await executable.close();}
  }
  const actualExecution=executionPin.path;
  const role=config.stage==="verify"?"verifier":"finalizer", launcher=root+"/launch-segmented-postgres-preservation.py";
  const entryBytes=await artifact(launcher);
  requireValue(entryBytes.bytes.length>0,"authority_launcher_pin");
  const catalogue=measured.catalogue;
  const relations=catalogue.relations as {schema:string;relation:string;select:boolean;column_writes:{operation:string;column:string}[]}[];
  const policyOrder=["full_data_preservation_operations","full_data_preservation_tables","full_data_preservation_staged_completions"] as const;
  const writeGrants=role==="finalizer" ? policyOrder.map(relation=>{
    const actual=relations.find(r=>r.schema===config.schema && r.relation===relation)!;
    const policy=finalizerLedgerPolicy[relation];
    return {relation:config.schema+"."+relation,operation:policy.operation,columns:actual.column_writes.map(g=>g.column).sort()};
  }):[];
  const ledgerTargets=role==="finalizer" ? Object.fromEntries(["operations","tables","completion"].map((key,index)=>
    [key,{relation:writeGrants[index]!.relation,columns:writeGrants[index]!.columns}])):null;
  const measurement={adapter_pin:{path:adapterPath,...adapter.pin},catalog_sha256:measured.catalogueSha256,
    session:{session_user:catalogue.username,current_user:catalogue.role,database:catalogue.database,system_identifier:before.systemIdentifier,
      backend_pid:catalogue.backend_pid,transaction_read_only:catalogue.readonly==="on"},reachable_roles:[catalogue.role],owned_objects:[],
    unsafe_role_attributes:[],set_reachable_write_paths:[],write_grants:writeGrants,measured_at:Math.floor(measured.observedAtMs/1000),
    ...(role==="finalizer"?{select_grants:relations.filter(r=>r.select).map(r=>r.schema+"."+r.relation).sort()}: {})};
  const proof={version:2,nonce:config.nonce,record_sha256:recordSha256,request_nonce:config.invocation.requestNonce,role,
    config_relative:basename(configPath),config_pin:stored.pin,credential_ref:digest(stored.bytes),system_identifier:before.systemIdentifier,
    username:catalogue.username,entry:{code_relative:basename(launcher),execution_pin:executionPin,
      argv_sha256:digest(canonicalAuthority([actualExecution,launcher,configPath])),kind:role==="verifier"?"readonly-verifier":"native-ledger-uow"},
    measurement,ledger_targets:ledgerTargets};
  const bytes=Buffer.from(canonicalAuthority(proof));
  requireValue(bytes.length<=1048576,"authority_size");
  return {bytes,sha256:digest(bytes),name:role==="verifier"?"db-readonly.json":"ledger-authority.json",
    barrierIdentitySha256:before.identitySha256};
}

/** Test seams replace native calls only in local tests; the CLI fixes every implementation below. */
export async function executeSegmentedEntry(config: SegmentedEntryConfig, invocation: SegmentedInvocation, dependencies: {
  pool: PostgresPool & { end(): Promise<void> };
  reader: Awaited<ReturnType<typeof createPacedPreservationSourceReader>>;
  trust?: SegmentedEntryTrust;
  native?: { importSegment: typeof importStagedFullDataPreservationSegment; verifySegment: typeof verifyStagedFullDataPreservationSegment; finalize: typeof finalizeStagedFullDataPreservation };
  clock?: () => number; monotonic?: () => number;
}) {
  const clock = dependencies.clock ?? Date.now, monotonic = dependencies.monotonic ?? (() => performance.now());
  const started = monotonic();
  const metrics = { finalizeAttempts: 0, acknowledgedFinalizations: 0, physicalSqlStatements: 0, commitAttempts: 0, acknowledgedCommits: 0, acknowledgedRollbacks: 0, uncertainCommit: false };
  const native = dependencies.native ?? { importSegment: importStagedFullDataPreservationSegment, verifySegment: verifyStagedFullDataPreservationSegment, finalize: finalizeStagedFullDataPreservation };
  const checkpoint = (released = false, allocationBytes = 0) => {
    requireValue(clock() < invocation.deadlineAtMs && monotonic() - started < invocation.timeoutMs - 10000, "deadline");
    requireValue(process.memoryUsage().rss <= 268435456, "rss");
    if (released || allocationBytes >= 256 * 1024) (globalThis as { gc?: () => void }).gc?.();
  };
  try {
    validateSegmentedEntry(config, invocation, clock()); checkpoint();
    const manifestBytes = await dependencies.reader.read(immutablePreservationDirectory, "manifest.json", 16777216);
    requireValue(digest(manifestBytes) === segmentedSourcePins.manifestSha256, "source_manifest");
    const manifest = verifyFullDataPreservationManifest(manifestBytes);
    requireValue(manifest.value.snapshotSha256 === segmentedSourcePins.snapshotSha256 && manifest.value.catalogFingerprint === segmentedSourcePins.catalogFingerprint &&
      manifest.value.tables.length === 141 && manifest.totalRows === 6023033 && manifest.totalChunks === 1548, "source_pins");
    if (config.binding) requireValue(config.binding.operationId === manifest.value.operationId, "operation_binding");
    const pool: PostgresPool = { async connect() {
      checkpoint(); const client = await dependencies.pool.connect();
      try {
        metrics.physicalSqlStatements++;
        const identity = await client.query(`SELECT current_database() AS database, session_user AS username, current_user AS role,
          r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,
          (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
          (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=$1) AS schema_owner
          FROM pg_roles r WHERE rolname=current_user`, [config.schema]);
        const row = identity.rows[0];
        requireValue(identity.rows.length === 1 && row?.database === config.connection.database && row.username === config.connection.username && row.role === row.username &&
          row.rolsuper === false && row.rolcreaterole === false && row.rolcreatedb === false && row.rolreplication === false && row.rolbypassrls === false &&
          row.memberships === 0 && (row.schema_owner === "postgres" || (["calibrate","import"].includes(config.stage) && row.schema_owner === config.connection.username)), "native_role");
        if (["verify","finalize"].includes(config.stage)) { metrics.physicalSqlStatements++; await measureSegmentedDatabaseAuthority(client, config); }
      } catch (error) { client.release(error instanceof Error ? error : new Error("segmented_entry_native_role")); throw error; }
      return { release: error => client.release(error), async query(text: string, values?: unknown[]): Promise<PostgresResult> {
        checkpoint(); metrics.physicalSqlStatements++;
        if (text === "COMMIT") metrics.commitAttempts++;
        try { const result = await client.query(text, values); if (text === "COMMIT") metrics.acknowledgedCommits++; if (text === "ROLLBACK") metrics.acknowledgedRollbacks++; return result; }
        catch (error) { if (text === "COMMIT") metrics.uncertainCommit = true; throw error; }
      } };
    } };
    const common = { bundleDirectory: immutablePreservationDirectory, unitOfWork: createPostgresUnitOfWork(pool, { statementTimeoutMs: 60000, lockTimeoutMs: 5000 }),
      target: { database: config.connection.database, schema: config.schema, role: config.connection.username },
      executionBudget: { deadlineAtMs: invocation.deadlineAtMs - 10000, maximumTransactionMs: 60000, maximumQueriesPerTransaction: 10000,
        maximumTotalQueries: 1000000, opaqueRowWindows: { maximumRows: 256, maximumBytes: 262144 } }, checkpoint };
    const result = await withFullDataPreservationSourceReader(dependencies.reader, async () => {
      if(config.stage === "calibrate") {
        const target=config.calibrationTarget;
        requireValue(target && target.database===config.database && target.schema===config.schema && target.username===config.username &&
          target.systemIdentifier===config.systemIdentifier && target.serverPort===5434 && target.serverAddress==="127.0.0.1","calibration_target");
        const approvalRef="human-backup-derived-isolated-segmented";
        const calibration: PreservationRehearsalConfig={version:1,stage:"import",bundleDirectory:immutablePreservationDirectory,
          evidenceDirectory:"/var/lib/address-radar-rehearsal-artifacts/"+config.nonce+"/evidence",storagePath:"/tmp/radar_rehearsal_"+config.nonce+"/data",
          authorityModule:"/var/lib/address-radar-rehearsal-artifacts/"+config.nonce+"/segmented-runner.mjs",authorityModuleSha256:config.runnerSha256,
          approvalRef,deadlineAtMs:invocation.deadlineAtMs-10000,expected:segmentedSourcePins,target,
          resources:{reserveBytes:5368709120,maximumTargetGrowthBytes:21474836480,minimumAvailableMemoryBytes:1073741824,
            maximumRssBytes:268435456,maximumMemoryPsiAvg10:1,maximumResidentChunkBytes:16775058},
          maximumTotalQueries:1000000,maximumTransactionMs:60000,maximumQueriesPerTransaction:10000,interruptAfterCommittedChunks:2};
        return calibratePreservationChunk(calibration,{pool:{...pool,end:async()=>{}},assertAuthorized:async request=>{
          checkpoint();requireValue(canonicalAuthority(request.target)===canonicalAuthority(target) && request.capability.mode==="isolated" &&
            request.capability.purpose==="schema_install" && request.capability.planSha256===segmentedSourcePins.manifestSha256 &&
            request.capability.approvalRef===approvalRef && request.capability.expiresAtMs<=calibration.deadlineAtMs,"calibration_capability");
        }});
      }
      if (config.stage === "import") return native.importSegment({ ...common, sessionId: config.sessionId, selection: config.selection!, closeReserveMs: 10000 });
      requireValue(dependencies.trust?.freeze && typeof dependencies.trust.freeze.readLiveMeasurement === "function" && typeof dependencies.trust.freeze.verifyMeasurement === "function", "measured_freeze_required");
      const parity = { ...common, binding: config.binding!, freeze: dependencies.trust.freeze, closeReserveMs: 10000, maximumEvidenceAgeMs: 10800000 };
      if (config.stage === "verify") return native.verifySegment({ ...parity, selection: config.selection! });
      requireValue(dependencies.trust.evidence && typeof dependencies.trust.evidence.verifyArtifact === "function" && dependencies.trust.readArtifact, "protected_provenance_required");
      const proofs: StagedPreservationParityArtifact[] = []; let total = 0;
      for (const reference of config.proofFiles!) {
        checkpoint(); const bytes = await dependencies.trust.readArtifact(reference.name, reference.artifactSha256);
        requireValue(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 4194304 && digest(bytes) === reference.artifactSha256, "artifact_pin");
        total += bytes.length; requireValue(total <= 67108864, "artifact_total");
        proofs.push({ artifactSha256: reference.artifactSha256, bytes });
      }
      metrics.finalizeAttempts++;
      const finalized=await native.finalize({ ...parity, proofs, evidence: dependencies.trust.evidence });
      if(finalized.completionOutcome==="acknowledged" && !metrics.uncertainCommit)metrics.acknowledgedFinalizations++;
      return finalized;
    });
    checkpoint();
    let counts;
    if(config.stage==="finalize") {
      const actor=await pool.connect();
      try {
        const aggregate=await actor.query('SELECT (SELECT count(*)::int FROM "'+config.schema+'".full_data_preservation_tables) AS tables, (SELECT count(*)::int FROM "'+config.schema+'".full_data_preservation_chunks) AS chunks, (SELECT count(*)::int FROM "'+config.schema+'".full_data_preservation_rows) AS rows');
        counts=aggregate.rows[0];requireValue(aggregate.rows.length===1 && counts?.tables===141 && counts.chunks===1548 && counts.rows===6023033,"native_aggregate_counts");
      } finally {actor.release();}
    }
    const plans=manifest.value.tables.flatMap(table=>table.chunks);
    let segment;
    if(config.stage==="import") {
      const imported=result as Awaited<ReturnType<typeof importStagedFullDataPreservationSegment>>;
      const selected=plans.slice(imported.selection.startChunkIndex,imported.nextChunkIndex);
      segment={startChunk:imported.selection.startChunkIndex,endChunk:imported.nextChunkIndex,
        rows:selected.reduce((sum,chunk)=>sum+chunk.rowCount,0),sourceSha256:digest(canonicalAuthority(selected.map(p=>({sha256:p.sha256,rowCount:p.rowCount}))))};
    } else if(config.stage==="verify") {
      const verified=JSON.parse(Buffer.from((result as StagedPreservationParityArtifact).bytes).toString("utf8"));
      const sourceSha256=digest(canonicalAuthority(verified.chunks));
      segment={startChunk:verified.selection.startChunkIndex,endChunk:verified.selection.endChunkIndexExclusive,
        rows:verified.chunks.reduce((sum:number,p:{rowCount:number})=>sum+p.rowCount,0),sourceSha256,targetSha256:sourceSha256};
    }
    if (config.stage === "finalize") requireValue("completed" in result && result.completed === true && "completionOutcome" in result &&
      ["acknowledged", "reconciled"].includes(result.completionOutcome), "native_completion");
    else requireValue(!("completed" in result && result.completed === true), "premature_completion");
    return { version: 2, stage: config.stage, requestNonce: invocation.requestNonce, expected: segmentedSourcePins,
      target: { database: config.connection.database, schema: config.schema, role: config.connection.username, systemIdentifier: config.connection.systemIdentifier },
      ...(counts ? { counts } : {}), ...(segment ? { segment } : {}), nativeMetrics: metrics, sourceReader: { ...dependencies.reader.metrics },
      result: config.stage === "verify" ? { artifactSha256: (result as StagedPreservationParityArtifact).artifactSha256,
        artifactBase64: Buffer.from((result as StagedPreservationParityArtifact).bytes).toString("base64") } : result,
      parityComplete: config.stage === "finalize", productionAuthorized: false, grantsBusinessEligibility: false };
  } finally {
    try { await dependencies.reader.close(); } finally { await dependencies.pool.end(); }
  }
}

async function protectedFile(path: string, root: string, maximum: number) {
  requireValue(path.startsWith(root + "/") && await realpath(path) === path, "protected_path");
  for (let directory = dirname(path); directory !== "/"; directory = dirname(directory)) {
    const info = await lstat(directory); requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), "protected_ancestor");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); requireValue(info.isFile() && info.uid === 0 && info.nlink === 1 && !(info.mode & 0o077) && info.size > 0 && info.size <= maximum, "protected_file"); return await handle.readFile(); }
  finally { await handle.close(); }
}
async function main() {
  requireValue(process.getuid?.() === 0 && process.argv.length === 3, "arguments");
  const configPath = process.argv[2]!;
  const match = /^\/var\/lib\/address-radar-rehearsal-artifacts\/([a-f0-9]{16})\/[a-zA-Z0-9_-]+\.json$/.exec(configPath);
  requireValue(match, "config_path"); const root = "/var/lib/address-radar-rehearsal-artifacts/" + match[1];
  const raw = await protectedFile(configPath, root, 1048576);
  const config = JSON.parse(raw.toString("utf8")) as SegmentedEntryConfig;
  requireValue(config.nonce === match[1], "config_nonce");
  const { requestNonce } = config.invocation;
  const control = "/var/lib/address-radar-rehearsal-artifact-control/" + config.nonce;
  const authorityFile = ["calibrate","import"].includes(config.stage) ? "prepared-configs.json" : config.stage === "verify" ? "db-readonly.json" : "ledger-authority.json";
  const admission = JSON.parse((await protectedFile(control + "/" + authorityFile, control, 1048576)).toString("utf8"));
  const role = ["calibrate","import"].includes(config.stage) ? "producer" : config.stage === "verify" ? "verifier" : "finalizer";
  const managed = JSON.parse((await protectedFile(control + "/invocations/" + requestNonce + "-" + role + ".request.json", control, 16384)).toString("utf8"));
  const invocation = deriveManagedInvocation(config, managed);
  const relative = configPath.slice(root.length + 1);
  requireValue(["calibrate","import"].includes(config.stage) ? admission.version === 1 && admission.nonce === config.nonce && admission.configs?.[relative] === digest(raw) :
    admission.version === 2 && admission.nonce === config.nonce && admission.request_nonce === requestNonce && admission.config_relative === relative &&
    admission.credential_ref === digest(raw) && admission.username === config.username, "config_pin");
  const authorityPath = root + "/segmented-authority.mjs", readerPath = root + "/source-reader.py";
  requireValue(digest(await protectedFile(root + "/segmented-runner.mjs", root, 2097152)) === config.runnerSha256 &&
    digest(await protectedFile(readerPath, root, 2097152)) === config.sourceReaderSha256 &&
    digest(await protectedFile(authorityPath, root, 2097152)) === config.authorityModuleSha256, "runtime_pins");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ host: config.connection.host, port: config.connection.port, database: config.connection.database,
    user: config.connection.username, password: config.connection.password, max: 1, connectionTimeoutMillis: 5000, query_timeout: 60000,
    application_name: "radar-segment-" + requestNonce, options: config.stage === "verify" ? "-c default_transaction_read_only=on" : "" });
  let trust: SegmentedEntryTrust | undefined;
  try {
    if (config.stage !== "import") {
      const epoch = JSON.parse((await protectedFile(control + "/freeze-binding.json", control, 16384)).toString("utf8"));
      requireValue(epoch.recordSha256 === managed.record_sha256 && epoch.nonce === config.nonce &&
        canonicalAuthority({...epoch.binding,freezeEvidenceSha256:config.binding?.freezeEvidenceSha256}) === canonicalAuthority(config.binding) && integer(epoch.backendPid,1,2147483647), "freeze_control_binding");
      config.binding = epoch.binding;
      config.freezeBarrier = { backendPid: epoch.backendPid, epoch: config.binding!.freezeEpoch };
      trust = await createNativeSegmentedTrust(config, invocation, pool, control, managed.record_sha256);
    }
    validateSegmentedEntry(config, invocation);
  } catch (error) { await pool.end(); throw error; }
  let reader;
  try { reader = await createPacedPreservationSourceReader(readerPath, config.sourceReaderSha256, invocation.deadlineAtMs); }
  catch (error) { await pool.end(); throw error; }
  const receipt = await executeSegmentedEntry(config, invocation, { pool, reader, ...(trust ? { trust } : {}) });
  process.stdout.write(JSON.stringify({ ...receipt, configRelative: basename(configPath), configSha256: digest(raw) }) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  void main().catch(() => { process.stdout.write(JSON.stringify({ version: 2, status: "failed", reconciliationRequired: true,
    parityComplete: false, productionAuthorized: false }) + "\n"); process.exitCode = 1; });
}

export function deriveManagedInvocation(config: SegmentedEntryConfig, header: Record<string, any>, now = Date.now()): SegmentedInvocation {
  const role = config.stage === "import" ? "producer" : config.stage === "verify" ? "verifier" : "finalizer";
  requireValue(header.version === 1 && header.role === role && header.request_nonce === config.invocation.requestNonce &&
    header.unit === "radar-rehearsal-"+config.nonce+"-"+role+"-"+header.request_nonce+".service" && isHash(header.record_sha256) &&
    integer(header.deadline,1,Number.MAX_SAFE_INTEGER) && integer(header.policy?.runtime_seconds,1,config.stage === "calibrate" ? 180 : 900) &&
    integer(config.invocation.timeoutMs,10001,900000), "managed_budget_binding");
  const deadlineAtMs = Math.min(header.deadline*1000-25000,now+header.policy.runtime_seconds*1000,now+config.invocation.timeoutMs);
  const timeoutMs = deadlineAtMs-now;
  requireValue(integer(timeoutMs,10001,900000), "managed_clipped_budget");
  return {requestNonce:config.invocation.requestNonce,deadlineAtMs,timeoutMs};
}

export async function createNativeSegmentedTrust(config: SegmentedEntryConfig, invocation: SegmentedInvocation,
  pool: PostgresPool, control: string, recordSha256: string): Promise<SegmentedEntryTrust> {
  const observations = new Map<string, {binding: StagedPreservationFreezeBinding;observedAtMs:number;validUntilMs:number}>();
  const artifacts = new Map<string, Buffer>();
  const trustedVerifierId = "managed-native-verifier-"+recordSha256;
  const trust: SegmentedEntryTrust = {freeze:{
    async readLiveMeasurement(binding) {
      requireValue(canonicalAuthority(binding)===canonicalAuthority(config.binding),"live_binding");
      const client = await pool.connect();
      try {
        const measured = await measureSegmentedDatabaseAuthority(client,config);
        const value = {binding,observedAtMs:Date.now(),validUntilMs:invocation.deadlineAtMs,catalogueSha256:measured.catalogueSha256,
          backendPid:measured.barrierBackendPid,recordSha256};
        const bytes = Buffer.from(canonicalAuthority(value));
        observations.clear(); observations.set(digest(bytes),value); return bytes;
      } finally {client.release();}
    },
    async verifyMeasurement(bytes,binding) {
      const measured = observations.get(digest(bytes)); observations.delete(digest(bytes));
      return measured && canonicalAuthority(measured.binding)===canonicalAuthority(binding) ? measured : null;
    }
  }};
  if(config.stage!=="finalize")return trust;
  requireValue(config.proofRequests && config.proofRequests.length>0,"protected_proof_requests");
  const journal = JSON.parse((await protectedFile(control+"/proof-journal.json",control,1048576)).toString("utf8"));
  requireValue(journal.version===1 && journal.nonce===config.nonce && journal.recordSha256===recordSha256 && Array.isArray(journal.proofs),"proof_journal");
  const references: {name:string;artifactSha256:string}[]=[];
  for(const request of config.proofRequests) {
    const matches=journal.proofs.filter((p: any)=>p.requestNonce===request);
    requireValue(matches.length===1,"proof_journal_unique"); const reference=matches[0];
    const name=request+"-verify.proof.json";
    requireValue(reference.name===name && isHash(reference.sha256),"proof_journal_reference");
    const raw=await protectedFile(control+"/receipts/"+name,control,4194304);
    requireValue(digest(raw)===reference.sha256,"proof_envelope_hash");
    const envelope=JSON.parse(raw.toString("utf8")), b=envelope.binding, body=envelope.body;
    requireValue(envelope.version===1 && canonicalAuthority(envelope)===raw.toString("utf8") && isHash(envelope.body_sha256) &&
      digest(canonicalAuthority(body))===envelope.body_sha256 && b.nonce===config.nonce && b.request_nonce===request && b.stage==="verify" &&
      b.record_sha256===recordSha256 && b.runner_sha256===config.runnerSha256 && b.source_reader_sha256===config.sourceReaderSha256 &&
      b.unit==="radar-rehearsal-"+config.nonce+"-verifier-"+request+".service" && /^[a-f0-9]{32}$/.test(b.invocation_id) && b.invocation_id!=="0".repeat(32) &&
      body.version===2 && body.stage==="verify" && body.requestNonce===request && body.parityComplete===false && body.productionAuthorized===false &&
      body.grantsBusinessEligibility===false && body.nativeMetrics?.uncertainCommit===false &&
      body.nativeMetrics.commitAttempts===body.nativeMetrics.acknowledgedCommits,"proof_provenance");
    const binding=JSON.parse((await protectedFile(control+"/invocations/"+request+"-verifier.binding.json",control,16384)).toString("utf8"));
    requireValue(binding.unit===b.unit && binding.invocation_id===b.invocation_id && binding.control_group===b.control_group &&
      canonicalAuthority(binding.identity)===canonicalAuthority(b.cgroup_identity) && binding.record_sha256===recordSha256,"proof_retirement_binding");
    const bytes=Buffer.from(body.result.artifactBase64,"base64");
    requireValue(bytes.length>0 && bytes.length<=4194304 && digest(bytes)===body.result.artifactSha256,"proof_native_artifact");
    const native=JSON.parse(bytes.toString("utf8"));
    requireValue(canonicalAuthority(native.binding)===canonicalAuthority(config.binding),"proof_native_binding");
    artifacts.set(name,bytes);references.push({name,artifactSha256:digest(bytes)});
  }
  config.proofFiles=references;
  trust.readArtifact=async(name,expected)=>{const bytes=artifacts.get(name);requireValue(bytes && digest(bytes)===expected,"protected_artifact_pin");return bytes;};
  trust.evidence={trustedVerifierId,async verifyArtifact(bytes,context) {
    if(canonicalAuthority(context.binding)!==canonicalAuthority(config.binding) || digest(bytes)!==context.artifactSha256)return null;
    return [...artifacts.values()].some(actual=>actual.equals(Buffer.from(bytes))) ? {artifactSha256:context.artifactSha256,verifierId:trustedVerifierId} : null;
  }};
  return trust;
}

export async function prepareSegmentedFreezeRoles(owner: PostgresClient, verifier: SegmentedEntryConfig, finalizer: SegmentedEntryConfig) {
  requireValue(verifier.stage==="verify" && finalizer.stage==="finalize" && verifier.nonce===finalizer.nonce &&
    verifier.database===finalizer.database && verifier.schema===finalizer.schema,"role_provision_scope");
  const measured=await owner.query("SELECT current_database() AS database,current_user AS role,current_setting('port')::int AS port,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier");
  requireValue(measured.rows.length===1 && measured.rows[0]?.database===verifier.database && measured.rows[0].role==="postgres" &&
    measured.rows[0].port===5434 && measured.rows[0].system_identifier===verifier.systemIdentifier,"role_provision_owner");
  const q=(name:string)=>'"'+name+'"';requireValue(/^radar_rehearsal_[a-f0-9]{16}_schema$/.test(verifier.schema),"role_provision_schema");
  const schema=q(verifier.schema);
  await owner.query("BEGIN");
  try {
    await owner.query("SELECT set_config('statement_timeout','60000',true),set_config('lock_timeout','5000',true)");
    await owner.query(createStagedPreservationCompletionSchemaSql(verifier.schema));
    for(const config of [verifier,finalizer]) {
      requireValue(config.username===config.database+(config.stage==="verify"?"_verifier":"_finalizer") && /^[a-f0-9]{64}$/.test(config.connection.password),"role_provision_credential");
      const existing=await owner.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname=$1",[config.username]);
      requireValue(existing.rows[0]?.count===0,"role_provision_not_fresh");
      await owner.query("CREATE ROLE "+q(config.username)+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD $1",[config.connection.password]);
      await owner.query("GRANT CONNECT ON DATABASE "+q(config.database)+" TO "+q(config.username));
      await owner.query("GRANT USAGE ON SCHEMA "+schema+" TO "+q(config.username));
      await owner.query("GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "+q(config.username));
      for(const relation of preservationRelations)await owner.query("GRANT SELECT ON TABLE "+schema+"."+relation+" TO "+q(config.username));
    }
    for(const [relation,policy] of Object.entries(finalizerLedgerPolicy))await owner.query("GRANT "+policy.operation+" ("+policy.columns.join(",")+") ON TABLE "+schema+"."+relation+" TO "+q(finalizer.username));
    await owner.query("COMMIT");
  } catch(error) {await owner.query("ROLLBACK");throw error;}
}
