import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate, digest, verifyLedger } from './install-production-postgres-business-schema.mjs';
import { createPostgresServiceSchema } from '../apps/automation/src/postgres-service-schema.js';

const candidateSha = '7d33863ac425f4531ceb9c036cdadbe3ddf8768570899b6311a42088e5f08278';
const ledgerSha = '1da609302e537321d2ab5cfdc68372fbe178e44fd1f1b2a57f8536247aae86e9';
const services = ['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'];
const demand = (value, code) => { if (!value) throw new Error(code); };

/** Offline contract comparison only: supplied observations are not authenticated live proof. */
export function prepareProductionImportHandoff(input) {
  demand(input && Object.keys(input).sort().join(',') === ['boundary','ledger','schemaCandidate',...(Object.hasOwn(input,'serviceRoles')?['serviceRoles']:[])].sort().join(','), 'unknown_or_missing_input');
  const candidate = validateCandidate(input.schemaCandidate);
  demand(digest(candidate) === candidateSha, 'installed_candidate_changed');
  demand(verifyLedger(candidate,input.ledger) === ledgerSha, 'installed_ledger_changed');
  const b = input.boundary;
  demand(b && b.database === 'address_radar' && b.databaseOid === '16391'
    && b.systemIdentifier === '7693392208475083526' && b.postmasterStart === '2026-10-06 12:39:27.858083+08', 'observed_target_changed');
  const definition = createPostgresServiceSchema({protocolVersion:2});
  demand(definition.plan.version === 3 && digest(definition.plan.migrations.slice(0,candidate.schemaPlan.version)) === digest(candidate.schemaPlan.migrations), 'service_schema_prefix_changed');
  const roles = Object.fromEntries(services.map(service=>[service,null]));
  if (input.serviceRoles) {
    demand(Object.keys(input.serviceRoles).sort().join(',') === [...services].sort().join(','), 'six_roles_required');
    const names=services.map(s=>input.serviceRoles[s]);
    demand(names.every(n=>typeof n==='string' && /^[a-z_][a-z0-9_]{0,62}$/.test(n) && !/^(pg_|postgres$)/.test(n)
      && !/(?:^|_)(?:test|acceptance)(?:_|$)/.test(n)) && new Set([...names,candidate.target.username]).size===7, 'role_collision_or_invalid');
    Object.assign(roles,input.serviceRoles);
  }
  return {
    mode:'offline-production-import-handoff', observationsAuthenticated:false,
    installedCandidateSha256:candidateSha, installedLedgerSha256:ledgerSha,
    installedTarget:{...candidate.target,serverAddress:'127.0.0.1',serverPort:5432,
      systemIdentifier:b.systemIdentifier,schemaVersion:candidate.schemaPlan.version,schemaFingerprint:candidate.schemaPlan.fingerprint},
    requiredServiceSchema:{version:definition.plan.version,fingerprint:definition.plan.fingerprint,
      migrations:definition.plan.migrations,supportTables:definition.supportTables},
    serviceRoles:roles, source:null,capacity:null,trust:null,capability:null,
    preservation:{entrypoint:'importStagedFullDataPreservationSegment',nativeCompositionOwner:'parent/Kuhn',
      limitation:'existing segmented host entry is rehearsal-only; production identity/source/authority ports remain required'},
    typedImport:{module:'apps/automation/src/postgres-cohort-import.ts',entrypoint:'applyReviewedPostgresCohortImportPlanInTransaction',
      providerEntrypoint:'applyReviewedPostgresProviderBudgetSeedPlanInTransaction',commitState:'pending_parent_commit',
      unsupported:['token_projection','fresh_chain_facts','stable_qualification'],maximumProfilesInParentTransaction:1000,
      sourceReviewFields:['operationId','snapshotSha256','catalogFingerprint','manifestSha256','reviewedRoutingSha256','crosswalkSha256','databaseEncoding'],
      cohortReviewFields:['importId','approvalRef','actorId','actorAuthorizationRef','generationId','sourceWatermark','importedAt','allowlist']},
    rollback:{afterFirstWrite:'same-retained-postgres-data',legacySqliteWriterRestartAllowed:false,
      module:'packages/database/src/migration-cutover-coordinator.ts',independentCompatibilityProof:null},
    executionOrder:['fresh writer fence/snapshot and capacity evidence','production preservation composition and complete byte parity',
      'explicit code-owned service schema append and native full ledger/ACL proof','reviewed source/cohort/provider continuity plans',
      'authenticated protocol-v2 policy/bundle and same-data PG rollback compatibility',
      'parent coordinator first-write UOW: generation + typed projection + marker + transition, one native COMMIT',
      'independent committed receipt/marker/body reconciliation before writer startup'],
    unknownCommit:'stop; independently read exact committed transition, first-write marker, import ledger and target bodies; never treat pending_parent_commit as ACK or replay merely because acknowledgment was lost',
    productionImportAdmitted:false,productionMigrationReady:false,backendChanged:false,businessActivation:false,deliveryEnabled:false,
  };
}

async function readMetadata(path) {
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
  try {
    const before=await fd.stat({bigint:true});demand(before.isFile()&&before.size<=1048576n,'oversize_metadata');
    const bytes=Buffer.alloc(Number(before.size)+1);let size=0;
    while(size<bytes.length){const r=await fd.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
    demand(size===Number(before.size)&&stamp(before)===stamp(await fd.stat({bigint:true})),'metadata_changed');
    return JSON.parse(bytes.subarray(0,size).toString('utf8'));
  } finally {await fd.close();}
}
export async function main(args=process.argv.slice(2)) {
  demand(args.length===4&&args[0]==='--schema-candidate'&&args[2]==='--peer-catalog-receipt','invalid_cli');
  const schemaCandidate=await readMetadata(args[1]),receipt=await readMetadata(args[3]);
  return prepareProductionImportHandoff({schemaCandidate,ledger:receipt.ledger,boundary:receipt.boundary});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().then(v=>console.log(JSON.stringify(v)),()=>{console.log('{"status":"refused","code":"offline_handoff_contract_mismatch","productionMigrationReady":false}');process.exitCode=1;});
}
