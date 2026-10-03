import { createHash } from "node:crypto";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export interface ForwardTargetRefreshCursor { readonly entityId: string; readonly subjectKey: string }
export interface ForwardTargetRefreshCursors { readonly fomo: ForwardTargetRefreshCursor | null; readonly wallet: ForwardTargetRefreshCursor | null }
export interface ForwardTargetRefreshLease {
  readonly generationId: string; readonly leaseId: string; readonly ownerId: string;
  readonly startedAt: number; readonly expiresAt: number; readonly checkpointSequence: number;
  readonly cursors: ForwardTargetRefreshCursors;
}
export interface ForwardTargetRefreshCheckpoint {
  readonly checkedAt: number; readonly completedAt: number; readonly nextCursors: ForwardTargetRefreshCursors;
  readonly receiptIds: readonly string[]; readonly processed: number; readonly verified: number;
  readonly sourceMissing: number; readonly sourceUnavailable: number;
}
export const POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL = `
CREATE TABLE forward_target_refresh_coordinators (
  generation_id text PRIMARY KEY REFERENCES forward_strategy_generations(generation_id),
  checkpoint_sequence bigint NOT NULL DEFAULT 0 CHECK(checkpoint_sequence>=0),cursors text NOT NULL,
  lease_id text,lease_owner text,lease_started_at bigint,lease_expires_at bigint,
  last_checked_at bigint,last_checkpoint_at bigint,last_failure_code text,
  CHECK((lease_id IS NULL AND lease_owner IS NULL AND lease_started_at IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_started_at IS NOT NULL AND lease_expires_at>lease_started_at))
);
CREATE TABLE forward_target_refresh_checkpoints (
  checkpoint_id text PRIMARY KEY,generation_id text NOT NULL REFERENCES forward_target_refresh_coordinators(generation_id),
  checkpoint_sequence bigint NOT NULL CHECK(checkpoint_sequence>0),lease_id text NOT NULL UNIQUE,
  checked_at bigint NOT NULL,completed_at bigint NOT NULL,fingerprint text NOT NULL,payload text NOT NULL,
  UNIQUE(generation_id,checkpoint_sequence),CHECK(completed_at>=checked_at)
);
`;
const clock=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const nonempty=(value:string)=>typeof value==="string"&&value.trim().length>0;
function validateCursors(value: ForwardTargetRefreshCursors) {
  if (!value || typeof value!=="object" || Object.keys(value).some(key=>key!=="fomo"&&key!=="wallet")) throw new Error("Invalid refresh cursors");
  for(const channel of ["fomo","wallet"] as const) {
    const cursor=value[channel];
    if(cursor!==null && (!cursor || !nonempty(cursor.entityId) || !nonempty(cursor.subjectKey) || Object.keys(cursor).some(key=>key!=="entityId"&&key!=="subjectKey"))) throw new Error("Invalid refresh cursor");
  }
}
export async function claimPostgresForwardTargetRefresh(tx:PostgresTransaction,input:{
  readonly generationId:string;readonly leaseId:string;readonly ownerId:string;readonly now:number;readonly leaseDurationMs:number;
}) {
  if(!nonempty(input.generationId)||!nonempty(input.leaseId)||!nonempty(input.ownerId)||!clock(input.now)||!Number.isSafeInteger(input.leaseDurationMs)||input.leaseDurationMs<=0||!clock(input.now+input.leaseDurationMs)) throw new Error("Invalid refresh claim");
  await tx.query("INSERT INTO forward_target_refresh_coordinators(generation_id,cursors) VALUES($1,$2) ON CONFLICT(generation_id) DO NOTHING",[input.generationId,JSON.stringify({fomo:null,wallet:null})]);
  const row=(await tx.query("SELECT * FROM forward_target_refresh_coordinators WHERE generation_id=$1 FOR UPDATE SKIP LOCKED",[input.generationId])).rows[0];
  if(!row || (row.lease_id!==null && Number(row.lease_expires_at)>input.now)) return {status:"busy" as const};
  if(row.last_checkpoint_at!==null && Number(row.last_checkpoint_at)>input.now) return {status:"deferred_clock" as const};
  const sequence=Number(row.checkpoint_sequence),cursors=JSON.parse(String(row.cursors)) as ForwardTargetRefreshCursors;
  if(!clock(sequence)) throw new Error("Invalid stored checkpoint sequence");
  validateCursors(cursors);
  const expiresAt=input.now+input.leaseDurationMs;
  await tx.query("UPDATE forward_target_refresh_coordinators SET lease_id=$2,lease_owner=$3,lease_started_at=$4,lease_expires_at=$5,last_failure_code=NULL WHERE generation_id=$1",[input.generationId,input.leaseId,input.ownerId,input.now,expiresAt]);
  return {status:"claimed" as const,lease:{generationId:input.generationId,leaseId:input.leaseId,ownerId:input.ownerId,startedAt:input.now,expiresAt,checkpointSequence:sequence,cursors} satisfies ForwardTargetRefreshLease};
}
export async function checkpointPostgresForwardTargetRefresh(tx:PostgresTransaction,lease:ForwardTargetRefreshLease,input:ForwardTargetRefreshCheckpoint) {
  validateCursors(input.nextCursors);
  if(!clock(input.checkedAt)||!clock(input.completedAt)||input.checkedAt<lease.startedAt||input.checkedAt>input.completedAt ||
    ![input.processed,input.verified,input.sourceMissing,input.sourceUnavailable].every(clock) ||
    input.processed!==input.verified+input.sourceMissing+input.sourceUnavailable ||
    input.receiptIds.length!==input.processed || new Set(input.receiptIds).size!==input.receiptIds.length || input.receiptIds.some(id=>!nonempty(id)) ||
    !clock(lease.checkpointSequence+1)) throw new Error("Invalid refresh checkpoint");
  const payload={checkedAt:input.checkedAt,nextCursors:input.nextCursors,receiptIds:[...input.receiptIds].sort(),processed:input.processed,verified:input.verified,sourceMissing:input.sourceMissing,sourceUnavailable:input.sourceUnavailable};
  const fingerprint=createHash("sha256").update(JSON.stringify([lease.generationId,lease.leaseId,lease.ownerId,lease.checkpointSequence+1,payload])).digest("hex");
  const row=(await tx.query("SELECT * FROM forward_target_refresh_coordinators WHERE generation_id=$1 FOR UPDATE",[lease.generationId])).rows[0];
  const previous=(await tx.query("SELECT checkpoint_sequence,fingerprint FROM forward_target_refresh_checkpoints WHERE generation_id=$1 AND lease_id=$2",[lease.generationId,lease.leaseId])).rows[0];
  if(previous) {
    if(previous.fingerprint!==fingerprint) throw new Error("Refresh checkpoint identity conflict");
    return {status:"duplicate" as const,checkpointSequence:Number(previous.checkpoint_sequence)};
  }
  if(!row || row.lease_id!==lease.leaseId || row.lease_owner!==lease.ownerId || Number(row.checkpoint_sequence)!==lease.checkpointSequence || Number(row.lease_expires_at)<=input.completedAt) return {status:"lease_lost" as const};
  if(row.last_checked_at!==null && Number(row.last_checked_at)>input.checkedAt) throw new Error("Refresh assessment clock regressed");
  const receipts=(await tx.query("SELECT refresh_id,generation_id,entity_id,channel,subject_key,checked_at,status FROM forward_target_identity_refresh_receipts WHERE refresh_id=ANY($1::text[])",[input.receiptIds])).rows;
  if(receipts.length!==input.processed || receipts.some(receipt=>receipt.generation_id!==lease.generationId || Number(receipt.checked_at)!==input.checkedAt) ||
    receipts.filter(receipt=>receipt.status==="verified").length!==input.verified ||
    receipts.filter(receipt=>receipt.status==="source_missing").length!==input.sourceMissing ||
    receipts.filter(receipt=>receipt.status==="source_unavailable").length!==input.sourceUnavailable) throw new Error("Refresh receipt proof missing");
  for(const channel of ["fomo","wallet"] as const) {
    const next=input.nextCursors[channel];
    if(next && (!receipts.some(receipt=>receipt.channel===channel && receipt.entity_id===next.entityId && receipt.subject_key===next.subjectKey) ||
      (lease.cursors[channel]?.entityId===next.entityId && lease.cursors[channel]?.subjectKey===next.subjectKey))) throw new Error("Refresh cursor lacks progress proof");
  }
  const sequence=lease.checkpointSequence+1;
  await tx.query("UPDATE forward_target_refresh_coordinators SET checkpoint_sequence=$2,cursors=$3,last_checked_at=$4,last_checkpoint_at=$5,lease_id=NULL,lease_owner=NULL,lease_started_at=NULL,lease_expires_at=NULL,last_failure_code=NULL WHERE generation_id=$1",[lease.generationId,sequence,JSON.stringify(input.nextCursors),input.checkedAt,input.completedAt]);
  await tx.query("INSERT INTO forward_target_refresh_checkpoints(checkpoint_id,generation_id,checkpoint_sequence,lease_id,checked_at,completed_at,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",["refresh-checkpoint:"+fingerprint,lease.generationId,sequence,lease.leaseId,input.checkedAt,input.completedAt,fingerprint,JSON.stringify(payload)]);
  return {status:"checkpointed" as const,checkpointSequence:sequence};
}
export async function releasePostgresForwardTargetRefresh(tx:PostgresTransaction,lease:ForwardTargetRefreshLease,reason:"source_page_failed"|"checkpoint_failed") {
  if(reason!=="source_page_failed"&&reason!=="checkpoint_failed") throw new Error("Invalid refresh failure code");
  const result=await tx.query("UPDATE forward_target_refresh_coordinators SET lease_id=NULL,lease_owner=NULL,lease_started_at=NULL,lease_expires_at=NULL,last_failure_code=$4 WHERE generation_id=$1 AND lease_id=$2 AND lease_owner=$3",[lease.generationId,lease.leaseId,lease.ownerId,reason]);
  return {released:result.rowCount===1};
}
