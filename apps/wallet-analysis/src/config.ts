import { RADAR_DISCOVERY_CHAINS, type DiscoveryChain } from "@address-radar/collectors";

export interface WalletAnalysisConfig {
  readonly databasePath: string;
  readonly intervalMs: number;
  readonly endpoints: Readonly<Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>>>;
}

export interface HistoricalBackfillConfig {
  readonly databasePath: string;
  readonly apiKey: string | null;
  readonly queryIds: Readonly<Partial<Record<"token_universe" | "milestone_crossings" | "pre_milestone_trades", number>>>;
  readonly duneFallbackEnabled: boolean;
  readonly geckoTerminal: { readonly baseUrl: string; readonly timeoutMs: number; readonly maxPages: number; readonly minimumRequestIntervalMs: number };
  readonly blockscoutEndpoints: Readonly<Partial<Record<Exclude<DiscoveryChain, "solana">, string>>>;
  readonly chains: readonly string[];
  readonly startAt: number;
  readonly intervalMs: number;
  readonly pageSize: number;
  readonly dailyCreditBudget: number;
  readonly strategyVersion: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly fomoLookupQueuePath: string;
  readonly fomoLookupResultPath: string;
  readonly fomoLookupResultCursorPath: string;
  readonly fomoMaximumActiveLookups: number;
  readonly solanaRpc?: { readonly primary: string; readonly fallback?: string };
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

export function loadHistoricalBackfillConfig(env: Readonly<Record<string, string | undefined>>): HistoricalBackfillConfig {
  if (env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED === "true") throw new Error("Historical backfill requires gateway delivery to remain disabled");
  const apiKey = env.DUNE_API_KEY?.trim() || null;
  const positiveInteger = (key: string, fallback?: number): number => {
    const raw = env[key];
    const value = raw === undefined && fallback !== undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  const startAt = Date.parse(env.DUNE_HISTORICAL_START_AT ?? "2026-08-09T16:00:00.000Z");
  if (!Number.isFinite(startAt)) throw new Error("DUNE_HISTORICAL_START_AT must be an ISO timestamp");
  const solanaPrimary = env.RADAR_RPC_SOLANA_HTTP_URL?.trim() || "https://api.mainnet-beta.solana.com";
  const solanaFallback = env.RADAR_RPC_SOLANA_FALLBACK_HTTP_URL?.trim();
  if (solanaPrimary) ensureHttpUrl(solanaPrimary, "solana");
  if (solanaFallback) ensureHttpUrl(solanaFallback, "solana");
  const defaultChains = "solana,bsc,eth,robinhood,base";
  const chains = [...new Set((env.DUNE_HISTORICAL_CHAINS ?? defaultChains).split(",").map(value => value.trim().toLowerCase()).filter(Boolean))];
  if (!chains.length) throw new Error("DUNE_HISTORICAL_CHAINS must not be empty");
  const unsupported = chains.filter(chain => !new Set(["solana", "bsc", "eth", "robinhood", "base"]).has(chain));
  if (unsupported.length) throw new Error(`DUNE_HISTORICAL_CHAINS contains unsupported chains: ${unsupported.join(",")}`);
  if (chains.includes("solana") && !solanaPrimary) throw new Error("RADAR_RPC_SOLANA_HTTP_URL is required when Solana historical backfill is enabled");
  const databasePath = env.ADDRESS_RADAR_DATABASE_PATH?.trim() || ".address-radar/address-radar.sqlite";
  const optionalPositiveInteger = (key: string): number | undefined => env[key] === undefined ? undefined : positiveInteger(key);
  const tokenUniverseQueryId = optionalPositiveInteger("DUNE_TOKEN_UNIVERSE_QUERY_ID");
  const milestoneCrossingsQueryId = optionalPositiveInteger("DUNE_MILESTONE_CROSSINGS_QUERY_ID");
  const preMilestoneTradesQueryId = optionalPositiveInteger("DUNE_PRE_MILESTONE_TRADES_QUERY_ID");
  const queryIds = Object.freeze({
    ...(tokenUniverseQueryId !== undefined ? { token_universe: tokenUniverseQueryId } : {}),
    ...(milestoneCrossingsQueryId !== undefined ? { milestone_crossings: milestoneCrossingsQueryId } : {}),
    ...(preMilestoneTradesQueryId !== undefined ? { pre_milestone_trades: preMilestoneTradesQueryId } : {}),
  });
  const duneFallbackEnabled = env.ADDRESS_RADAR_DUNE_FALLBACK_ENABLED !== "false" && apiKey !== null;
  if (duneFallbackEnabled && Object.values(queryIds).some(value => value === undefined)) throw new Error("All Dune query IDs are required when Dune fallback is enabled");
  const geckoBaseUrl = env.ADDRESS_RADAR_GECKO_TERMINAL_BASE_URL?.trim() || "https://api.geckoterminal.com/api/v2";
  ensureHttpUrl(geckoBaseUrl, "gecko-terminal");
  const blockscoutEndpoints = Object.freeze({
    eth: env.ADDRESS_RADAR_BLOCKSCOUT_ETH_URL?.trim() || "https://eth.blockscout.com",
    base: env.ADDRESS_RADAR_BLOCKSCOUT_BASE_URL?.trim() || "https://base.blockscout.com",
    bsc: env.ADDRESS_RADAR_BLOCKSCOUT_BSC_URL?.trim() || "https://bsc.blockscout.com",
  });
  for (const [chain, endpoint] of Object.entries(blockscoutEndpoints)) ensureHttpUrl(endpoint, `blockscout-${chain}`);
  return Object.freeze({
    databasePath,
    apiKey,
    queryIds,
    duneFallbackEnabled,
    geckoTerminal: Object.freeze({ baseUrl: geckoBaseUrl, timeoutMs: positiveInteger("ADDRESS_RADAR_GECKO_TERMINAL_TIMEOUT_MS", 10_000), maxPages: positiveInteger("ADDRESS_RADAR_GECKO_TERMINAL_MAX_PAGES", 4), minimumRequestIntervalMs: positiveInteger("ADDRESS_RADAR_GECKO_TERMINAL_MIN_REQUEST_INTERVAL_MS", 2_100) }),
    blockscoutEndpoints,
    chains: Object.freeze(chains),
    startAt,
    intervalMs: positiveInteger("DUNE_WORKER_INTERVAL_MS", 5_000),
    pageSize: positiveInteger("DUNE_RESULT_PAGE_SIZE", 1_000),
    dailyCreditBudget: positiveInteger("DUNE_DAILY_CREDIT_BUDGET", 1_000),
    strategyVersion: env.ADDRESS_RADAR_CANDIDATE_HISTORY_STRATEGY_VERSION?.trim() || "candidate-history-v3",
    timeoutMs: positiveInteger("DUNE_QUERY_TIMEOUT_MS", 300_000),
    pollIntervalMs: positiveInteger("DUNE_POLL_INTERVAL_MS", 2_000),
    fomoLookupQueuePath: env.ADDRESS_RADAR_FOMO_LOOKUP_QUEUE_PATH?.trim() || env.RADAR_FOMO_LOOKUP_QUEUE_PATH?.trim() || `${databasePath}.fomo-lookups.ndjson`,
    fomoLookupResultPath: env.ADDRESS_RADAR_FOMO_LOOKUP_RESULT_PATH?.trim() || env.RADAR_FOMO_LOOKUP_RESULT_PATH?.trim() || `${databasePath}.fomo-results.ndjson`,
    fomoLookupResultCursorPath: env.ADDRESS_RADAR_FOMO_LOOKUP_RESULT_CURSOR_PATH?.trim() || env.ADDRESS_RADAR_FOMO_RESULT_CURSOR_PATH?.trim() || `${databasePath}.fomo-results.cursor.json`,
    fomoMaximumActiveLookups: positiveInteger("ADDRESS_RADAR_FOMO_MAX_ACTIVE_LOOKUPS", 100),
    ...(solanaPrimary ? { solanaRpc: Object.freeze({ primary: solanaPrimary, ...(solanaFallback ? { fallback: solanaFallback } : {}) }) } : {}),
  });
}
