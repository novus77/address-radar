import type { DatabaseSync } from "node:sqlite";

import { withAddressRadarWriteTransaction } from "./connection.js";

export const SUPPORTED_CHAIN_IDS = Object.freeze(["solana", "eth", "bsc", "base", "robinhood"] as const);
export type CanonicalChainId = typeof SUPPORTED_CHAIN_IDS[number];
export type ChainFamily = "solana" | "evm";
export type MarketType = "launchpad_curve" | "dex_pool" | "migrated_pool" | "aggregator_route";

export interface CanonicalChainRecord {
  readonly chainId: CanonicalChainId;
  readonly displayName: string;
  readonly chainFamily: ChainFamily;
  readonly rpcNetwork: string;
  readonly nativeAsset: string;
  readonly dexScreenerChainId: string;
  readonly geckoNetworkId: string;
  readonly blockscoutChainId: string | null;
  readonly finalityPolicy: string;
  readonly enabled: boolean;
}

export interface CanonicalTokenInput {
  readonly tokenId: string;
  readonly chainId: CanonicalChainId;
  readonly tokenAddress: string;
  readonly symbol?: string | null;
  readonly name?: string | null;
  readonly decimals?: number | null;
  readonly launchpadId?: string | null;
  readonly identityStatus: "pending" | "confirmed" | "conflicted" | "rejected";
  readonly observedAt: number;
}

export interface CanonicalMarketInput {
  readonly marketId: string;
  readonly tokenId: string;
  readonly chainId: CanonicalChainId;
  readonly dexId: string;
  readonly poolAddress: string;
  readonly quoteToken: string | null;
  readonly marketType: MarketType;
  readonly openedAt: number | null;
  readonly closedAt: number | null;
  readonly liquidityRank: number | null;
  readonly observedAt: number;
}

export interface CanonicalRegistryStore {
  chains(): readonly CanonicalChainRecord[];
  chain(chainId: string): CanonicalChainRecord | null;
  saveToken(input: CanonicalTokenInput): void;
  saveMarket(input: CanonicalMarketInput): void;
  setCanonicalMarket(tokenId: string, marketId: string, canonicalFrom: number, canonicalTo: number | null, reason: string, updatedAt: number): void;
  canonicalMarket(tokenId: string, at: number): CanonicalMarketInput | null;
}

const CHAIN_SEEDS: readonly CanonicalChainRecord[] = Object.freeze([
  { chainId: "solana", displayName: "Solana", chainFamily: "solana", rpcNetwork: "solana-mainnet", nativeAsset: "SOL", dexScreenerChainId: "solana", geckoNetworkId: "solana", blockscoutChainId: null, finalityPolicy: "finalized", enabled: true },
  { chainId: "eth", displayName: "Ethereum", chainFamily: "evm", rpcNetwork: "ethereum-mainnet", nativeAsset: "ETH", dexScreenerChainId: "ethereum", geckoNetworkId: "eth", blockscoutChainId: "1", finalityPolicy: "12_confirmations", enabled: true },
  { chainId: "bsc", displayName: "BSC", chainFamily: "evm", rpcNetwork: "bsc-mainnet", nativeAsset: "BNB", dexScreenerChainId: "bsc", geckoNetworkId: "bsc", blockscoutChainId: "56", finalityPolicy: "15_confirmations", enabled: true },
  { chainId: "base", displayName: "Base", chainFamily: "evm", rpcNetwork: "base-mainnet", nativeAsset: "ETH", dexScreenerChainId: "base", geckoNetworkId: "base", blockscoutChainId: "8453", finalityPolicy: "safe", enabled: true },
  { chainId: "robinhood", displayName: "Robinhood", chainFamily: "evm", rpcNetwork: "robinhood", nativeAsset: "ETH", dexScreenerChainId: "robinhood", geckoNetworkId: "robinhood", blockscoutChainId: null, finalityPolicy: "provider_confirmed", enabled: true },
]);

const canonicalAddress = (chainId: CanonicalChainId, address: string): string => {
  const value = address.trim();
  if (!value) throw new Error("Address is required");
  return chainId === "solana" ? value : value.toLowerCase();
};

