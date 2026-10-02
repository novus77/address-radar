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
  return Object.freeze({
    name:collector.name,
    async collect() {
      try {
        const connected=await observer.refresh()>0;
        input.inbox.connection(sessionId,connected,Date.now());collector.setConnected(connected);
      } catch(error) {
        input.inbox.connection(sessionId,false,Date.now());collector.setConnected(false);throw error;
      }
      return collector.collect();
    },

    diagnostics:collector.diagnostics,
    close() {observer.close();input.inbox.endSession(sessionId,Date.now());},
  });
}
