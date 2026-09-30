import type { AddressRadarRepository, HistoricalBackfillPartition } from "@address-radar/database";

export interface HistoricalBackfillWorkerResult { readonly executionId: string; readonly nextOffset: number | null; readonly rowCount: number; readonly watermark: number; readonly creditsUsed: number; readonly done: boolean; }
export interface HistoricalBackfillWorker { execute(partition: HistoricalBackfillPartition, signal: AbortSignal): Promise<HistoricalBackfillWorkerResult>; }

export async function runHistoricalBackfillCycle(input: {
  readonly verification: { runOnce(): Promise<{ readonly processed: boolean }> };
  readonly scheduler: { runOnce(signal?: AbortSignal): Promise<{ readonly processed: boolean }> };
  readonly signal: AbortSignal;
}): Promise<{ readonly processed: boolean }> {
  const verification = await input.verification.runOnce();
  const backfill = await input.scheduler.runOnce(input.signal);
  return Object.freeze({ processed: verification.processed || backfill.processed });
}

const usageDay = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

export function createHistoricalBackfillScheduler(input: {
  readonly repository: AddressRadarRepository;
  readonly worker: HistoricalBackfillWorker;
  readonly dailyCreditBudget: number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
}) {
  if (!Number.isSafeInteger(input.dailyCreditBudget) || input.dailyCreditBudget < 0) throw new Error("Historical daily credit budget must be a nonnegative integer");
  const leaseMs = input.leaseMs ?? 10 * 60_000;
  const retryDelayMs = input.retryDelayMs ?? 60_000;
  const now = input.now ?? Date.now;
  return Object.freeze({
    async runOnce(signal: AbortSignal = new AbortController().signal) {
      const startedAt = now();
      const day = usageDay(startedAt);
      const creditsUsed = input.repository.historicalCreditsUsed(day);
      if (creditsUsed >= input.dailyCreditBudget) return Object.freeze({ processed: false, status: "budget_wait" as const, creditsUsed });
      const partition = input.repository.claimHistoricalBackfillPartition(startedAt, leaseMs);
      if (!partition) return Object.freeze({ processed: false, status: "idle" as const, creditsUsed });
      try {
        const result = await input.worker.execute(partition, signal);
        input.repository.recordHistoricalCreditUsage(day, result.creditsUsed, now());
        if (result.done) {
          input.repository.completeHistoricalBackfillPartition(partition.partitionId, { executionId: result.executionId, rowCount: result.rowCount, watermark: result.watermark, completedAt: now() });
          input.repository.advanceHistoricalWatermark(partition.chain, partition.queryKind, result.watermark, now());
          return Object.freeze({ processed: true, status: "completed" as const, partitionId: partition.partitionId, chain: partition.chain, rowCount: result.rowCount });
        }
        if (result.nextOffset === null) throw new Error("Incomplete historical partition requires nextOffset");
        input.repository.checkpointHistoricalBackfillPartition(partition.partitionId, { executionId: result.executionId, nextOffset: result.nextOffset, rowCount: result.rowCount, watermark: result.watermark, updatedAt: now() });
        return Object.freeze({ processed: true, status: "pending" as const, partitionId: partition.partitionId, chain: partition.chain, rowCount: result.rowCount });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        input.repository.failHistoricalBackfillPartition(partition.partitionId, error, now() + retryDelayMs);
        return Object.freeze({ processed: false, status: "failed" as const, partitionId: partition.partitionId, chain: partition.chain, error });
      }
    },
  });
}
