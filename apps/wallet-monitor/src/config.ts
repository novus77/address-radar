import { RADAR_DISCOVERY_CHAINS, type DiscoveryChain } from "@address-radar/collectors";

export interface WalletMonitorConfig {
  readonly databasePath: string;
  readonly intervalMs: number;
  readonly solanaBatchSize: number;
  readonly solanaRateLimitCooldownMs: number;
  readonly endpoints: Readonly<Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>>>;
}

export function loadWalletMonitorConfig(env: Readonly<Record<string, string | undefined>>): WalletMonitorConfig {
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
  if (Object.keys(endpoints).length === 0) throw new Error("At least one wallet-monitor RPC endpoint is required");
  return Object.freeze({
    databasePath: env.ADDRESS_RADAR_DATABASE_PATH?.trim() || ".address-radar/address-radar.sqlite",
    intervalMs: positiveInteger(env.ADDRESS_RADAR_WALLET_MONITOR_INTERVAL_MS, 5_000, "wallet monitor interval"),
    solanaBatchSize: positiveInteger(env.ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE, 3, "Solana wallet batch size"),
    solanaRateLimitCooldownMs: positiveInteger(
      env.ADDRESS_RADAR_SOLANA_RATE_LIMIT_COOLDOWN_MS,
      30_000,
      "Solana rate-limit cooldown",
    ),
    endpoints: Object.freeze(endpoints),
  });
}

function ensureHttpUrl(value: string, chain: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Invalid RPC endpoint for ${chain}`);
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}
