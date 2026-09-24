export const normalizeAddressRadarTokenAddress = (chain: string, tokenAddress: string): string =>
  chain.toLowerCase() === "solana" ? tokenAddress : tokenAddress.toLowerCase();

export const addressRadarTokenId = (chain: string, tokenAddress: string): string =>
  `${chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(chain, tokenAddress)}`;

export const addressRadarBroadcastId = (tokenId: string, broadcastNumber: number): string =>
  `${tokenId}:broadcast:${broadcastNumber}`;
