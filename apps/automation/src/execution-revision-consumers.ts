import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction, withExecutionRevisionContext, type AutomationJobStore } from "@address-radar/database";
import type { AutomationExecutionResult } from "./scheduler.js";
import { enqueueTraderAbilityEvaluation } from "./trader-ability-worker.js";
import { enqueueCandidateFactEvaluation } from "./candidate-evidence-worker.js";

export async function executeAuditedAbilityRevision(input: {
  readonly database: DatabaseSync; readonly traderId: string; readonly now: () => number;
  readonly execute: () => Promise<AutomationExecutionResult>;
}): Promise<AutomationExecutionResult> {
  const hasRevision = input.database.prepare(`SELECT 1 FROM trader_execution_heads
    WHERE entity_id=? AND projection_state='applied' AND revision>0 LIMIT 1`).get(input.traderId);
  if (!hasRevision) return input.execute();
  const owned = !input.database.isTransaction;
  if (owned) input.database.exec("BEGIN IMMEDIATE");
  try {
    const result = await withExecutionRevisionContext(input.database,input.traderId,input.now(),input.execute);
    if (result.status === "completed") input.database.prepare(`UPDATE execution_revision_requests SET
      applied_revision=desired_revision,applied_at=?,last_outcome='execution_recomputed'
      WHERE consumer_type='ability_evaluation' AND subject_key=? AND desired_revision>applied_revision
      AND EXISTS(SELECT 1 FROM trader_execution_heads h WHERE h.source=execution_revision_requests.source
        AND h.event_id=execution_revision_requests.event_id AND h.revision=execution_revision_requests.desired_revision
        AND h.projection_state='applied')`).run(input.now(),input.traderId);
    if (owned) input.database.exec("COMMIT");
    return result;
  } catch (error) { if (owned && input.database.isTransaction) input.database.exec("ROLLBACK"); throw error; }
}

export function reconcileExecutionRevisionRequests(input: {
  readonly database: DatabaseSync; readonly jobs: AutomationJobStore; readonly now?: () => number; readonly limit?: number;
}) {
  const at = (input.now ?? Date.now)();
  return withAddressRadarWriteTransaction(input.database, () => {
    const rows = input.database.prepare(`SELECT consumer_type,subject_key,token_id,entity_id,source,event_id,desired_revision
      FROM execution_revision_requests WHERE desired_revision>applied_revision AND desired_revision>dispatched_revision
      ORDER BY requested_at,source,event_id,consumer_type LIMIT ?`).all(input.limit ?? 100) as Array<{ consumer_type: string; subject_key: string; token_id: string; entity_id: string; source: string; event_id: string; desired_revision: number }>;
    const groups = new Map<string,typeof rows>();
    for (const row of rows) { const key=JSON.stringify([row.consumer_type,row.subject_key]); const group=groups.get(key) ?? []; group.push(row); groups.set(key,group); }
    let dispatched=0; let deferred=0;
    for (const group of groups.values()) {
      const row=group[0]!; const type=String(row.consumer_type); const subject=String(row.subject_key);
      const sourceKey=`execution-revision:${createHash("sha256").update(JSON.stringify(group.map(r=>[r.source,r.event_id,r.desired_revision]))).digest("hex")}`;
      if (type === "ability_evaluation") {
        if (input.jobs.runnableCount(type)>=1_000 || input.jobs.activeJobForSubject(type,subject)) { deferred+=group.length; continue; }
        enqueueTraderAbilityEvaluation(input.jobs,subject,at,at,sourceKey);
      } else if (type === "candidate_evidence") {
        enqueueCandidateFactEvaluation({ database: input.database,jobs: input.jobs,tokenId:String(row.token_id),sourceKey,evaluatedAt:at,now:at });
      } else if (type === "event_projection") {
        const running=input.database.prepare(`SELECT 1 FROM event_projections WHERE event_id=? AND status='running' LIMIT 1`).get(subject);
        if (running) { deferred+=group.length; continue; }
        input.database.prepare(`UPDATE event_projections SET status='pending',next_attempt_at=?,completed_at=NULL,
          last_error='execution_revision_replay',updated_at=? WHERE event_id=? AND status<>'running'`).run(at,at,subject);
      } else {
        // The normal signal reconciler fingerprints applied execution revisions and owns its leases.
        const request=input.database.prepare("SELECT desired_revision,applied_revision FROM signal_projection_requests WHERE token_id=?").get(String(row.token_id));
        if (!request || request.desired_revision === request.applied_revision) { deferred+=group.length; continue; }
      }
      for (const r of group) input.database.prepare(`UPDATE execution_revision_requests SET dispatched_revision=?,dispatched_at=?,last_outcome=?
        WHERE source=? AND event_id=? AND consumer_type=? AND desired_revision=?`).run(r.desired_revision,at,
          type === "candidate_evidence" ? "awaiting_candidate_execution_basis_ack" : type === "event_projection" ? "awaiting_projection_revision_ack" : "dispatched",
          r.source,r.event_id,r.consumer_type,r.desired_revision);
      dispatched+=group.length;
    }
    return Object.freeze({ examined:rows.length,dispatched,deferred });
  });
}
