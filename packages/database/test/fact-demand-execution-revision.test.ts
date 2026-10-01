import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createFactDemandStore, initializeFactDemandSchema } from "../src/fact-demand-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  initializeFactDemandSchema(db);
  return createFactDemandStore(db);
}
const demand = {
  demandId: "positive", consumerId: "trader", purchaseId: "buy", tokenId: "solana:MintAbC",
  strategyVersion: "test", requiredFrom: 10, requiredTo: 30, evaluatedAt: 30,
  purpose: "positive_hit" as const, reasonCode: "verified_opportunity", executionRevision: 1,
  proof: { kind: "positive_hit" as const, from: 10, to: 20, knownAt: 25,
    reference: "buy:peak", maximumMultiple: 5, executionRevision: 1 },
};

describe("execution revision fencing for fact demands", () => {
  it("invalidates a prior positive proof when the entry execution changes", () => {
    const store = setup();
    store.record(demand);
    store.record({ ...demand, executionRevision: 2, evaluatedAt: 31,
      reasonCode: "execution_revision_pending", proof: null });
    expect(store.get("positive")).toMatchObject({ status: "pending", proof: null,
      executionRevision: 2, reasonCode: "execution_revision_pending" });
  });

  it("accepts a corrected lower multiple rather than preserving the old entry result", () => {
    const store = setup();
    store.record(demand);
    store.record({ ...demand, executionRevision: 2, evaluatedAt: 31,
      proof: { ...demand.proof, maximumMultiple: 3, executionRevision: 2 } });
    expect(store.get("positive")).toMatchObject({ status: "satisfied", executionRevision: 2,
      proof: { maximumMultiple: 3, executionRevision: 2 } });
  });

  it("rejects an older execution even when its evaluation arrives later", () => {
    const store = setup();
    store.record({ ...demand, executionRevision: 2, proof: { ...demand.proof, executionRevision: 2 } });
    store.record({ ...demand, evaluatedAt: 40, proof: { ...demand.proof, maximumMultiple: 20 } });
    expect(store.get("positive")).toMatchObject({ evaluatedAt: 30, executionRevision: 2,
      proof: { maximumMultiple: 5, executionRevision: 2 } });
  });

  it("does not certify a proof from another execution revision", () => {
    const store = setup();
    store.record({ ...demand, executionRevision: 2 });
    expect(store.get("positive")).toMatchObject({ status: "pending", proof: null });
  });

  it("continues preserving stronger evidence within the same execution revision", () => {
    const store = setup();
    store.record(demand);
    store.record({ ...demand, evaluatedAt: 31, proof: { ...demand.proof, maximumMultiple: 3 } });
    expect(store.get("positive")?.proof?.maximumMultiple).toBe(5);
  });

  it("does not allow an unversioned replay to replace a versioned demand", () => {
    const store = setup();
    store.record(demand);
    const { executionRevision: _revision, proof, ...legacy } = demand;
    const { executionRevision: _proofRevision, ...legacyProof } = proof;
    store.record({ ...legacy, evaluatedAt: 40, proof: legacyProof });
    expect(store.get("positive")).toMatchObject({ executionRevision: 1, evaluatedAt: 30 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid execution revision %s", revision => {
    const store = setup();
    expect(() => store.record({ ...demand, executionRevision: revision })).toThrow("Execution revision");
    expect(store.get("positive")).toBeNull();
  });
});
