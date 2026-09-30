export type SupportedCollectorChain = "eth" | "bnb" | "bsc" | "robinhood" | "base" | "solana" | "sol";
export type DiscoveryChain = "eth" | "bsc" | "robinhood" | "base" | "solana";

export interface RadarRpcTradeEvent {
  readonly eventId: string;
  readonly chain: SupportedCollectorChain;
  readonly tokenAddress: string;
  readonly marketAddress: string;
  readonly venueId: string;
  readonly buyerAddress: string;
  readonly priceUsd: number;
  readonly amountUsd: number;
  readonly liquidityUsd: number;
  readonly blockNumber: number;
  readonly occurredAt: number;
}

export interface RadarRpcSubscription {
  addContractAddresses?(addresses: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export interface RadarRpcDiscoveryProvider {
  subscribe(input: { readonly chain: SupportedCollectorChain; readonly contractAddresses: readonly string[]; readonly signal: AbortSignal; readonly onTrade: (event: RadarRpcTradeEvent) => Promise<void> }): Promise<RadarRpcSubscription>;
  tradesInBlockRange(input: { readonly chain: SupportedCollectorChain; readonly contractAddresses: readonly string[]; readonly fromBlock: number; readonly toBlock: number; readonly signal: AbortSignal }): Promise<readonly RadarRpcTradeEvent[]>;
}

export interface RadarChainDiscoveryConfiguration {
  readonly chain: SupportedCollectorChain;
  readonly version: string;
  readonly coreVenueIds: readonly string[];
  readonly coreContractAddresses: readonly string[];
  readonly minimumLiquidityUsd: number;
}

export const RADAR_DISCOVERY_CHAINS = ["eth", "bsc", "robinhood", "base", "solana"] as const;

export function createRadarChainDiscoveryConfiguration(input: RadarChainDiscoveryConfiguration): RadarChainDiscoveryConfiguration {
  if (!RADAR_DISCOVERY_CHAINS.includes(input.chain as DiscoveryChain)) throw new Error(`Unsupported discovery chain: ${input.chain}`);
  if (!input.version.trim()) throw new Error("Discovery configuration version must not be empty");
  if (input.coreVenueIds.length === 0 || input.coreVenueIds.some((value) => !value.trim())) throw new Error("At least one core venue is required");
  if (!Number.isFinite(input.minimumLiquidityUsd) || input.minimumLiquidityUsd <= 0) throw new Error("minimumLiquidityUsd must be positive");
  return Object.freeze({ ...input, coreVenueIds: Object.freeze([...new Set(input.coreVenueIds)]), coreContractAddresses: Object.freeze([...new Set(input.coreContractAddresses)]) });
}

export function createRadarRpcDiscoveryProvider(input: {
  readonly live: { subscribe(request: Parameters<RadarRpcDiscoveryProvider["subscribe"]>[0]): Promise<RadarRpcSubscription> };
  readonly backfill: { loadTrades(request: Parameters<RadarRpcDiscoveryProvider["tradesInBlockRange"]>[0]): Promise<readonly RadarRpcTradeEvent[]> };
}): RadarRpcDiscoveryProvider {
  return Object.freeze({
    subscribe(request: Parameters<RadarRpcDiscoveryProvider["subscribe"]>[0]) { return input.live.subscribe(request); },
    async tradesInBlockRange(request: Parameters<RadarRpcDiscoveryProvider["tradesInBlockRange"]>[0]) {
      if (!RADAR_DISCOVERY_CHAINS.includes(request.chain as DiscoveryChain)) return Object.freeze([]);
      if (!validBlock(request.fromBlock) || !validBlock(request.toBlock) || request.fromBlock > request.toBlock) throw new Error("Invalid RPC backfill range");
      const events = await input.backfill.loadTrades(request);
      return Object.freeze([...new Map(events.flatMap((event) => {
        const normalized = normalizeTradeEvent(event, request);
        return normalized ? [[normalized.eventId, normalized] as const] : [];
      })).values()]);
    },
  });
}

const validBlock = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function normalizeTradeEvent(event: RadarRpcTradeEvent, request: Parameters<RadarRpcDiscoveryProvider["tradesInBlockRange"]>[0]): RadarRpcTradeEvent | null {
  const solana = request.chain === "solana";
  const address = (value: string): string => solana ? value.trim() : value.trim().toLowerCase();
  const contracts = new Set(request.contractAddresses.map(address).filter(Boolean));
  const marketAddress = address(event.marketAddress);
  if (
    event.chain !== request.chain || !event.eventId.trim() || !event.tokenAddress.trim() || !marketAddress ||
    !event.venueId.trim() || !event.buyerAddress.trim() || !contracts.has(marketAddress) ||
    !validBlock(event.blockNumber) || event.blockNumber < request.fromBlock || event.blockNumber > request.toBlock ||
    !finiteNonNegative(event.priceUsd) || !finiteNonNegative(event.amountUsd) || !finiteNonNegative(event.liquidityUsd) ||
    !Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0
  ) return null;
  return Object.freeze({
    ...event,
    eventId: event.eventId.trim(),
    tokenAddress: address(event.tokenAddress),
    marketAddress,
    venueId: event.venueId.trim(),
    buyerAddress: address(event.buyerAddress),
  });
}

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
