import { describe, expect, it } from "vitest";

import { createRuntimeQualitySnapshot } from "../src/index.js";

describe("runtime quality snapshot", () => {
  it("calculates freshness, queue lag, provider state, registry version, and aggregation lag", () => {
    expect(createRuntimeQualitySnapshot({
      now: 20_000,
      lastEventAt: 18_000,
      oldestQueuedAt: 15_000,
      latestAggregationAt: 19_000,
      registryVersion: 7,
      providerStatuses: { fomo: "ready", onchain: "degraded" },
    })).toEqual({
      eventFreshnessMs: 2_000,
      queueLagMs: 5_000,
      aggregationLagMs: 1_000,
      registryVersion: 7,
      providerStatuses: { fomo: "ready", onchain: "degraded" },
      status: "degraded",
    });
  });
});
