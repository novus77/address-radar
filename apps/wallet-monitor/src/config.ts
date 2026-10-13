import { RADAR_DISCOVERY_CHAINS, type DiscoveryChain } from "@address-radar/collectors";

export interface WalletMonitorConfig {
  readonly databasePath: string;
  readonly intervalMs: number;
  readonly solanaBatchSize: number;
  readonly solanaSignatureLimit: number;
  readonly evmBootstrapFloors: Readonly<Partial<Record<"eth" | "bsc" | "base", number>>>;
  readonly solanaRateLimitCooldownMs: number;
  readonly indexedWalletBatchSize: number;
  readonly indexedWalletMaxPages: number;
  readonly indexedWalletLookbackMs: number;
  readonly endpoints: Readonly<Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>>>;
  readonly indexedEndpoints: Readonly<Partial<Record<Exclude<DiscoveryChain, "solana">, string>>>;
}

export function loadWalletMonitorConfig(env: Readonly<Record<string, string | undefined>>): WalletMonitorConfig {
  const endpoints: Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>> = {};
  const indexedEndpoints: Partial<Record<Exclude<DiscoveryChain, "solana">, string>> = {};
  for (const chain of RADAR_DISCOVERY_CHAINS) {
    const key = chain.toUpperCase();
    const primary = env[`RADAR_RPC_${key}_HTTP_URL`]?.trim();
    if (!primary) continue;
    ensureHttpUrl(primary, chain);
    const fallback = env[`RADAR_RPC_${key}_FALLBACK_HTTP_URL`]?.trim();
    if (fallback) ensureHttpUrl(fallback, chain);
    endpoints[chain] = Object.freeze({ primary, ...(fallback ? { fallback } : {}) });
    if (chain !== "solana") {
      const indexedEndpoint = env[`ADDRESS_RADAR_BLOCKSCOUT_${key}_URL`]?.trim();
      if (indexedEndpoint) {
        ensureHttpUrl(indexedEndpoint, `${chain} Blockscout`);
        indexedEndpoints[chain] = indexedEndpoint;
      }
    }
  }
  if (Object.keys(endpoints).length === 0) throw new Error("At least one wallet-monitor RPC endpoint is required");
  return Object.freeze({
    databasePath: env.ADDRESS_RADAR_DATABASE_PATH?.trim() || ".address-radar/address-radar.sqlite",
    intervalMs: positiveInteger(env.ADDRESS_RADAR_WALLET_MONITOR_INTERVAL_MS, 5_000, "wallet monitor interval"),
    solanaBatchSize: positiveInteger(env.ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE, 3, "Solana wallet batch size"),
    solanaSignatureLimit: positiveInteger(env.ADDRESS_RADAR_SOLANA_SIGNATURE_LIMIT, 100, "Solana signature limit", 1000),
    evmBootstrapFloors: readEvmBootstrapFloors(env.ADDRESS_RADAR_EVM_BOOTSTRAP_FLOORS),
    solanaRateLimitCooldownMs: positiveInteger(
      env.ADDRESS_RADAR_SOLANA_RATE_LIMIT_COOLDOWN_MS,
      30_000,
      "Solana rate-limit cooldown",
    ),
    indexedWalletBatchSize: positiveInteger(env.ADDRESS_RADAR_INDEXED_WALLET_BATCH_SIZE, 5, "indexed wallet batch size"),
    indexedWalletMaxPages: positiveInteger(env.ADDRESS_RADAR_INDEXED_WALLET_MAX_PAGES, 2, "indexed wallet max pages"),
    indexedWalletLookbackMs: positiveInteger(env.ADDRESS_RADAR_INDEXED_WALLET_LOOKBACK_DAYS, 60, "indexed wallet lookback days") * 24 * 60 * 60 * 1_000,
    endpoints: Object.freeze(endpoints),
    indexedEndpoints: Object.freeze(indexedEndpoints),
  });
}

function readEvmBootstrapFloors(value: string | undefined): WalletMonitorConfig["evmBootstrapFloors"] {
  if (value === undefined) return Object.freeze({});
  const invalid = () => new Error("Invalid sealed EVM bootstrap floors");
  if (value.length > 4096) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const floors: Partial<Record<"eth" | "bsc" | "base", number>> = {};
  for (const [chain, floor] of Object.entries(parsed)) {
    if (!["eth", "bsc", "base"].includes(chain) || typeof floor !== "number" || !Number.isSafeInteger(floor) || floor < 1) throw invalid();
    floors[chain as "eth" | "bsc" | "base"] = floor;
  }
  // JSON.parse accepts duplicate keys; a sealed floor must never depend on last-key-wins.
  const keys = new Set<string>();
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    const key = JSON.parse(`"${match[1]}"`) as string;
    if (keys.has(key)) throw invalid();
    keys.add(key);
  }
  return Object.freeze(floors);
}

function ensureHttpUrl(value: string, chain: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Invalid RPC endpoint for ${chain}`);
}

function positiveInteger(value: string | undefined, fallback: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`Invalid ${label}`);
  return parsed;
}
