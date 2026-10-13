import { createPostgresMigrationRuntime } from "../packages/database/src/postgres-migration-runtime.js";
import { createFullDataPreservationSchemaSql } from "../packages/database/src/postgres-full-data-import.js";
import { createPacedPreservationSourceReader } from "./preservation-source-reader.js";
import { withFullDataPreservationSourceReader } from "../packages/database/src/postgres-full-data-import.js";
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { calibratePreservationChunk, measurePreservationFixtureResources } from "./calibrate-postgres-preservation-chunk.js";
import { authenticatePreservationFixtureAuthority, validatePreservationResidentCalibration } from "./postgres-preservation-fixture-authority.js";
import { readPrivatePreservationFile, runFullPreservationRehearsal, assertPreservationResources } from "./rehearse-postgres-full-preservation.js";

// Invoked only inside the fresh nonce lifecycle. Root is a read-only OS source reader;
// every PostgreSQL connection is the dedicated non-superuser fixture actor.
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let pool, sourceReader;
const nativeMetrics={physicalSqlStatements:0,commitAttempts:0,acknowledgedCommits:0,acknowledgedRollbacks:0};
try {
  const [stage, configPath, configPin, authorityPath, authorityPin] = process.argv.slice(2);
  if (!["install","calibrate","interrupt","import","resume","parity"].includes(stage) || process.argv.length !== 7) throw new Error("fixture_arguments");
  const bytes = await readPrivatePreservationFile(configPath,65536);
  if (sha(bytes) !== configPin) throw new Error("fixture_config_pin");
  const config = JSON.parse(bytes.toString("utf8"));
  if (config.bundleDirectory !== "/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle") throw new Error("fixture_source_scope");
  const authorityBytes = await readPrivatePreservationFile(authorityPath,16384);
  const authority = authenticatePreservationFixtureAuthority(authorityBytes,authorityPin,config);
  pool = new pg.Pool({ host:"127.0.0.1",port:5434,database:authority.target.database,user:authority.target.username,password:authority.password,
    max:1,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,ssl:false,application_name:"private-history-preservation" });
  const nativeConnect=pool.connect.bind(pool),wrappedClients=new WeakSet();
  pool.connect=async()=>{const client=await nativeConnect();if(!wrappedClients.has(client)){wrappedClients.add(client);const nativeQuery=client.query.bind(client);client.query=async(sql,values)=>{nativeMetrics.physicalSqlStatements++;if(sql==="COMMIT")nativeMetrics.commitAttempts++;const result=await nativeQuery(sql,values);if(sql==="COMMIT")nativeMetrics.acknowledgedCommits++;if(sql==="ROLLBACK")nativeMetrics.acknowledgedRollbacks++;return result;};}return client;};
  const nativeEnd = pool.end.bind(pool); let ending; pool.end = () => ending ??= nativeEnd();
  const ports = { pool, assertAuthorized: async request => {
    if (JSON.stringify(request.target) !== JSON.stringify(authority.target) || request.capability.mode !== "isolated" || request.capability.purpose !== "schema_install" ||
      request.capability.planSha256 !== config.expected.manifestSha256 || request.capability.approvalRef !== authority.approvalRef ||
      request.capability.expiresAtMs > authority.expiresAtMs || Date.now() >= authority.expiresAtMs) throw new Error("fixture_authority_rejected");
  } };
  sourceReader = await createPacedPreservationSourceReader(join(config.evidenceDirectory,"..","source-reader.py"),config.sourceReaderSha256,config.deadlineAtMs);
  let report;
  if (stage === "install") {
    const proof = JSON.parse(await readFile(join(config.evidenceDirectory,"calibration.json"),"utf8"));
    validatePreservationResidentCalibration(proof);
    const check = async () => { if(Date.now() >= config.deadlineAtMs) throw new Error("fixture_install_deadline"); assertPreservationResources(config,await measurePreservationFixtureResources(config.storagePath),false); };
    await check();
    const runtime = createPostgresMigrationRuntime({ pool, target: config.target,
      capability:{mode:"isolated",purpose:"schema_install",approvalRef:config.approvalRef,planSha256:config.expected.manifestSha256,expiresAtMs:config.deadlineAtMs},
      assertAuthorized:ports.assertAuthorized,clock:Date.now,
      limits:{operationTimeoutMs:60000,connectionTimeoutMs:3000,statementTimeoutMs:30000,lockTimeoutMs:500,maximumSqlStatements:10000,workMemKb:1024,closeTimeoutMs:5000}});
    try { await runtime.run(async tx=>{for(const statement of createFullDataPreservationSchemaSql(config.target.schema)){await check();await tx.query(statement);}}); }
    finally {await runtime.close();}
    await check();
    report={status:"installed_preservation_ledgers",historicalRowsCommitted:0,residentAllowanceBasis:"prior_authenticated_source_calibration",freshSourceValidationSkipped:false,resources:await measurePreservationFixtureResources(config.storagePath),productionAuthorized:false};
  } else if (stage === "calibrate") report = await withFullDataPreservationSourceReader(sourceReader,()=>calibratePreservationChunk(config,ports));
  else {
    const proof = JSON.parse(await readFile(join(config.evidenceDirectory,"calibration.json"),"utf8"));
    ports.residentChunkAllowance = validatePreservationResidentCalibration(proof);
    report = await withFullDataPreservationSourceReader(sourceReader,()=>runFullPreservationRehearsal((({sourceReaderSha256,...config})=>config)(config),ports));
  }
  report.sourceReader={...sourceReader.metrics};
  report.nativeMetrics={...nativeMetrics};
  const invocationId = process.env.PRESERVATION_INVOCATION_ID;
  if (invocationId !== undefined && !/^[a-f0-9]{32}-[0-9]{6}$/.test(invocationId)) throw new Error("fixture_invocation_id");
  const reportName = invocationId === undefined ? stage : stage + "-" + invocationId;
  await writeFile(join(config.evidenceDirectory,reportName+".json"),JSON.stringify(report)+"\n",{flag:"wx",mode:0o600});
  if (stage === "calibrate") await writeFile(join(config.evidenceDirectory,"calibration.json"),JSON.stringify(report)+"\n",{flag:"wx",mode:0o600});
  process.stdout.write(JSON.stringify({stage,status:report.status,parityComplete:report.parityComplete??false,productionAuthorized:false})+"\n");
  if (report.status === "failed") process.exitCode = 1;
} catch (error) {
  let resources; try { resources = await measurePreservationFixtureResources("/tmp"); } catch {}
  const reason = typeof error?.message === "string" && /^(preservation_rehearsal_|calibration_|source_|fixture_|PostgreSQL migration rejected:)/.test(error.message) ? error.message : "fixture_failed_reconcile_before_retry";
  process.stdout.write(JSON.stringify({status:"failed",reason,errorName:error?.name,errorCode:typeof error?.code==="string"?error.code:undefined,resources,nativeMetrics,productionAuthorized:false})+"\n");
  process.exitCode=1;
} finally { if (sourceReader) await sourceReader.close(); if (pool) await pool.end(); }
