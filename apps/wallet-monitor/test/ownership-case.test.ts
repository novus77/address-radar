import { expect, it } from "vitest";
import { normalizeWalletObservations } from "../src/normalize-observations.js";

const event = (walletAddress: string) => ({ eventId: walletAddress, walletAddress, chain: "solana", tokenAddress: "MiNt", side: "buy" as const, amountUsd: 100, priceUsd: 1, marketCapUsd: null, occurredAt: 1, sourceReference: "fixture" });
const wallet = (address: string, entityId: string) => ({ address, entityId, accountId: entityId, lifecycle: "active" as const });

it("preserves case-sensitive Solana ownership and mint identity", () => {
  const result = normalizeWalletObservations([event("Abc"), event("abc"), event("ABC")], [wallet("Abc", "first"), wallet("abc", "second")], "solana-rpc", "solana", 2);
  expect(result.map(row => [row.entityId, row.walletAddress, row.tokenAddress])).toEqual([["first", "Abc", "MiNt"], ["second", "abc", "MiNt"]]);
});
it("matches and normalizes EVM address case", () => {
  const result = normalizeWalletObservations([event("0xABC")], [wallet("0xabc", "owner")], "evm-rpc", "evm", 2);
  expect(result[0]).toMatchObject({ entityId: "owner", walletAddress: "0xabc", tokenAddress: "mint" });
});
