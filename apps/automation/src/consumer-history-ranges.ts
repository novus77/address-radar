import type { DatabaseSync } from "node:sqlite";
import { hasConsumerHistoryRequestCoverage,listConsumerHistoryRangeRechecks,reconsiderConsumerHistoryRecovery } from "@address-radar/database";

export function reconcileConsumerHistoryRanges(input: {
  readonly database: DatabaseSync; readonly now?: () => number; readonly limit?: number;
}) {
  const at=(input.now??Date.now)();
  const rows=listConsumerHistoryRangeRechecks(input.database,at,input.limit??25);
  let requeued=0;
  let reopened=0;
  for(const row of rows) {
    const result=reconsiderConsumerHistoryRecovery(input.database,{
      jobId:row.jobId,tokenId:row.tokenId,fromAt:row.fromAt,toAt:row.toAt,
      expectedUpdatedAt:row.updatedAt,expectedStatus:row.status,
      covered:hasConsumerHistoryRequestCoverage(input.database,row.tokenId,row.fromAt,row.toAt),at,
    });
    if(result==="requeued")requeued+=1;
    if(result==="reopened")reopened+=1;
  }
  return Object.freeze({examined:rows.length,requeued,reopened});
}
