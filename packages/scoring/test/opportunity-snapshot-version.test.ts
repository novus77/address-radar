import { describe, expect, it } from "vitest";

import { evaluateTraderOpportunities, evaluateTraderPerformance } from "@address-radar/scoring";

describe("opportunity snapshot compatibility", () => {
  it("uses a separate snapshot ID for the new basis without changing numerical score weights", () => {
    const request = {
      entityId: "entity", currentLifecycle: "active" as const, locked: false,
      samples: [], outcomes: [], discoveries: [], asOf: 100, window: "30d" as const,
      preferredHorizon: "24h" as const, strategyVersion: "legacy-v2",
    };
    const legacy = evaluateTraderPerformance(request);
    const updated = evaluateTraderPerformance({ ...request, opportunities: evaluateTraderOpportunities({ purchases: [], asOf: request.asOf }) });
    expect(updated.snapshot.snapshotId).not.toBe(legacy.snapshot.snapshotId);
    expect(updated.snapshot.strategyVersion).toBe("legacy-v2:trader-opportunity-v1");
    expect(updated.snapshot.rawQuality).toBe(legacy.snapshot.rawQuality);
    expect(updated.lifecycle).toMatchObject({ next: "active", changed: false });
    expect(updated.snapshot.metrics.opportunityAwaitingDataTokens).toBe(0);
  });
});
