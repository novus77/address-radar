import { randomUUID } from "node:crypto";
import type { FomoLiveInbox } from "@address-radar/database";
import type { MonitoringRegistry } from "@address-radar/identity";
import { createFomoCdpObserver } from "./fomo-cdp-observer.js";
import { createFomoLiveCollector } from "./fomo-live-collector.js";

export function createFomoBrowserCollector(input: { readonly endpoint: string; readonly registry: MonitoringRegistry; readonly inbox: FomoLiveInbox }) {
  if (!input.registry.fomoAccounts) throw new Error("FOMO target registry capability is required");
  const sessionId=randomUUID();
  input.inbox.startSession(sessionId,Date.now());
  const collector=createFomoLiveCollector({targets:()=>input.registry.fomoAccounts!(),inbox:input.inbox});
  const observer=createFomoCdpObserver({endpoint:input.endpoint,onActivity:body=>{collector.receive(body);}});
  let lastConnectionError: "cdp_unavailable" | "cdp_not_attached" | null = null;
  let consecutiveConnectionFailures = 0;
  return Object.freeze({
    name:collector.name,
    async collect() {
      let connected = false;
      try {
        connected = await observer.refresh() > 0;
        lastConnectionError = connected ? null : "cdp_not_attached";
      } catch {
        lastConnectionError = "cdp_unavailable";
      }
      consecutiveConnectionFailures = connected ? 0 : consecutiveConnectionFailures + 1;
      input.inbox.connection(sessionId,connected,Date.now());
      collector.setConnected(connected);
      return collector.collect();
    },

    diagnostics: () => Object.freeze({ ...collector.diagnostics(), lastConnectionError, consecutiveConnectionFailures }),
    close() {observer.close();input.inbox.endSession(sessionId,Date.now());},
  });
}
