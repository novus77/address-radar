import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { claimPostgresForwardTargetRefresh,checkpointPostgresForwardTargetRefresh,releasePostgresForwardTargetRefresh,type PostgresTransaction } from "@address-radar/database";
import type { createForwardTargetIdentityRefreshWorker } from "./forward-target-identity-refresh.js";

export function createDurableForwardTargetRefreshCoordinator(options:{
  readonly run:<T>(operation:(tx:PostgresTransaction)=>Promise<T>)=>Promise<T>;
  readonly generationId:string;readonly ownerId:string;readonly leaseDurationMs:number;readonly now:()=>number;
  readonly worker:Pick<ReturnType<typeof createForwardTargetIdentityRefreshWorker>,"tick">;
}) {
  if(!options.generationId.trim()||!options.ownerId.trim()||!Number.isSafeInteger(options.leaseDurationMs)||options.leaseDurationMs<=0) throw new Error("Explicit refresh coordinator configuration required");
  return {async tick() {
    const claim=await options.run(tx=>claimPostgresForwardTargetRefresh(tx,{generationId:options.generationId,ownerId:options.ownerId,leaseId:randomUUID(),now:options.now(),leaseDurationMs:options.leaseDurationMs}));
    if(claim.status!=="claimed") return claim;
    let page:Awaited<ReturnType<typeof options.worker.tick>>;
    try {page=await options.worker.tick(structuredClone(claim.lease.cursors));}
    catch {
      await options.run(tx=>releasePostgresForwardTargetRefresh(tx,claim.lease,"source_page_failed")).catch(()=>undefined);
      return {status:"deferred" as const,reasonCode:"source_page_failed" as const};
    }
    try {
      const checkpoint=await options.run(tx=>checkpointPostgresForwardTargetRefresh(tx,claim.lease,{
        checkedAt:page.checkedAt,completedAt:options.now(),nextCursors:page.nextCursors,
        receiptIds:page.results.map(result=>result.refreshId),processed:page.processed,verified:page.verified,sourceMissing:page.sourceMissing,sourceUnavailable:page.sourceUnavailable
      }));
      return {...checkpoint,checkedAt:page.checkedAt,processed:page.processed,verified:page.verified,sourceMissing:page.sourceMissing,sourceUnavailable:page.sourceUnavailable};
    } catch {
      await options.run(tx=>releasePostgresForwardTargetRefresh(tx,claim.lease,"checkpoint_failed")).catch(()=>undefined);
      return {status:"deferred" as const,reasonCode:"checkpoint_failed" as const};
    }
  }};
}
export async function runDurableForwardTargetRefreshCoordinator(coordinator:Pick<ReturnType<typeof createDurableForwardTargetRefreshCoordinator>,"tick">,options:{
  readonly intervalMs:number;readonly signal:AbortSignal;
  readonly onResult:(result:Awaited<ReturnType<typeof coordinator.tick>>)=>void|Promise<void>;
}) {
  if(!Number.isSafeInteger(options.intervalMs)||options.intervalMs<=0) throw new Error("Explicit refresh cadence required");
  while(!options.signal.aborted) {
    await options.onResult(await coordinator.tick());
    try {await delay(options.intervalMs,undefined,{signal:options.signal});}
    catch(error) {if(!options.signal.aborted) throw error;}
  }
}
