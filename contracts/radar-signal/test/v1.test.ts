import { describe, expect, it } from "vitest";

import { radarSignalV1Schema } from "../src/index.js";

const fixture = {
  schemaVersion: "1", signalId: "solana:token-a", idempotencyKey: "solana:token-a:2",
  token: { chain: "solana", contractAddress: "TokenA", symbol: "TKA", name: "Token A", imageUrl: "https://example.com/a.png" },
  category: "new_token_discovery", broadcastSequence: 2, score: 78, confidence: 0.82,
  marketCapUsd: 500_000, priceUsd: 0.005, triggeredAt: "2026-09-24T08:00:00.000Z", expiresAt: "2026-09-24T08:15:00.000Z",
  display: { title: "New token discovery", summary: "Three qualified traders entered", reasonCodes: ["concurrent_qualified_entries"] },
} as const;

describe("RadarSignalV1", () => {
  it("round-trips a valid signal", () => {
    expect(radarSignalV1Schema.parse(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
  });

  it.each([
    ["unsupported schema", { ...fixture, schemaVersion: "2" }],
    ["missing idempotency key", { ...fixture, idempotencyKey: "" }],
    ["negative score", { ...fixture, score: -1 }],
    ["invalid timestamp", { ...fixture, triggeredAt: "today" }],
  ])("rejects %s", (_name, value) => {
    expect(radarSignalV1Schema.safeParse(value).success).toBe(false);
  });
});