const finiteTime = (value: number | null, field: string): void => {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${field} must be a non-negative timestamp`);
};

export function initializeCanonicalRegistrySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS canonical_chains (
      chain_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      chain_family TEXT NOT NULL CHECK(chain_family IN ('solana','evm')),
      rpc_network TEXT NOT NULL,
      native_asset TEXT NOT NULL,
      dexscreener_chain_id TEXT NOT NULL,
      gecko_network_id TEXT NOT NULL,
      blockscout_chain_id TEXT,
      finality_policy TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS canonical_tokens (
      token_id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      decimals INTEGER,
      launchpad_id TEXT,
      identity_status TEXT NOT NULL CHECK(identity_status IN ('pending','confirmed','conflicted','rejected')),
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      UNIQUE(chain_id, token_address),
      FOREIGN KEY(chain_id) REFERENCES canonical_chains(chain_id)
    );
    CREATE INDEX IF NOT EXISTS canonical_tokens_chain_status ON canonical_tokens(chain_id, identity_status, last_observed_at);
    CREATE TABLE IF NOT EXISTS canonical_markets (
      market_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      dex_id TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      quote_token TEXT,
      market_type TEXT NOT NULL CHECK(market_type IN ('launchpad_curve','dex_pool','migrated_pool','aggregator_route')),
      opened_at INTEGER,
      closed_at INTEGER,
      liquidity_rank INTEGER,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      UNIQUE(chain_id, pool_address),
      CHECK(opened_at IS NULL OR closed_at IS NULL OR opened_at <= closed_at),
      FOREIGN KEY(token_id) REFERENCES canonical_tokens(token_id) ON DELETE CASCADE,
      FOREIGN KEY(chain_id) REFERENCES canonical_chains(chain_id)
    );
    CREATE INDEX IF NOT EXISTS canonical_markets_token_time ON canonical_markets(token_id, opened_at, closed_at);
    CREATE TABLE IF NOT EXISTS canonical_market_windows (
      token_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      canonical_from INTEGER NOT NULL,
      canonical_to INTEGER,
      reason TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(token_id, market_id, canonical_from),
      CHECK(canonical_to IS NULL OR canonical_from < canonical_to),
      FOREIGN KEY(token_id) REFERENCES canonical_tokens(token_id) ON DELETE CASCADE,
      FOREIGN KEY(market_id) REFERENCES canonical_markets(market_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS canonical_market_windows_lookup ON canonical_market_windows(token_id, canonical_from, canonical_to);
  `);
  const insert = database.prepare(`INSERT INTO canonical_chains(chain_id, display_name, chain_family, rpc_network, native_asset, dexscreener_chain_id, gecko_network_id, blockscout_chain_id, finality_policy, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chain_id) DO UPDATE SET display_name=excluded.display_name, chain_family=excluded.chain_family, rpc_network=excluded.rpc_network, native_asset=excluded.native_asset, dexscreener_chain_id=excluded.dexscreener_chain_id, gecko_network_id=excluded.gecko_network_id, blockscout_chain_id=excluded.blockscout_chain_id, finality_policy=excluded.finality_policy`);
  for (const chain of CHAIN_SEEDS) insert.run(chain.chainId, chain.displayName, chain.chainFamily, chain.rpcNetwork, chain.nativeAsset, chain.dexScreenerChainId, chain.geckoNetworkId, chain.blockscoutChainId, chain.finalityPolicy, chain.enabled ? 1 : 0);
}

const toChain = (row: Record<string, unknown>): CanonicalChainRecord => Object.freeze({
  chainId: row.chain_id as CanonicalChainId, displayName: String(row.display_name), chainFamily: row.chain_family as ChainFamily,
  rpcNetwork: String(row.rpc_network), nativeAsset: String(row.native_asset), dexScreenerChainId: String(row.dexscreener_chain_id),
  geckoNetworkId: String(row.gecko_network_id), blockscoutChainId: row.blockscout_chain_id as string | null,
  finalityPolicy: String(row.finality_policy), enabled: Number(row.enabled) === 1,
});

const toMarket = (row: Record<string, unknown>): CanonicalMarketInput => Object.freeze({
  marketId: String(row.market_id), tokenId: String(row.token_id), chainId: row.chain_id as CanonicalChainId,
  dexId: String(row.dex_id), poolAddress: String(row.pool_address), quoteToken: row.quote_token as string | null,
  marketType: row.market_type as MarketType, openedAt: row.opened_at as number | null, closedAt: row.closed_at as number | null,
  liquidityRank: row.liquidity_rank as number | null, observedAt: Number(row.last_observed_at),
});

