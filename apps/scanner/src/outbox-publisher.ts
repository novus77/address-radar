import type { AddressRadarRepository } from "@address-radar/database";
import { replayRadarSignalV1, type RadarSignalV1 } from "@address-radar/signal-engine";

export interface SignalOutboxSink { accept(candidates: readonly RadarSignalV1[]): void | Promise<void> }

export function createSignalOutboxPublisher(input: {
  readonly repository: Pick<AddressRadarRepository, "claimSignalOutbox" | "markSignalOutboxDelivered" | "failSignalOutbox">;
  readonly sink: SignalOutboxSink;
  readonly workerId: string;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: (attemptCount: number) => number;
}) {
  const now = input.now ?? Date.now;
  const leaseMs = input.leaseMs ?? 60_000;
  const retryDelayMs = input.retryDelayMs ?? (attempt => Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6)));
  return Object.freeze({
    async publishNext() {
      const row = input.repository.claimSignalOutbox({ workerId: input.workerId, now: now(), leaseMs });
      if (!row) return Object.freeze({ status: "idle" as const });
      try {
        const signal = replayRadarSignalV1(row.payload);
        await input.sink.accept(Object.freeze([signal]));
        if (!row.claimToken || !input.repository.markSignalOutboxDelivered({ outboxId: row.outboxId, claimToken: row.claimToken, deliveredAt: now() })) throw new Error("Outbox delivery claim was lost");
        return Object.freeze({ status: "delivered" as const, outboxId: row.outboxId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (row.claimToken) input.repository.failSignalOutbox({ outboxId: row.outboxId, claimToken: row.claimToken, nextRetryAt: now() + retryDelayMs(row.attemptCount), error: message });
        return Object.freeze({ status: "retry_scheduled" as const, outboxId: row.outboxId, error: message });
      }
    },
  });
}
