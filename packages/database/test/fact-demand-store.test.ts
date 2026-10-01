import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFactDemandStore, initializeFactDemandSchema } from "../src/fact-demand-store.js";

describe("consumer fact demands", () => {
  it("keeps positive evidence separate from full-range coverage and rejects late regression", () => {
    const db = new DatabaseSync(":memory:");
    initializeFactDemandSchema(db);
    const store = createFactDemandStore(db);
    const base = { demandId: "positive", consumerId: "trader", purchaseId: "buy", tokenId: "solana:MintAbC",
      strategyVersion: "test", requiredFrom: 10, requiredTo: 30, evaluatedAt: 30 };
    store.record({ ...base, purpose: "positive_hit", reasonCode: "verified_opportunity",
      proof: { kind: "positive_hit", from: 10, to: 20, knownAt: 25, reference: "buy:peak", maximumMultiple: 5 } });
    store.record({ ...base, demandId: "range", purpose: "complete_range", reasonCode: "market_range_missing", proof: null });
    expect(store.get("positive")?.status).toBe("satisfied");
    expect(store.get("range")?.status).toBe("pending");
    store.record({ ...base, purpose: "positive_hit", requiredTo: 29, evaluatedAt: 29, reasonCode: "market_range_missing", proof: null });
    expect(store.get("positive")?.evaluatedAt).toBe(30);
    expect(store.get("positive")?.status).toBe("satisfied");
    store.record({ ...base, purpose: "positive_hit", evaluatedAt: 31, reasonCode: "market_range_missing", proof: null });
    expect(store.get("positive")?.status).toBe("satisfied");
    store.record({ ...base, purpose: "positive_hit", evaluatedAt: 32, reasonCode: "verified_opportunity",
      proof: { kind: "positive_hit", from: 10, to: 20, knownAt: 25, reference: "buy:lower-peak", maximumMultiple: 3 } });
    expect(store.get("positive")?.proof?.maximumMultiple).toBe(5);
    db.close();
  });

  it("does not reuse coverage for an extended range, future proof, or a different purchase", () => {
    const db = new DatabaseSync(":memory:");
    initializeFactDemandSchema(db);
    const store = createFactDemandStore(db);
    const base = { demandId: "range", consumerId: "trader", purchaseId: "buy", tokenId: "eth:0xabc",
      strategyVersion: "test", requiredFrom: 10, requiredTo: 20, evaluatedAt: 20, purpose: "complete_range" as const,
      reasonCode: "covered", proof: { kind: "complete_range" as const, from: 10, to: 20, knownAt: 20, reference: "provider:range" } };
    store.record(base);
    expect(store.get("range")?.status).toBe("satisfied");
    store.record({ ...base, requiredTo: 30, evaluatedAt: 30, proof: null, reasonCode: "market_range_missing" });
    expect(store.get("range")?.status).toBe("pending");
    store.record({ ...base, requiredTo: 30, evaluatedAt: 30, proof: { ...base.proof, to: 30, knownAt: 31 } });
    expect(store.get("range")?.status).toBe("pending");
    expect(() => store.record({ ...base, purchaseId: "other" })).toThrow("identity conflict");
    db.close();
  });
});
