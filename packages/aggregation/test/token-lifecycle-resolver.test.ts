import { describe, expect, it, vi } from "vitest";

import { createTokenLifecycleResolver } from "../src/index.js";

describe("token lifecycle resolver", () => {
  it("uses the earliest executable market as launch time", async () => {
    const tokenFacts = vi.fn(async () => ({ status: "ready" as const, markets: [{ launchedAt: 9_000 }, { launchedAt: 8_000 }] }));
    const resolver = createTokenLifecycleResolver({ provider: { tokenFacts } });

    await expect(resolver.resolve({ chain: "base", tokenAddress: "0xtoken", observedAt: 10_000 })).resolves.toBe("launched_0_2h");
  });

  it("degrades to unknown when lifecycle evidence is unavailable", async () => {
    const resolver = createTokenLifecycleResolver({ provider: { tokenFacts: vi.fn(async () => ({ status: "rate_limited" as const, markets: [] })) } });

    await expect(resolver.resolve({ chain: "base", tokenAddress: "0xtoken", observedAt: 10_000 })).resolves.toBe("unknown");
  });

  it("classifies metadata with createdAt and no launch as created", async () => {
    const resolver = createTokenLifecycleResolver({
      provider: { tokenFacts: vi.fn(async () => ({ status: "ready" as const, createdAt: 5_000, markets: [] })) },
    });
    await expect(resolver.resolve({ chain: "solana", tokenAddress: "TokenA", observedAt: 10_000 })).resolves.toBe("created");
  });
});
