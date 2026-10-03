import { createPostgresForwardTraderCapabilityWorkRepository, type ForwardTraderCapabilityLease, type PostgresTransaction } from "@address-radar/database";
import { forwardEvidenceTime } from "@address-radar/domain";
import { projectPostgresForwardTraderCapability } from "./forward-trader-capability-worker.js";

export async function consumePostgresForwardTraderCapability(transaction: PostgresTransaction, lease: ForwardTraderCapabilityLease, input: {
  readonly now: () => number; readonly maximumSamples: number; readonly retryDelayMs: number;
}) {
  if (!Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 1) throw new Error("Invalid capability retry delay");
  const work = createPostgresForwardTraderCapabilityWorkRepository(transaction);
  const asOf = input.now(); forwardEvidenceTime(asOf);
  // Do not retain a job lock while waiting for projection/sample locks.
  await work.preflight(lease, asOf);
  const result = await projectPostgresForwardTraderCapability(transaction, {
    entityId: lease.entityId, generationId: lease.generationId, asOf, maximumSamples: input.maximumSamples,
  });
  const finishedAt = input.now(); forwardEvidenceTime(finishedAt);
  if (finishedAt < asOf) throw new Error("Capability clock moved backwards");
  if (result.status === "deferred" || result.status === "stale_decision") {
    const reasonCode = result.status === "deferred" ? result.reasonCode : "capability_stale_decision";
    await work.defer(lease, { now: finishedAt, retryAt: finishedAt + input.retryDelayMs, reasonCode });
    return { status: "deferred" as const, reasonCode };
  }
  // Loss/expiry throws; the caller must roll back projection and receipt together.
  await work.complete(lease, { now: finishedAt, versionId: result.versionId, headGeneration: result.headGeneration });
  return { status: "projected" as const, projectionStatus: result.status, versionId: result.versionId,
    stableCapability: result.projection.stableCapability, observationStatus: result.projection.observationStatus };
}