export function createCanonicalRegistryStore(database: DatabaseSync): CanonicalRegistryStore {
  const store: CanonicalRegistryStore = {
    chains() { return Object.freeze((database.prepare("SELECT * FROM canonical_chains WHERE enabled=1 ORDER BY chain_id").all() as Record<string, unknown>[]).map(toChain)); },
    chain(chainId) { const row = database.prepare("SELECT * FROM canonical_chains WHERE chain_id=?").get(chainId) as Record<string, unknown> | undefined; return row ? toChain(row) : null; },
    saveToken(input) {
      finiteTime(input.observedAt, "observedAt");
      const address = canonicalAddress(input.chainId, input.tokenAddress);
      database.prepare(`INSERT INTO canonical_tokens(token_id, chain_id, token_address, symbol, name, decimals, launchpad_id, identity_status, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET symbol=COALESCE(excluded.symbol, canonical_tokens.symbol), name=COALESCE(excluded.name, canonical_tokens.name), decimals=COALESCE(excluded.decimals, canonical_tokens.decimals), launchpad_id=COALESCE(excluded.launchpad_id, canonical_tokens.launchpad_id), identity_status=excluded.identity_status, first_observed_at=MIN(canonical_tokens.first_observed_at, excluded.first_observed_at), last_observed_at=MAX(canonical_tokens.last_observed_at, excluded.last_observed_at)`).run(input.tokenId, input.chainId, address, input.symbol ?? null, input.name ?? null, input.decimals ?? null, input.launchpadId ?? null, input.identityStatus, input.observedAt, input.observedAt);
    },
    saveMarket(input) {
      finiteTime(input.observedAt, "observedAt"); finiteTime(input.openedAt, "openedAt"); finiteTime(input.closedAt, "closedAt");
      if (input.openedAt !== null && input.closedAt !== null && input.openedAt > input.closedAt) throw new Error("Market close cannot be before open");
      database.prepare(`INSERT INTO canonical_markets(market_id, token_id, chain_id, dex_id, pool_address, quote_token, market_type, opened_at, closed_at, liquidity_rank, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(market_id) DO UPDATE SET dex_id=excluded.dex_id, quote_token=COALESCE(excluded.quote_token, canonical_markets.quote_token), market_type=excluded.market_type, opened_at=COALESCE(canonical_markets.opened_at, excluded.opened_at), closed_at=excluded.closed_at, liquidity_rank=excluded.liquidity_rank, first_observed_at=MIN(canonical_markets.first_observed_at, excluded.first_observed_at), last_observed_at=MAX(canonical_markets.last_observed_at, excluded.last_observed_at)`).run(input.marketId, input.tokenId, input.chainId, input.dexId, canonicalAddress(input.chainId, input.poolAddress), input.quoteToken, input.marketType, input.openedAt, input.closedAt, input.liquidityRank, input.observedAt, input.observedAt);
    },
    setCanonicalMarket(tokenId, marketId, canonicalFrom, canonicalTo, reason, updatedAt) {
      finiteTime(canonicalFrom, "canonicalFrom"); finiteTime(canonicalTo, "canonicalTo"); finiteTime(updatedAt, "updatedAt");
      if (canonicalTo !== null && canonicalFrom >= canonicalTo) throw new Error("Canonical market window must have positive duration");
      withAddressRadarWriteTransaction(database, () => {
        const overlap = database.prepare(`SELECT 1 FROM canonical_market_windows WHERE token_id=? AND canonical_from < COALESCE(?, 9223372036854775807) AND COALESCE(canonical_to, 9223372036854775807) > ? LIMIT 1`).get(tokenId, canonicalTo, canonicalFrom);
        if (overlap) throw new Error("Canonical market windows cannot overlap");
        database.prepare("INSERT INTO canonical_market_windows(token_id, market_id, canonical_from, canonical_to, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(tokenId, marketId, canonicalFrom, canonicalTo, reason, updatedAt);
      });
    },
    canonicalMarket(tokenId, at) {
      finiteTime(at, "at");
      const row = database.prepare(`SELECT m.* FROM canonical_market_windows w JOIN canonical_markets m ON m.market_id=w.market_id WHERE w.token_id=? AND w.canonical_from<=? AND (w.canonical_to IS NULL OR w.canonical_to>?) ORDER BY w.canonical_from DESC LIMIT 1`).get(tokenId, at, at) as Record<string, unknown> | undefined;
      return row ? toMarket(row) : null;
    },
  };
  return Object.freeze(store);
}
