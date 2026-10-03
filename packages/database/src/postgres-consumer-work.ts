import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_CONSUMER_WORK_SCHEMA_SQL = `
CREATE TABLE capture_consumer_jobs (
  intent_id text NOT NULL REFERENCES capture_consumer_intents(intent_id), consumer_name text NOT NULL,
  consumer_version text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','completed')),
  next_attempt_at bigint NOT NULL, lease_owner text, claim_generation integer NOT NULL DEFAULT 0,
  lease_expires_at bigint, failure_reason text, completed_at bigint,
  PRIMARY KEY(intent_id,consumer_name,consumer_version)
);
CREATE INDEX capture_consumer_jobs_due ON capture_consumer_jobs(consumer_name,consumer_version,next_attempt_at,intent_id)
  WHERE status IN ('pending','leased');
CREATE TABLE capture_consumer_receipts (
  intent_id text NOT NULL, consumer_name text NOT NULL, consumer_version text NOT NULL,
  input_fingerprint text NOT NULL, parser_version text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('produced','no_output')),
  result_key text, reason_code text, committed_at bigint NOT NULL,
  PRIMARY KEY(intent_id,consumer_name,consumer_version),
  FOREIGN KEY(intent_id,consumer_name,consumer_version)
    REFERENCES capture_consumer_jobs(intent_id,consumer_name,consumer_version),
  CHECK ((outcome='produced' AND result_key IS NOT NULL) OR (outcome='no_output' AND reason_code IS NOT NULL))
);
`;

export interface CaptureConsumerLease {
  readonly intentId:string;
  readonly jobId:string;
  readonly consumerName:string;
  readonly consumerVersion:string;
  readonly owner:string;
  readonly claimGeneration:number;
  readonly leaseExpiresAt:number;
  readonly inputFingerprint:string;
  readonly parserVersion:string;
  readonly requiresReview:boolean;
}
export type CaptureConsumerOutcome =
  | { readonly outcome:"produced"; readonly resultKey:string }
  | { readonly outcome:"no_output"; readonly reasonCode:"non_trade_event"|"excluded_by_policy" };
function id(value:string):void {
  if (!value.trim()||value.length>512) throw new Error("Consumer identity must be nonempty and bounded");
}
function clock(value:number):void {
  if (!Number.isSafeInteger(value)||value<0) throw new Error("Consumer timestamp is invalid");
}

