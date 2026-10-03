import { createPostgresForwardOpportunityRepository, createPostgresForwardOpportunityWorkRepository,
  createPostgresForwardOpportunityFanoutRepository, type PostgresTransaction } from "@address-radar/database";
import type { ForwardPeakEvidence } from "@address-radar/domain";

export const FORWARD_OPPORTUNITY_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export interface ForwardOpportunityTransactionRuntime {
  run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T>;
}

export async function recordPostgresForwardPeakAndWake(transaction: PostgresTransaction,
  input: { readonly peak: ForwardPeakEvidence; readonly now: number }) {
  if (input.peak.knownAt > input.now) throw new Error("Forward market publication cannot use future evidence");
  const evidence = await createPostgresForwardOpportunityRepository(transaction).recordPeak(input.peak);
  const fanout = await createPostgresForwardOpportunityFanoutRepository(transaction).enqueue({
    peakId: input.peak.peakId, revisionId: input.peak.revisionId, now: input.now });
  return { evidence, fanout };
}

// Reconcile durable facts only; the runtime owns the timer and supplies bounded budgets.
export async function reconcilePostgresForwardOpportunities(transaction: PostgresTransaction,
  input: { readonly now: number; readonly sampleLimit: number; readonly peakLimit: number }) {
  const sampleRequests = await createPostgresForwardOpportunityWorkRepository(transaction).scheduleSamples(input.now, input.sampleLimit);
  const peakFanouts = await createPostgresForwardOpportunityFanoutRepository(transaction).recover(input.now, input.peakLimit);
  return { sampleRequests, peakFanouts };
}

export async function processPostgresForwardPeakFanout(runtime: ForwardOpportunityTransactionRuntime,
  input: { readonly owner: string; readonly now: () => number; readonly leaseMs: number; readonly limit: number }) {
  const lease = await runtime.run((transaction) => createPostgresForwardOpportunityFanoutRepository(transaction)
    .claim({ owner: input.owner, now: input.now(), leaseMs: input.leaseMs }));
  if (!lease) return null;
  return runtime.run((transaction) => createPostgresForwardOpportunityFanoutRepository(transaction).dispatch(lease, input));
}
