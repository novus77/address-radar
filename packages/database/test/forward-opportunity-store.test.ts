import { describe, expect, it } from "vitest";
import * as store from "../src/forward-opportunity-store.js";
import type { PostgresTransaction } from "../src/postgres-unit-of-work.js";

describe("forward PostgreSQL opportunity store", () => {
  it("exports a transaction-bound opportunity repository", () => {
    expect((store as Record<string, unknown>).createPostgresForwardOpportunityRepository).toBeTypeOf("function");
  });
  it("rejects invalid peak evidence before executing SQL", async () => {
    let calls = 0;
    const transaction: PostgresTransaction = { async query() { calls++; throw new Error("unexpected SQL"); } };
    const repository = store.createPostgresForwardOpportunityRepository(transaction);
    await expect(repository.recordPeak({ peakId: "peak", revisionId: "v1", chain: "base", tokenAddress: "0xabc",
      priceUsd: "0", knownAt: 10, verification: "validated", evidenceRef: "fixture:peak", kind: "trade", occurredAt: 10 })).rejects.toThrow("positive");
    expect(calls).toBe(0);
  });
});
