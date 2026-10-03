import { randomBytes } from "node:crypto";
import { readPostgresForwardTrace,type PostgresAcceptanceRuntime,type PostgresTransaction } from "@address-radar/database";
import { startForwardTraceConsole } from "./forward-trace-server.js";
export { createPostgresAcceptanceRuntime, POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL, POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL, POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL } from "@address-radar/database";

export async function verifyPostgresForwardTraceAcceptance(runtime: PostgresAcceptanceRuntime,input: {
  readonly now: number; readonly setup: string; readonly publicDirectory: string;
  readonly seed: (tx: PostgresTransaction,now: number)=>Promise<{readonly generationId: string}>;
}) {
  const tables=async(tx:PostgresTransaction)=>(await tx.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind IN ('r','p') ORDER BY relname")).rows.map(row=>String(row.relname));
  const expected=[...new Set([...input.setup.matchAll(/^CREATE TEMP TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gm)].map(match=>match[1]!))].sort();
  const assert=(value:unknown,message:string)=>{if(!value) throw new Error(message);};
  assert(expected.length>0,"Temporary schema inventory required");
  await runtime.probe();
  let backend=0,owned=false,listener: Awaited<ReturnType<typeof startForwardTraceConsole>> | null=null;
  const run:PostgresAcceptanceRuntime["run"]=operation=>runtime.run(async tx=>{
    const pid=Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    if(!backend) backend=pid; assert(pid===backend,"Dedicated temporary session changed"); return operation(tx);
  });
  const before=await run(tables); assert(before.length===0,"Temporary namespace must be empty");
  try {
    const seed=await run(async tx=>{
      await tx.query(input.setup);
      const actual=await tables(tx);assert(JSON.stringify(actual)===JSON.stringify(expected),"Unexpected temporary schema inventory");
      return input.seed(tx,input.now);
    });
    owned=true;
    const first=await run(tx=>readPostgresForwardTrace(tx,{entityId:"entity-a",generationId:seed.generationId,asOf:input.now,limit:1,after:null}));
    assert(first.purchases.length===1 && first.nextCursor,"First page and keyset cursor missing");
    const second=await run(tx=>readPostgresForwardTrace(tx,{entityId:"entity-a",generationId:seed.generationId,asOf:input.now,limit:1,after:first.nextCursor}));
    assert(second.purchases.length===1 && first.purchases[0]?.sampleId!==second.purchases[0]?.sampleId,"Keyset pages overlap");
    let invalid=false;
    try {await run(tx=>readPostgresForwardTrace(tx,{entityId:"entity-a",generationId:seed.generationId,asOf:input.now,limit:1001,after:null}));} catch {invalid=true;}
    assert(invalid,"Unbounded page must be rejected");
    const counts=async(tx:PostgresTransaction)=>(await tx.query("SELECT (SELECT count(*) FROM forward_purchase_samples)::text AS samples,(SELECT count(*) FROM forward_signal_readiness_intents)::text AS signals,(SELECT count(*) FROM forward_target_authorization_intents)::text AS controls")).rows[0];
    const mutationsBefore=await run(counts);
    const token=randomBytes(32).toString("hex");
    listener=await startForwardTraceConsole({run,generationId:seed.generationId,developerToken:token,
      principal:{actorId:"trace-fixture-operator",authorizationEvidenceRef:"synthetic:trace-read-only",permissions:["target_registry_write"]},
      now:()=>input.now,limit:1,maximumInFlight:1,requestTimeoutMs:5000,port:0,publicDirectory:input.publicDirectory});
    const endpoint=listener.url+"/api/v2/forward-trace?entityId=entity-a";
    assert((await fetch(endpoint)).status===401,"Unauthorized read must be denied");
    const headers={Authorization:"Bearer "+token};
    assert((await fetch(endpoint,{method:"POST",headers})).status===405,"Mutating HTTP method must be denied");
    assert((await fetch(endpoint+"&generationId=other",{headers})).status===400,"Client generation override must be denied");
    const response=await fetch(endpoint,{headers});assert(response.status===200,"Authenticated trace read failed");
    const snapshot=await response.json() as typeof first;
    assert(snapshot.purchases.length===1 && snapshot.countScope==="current_page" && snapshot.gatewayDeliveryEnabled===false && snapshot.liveSourceCoverageVerified===false,"Trace scope mislabeled");
    const html=await fetch(listener.url);assert(html.status===200 && (await html.text()).includes("30 天机会"),"Trace UI not served");
    assert((await fetch(listener.url+"/forward-trace.js")).status===200,"Trace UI module not served");
    assert(JSON.stringify(mutationsBefore)===JSON.stringify(await run(counts)),"Read-only trace mutated business facts");
    await listener.close();listener=null;
  } finally {
    if(listener) await listener.close();
    if(owned) await run(async tx=>{
      const actual=await tables(tx);assert(JSON.stringify(actual)===JSON.stringify(expected),"Cleanup inventory changed");
      for(const table of expected) await tx.query('DROP TABLE IF EXISTS pg_temp."'+table+'" CASCADE');
    });
    assert(JSON.stringify(await run(tables))===JSON.stringify(before),"Temporary cleanup incomplete");
  }
  return {status:"passed",fixtureScope:"synthetic_read_only_forward_trace",actualHttpReadVerified:true,
    singleStatementSnapshotVerified:true,keysetPaginationVerified:true,unauthorizedNoMutationVerified:true,
    clientGenerationOverrideDenied:true,operatorAssetsServed:true,signalJoinLiveCoverageVerified:false,
    cleanupVerified:true,businessActivation:false,liveSourceCoverageVerified:false,gatewayDeliveryEnabled:false} as const;
}
