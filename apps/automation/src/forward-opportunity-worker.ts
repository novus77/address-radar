import { createPostgresForwardOpportunityRepository, createPostgresForwardOpportunityWorkRepository,
  type ForwardOpportunityLease, type PostgresTransaction } from "@address-radar/database";
import { evaluateForwardOpportunity } from "@address-radar/scoring";

// The caller acknowledges only after the enclosing unit of work commits.
export async function consumePostgresForwardOpportunity(transaction: PostgresTransaction, lease: ForwardOpportunityLease,
  input: { readonly now: number; readonly retryAt: number }) {
  const evidence = createPostgresForwardOpportunityRepository(transaction);
  const work = createPostgresForwardOpportunityWorkRepository(transaction);
  const sample = await evidence.getSample(lease.sampleId, true);
  await work.assertOwned(lease, input.now);
  if (!sample || sample.executionFingerprint !== lease.executionFingerprint) {
    await work.supersede(lease, input.now);
    return { status: "superseded" as const };
  }
  const peaks = await evidence.listPeaks(sample, input.now);
  const evaluation = evaluateForwardOpportunity({ sample, peaks, asOf: input.now });
  const result = await evidence.saveEvaluation(evaluation);
  if (result.status === "stale_execution" || !result.evaluationId) throw new Error("Opportunity execution changed during evaluation");
  if (evaluation.status === "awaiting_verification" || evaluation.status === "insufficient_coverage") {
    await work.defer(lease, { now: input.now, retryAt: input.retryAt, reasonCode: evaluation.reasonCode });
    return { status: "deferred" as const, reasonCode: evaluation.reasonCode, evaluationId: result.evaluationId };
  }
  await work.complete(lease, result.evaluationId, input.now);
  return { status: "evaluated" as const, evaluationStatus: evaluation.status,
    tier: evaluation.tier, evaluationId: result.evaluationId };
}
