import { describe, expect, it, vi } from "vitest";

import { createTokenLifecycleResolver } from "../src/index.js";

describe("token lifecycle resolver", () => {
  it("uses the earliest executable market as launch time", async () => {
    const launchFacts = vi.fn(async () => ({ status: "ready" as const, markets: [{ launchedAt: 9_000 }, { launchedAt: 8_000 }] }));
    const resolver = createTokenLifecycleResolver({ launchProvider: { launchFacts } });

    await expect(resolver.resolve({ chain: "base", tokenAddress: "0xtoken", observedAt: 10_000 })).resolves.toBe("launched_0_2h");
  });

  it("degrades to unknown when lifecycle evidence is unavailable", async () => {
    const resolver = createTokenLifecycleResolver({ launchProvider: { launchFacts: vi.fn(async () => ({ status: "rate_limited" as const, markets: [] })) } });

    await expect(resolver.resolve({ chain: "base", tokenAddress: "0xtoken", observedAt: 10_000 })).resolves.toBe("unknown");
  });

  it("classifies independent token creation evidence with no launch as created", async () => {
    const resolver = createTokenLifecycleResolver({
      creationProvider: { creationFacts: vi.fn(async () => ({ status: "ready" as const, createdAt: 5_000 })) },
      launchProvider: { launchFacts: vi.fn(async () => ({ status: "ready" as const, markets: [] })) },
    });
    await expect(resolver.resolve({ chain: "solana", tokenAddress: "TokenA", observedAt: 10_000 })).resolves.toBe("created");
  });

  it.each(["unavailable", "rate_limited"] as const)("defers created evidence while launch provider is %s", async (status) => {
    const resolver = createTokenLifecycleResolver({
      creationProvider: { creationFacts: vi.fn(async () => ({ status: "ready" as const, createdAt: 5_000 })) },
      launchProvider: { launchFacts: vi.fn(async () => ({ status, markets: [] })) },
    });
    await expect(resolver.resolve({ chain: "solana", tokenAddress: "TokenA", observedAt: 10_000 })).resolves.toBe("unknown");
  });

  it("uses source creation evidence independently from provider launch evidence", async () => {
    const resolver = createTokenLifecycleResolver({
      launchProvider: { launchFacts: vi.fn(async () => ({ status: "ready" as const, markets: [] })) },
    });
    await expect(resolver.resolve({ chain: "solana", tokenAddress: "TokenA", observedAt: 10_000, createdAt: 5_000 })).resolves.toBe("created");
  });
});
