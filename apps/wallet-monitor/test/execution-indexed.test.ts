import { expect, it } from "vitest";
import { createIndexedEvmWalletCollector } from "../src/indexed-wallet-collector.js";

it("does not assign spot price or shared quote spend to unverified indexed transfers", async () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  const pool = "0x2222222222222222222222222222222222222222";
  const result = await createIndexedEvmWalletCollector({
    chain: "eth", endpoint: "https://index.example", now: () => 200_000,
    fetch: async () => new Response(JSON.stringify({ next_page_params: null, items: [
      { tx_hash: "tx", log_index: 1, timestamp: new Date(100_000).toISOString(),
        from: { hash: wallet }, to: { hash: pool }, total: { value: "60000000", decimals: "6" },
        token: { address_hash: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", type: "ERC-20" } },
      { tx_hash: "tx", log_index: 2, timestamp: new Date(100_000).toISOString(),
        from: { hash: pool }, to: { hash: wallet }, total: { value: "100000000", decimals: "6" },
        token: { address_hash: "0x3333333333333333333333333333333333333333", symbol: "TOKEN", type: "ERC-20" } },
    ] })),
    market: { async lookup(_chain, tokenAddress) { return { chain: "eth", tokenAddress,
      priceUsd: 999, marketCapUsd: 9_000_000, liquidityUsd: 1000,
      observedAt: new Date(200_000).toISOString() }; } },
  }).collect({
    wallets: [{ address: wallet, accountId: "account", entityId: "entity", lifecycle: "active" }],
    checkpoint: () => null, signal: new AbortController().signal,
  });
  const events = result.partitions.flatMap(partition => partition.events);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ amountUsd: null, priceUsd: null, marketCapUsd: null,
    executionBasis: { status: "unavailable", reason: "execution_not_confirmed" } });
});
