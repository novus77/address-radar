import { expect, it } from "vitest";
import { normalizeWalletObservations } from "../src/normalize-observations.js";
import { deriveExecutionBasis } from "../src/execution-basis.js";

it("preserves execution provenance while associating the wallet with its identity", () => {
  const basis = deriveExecutionBasis({ successful: true, swapConfirmed: true,
    tokenDeltas: [{ asset: "TokenCase", quantity: 100 }],
    quoteDeltas: [{ asset: "usdc", symbol: "USDC", quantity: -60, verifiedStablecoin: true }],
  });
  const event = {
    eventId: "sig:1", chain: "solana", walletAddress: "WalletCase", tokenAddress: "TokenCase",
    side: "buy" as const, amountUsd: 60, priceUsd: 0.6, marketCapUsd: null,
    occurredAt: 100, sourceReference: "solana:sig", executionBasis: basis,
  };
  const observations = normalizeWalletObservations([event], [
    { address: "WalletCase", accountId: "account", entityId: "entity", lifecycle: "active" },
  ], "solana", "solana", 200);
  expect(observations[0]).toMatchObject({ accountId: "account", entityId: "entity", executionBasis: basis });
});
