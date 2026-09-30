import { describe, expect, it } from "vitest";

import {
  createSourceObservation,
  normalizeDiscoveryAddress,
  normalizeDiscoveryChain,
  sourceObservationId,
} from "@address-radar/domain";

describe("source observation contracts", () => {
  it.each([
    ["sol", "solana"],
    ["SOLANA", "solana"],
    ["ethereum", "eth"],
    ["bnb", "bsc"],
    ["BSC", "bsc"],
    ["base", "base"],
    ["robinhood", "robinhood"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeDiscoveryChain(input)).toBe(expected);
  });

  it("rejects chains outside the active five-chain registry", () => {
    expect(() => normalizeDiscoveryChain("monad")).toThrow(/Unsupported discovery chain/);
  });

  it("lowercases EVM addresses and preserves Solana case", () => {
    expect(normalizeDiscoveryAddress("base", " 0xAbCd ")).toBe("0xabcd");
    expect(normalizeDiscoveryAddress("solana", " MintCaseSensitive ")).toBe("MintCaseSensitive");
  });

  it("creates deterministic observation identities", () => {
    const first = sourceObservationId("fomo_feed", "event-1", 1);
    expect(sourceObservationId("fomo_feed", "event-1", 1)).toBe(first);
    expect(sourceObservationId("fomo_feed", "event-1", 2)).not.toBe(first);
    expect(sourceObservationId("rpc_evm", "event-1", 1)).not.toBe(first);
  });

  it("normalizes and freezes a valid observation", () => {
    const observation = createSourceObservation({
      source: "rpc_evm",
      sourceEventId: "tx:1",
      chain: "ethereum",
      observedAt: 100,
      collectedAt: 120,
      payloadVersion: 1,
      payload: { tokenAddress: "0xAbC" },
      confidence: 0.9,
      extractionMode: "rpc",
      provenance: { endpoint: "primary" },
    });

    expect(observation).toMatchObject({
      observationId: sourceObservationId("rpc_evm", "tx:1", 1),
      chain: "eth",
      confidence: 0.9,
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.provenance)).toBe(true);
  });

  it.each([-0.1, 1.1, Number.NaN])("rejects invalid confidence %s", confidence => {
    expect(() => createSourceObservation({
      source: "dexscreener",
      sourceEventId: "market-1",
      chain: "base",
      observedAt: 100,
      collectedAt: 100,
      payloadVersion: 1,
      payload: {},
      confidence,
      extractionMode: "api",
      provenance: {},
    })).toThrow(/confidence/);
  });
});
