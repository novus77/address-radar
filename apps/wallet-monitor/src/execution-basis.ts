export interface ExecutionAssetDelta {
  readonly asset: string;
  readonly quantity: number;
}

export interface ExecutionQuoteDelta extends ExecutionAssetDelta {
  readonly symbol: string;
  // Set only after matching a configured chain-specific contract or mint.
  readonly verifiedStablecoin?: boolean;
}

export interface ExecutionBasisInput {
  readonly successful: boolean | null;
  readonly swapConfirmed: boolean;
  readonly tokenDeltas: readonly ExecutionAssetDelta[];
  readonly quoteDeltas: readonly ExecutionQuoteDelta[];
}

export type ExecutionBasis = {
  readonly status: "estimated";
  readonly reason: "nominal_stablecoin_usd";
  readonly tokenAddress: string;
  readonly side: "buy" | "sell";
  readonly tokenQuantity: number;
  readonly quoteAsset: string;
  readonly quoteQuantity: number;
  readonly amountUsd: number;
  readonly priceUsd: number;
  readonly amountBasis: "nominal_stablecoin";
} | {
  readonly status: "unavailable";
  readonly reason: string;
  readonly tokenAddress: null;
  readonly tokenQuantity: null;
  readonly amountUsd: null;
  readonly priceUsd: null;
};

function unavailable(reason: string): ExecutionBasis {
  return { status: "unavailable", reason, tokenAddress: null, tokenQuantity: null,
    amountUsd: null, priceUsd: null };
}

function netDeltas(deltas: readonly ExecutionAssetDelta[]): Map<string, number> | null {
  const totals = new Map<string, number>();
  for (const delta of deltas) {
    if (!delta.asset || delta.asset.trim() !== delta.asset || !Number.isFinite(delta.quantity)) return null;
    const total = (totals.get(delta.asset) ?? 0) + delta.quantity;
    if (!Number.isFinite(total)) return null;
    totals.set(delta.asset, total);
  }
  return new Map([...totals].filter(([, quantity]) => quantity !== 0));
}

/** Derive a single economic trade without spot-price fallback or shared-spend allocation. */
export function deriveExecutionBasis(input: ExecutionBasisInput): ExecutionBasis {
  if (input.successful !== true) return unavailable("execution_not_confirmed");
  if (!input.swapConfirmed) return unavailable("swap_not_confirmed");
  const tokens = netDeltas(input.tokenDeltas);
  if (!tokens || tokens.size === 0) return unavailable("missing_token_quantity");
  if (tokens.size !== 1) return unavailable("ambiguous_token_allocation");
  if (input.quoteDeltas.some((quote) => quote.verifiedStablecoin !== true
    || (quote.symbol !== "USDT" && quote.symbol !== "USDC"))) {
    return unavailable("unsupported_quote_valuation");
  }
  const quotes = netDeltas(input.quoteDeltas);
  if (!quotes || quotes.size === 0) return unavailable("missing_quote_quantity");
  if (quotes.size !== 1) return unavailable("ambiguous_quote_allocation");
  const [tokenAddress, tokenQuantity] = [...tokens][0]!;
  const [quoteAsset, quoteQuantity] = [...quotes][0]!;
  if (tokenAddress === quoteAsset || Math.sign(tokenQuantity) === Math.sign(quoteQuantity)) {
    return unavailable("quote_direction_mismatch");
  }
  const amountUsd = Math.abs(quoteQuantity);
  const priceUsd = amountUsd / Math.abs(tokenQuantity);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return unavailable("invalid_execution_price");
  return {
    status: "estimated", reason: "nominal_stablecoin_usd", tokenAddress,
    side: tokenQuantity > 0 ? "buy" : "sell", tokenQuantity: Math.abs(tokenQuantity),
    quoteAsset, quoteQuantity: amountUsd, amountUsd, priceUsd,
    amountBasis: "nominal_stablecoin",
  };
}
