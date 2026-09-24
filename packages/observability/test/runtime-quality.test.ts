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
      recordedAt: 20_000,
      startedAt: 20_000,
      lastEventAt: 18_000,
      latestAggregationAt: 19_000,
      eventFreshnessMs: 2_000,
      queueLagMs: 5_000,
      aggregationLagMs: 1_000,
      registryVersion: 7,
      providerStatuses: { fomo: "ready", onchain: "degraded" },
      status: "degraded",
    });
  });

  it("marks stale inputs degraded even when providers are ready", () => {
    expect(createRuntimeQualitySnapshot({
      now: 100_000, lastEventAt: 1_000, oldestQueuedAt: null, latestAggregationAt: 1_000,
      registryVersion: 8, providerStatuses: { fomo: "ready" }, staleAfterMs: 10_000,
    }).status).toBe("degraded");
  });

  it("reports a ready source without events as warming before it becomes stale", () => {
    expect(createRuntimeQualitySnapshot({
      now: 5_000, startedAt: 1_000, lastEventAt: null, oldestQueuedAt: null, latestAggregationAt: null,
      registryVersion: 1, providerStatuses: { fomo: "ready" }, staleAfterMs: 10_000,
    }).status).toBe("warming");
    expect(createRuntimeQualitySnapshot({
      now: 20_000, startedAt: 1_000, lastEventAt: null, oldestQueuedAt: null, latestAggregationAt: null,
      registryVersion: 1, providerStatuses: { fomo: "ready" }, staleAfterMs: 10_000,
    }).status).toBe("degraded");
  });
});