export function createPostgresConsumerWorkRepository(transaction:PostgresTransaction,
  config:{readonly consumerName:string;readonly consumerVersion:string}) {
  id(config.consumerName);id(config.consumerVersion);
  async function owned(lease:CaptureConsumerLease,now:number) {
    clock(now);id(lease.intentId);id(lease.owner);
    if (lease.consumerName!==config.consumerName||lease.consumerVersion!==config.consumerVersion) throw new Error("Consumer lease belongs to another policy");
    if (!Number.isSafeInteger(lease.claimGeneration)||lease.claimGeneration<1) throw new Error("Consumer claim generation is invalid");
    const result=await transaction.query(`SELECT w.*,i.job_id,j.semantic_fingerprint,j.parser_version,r.requires_review
      FROM capture_consumer_jobs w JOIN capture_consumer_intents i USING(intent_id)
      JOIN capture_normalization_jobs j ON j.job_id=i.job_id JOIN capture_normalized_results r ON r.job_id=j.job_id
      WHERE w.intent_id=$1 AND w.consumer_name=$2 AND w.consumer_version=$3 AND w.status='leased'
        AND w.lease_owner=$4 AND w.claim_generation=$5 AND w.lease_expires_at>$6 FOR UPDATE OF w`,
      [lease.intentId,config.consumerName,config.consumerVersion,lease.owner,lease.claimGeneration,now]);
    const row=result.rows[0];
    if (row&&(row.job_id!==lease.jobId||row.semantic_fingerprint!==lease.inputFingerprint||row.parser_version!==lease.parserVersion)) {
      throw new Error("Consumer lease input revision does not match");
    }
    return row;
  }
  return Object.freeze({
    async schedulePending(now:number,limit:number):Promise<number> {
      clock(now);
      if (!Number.isSafeInteger(limit)||limit<1||limit>1_000) throw new Error("Consumer admission batch must be between 1 and 1000");
      const result=await transaction.query(`INSERT INTO capture_consumer_jobs(intent_id,consumer_name,consumer_version,next_attempt_at)
        SELECT i.intent_id,$1,$2,$3 FROM capture_consumer_intents i
        WHERE NOT EXISTS(SELECT 1 FROM capture_consumer_jobs w WHERE w.intent_id=i.intent_id AND w.consumer_name=$1 AND w.consumer_version=$2)
        ORDER BY i.created_at,i.intent_id LIMIT $4 ON CONFLICT(intent_id,consumer_name,consumer_version) DO NOTHING`,
        [config.consumerName,config.consumerVersion,now,limit]);
      return result.rowCount??0;
    },
    async claim(input:{readonly owner:string;readonly now:number;readonly leaseMs:number}):Promise<CaptureConsumerLease|null> {
      id(input.owner);clock(input.now);
      if (!Number.isSafeInteger(input.leaseMs)||input.leaseMs<=0||!Number.isSafeInteger(input.now+input.leaseMs)) throw new Error("Consumer lease duration is invalid");
      const result=await transaction.query(`WITH due AS (
        SELECT intent_id FROM capture_consumer_jobs WHERE consumer_name=$1 AND consumer_version=$2 AND
          ((status='pending' AND next_attempt_at<=$3) OR (status='leased' AND lease_expires_at<=$3))
        ORDER BY next_attempt_at,intent_id FOR UPDATE SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE capture_consumer_jobs w SET status='leased',lease_owner=$4,claim_generation=w.claim_generation+1,
          lease_expires_at=$5 FROM due WHERE w.intent_id=due.intent_id AND w.consumer_name=$1 AND w.consumer_version=$2 RETURNING w.*
      ) SELECT w.*,i.job_id,j.semantic_fingerprint,j.parser_version,r.requires_review FROM claimed w
        JOIN capture_consumer_intents i USING(intent_id) JOIN capture_normalization_jobs j ON j.job_id=i.job_id
        JOIN capture_normalized_results r ON r.job_id=j.job_id`,
        [config.consumerName,config.consumerVersion,input.now,input.owner,input.now+input.leaseMs]);
      const row=result.rows[0];if(!row)return null;
      return Object.freeze({intentId:String(row.intent_id),jobId:String(row.job_id),consumerName:config.consumerName,
        consumerVersion:config.consumerVersion,owner:input.owner,claimGeneration:Number(row.claim_generation),
        leaseExpiresAt:Number(row.lease_expires_at),inputFingerprint:String(row.semantic_fingerprint),parserVersion:String(row.parser_version),
        requiresReview:row.requires_review===true});
    },
    async complete(lease:CaptureConsumerLease,outcome:CaptureConsumerOutcome,now:number):Promise<boolean> {
      if(outcome.outcome==="produced")id(outcome.resultKey);
      else if(outcome.outcome!=="no_output"||!["non_trade_event","excluded_by_policy"].includes(outcome.reasonCode))throw new Error("Consumer no-output reason is invalid");
      const row=await owned(lease,now);if(!row)return false;
      if(row.requires_review===true)throw new Error("Source revision requires review before consumer completion");
      // The caller must persist its actual result through this same transaction before recording this receipt.
      await transaction.query(`INSERT INTO capture_consumer_receipts(intent_id,consumer_name,consumer_version,input_fingerprint,
        parser_version,outcome,result_key,reason_code,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [lease.intentId,config.consumerName,config.consumerVersion,lease.inputFingerprint,lease.parserVersion,outcome.outcome,
          outcome.outcome==="produced"?outcome.resultKey:null,outcome.outcome==="no_output"?outcome.reasonCode:null,now]);
      await transaction.query(`UPDATE capture_consumer_jobs SET status='completed',completed_at=$4,lease_owner=NULL,lease_expires_at=NULL
        WHERE intent_id=$1 AND consumer_name=$2 AND consumer_version=$3`,[lease.intentId,config.consumerName,config.consumerVersion,now]);
      await transaction.query(`UPDATE capture_consumer_intents SET status='dispatched',dispatched_at=COALESCE(dispatched_at,$2)
        WHERE intent_id=$1`,[lease.intentId,now]);
      return true;
    },
    async defer(lease:CaptureConsumerLease,input:{readonly now:number;readonly retryAt:number;readonly reasonCode:string}):Promise<boolean> {
      clock(input.retryAt);id(input.reasonCode);
      if(input.retryAt<input.now)throw new Error("Consumer retry cannot precede its decision time");
      if(!await owned(lease,input.now))return false;
      await transaction.query(`UPDATE capture_consumer_jobs SET status='pending',next_attempt_at=$4,failure_reason=$5,
        lease_owner=NULL,lease_expires_at=NULL WHERE intent_id=$1 AND consumer_name=$2 AND consumer_version=$3`,
        [lease.intentId,config.consumerName,config.consumerVersion,input.retryAt,input.reasonCode]);
      return true;
    },
  });
}
