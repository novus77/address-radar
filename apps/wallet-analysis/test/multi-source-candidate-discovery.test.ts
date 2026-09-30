import { describe, expect, it, vi } from "vitest";

import { createMultiSourceCandidateDiscovery } from "../src/multi-source-candidate-discovery.js";

describe("multi-source candidate discovery", () => {
  it("accepts FOMO-only evidence before wallet identity is available", async () => {
    const requested: string[] = [];
    const discovery = createMultiSourceCandidateDiscovery({
      resolveCanonicalTraderId: () => null,
      requestIdentityResolution: identityKey => { requested.push(identityKey); },
    });

    const result = await discovery.evaluate([{
      identityKey: "fomo-user",
      identityKind: "fomo",
      source: "fomo",
      sourceStatus: "FOMO_ONLY",
      tokenId: "solana:token-a",
      evidenceType: "market_cap_300k_5x",
      observedAt: 1_000,
    }], 1_000);

    expect(result).toEqual([
      expect.objectContaining({ traderId: "fomo:fomo-user", admitted: true, strongTokenCount: 1 }),
    ]);
    expect(requested).toEqual(["fomo-user"]);
  });
  it("places 30D Top 100 and manual identities directly into observation", () => {
    const service = createMultiSourceCandidateDiscovery({ resolveCanonicalTraderId: value => value });
    const results = service.evaluate([
      { identityKey: "top", source: "leaderboard_30d", observedAt: 1_000 },
      { identityKey: "manual", source: "manual", observedAt: 1_000 },
    ], 2_000);
    expect(results.map(item => [item.traderId, item.admitted, item.admissionReason])).toEqual([
      ["manual", true, "trusted_observation"],
      ["top", true, "trusted_observation"],
    ]);
  });

  it("admits wallet-only Strong evidence and Fomo-only evidence from two tokens", () => {
    const requested: string[] = [];
    const service = createMultiSourceCandidateDiscovery({
      resolveCanonicalTraderId: () => null,
      requestIdentityResolution: key => { requested.push(key); },
    });
    const results = service.evaluate([
      { identityKey: "0xwallet", identityKind: "wallet", source: "milestone", tokenId: "base:0xa", evidenceType: "market_cap_500k_10x", observedAt: 1_000 },
      { identityKey: "alice", identityKind: "fomo", source: "fomo", tokenId: "solana:A", evidenceType: "market_cap_100k_3x", observedAt: 1_100 },
      { identityKey: "alice", identityKind: "fomo", source: "fomo", tokenId: "solana:B", evidenceType: "market_cap_200k_3x", observedAt: 1_200 },
    ], 2_000);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ traderId: "wallet:0xwallet", admitted: true, strongTokenCount: 1 }),
      expect.objectContaining({ traderId: "fomo:alice", admitted: true, earlyTokenCount: 2 }),
    ]));
    expect(requested.sort()).toEqual(["alice", "0xwallet"].sort());
  });

  it("counts one token once after source and canonical identity deduplication", () => {
    const service = createMultiSourceCandidateDiscovery({ resolveCanonicalTraderId: () => "entity-1" });
    const results = service.evaluate([
      { identityKey: "alice", source: "fomo", tokenId: "base:0xa", evidenceType: "market_cap_100k_3x", observedAt: 1_000 },
      { identityKey: "0xwallet", source: "milestone", tokenId: "base:0xa", evidenceType: "market_cap_200k_5x", observedAt: 1_100 },
    ], 2_000);
    expect(results).toEqual([expect.objectContaining({ traderId: "entity-1", admitted: false, distinctTokenCount: 1, strongestEvidenceType: "market_cap_200k_5x" })]);
  });

  it("requires shared holdings on two tokens and one independent positive outcome", () => {
    const service = createMultiSourceCandidateDiscovery({ resolveCanonicalTraderId: value => value });
    const incomplete = service.evaluate([
      { identityKey: "shared", source: "shared_holding", tokenId: "base:0xa", evidenceType: "market_cap_100k_3x", observedAt: 1_000, independentlyPositive: true },
    ], 2_000);
    expect(incomplete).toEqual([]);

    const complete = service.evaluate([
      { identityKey: "shared", source: "shared_holding", tokenId: "base:0xa", evidenceType: "market_cap_100k_3x", observedAt: 1_000, independentlyPositive: true },
      { identityKey: "shared", source: "shared_holding", tokenId: "base:0xb", evidenceType: "market_cap_200k_3x", observedAt: 1_100, independentlyPositive: false },
    ], 2_000);
    expect(complete).toEqual([expect.objectContaining({ traderId: "shared", distinctTokenCount: 2 })]);
  });

  it("requests unresolved identity enrichment only once per prospect", () => {
    const request = vi.fn();
    const service = createMultiSourceCandidateDiscovery({ resolveCanonicalTraderId: () => null, requestIdentityResolution: request });
    service.evaluate([
      { identityKey: "alice", identityKind: "fomo", source: "fomo", tokenId: "base:0xa", evidenceType: "market_cap_100k_3x", observedAt: 1_000 },
      { identityKey: "alice", identityKind: "fomo", source: "fomo", tokenId: "base:0xb", evidenceType: "market_cap_200k_3x", observedAt: 1_100 },
    ], 2_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("alice");
  });
});
