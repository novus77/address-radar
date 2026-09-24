import type { AddressRadarRepository } from "@address-radar/database";
import { radarSignalV1Schema } from "@address-radar/radar-signal";

import { GatewayDeliveryError } from "./gateway-client.js";

export function retryDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 8));
  return Math.round(base * (0.8 + random() * 0.4));
}

export function createGatewayDeliveryWorker(input: {
  readonly repository: Pick<AddressRadarRepository, "claimSignalOutbox" | "markSignalOutboxDelivered" | "failSignalOutbox" | "deadLetterSignalOutbox">;
  readonly client: Readonly<{ deliver(signal: ReturnType<typeof radarSignalV1Schema.parse>): Promise<void> }>;
  readonly workerId: string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly leaseMs?: number;
}) {
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  return Object.freeze({
    async runOnce() {
      const row = input.repository.claimSignalOutbox({ workerId: input.workerId, now: now(), leaseMs: input.leaseMs ?? 60_000 });
      if (!row) return Object.freeze({ status: "idle" as const });
      try {
        await input.client.deliver(radarSignalV1Schema.parse(row.payload));
        if (!row.claimToken || !input.repository.markSignalOutboxDelivered({ outboxId: row.outboxId, claimToken: row.claimToken, deliveredAt: now() })) throw new Error("Outbox delivery claim was lost");
        return Object.freeze({ status: "delivered" as const, outboxId: row.outboxId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (row.claimToken && error instanceof GatewayDeliveryError && error.permanent) {
          input.repository.deadLetterSignalOutbox({ outboxId: row.outboxId, claimToken: row.claimToken, error: message });
          return Object.freeze({ status: "dead_letter" as const, outboxId: row.outboxId, error: message });
        }
        if (row.claimToken) input.repository.failSignalOutbox({ outboxId: row.outboxId, claimToken: row.claimToken, nextRetryAt: now() + retryDelayMs(row.attemptCount, random), error: message });
        return Object.freeze({ status: "retry_scheduled" as const, outboxId: row.outboxId, error: message });
      }
    },
  });
}
