import { describe, expect, it } from "vitest";

import {
  createSourceObservation,
  semanticSourceObservationFingerprint,
} from "@address-radar/domain";

function observation(input: {
  readonly collectedAt: number;
  readonly amountUsd: number;
}) {
  return createSourceObservation({
    source: "fomo_feed",
    sourceEventId: "event-1",
    chain: "base",
    observedAt: 2_000,
    collectedAt: input.collectedAt,
    payloadVersion: 1,
    payload: {
      eventId: "event-1",
      source: "fomo_stream",
      accountId: "account-1",
      chain: "base",
      tokenAddress: "0xabc",
      side: "buy",
      amountUsd: input.amountUsd,
      occurredAt: 2_000,
      collectedAt: input.collectedAt,
    },
    confidence: 0.85,
    extractionMode: "network",
    provenance: { originalSource: "fomo_stream" },
  });
}

describe("semantic source observation fingerprint", () => {
  it("is stable when only collection time changes", () => {
    const first = semanticSourceObservationFingerprint(observation({
      collectedAt: 2_100,
      amountUsd: 100,
    }));
    const second = semanticSourceObservationFingerprint(observation({
      collectedAt: 9_900,
      amountUsd: 100,
    }));

    expect(second).toBe(first);
  });

  it("changes when a business field changes", () => {
    const first = semanticSourceObservationFingerprint(observation({
      collectedAt: 2_100,
      amountUsd: 100,
    }));
    const second = semanticSourceObservationFingerprint(observation({
      collectedAt: 2_100,
      amountUsd: 125,
    }));

    expect(second).not.toBe(first);
  });
});
