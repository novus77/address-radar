import { describe, expect, it } from "vitest";

import { classifyHistoricalTokenEligibility } from "../src/historical-token-eligibility.js";

describe("historical token eligibility", () => {
  it("accepts supported unknown tokens and canonicalizes EVM addresses", () => {
    expect(classifyHistoricalTokenEligibility({ chain: "BASE", tokenAddress: "0xAbC", symbol: "MEME" })).toEqual({
      eligible: true,
      chain: "base",
      tokenAddress: "0xabc",
    });
  });

  it("rejects unsupported chains", () => {
    expect(classifyHistoricalTokenEligibility({ chain: "monad", tokenAddress: "0xabc", symbol: "MEME" })).toMatchObject({
      eligible: false,
      reason: "unsupported_chain",
    });
  });

  it("rejects canonical Solana USDC by exact address", () => {
    expect(classifyHistoricalTokenEligibility({
      chain: "solana",
      tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
    })).toMatchObject({ eligible: false, reason: "canonical_quote_asset" });
  });

  it("does not reject an unknown token by symbol alone", () => {
    expect(classifyHistoricalTokenEligibility({ chain: "solana", tokenAddress: "MemeMint", symbol: "USDC" })).toMatchObject({ eligible: true });
  });
});
