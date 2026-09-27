const SUPPORTED_CHAINS = new Set(["solana", "eth", "bsc", "base", "robinhood"]);

const QUOTE_ASSET_IDS = new Set([
  "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana:Es9vMFrzaCERmJfrF4H2FYDZwDFh8vdzT9vVjTQwYh5W",
  "solana:So11111111111111111111111111111111111111112",
  "eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "eth:0xdac17f958d2ee523a2206206994597c13d831ec7",
  "eth:0x6b175474e89094c44da98b954eedeac495271d0f",
  "eth:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "eth:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  "bsc:0x55d398326f99059ff775485246999027b3197955",
  "bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  "bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  "base:0x4200000000000000000000000000000000000006",
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
]);

const canonicalChain = (value: string): string => {
  const chain = value.trim().toLowerCase();
  if (chain === "ethereum") return "eth";
  if (chain === "bnb" || chain === "binance") return "bsc";
  if (chain === "sol") return "solana";
  return chain;
};

export type HistoricalTokenEligibility =
  | { readonly eligible: true; readonly chain: string; readonly tokenAddress: string }
  | { readonly eligible: false; readonly chain: string; readonly tokenAddress: string; readonly reason: "unsupported_chain" | "invalid_address" | "canonical_quote_asset" | "operator_exclusion" };

export function classifyHistoricalTokenEligibility(input: {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly symbol?: string | null;
  readonly excludedTokenIds?: ReadonlySet<string>;
}): HistoricalTokenEligibility {
  const chain = canonicalChain(input.chain);
  const tokenAddress = chain === "solana" ? input.tokenAddress.trim() : input.tokenAddress.trim().toLowerCase();
  if (!SUPPORTED_CHAINS.has(chain)) return Object.freeze({ eligible: false, chain, tokenAddress, reason: "unsupported_chain" });
  if (!tokenAddress) return Object.freeze({ eligible: false, chain, tokenAddress, reason: "invalid_address" });
  const tokenId = `${chain}:${tokenAddress}`;
  if (input.excludedTokenIds?.has(tokenId)) return Object.freeze({ eligible: false, chain, tokenAddress, reason: "operator_exclusion" });
  if (QUOTE_ASSET_IDS.has(tokenId)) return Object.freeze({ eligible: false, chain, tokenAddress, reason: "canonical_quote_asset" });
  return Object.freeze({ eligible: true, chain, tokenAddress });
}
