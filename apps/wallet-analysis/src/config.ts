import { RADAR_DISCOVERY_CHAINS, type DiscoveryChain } from "@address-radar/collectors";

export interface WalletAnalysisConfig {
  readonly databasePath: string;
  readonly intervalMs: number;
  readonly endpoints: Readonly<Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>>>;
}

export function loadWalletAnalysisConfig(env: Readonly<Record<string, string | undefined>>): WalletAnalysisConfig {
  const endpoints: Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>> = {};
  for (const chain of RADAR_DISCOVERY_CHAINS) {
    const key = chain.toUpperCase();
    const primary = env[`RADAR_RPC_${key}_HTTP_URL`]?.trim();
    if (!primary) continue;
    ensureHttpUrl(primary, chain);
    const fallback = env[`RADAR_RPC_${key}_FALLBACK_HTTP_URL`]?.trim();
    if (fallback) ensureHttpUrl(fallback, chain);
    endpoints[chain] = Object.freeze({ primary, ...(fallback ? { fallback } : {}) });
  }
  if (Object.keys(endpoints).length === 0) throw new Error("At least one wallet-analysis RPC endpoint is required");
  const interval = Number(env.ADDRESS_RADAR_WALLET_ANALYSIS_INTERVAL_MS ?? 5_000);
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("Invalid wallet analysis interval");
  return Object.freeze({ databasePath: env.ADDRESS_RADAR_DATABASE_PATH?.trim() || ".address-radar/address-radar.sqlite", intervalMs: interval, endpoints: Object.freeze(endpoints) });
}

function ensureHttpUrl(value: string, chain: string): void { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Invalid RPC endpoint for ${chain}`); }
