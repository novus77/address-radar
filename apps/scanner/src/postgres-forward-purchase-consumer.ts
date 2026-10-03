import { createPostgresConsumerWorkRepository, createPostgresForwardPurchaseRepository,
  type CaptureConsumerLease, type PostgresTransaction, type VerifiedForwardPurchase } from "@address-radar/database";

export const FORWARD_PURCHASE_CONSUMER = Object.freeze({ consumerName:"forward_purchase_match",consumerVersion:"forward-purchase-v1" });
export type ForwardPurchaseResolution =
  | { readonly status:"verified"; readonly purchase:VerifiedForwardPurchase }
  | { readonly status:"deferred"; readonly reasonCode:string };

// Resolve external execution/ownership evidence before opening the database transaction.
export async function consumePostgresForwardPurchase(transaction:PostgresTransaction,lease:CaptureConsumerLease,
  input:{readonly generationId:string;readonly resolution:ForwardPurchaseResolution;readonly now:number;readonly retryAt:number}) {
  const work = createPostgresConsumerWorkRepository(transaction,FORWARD_PURCHASE_CONSUMER);
  const defer = (reasonCode:string) => work.defer(lease,{now:input.now,retryAt:input.retryAt,reasonCode});
  if (lease.requiresReview) return {status:"deferred" as const,applied:await defer("source_revision_review")};
  if (input.resolution.status==="deferred") return {status:"deferred" as const,applied:await defer(input.resolution.reasonCode)};
  const result = await createPostgresForwardPurchaseRepository(transaction).record({generationId:input.generationId,
    sourceJobId:lease.jobId,purchase:input.resolution.purchase,recordedAt:input.now});
  if (result.status==="revision_pending" || result.status==="ownership_conflict") {
    const applied = await defer(result.status);
    if (!applied) throw new Error("Forward purchase review was not fenced by its active consumer lease");
    return {status:"deferred" as const,applied:true,tradeId:result.tradeId};
  }
  const applied = await work.complete(lease,result.status==="sample_ready"
    ? {outcome:"produced",resultKey:`forward-sample:${result.sampleId!}`}
    : {outcome:"no_output",reasonCode:"excluded_by_policy"},input.now);
  if (!applied) throw new Error("Forward purchase result was not fenced by its active consumer lease");
  return {status:result.status,applied:true,tradeId:result.tradeId,sampleId:result.sampleId};
}
