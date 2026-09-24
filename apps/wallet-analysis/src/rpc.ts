import { createJsonRpcClient, type DiscoveryChain, type FetchLike, type JsonRpcClient } from "@address-radar/collectors";
import type { AnalysisRpcClient } from "./history.js";

export function createConfiguredAnalysisRpcClient(input: { readonly endpoints: Readonly<Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>>>; readonly fetch?: FetchLike }): AnalysisRpcClient {
  const clients = new Map<DiscoveryChain, JsonRpcClient>();
  for (const [chain, endpoint] of Object.entries(input.endpoints) as Array<[DiscoveryChain, { primary: string; fallback?: string }]>) clients.set(chain, createJsonRpcClient({ endpoint: endpoint.primary, ...(endpoint.fallback ? { fallbackEndpoint: endpoint.fallback } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) }));
  if (clients.size === 0) throw new Error("At least one configured RPC client is required");
  const rpc: AnalysisRpcClient = { async request(chain, method, params, signal) { if (signal.aborted) throw signal.reason ?? new Error("Aborted"); const client = clients.get(chain); if (!client) throw new Error(`RPC chain is not configured: ${chain}`); return client.request(method, params, signal); } };
  return Object.freeze(rpc);
}
