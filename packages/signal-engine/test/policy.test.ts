import { describe, expect, it } from "vitest";

import type { AddressSignalEvidence } from "@address-radar/aggregation";
import { evaluateTokenSignal } from "../src/index.js";

const evidence = (
  eventId: string,
  contribution: number,
  entityId = eventId,
  overrides: Partial<AddressSignalEvidence> = {},
): AddressSignalEvidence => ({
  eventId,
  entityId,
  contribution,
  occurredAt: 1_000,
  source: "fomo",
  side: "buy",
  amountUsd: 1_000,
  lifecycleStage: "launched_0_2h",
  traderTags: ["EARLY_LAUNCH"],
  ...overrides,
});

describe("token signal policy", () => {
  it("requires concurrent qualified early or high-multiple traders for new tokens", () => {
    const decision = evaluateTokenSignal({
      previous: null,
      threshold: 0.7,
      evidence: [
        evidence("early", 0.8, "entity-a", { occurredAt: 1_000_000 }),
        evidence("stale", 0.8, "entity-b", { occurredAt: 699_999 }),
      ],
    });

    expect(decision).toMatchObject({
      action: "observe",
      signalFamily: "NEW_TOKEN_DISCOVERY",
      windowMs: 5 * 60_000,
      participantCount: 1,
      missingConditions: ["distinct_traders:2"],
    });
  });

  it("qualifies an old-token anomaly from multiple traders and a large buy", () => {
    const decision = evaluateTokenSignal({
      previous: null,
      threshold: 0.7,
      evidence: [
        evidence("old-1", 0.8, "entity-a", { lifecycleStage: "older_1_7d", amountUsd: 12_000, occurredAt: 2_000_000 }),
        evidence("old-2", 0.8, "entity-b", { lifecycleStage: "older_1_7d", amountUsd: 8_500, occurredAt: 2_100_000 }),
      ],
    });

    expect(decision).toMatchObject({
      action: "broadcast",
      signalFamily: "OLD_TOKEN_MOVEMENT",
      participantCount: 2,
      totalBuyUsd: 20_500,
      windowMs: 30 * 60_000,
    });
  });

  it("keeps Fomo and on-chain evidence distinct while deduplicating one economic action", () => {
    const decision = evaluateTokenSignal({
      previous: null,
      threshold: 0.7,
      evidence: [
        evidence("fomo-1", 0.8, "entity-a", { source: "fomo", lifecycleStage: "older_1_7d", amountUsd: 12_000, dedupeKey: "tx-1" }),
        evidence("chain-1", 0.8, "entity-a", { source: "onchain", lifecycleStage: "older_1_7d", amountUsd: 12_000, dedupeKey: "tx-1" }),
        evidence("fomo-2", 0.8, "entity-b", { source: "fomo", lifecycleStage: "older_1_7d", amountUsd: 8_500, dedupeKey: "tx-2" }),
        evidence("chain-2", 0.8, "entity-b", { source: "onchain", lifecycleStage: "older_1_7d", amountUsd: 8_500, dedupeKey: "tx-2" }),
      ],
    });

    expect(decision).toMatchObject({
      action: "broadcast",
      participantCount: 2,
      totalBuyUsd: 20_500,
      sourceState: "FOMO_AND_ONCHAIN",
    });
  });

  it("respects the configured aggregate purchase threshold", () => {
    const decision = evaluateTokenSignal({
      previous: null,
      threshold: 0.7,
      minimumTotalBuyUsd: 3_000,
      evidence: [evidence("a", 0.8, "entity-a"), evidence("b", 0.8, "entity-b")],
    });

    expect(decision.missingConditions).toContain("minimum_total_buy_usd:3000");
  });

  it("rebroadcasts only from a fresh independently qualified group", () => {
    const decision = evaluateTokenSignal({
      previous: { broadcastCount: 1, consumedEvidenceIds: ["a", "b"] },
      threshold: 0.7,
      evidence: [
        evidence("a", 0.8, "entity-a"),
        evidence("b", 0.8, "entity-b"),
        evidence("c", 0.8, "entity-c"),
        evidence("d", 0.8, "entity-d"),
      ],
    });

    expect(decision).toMatchObject({ action: "rebroadcast", broadcastNumber: 2, consumeEvidenceIds: ["c", "d"] });
  });

  it("keeps created tokens in observation even with three traders inside ten minutes", () => {
    const decision = evaluateTokenSignal({ previous: null, threshold: 0.7, evidence: [
      evidence("a", 0.8, "entity-a", { lifecycleStage: "created", occurredAt: 1_000_000 }),
      evidence("b", 0.8, "entity-b", { lifecycleStage: "created", occurredAt: 700_001 }),
      evidence("c", 0.8, "entity-c", { lifecycleStage: "created", occurredAt: 999_999 }),
    ] });
    expect(decision).toMatchObject({ action: "observe", signalFamily: "NEW_TOKEN_DISCOVERY", windowMs: 600_000, participantCount: 3 });
    expect(decision.missingConditions).toContain("token_not_launched");
  });

  it("requires one actual ten-thousand-dollar buy", () => {
    const split = evaluateTokenSignal({ previous: null, threshold: 0.7, evidence: [
      evidence("a1", 0.8, "a", { lifecycleStage: "older_1_7d", amountUsd: 5_000 }),
      evidence("a2", 0.8, "a", { lifecycleStage: "older_1_7d", amountUsd: 5_000 }),
      evidence("b1", 0.8, "b", { lifecycleStage: "older_1_7d", amountUsd: 5_000 }),
      evidence("b2", 0.8, "b", { lifecycleStage: "older_1_7d", amountUsd: 5_000 }),
    ] });
    const actual = evaluateTokenSignal({ previous: null, threshold: 0.7, evidence: [
      evidence("a", 0.8, "a", { lifecycleStage: "older_1_7d", amountUsd: 10_000 }),
      evidence("b", 0.8, "b", { lifecycleStage: "older_1_7d", amountUsd: 10_000 }),
    ] });
    expect(split.missingConditions).toContain("single_buy_usd:10000");
    expect(actual.action).toBe("broadcast");
  });

  it("consumes only qualified evidence", () => {
    const decision = evaluateTokenSignal({ previous: null, threshold: 0.7, evidence: [
      evidence("qa", 0.8, "a"), evidence("qb", 0.8, "b"), evidence("low", 0.4, "c"),
    ] });
    expect(decision.consumeEvidenceIds).toEqual(["qa", "qb"]);
  });

  it("counts wallets buying within ten seconds as one independent participant", () => {
    const decision = evaluateTokenSignal({ previous: null, threshold: 0.7, evidence: [
      evidence("a", 0.8, "a", { occurredAt: 1_000, independenceKey: "bundle:a+b", bundleRisk: "strong" }),
      evidence("b", 0.8, "b", { occurredAt: 6_000, independenceKey: "bundle:a+b", bundleRisk: "strong" }),
    ] });
    expect(decision).toMatchObject({ action: "observe", participantCount: 1, totalBuyUsd: 2_000, bundleDiagnostics: { rawParticipantCount: 2, independentParticipantCount: 1, bundledParticipantCount: 2 } });
  });
});
