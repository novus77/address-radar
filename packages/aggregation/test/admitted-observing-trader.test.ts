import { describe, expect, it } from "vitest";
import type { AddressSignalEvidence } from "../src/evidence.js";
import { createTokenAggregationService } from "../src/service.js";

describe("admitted observing trader aggregation", () => {
  it.each([true, false])("honors observing-wallet monitoring enablement: %s", (enabled) => {
    let received: readonly AddressSignalEvidence[] = [];
    const service = createTokenAggregationService({
      repository: {
        tokenAggregationState: () => null,
        traderSignalProfile: () => ({
          lifecycle: "probation", mapped: true, monitoringEnabled: enabled,
          onchainMonitoringEnabled: enabled, fomoMonitoringEnabled: false,
        }),
        saveTokenEvaluation: () => undefined,
      } as never,
      threshold: 0.8, strategyVersion: "test", now: () => 1_000,
      evaluate: ({ evidence }) => {
        received = evidence;
        return {
          action: "observe", score: 0, broadcastNumber: 0, consumeEvidenceIds: [],
          signalFamily: null, lifecycleStage: "unknown", windowMs: 60_000,
          participantCount: evidence.length, totalBuyUsd: 100, maxSingleBuyUsd: 100,
          sourceState: "ONCHAIN_ONLY", missingConditions: [],
          bundleDiagnostics: {
            rawParticipantCount: evidence.length, independentParticipantCount: evidence.length,
            bundledParticipantCount: 0, bundledBuyUsd: 0, bundleBuyShare: 0, groups: [],
          },
        };
      },
      createCandidate: () => null, publicSignal: () => null,
    });
    service.evaluate("solana", "CaseSensitiveMint", [{
      eventId: "buy", entityId: "admitted", source: "onchain", side: "buy",
      amountUsd: 100, contribution: 0.5, occurredAt: 1_000,
    }]);
    expect(received).toHaveLength(enabled ? 1 : 0);
    if (enabled) expect(received[0]?.traderLifecycle).toBe("probation");
  });
});
