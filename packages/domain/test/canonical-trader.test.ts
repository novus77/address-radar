import { describe, expect, it } from "vitest";

import { createCanonicalTrader } from "@address-radar/domain";

describe("canonical trader", () => {
  it("supports one valid Solana wallet without a Fomo identity", () => {
    const trader = createCanonicalTrader({
      entity: { entityId: "entity-1", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 },
      fomoIdentity: null,
      wallets: [{
        chainFamily: "solana",
        address: "11111111111111111111111111111111",
        confidence: "confirmed",
        source: "onchain",
        firstObservedAt: 1,
        lastObservedAt: 1,
      }],
    });

    expect(trader.fomoIdentity).toBeNull();
    expect(trader.wallets).toHaveLength(1);
    expect(trader.wallets[0]).toMatchObject({ chainFamily: "solana", address: "11111111111111111111111111111111" });
    expect(trader.monitoringCoverage).toBe("onchain_only");
  });
});
