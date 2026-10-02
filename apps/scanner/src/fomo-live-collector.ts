import type { FomoLiveInbox } from "@address-radar/database";
import { selectFomoTargetActivity, type FomoActivityTarget } from "@address-radar/collectors";
import type { ScannerCollectorBatch, ScannerObservation } from "./runtime.js";

export function createFomoLiveCollector(input: {
  readonly targets: () => readonly FomoActivityTarget[];
  readonly now?: () => number;
  readonly capacity?: number;
  readonly inbox?: FomoLiveInbox;
}) {
  const capacity = input.capacity ?? 500;
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive safe integer");
  const now = input.now ?? Date.now;
  const pending = new Map<string, ScannerObservation>();
  const retryPayloads = new Map<string, string>();
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
      if (!input.inbox && pending.size >= capacity) { overflow += 1; return false; }
      const observation: ScannerObservation = Object.freeze({ event: Object.freeze({
        eventId: activity.eventId, accountId: activity.accountId, entityId: selected.entityId,
        chain: activity.chain, tokenAddress: activity.tokenAddress, side: activity.side,
        amountUsd: activity.amountUsd, priceUsd: activity.priceUsd, marketCapUsd: activity.marketCapUsd,
        occurredAt: activity.occurredAt, collectedAt: now(), tokenAgeMs: null, source: "fomo_stream" as const,
      }) });
      if (input.inbox) {
        const raw = JSON.parse(body) as {payload:Record<string,unknown>};
        const keys = ["id","tradeId","type","userId","userHandle","tokenAddress","networkId","createdAt","usdAmount","price","marketCap"];
        const sanitized = JSON.stringify({type:"data",topicType:"trading_activity",payload:Object.fromEntries(keys.filter(key=>raw.payload[key]!==undefined).map(key=>[key,raw.payload[key]]))});
        try { return input.inbox.append(observation.event!,sanitized) !== "revision_pending"; }
        catch(error) {
          if(pending.size < capacity) {
            pending.set(activity.eventId,observation);
            retryPayloads.set(activity.eventId,sanitized);
          } else overflow += 1;
          throw error;
        }
      }
      pending.set(activity.eventId,observation);

      return true;
    },
    diagnostics() { return Object.freeze({ connected, pending: pending.size, overflow, revoked, coverageComplete: false }); },
    async collect(): Promise<ScannerCollectorBatch> {
      const owners = new Map(input.targets().map(target => [target.accountId, target.entityId]));
      if (input.inbox) {
        for(const [id,observation] of pending) {
          const rawPayload = retryPayloads.get(id);
          if (rawPayload === undefined) throw new Error("missing original payload for write retry");
          input.inbox.append(observation.event!,rawPayload);
          pending.delete(id);
          retryPayloads.delete(id);
        }
        const rows=input.inbox.pending(capacity);
        const revokedIds=rows.filter(row=>owners.get(row.event.accountId)!==row.event.entityId).map(row=>row.event.eventId);
        if(revokedIds.length) {input.inbox.acknowledge(revokedIds,now(),"monitoring_revoked");revoked+=revokedIds.length;}
        const observations=rows.filter(row=>owners.get(row.event.accountId)===row.event.entityId);
        return Object.freeze({
          observations:Object.freeze(observations),status:connected?"ready" as const:"unavailable" as const,
          queueOldestAt:observations.length?Math.min(...observations.map(row=>row.event.occurredAt)):null,
          commit:()=>input.inbox!.acknowledge(observations.map(row=>row.event.eventId),now()),
        });
      }

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
