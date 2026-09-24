import { describe, expect, it } from "vitest";
import { RadarSignalValidationError, replayRadarSignalV1 } from "../src/index.js";

const valid = { schemaVersion: "1", signalId: "solana:T", idempotencyKey: "solana:T:broadcast:1", token: { chain: "solana", contractAddress: "T", symbol: null, name: null, imageUrl: null }, category: "new_token_discovery", broadcastSequence: 1, score: 0.8, confidence: 0.8, marketCapUsd: 0, priceUsd: 0, triggeredAt: new Date(1_000).toISOString(), expiresAt: new Date(2_000).toISOString(), display: { title: "Title", summary: "Summary", reasonCodes: ["reason"] } };

describe("RadarSignalV1 semantic validation", () => {
  it.each([
    ["empty id", { signalId: "" }], ["unsupported chain", { token: { ...valid.token, chain: "polygon" } }],
    ["score range", { score: 1.1 }], ["negative price", { priceUsd: -1 }],
    ["expiry order", { expiresAt: valid.triggeredAt }], ["empty display", { display: { title: "", summary: "Summary", reasonCodes: ["reason"] } }],
  ])("rejects %s for current and legacy V1", (_name, change) => {
    const corrupted = { ...valid, ...change };
    expect(() => replayRadarSignalV1({ kind: "radar_signal_evaluation", version: 1, publicSignal: corrupted, audit: {} })).toThrow(RadarSignalValidationError);
    expect(() => replayRadarSignalV1(corrupted)).toThrow(RadarSignalValidationError);
  });
});
