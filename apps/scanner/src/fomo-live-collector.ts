import { selectFomoTargetActivity, type FomoActivityTarget } from "@address-radar/collectors";
import type { ScannerCollectorBatch, ScannerObservation } from "./runtime.js";

export function createFomoLiveCollector(input: {
  readonly targets: () => readonly FomoActivityTarget[];
  readonly now?: () => number;
  readonly capacity?: number;
}) {
  const capacity = input.capacity ?? 500;
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive safe integer");
  const now = input.now ?? Date.now;
  const pending = new Map<string, ScannerObservation>();
  let overflow = 0;
  let revoked = 0;
  let connected = false;
  return Object.freeze({
    name: "fomo-live-browser",
    setConnected(value: boolean) { connected = value; },
    receive(body: string): boolean {
      const selected = selectFomoTargetActivity(body, input.targets());
      if (!selected) return false;
      const activity = selected.activity;
      if (pending.has(activity.eventId)) return true;
      if (pending.size >= capacity) { overflow += 1; return false; }
      pending.set(activity.eventId, Object.freeze({ event: Object.freeze({
        eventId: activity.eventId, accountId: activity.accountId, entityId: selected.entityId,
        chain: activity.chain, tokenAddress: activity.tokenAddress, side: activity.side,
        amountUsd: activity.amountUsd, priceUsd: activity.priceUsd, marketCapUsd: activity.marketCapUsd,
        occurredAt: activity.occurredAt, collectedAt: now(), tokenAgeMs: null, source: "fomo_stream" as const,
      }) }));
      return true;
    },
    diagnostics() { return Object.freeze({ connected, pending: pending.size, overflow, revoked, coverageComplete: false }); },
    async collect(): Promise<ScannerCollectorBatch> {
      const owners = new Map(input.targets().map(target => [target.accountId, target.entityId]));
      for (const [id, observation] of pending) {
        if (owners.get(observation.event!.accountId) !== observation.event!.entityId) { pending.delete(id); revoked += 1; }
      }
      const batch = [...pending.entries()];
      return Object.freeze({
        observations: Object.freeze(batch.map(([, observation]) => observation)),
        status: connected ? "ready" as const : "unavailable" as const,
        queueOldestAt: batch.length ? Math.min(...batch.map(([, observation]) => observation.event!.occurredAt)) : null,
        commit: () => { for (const [id, observation] of batch) if (pending.get(id) === observation) pending.delete(id); },
      });
    },
  });
}
