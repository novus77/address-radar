import type { MonitoringRegistry } from "@address-radar/identity";
import { createFomoCdpObserver } from "./fomo-cdp-observer.js";
import { createFomoLiveCollector } from "./fomo-live-collector.js";

export function createFomoBrowserCollector(input: { readonly endpoint: string; readonly registry: MonitoringRegistry }) {
  if (!input.registry.fomoAccounts) throw new Error("FOMO target registry capability is required");
  const collector=createFomoLiveCollector({targets:()=>input.registry.fomoAccounts!()});
  const observer=createFomoCdpObserver({endpoint:input.endpoint,onActivity:body=>{collector.receive(body);}});
  return Object.freeze({
    name:collector.name,
    async collect() {collector.setConnected(await observer.refresh()>0);return collector.collect();},
    diagnostics:collector.diagnostics,
    close:observer.close,
  });
}
