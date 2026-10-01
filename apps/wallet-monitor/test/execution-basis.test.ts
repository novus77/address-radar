import { describe, expect, it } from "vitest";
import { deriveExecutionBasis } from "../src/execution-basis.js";

const trade = {
  successful: true,
  swapConfirmed: true,
  tokenDeltas: [{ asset: "TokenCase", quantity: 100 }],
  quoteDeltas: [{ asset: "USDC-mint", symbol: "USDC", verifiedStablecoin: true, quantity: -60 }],
};

describe("execution basis", () => {
  it("derives the entry price from actual quantities and labels nominal USD as estimated", () => {
    expect(deriveExecutionBasis(trade)).toEqual({
      status: "estimated", reason: "nominal_stablecoin_usd", tokenAddress: "TokenCase",
      side: "buy", tokenQuantity: 100, amountUsd: 60, priceUsd: 0.6,
      quoteAsset: "USDC-mint", quoteQuantity: 60, amountBasis: "nominal_stablecoin",
    });
  });
  it("nets refunds instead of summing all stablecoin movements", () => {
    const result = deriveExecutionBasis({ ...trade, quoteDeltas: [
      ...trade.quoteDeltas, { asset: "USDC-mint", symbol: "USDC", verifiedStablecoin: true, quantity: 10 },
    ] });
    expect(result.amountUsd).toBe(50);
    expect(result.priceUsd).toBe(0.5);
  });
  it("nets repeated token legs without changing address case", () => {
    const result = deriveExecutionBasis({ ...trade, tokenDeltas: [
      { asset: "TokenCase", quantity: 110 }, { asset: "TokenCase", quantity: -10 },
    ] });
    expect(result.tokenAddress).toBe("TokenCase");
    expect(result.tokenQuantity).toBe(100);
  });
  it("does not allocate the same quote spend to multiple tokens", () => {
    const result = deriveExecutionBasis({ ...trade, tokenDeltas: [
      ...trade.tokenDeltas, { asset: "OtherToken", quantity: 20 },
    ] });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("ambiguous_token_allocation");
    expect(result.amountUsd).toBeNull();
    expect(result.priceUsd).toBeNull();
  });
  it.each([false, null])("rejects failed or unverified transaction status %s", (successful) => {
    expect(deriveExecutionBasis({ ...trade, successful }).reason).toBe("execution_not_confirmed");
  });
  it("requires swap evidence rather than two unrelated transfers", () => {
    expect(deriveExecutionBasis({ ...trade, swapConfirmed: false }).reason).toBe("swap_not_confirmed");
  });
  it.each([0, NaN, Infinity])("rejects invalid token quantity %s", (quantity) => {
    expect(deriveExecutionBasis({ ...trade, tokenDeltas: [{ asset: "TokenCase", quantity }] }).amountUsd).toBeNull();
  });
  it("does not treat unsupported quote assets as nominal USD", () => {
    expect(deriveExecutionBasis({ ...trade, quoteDeltas: [{ asset: "DAI", symbol: "DAI", quantity: -60 }] }).reason)
      .toBe("unsupported_quote_valuation");
  });
  it("requires verified asset metadata, not a spoofed ticker", () => {
    expect(deriveExecutionBasis({ ...trade, quoteDeltas: [{ asset: "unknown", symbol: "USDC", verifiedStablecoin: false, quantity: -60 }] }).reason)
      .toBe("unsupported_quote_valuation");
  });
  it("rejects same-direction quote and token flows", () => {
    expect(deriveExecutionBasis({ ...trade, quoteDeltas: [{ asset: "USDC-mint", symbol: "USDC", verifiedStablecoin: true, quantity: 60 }] }).reason)
      .toBe("quote_direction_mismatch");
  });
  it("derives sell proceeds without requiring sales for discovery admission", () => {
    expect(deriveExecutionBasis({ ...trade,
      tokenDeltas: [{ asset: "TokenCase", quantity: -100 }],
      quoteDeltas: [{ asset: "USDC-mint", symbol: "USDC", verifiedStablecoin: true, quantity: 90 }],
    })).toMatchObject({ side: "sell", amountUsd: 90, priceUsd: 0.9 });
  });
});
