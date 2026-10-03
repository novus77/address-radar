import { claimPostgresForwardTargetRefresh,checkpointPostgresForwardTargetRefresh,releasePostgresForwardTargetRefresh,type PostgresAcceptanceRuntime,type PostgresTransaction,type ForwardTargetRefreshCursors } from "@address-radar/database";
import { createDurableForwardTargetRefreshCoordinator } from "./forward-target-refresh-coordinator.js";
export { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL } from "@address-radar/database";

export async function verifyPostgresTargetRefreshCoordinatorAcceptance(runtime:PostgresAcceptanceRuntime,input:{readonly now:number;readonly setup:string}) {
  const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
  const tables=async(tx:PostgresTransaction)=>(await tx.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind IN ('r','p') ORDER BY relname")).rows.map(row=>String(row.relname));
  const expected=[...new Set([...input.setup.matchAll(/^CREATE TEMP TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gm)].map(match=>match[1]!))].sort();
  await runtime.probe();let backend=0,owned=false,clock=input.now,receiptSequence=0;
  const run:PostgresAcceptanceRuntime["run"]=operation=>runtime.run(async tx=>{
    const pid=Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    if(!backend)backend=pid;assert(pid===backend,"Dedicated temporary session changed");return operation(tx);
  });
  const before=await run(tables);assert(before.length===0&&expected.length>0,"Isolated temporary namespace required");
  const generationId="durable-refresh-fixture";
  const next:ForwardTargetRefreshCursors={fomo:{entityId:"fixture-fomo",subjectKey:'["fomo","fixture-fomo"]'},wallet:{entityId:"fixture-wallet",subjectKey:'["wallet","evm","0x1111111111111111111111111111111111111111"]'}};
  const page=async(nextCursors:ForwardTargetRefreshCursors)=>{
    const checkedAt=clock;
    const results=await run(async tx=>{
      const rows=[];
      for(const channel of ["fomo","wallet"] as const) {
        const key=next[channel]!,refreshId="fixture-refresh-"+(++receiptSequence);
        const status=channel==="fomo" ? "source_missing" as const : "source_unavailable" as const;
        await tx.query("INSERT INTO forward_target_identity_refresh_receipts(refresh_id,generation_id,entity_id,channel,subject_key,checked_at,status,actor_id,actor_authorization_ref,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[refreshId,generationId,key.entityId,channel,key.subjectKey,checkedAt,status,"fixture-actor","synthetic:refresh-proof",refreshId,JSON.stringify({monitoringEligible:false,radarEligible:false})]);
        rows.push({refreshId,status,checkedAt,targetVersionId:null,state:{monitoringEligible:false,radarEligible:false}});
      }
      return rows;
    });
    return {checkedAt,processed:2,verified:0,sourceMissing:1,sourceUnavailable:1,nextCursors,results};
  };
  const state=()=>run(async tx=>(await tx.query("SELECT * FROM forward_target_refresh_coordinators WHERE generation_id=$1",[generationId])).rows[0]!);
  const claim=(leaseId:string,ownerId:string,leaseDurationMs=100)=>run(tx=>claimPostgresForwardTargetRefresh(tx,{generationId,leaseId,ownerId,now:clock,leaseDurationMs}));
  try {
    await run(async tx=>{await tx.query(input.setup);assert(JSON.stringify(await tables(tx))===JSON.stringify(expected),"Temporary schema inventory mismatch");await tx.query("INSERT INTO forward_strategy_generations(generation_id,activated_at) VALUES($1,$2)",[generationId,clock]);});owned=true;
    const first=await claim("initial-lease","worker-a");assert(first.status==="claimed","Initial claim failed");
    assert((await claim("competing-lease","worker-b")).status==="busy","Active lease allowed overlap");
    if(first.status!=="claimed")throw new Error("Initial lease unavailable");
    await run(tx=>releasePostgresForwardTargetRefresh(tx,first.lease,"source_page_failed"));
    const failing=createDurableForwardTargetRefreshCoordinator({run,generationId,ownerId:"failed-worker",leaseDurationMs:100,now:()=>clock,worker:{tick:async()=>{throw new Error("Synthetic source page failure");}}});
    assert((await failing.tick()).status==="deferred","Source page failure was acknowledged");
    assert(Number((await state()).checkpoint_sequence)===0,"Failed page advanced cursor");
    const successful=createDurableForwardTargetRefreshCoordinator({run,generationId,ownerId:"worker-a",leaseDurationMs:100,now:()=>clock,worker:{tick:async cursors=>{assert(cursors.fomo===null&&cursors.wallet===null,"Initial cursors changed");return page(next);}}});
    assert((await successful.tick()).status==="checkpointed","Persisted refresh checkpoint failed");
    const resumed=createDurableForwardTargetRefreshCoordinator({run,generationId,ownerId:"restarted-worker",leaseDurationMs:100,now:()=>clock,worker:{tick:async cursors=>{assert(JSON.stringify(cursors)===JSON.stringify(next),"Restart discarded persisted cursors");return page({fomo:null,wallet:null});}}});
    assert((await resumed.tick()).status==="checkpointed","Restart did not resume");
    const expired=await claim("expired-lease","slow-worker",10);assert(expired.status==="claimed","Expiry fixture claim failed");
    clock+=11;
    const replacement=await claim("replacement-lease","new-worker");assert(replacement.status==="claimed","Expired lease not recoverable");
    if(expired.status!=="claimed"||replacement.status!=="claimed")throw new Error("Lease fixture unavailable");
    const recovered=await page({fomo:null,wallet:null});
    const checkpoint={checkedAt:recovered.checkedAt,completedAt:clock,nextCursors:recovered.nextCursors,receiptIds:recovered.results.map(row=>row.refreshId),processed:2,verified:0,sourceMissing:1,sourceUnavailable:1};
    assert((await run(tx=>checkpointPostgresForwardTargetRefresh(tx,expired.lease,checkpoint))).status==="lease_lost","Expired worker overwrote progress");
    assert((await run(tx=>checkpointPostgresForwardTargetRefresh(tx,replacement.lease,checkpoint))).status==="checkpointed","Replacement checkpoint failed");
    assert((await run(tx=>checkpointPostgresForwardTargetRefresh(tx,replacement.lease,{...checkpoint,completedAt:clock+1}))).status==="duplicate","Committed retry not idempotent");
    const missing=await claim("missing-proof","worker-a");if(missing.status!=="claimed")throw new Error("Missing proof fixture unavailable");
    let rejected=false;
    try {await run(tx=>checkpointPostgresForwardTargetRefresh(tx,missing.lease,{...checkpoint,receiptIds:["absent"],processed:1,verified:0,sourceMissing:1,sourceUnavailable:0}));}catch {rejected=true;}
    assert(rejected&&Number((await state()).checkpoint_sequence)===3,"Missing proof advanced cursor");
    await run(tx=>releasePostgresForwardTargetRefresh(tx,missing.lease,"checkpoint_failed"));
    const atomic=await claim("atomic-audit","worker-a");if(atomic.status!=="claimed")throw new Error("Atomic audit fixture unavailable");
    let rolledBack=false;
    try {await run(tx=>checkpointPostgresForwardTargetRefresh({query:async(text,values)=>{if(text.startsWith("INSERT INTO forward_target_refresh_checkpoints"))throw new Error("Synthetic audit failure");return tx.query(text,values);}},atomic.lease,checkpoint));}catch {rolledBack=true;}
    assert(rolledBack&&Number((await state()).checkpoint_sequence)===3&&(await state()).lease_id==="atomic-audit","Audit failure partially committed cursor");
    await run(tx=>releasePostgresForwardTargetRefresh(tx,atomic.lease,"checkpoint_failed"));
    clock--;
    assert((await claim("regressed-clock","worker-a")).status==="deferred_clock","Regressed clock allowed new progress");
  } finally {
    if(owned)await run(async tx=>{assert(JSON.stringify(await tables(tx))===JSON.stringify(expected),"Cleanup inventory mismatch");for(const table of expected)await tx.query('DROP TABLE IF EXISTS pg_temp."'+table+'" CASCADE');});
    assert(JSON.stringify(await run(tables))===JSON.stringify(before),"Temporary cleanup incomplete");
  }
  return {status:"passed",fixtureScope:"synthetic_durable_target_refresh",restartCursorRecoveryVerified:true,
    expiredLeaseFenceVerified:true,missingReceiptNoProgressVerified:true,checkpointAuditAtomicityVerified:true,
    idempotentCheckpointRetryVerified:true,independentCursorsVerified:true,sourceFailuresDoNotGrantEligibility:true,
    clockRegressionDeferred:true,cleanupVerified:true,businessActivation:false,liveSourceCoverageVerified:false,gatewayDeliveryEnabled:false} as const;
}
