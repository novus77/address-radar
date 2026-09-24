import { describe, expect, it } from "vitest";

import { classifyTokenLifecycle } from "@address-radar/domain";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("token lifecycle classification", () => {
  it("keeps created tokens separate from launched tokens", () => {
    expect(classifyTokenLifecycle({ observedAt: 10_000, createdAt: 1_000, launchedAt: null })).toBe("created");
  });

  it.each([
    [0, "launched_0_2h"], [2 * HOUR - 1, "launched_0_2h"], [2 * HOUR, "launched_2_12h"],
    [12 * HOUR, "launched_12_24h"], [DAY, "older_1_7d"], [7 * DAY, "older_7d_plus"],
  ] as const)("classifies launch age %s", (age, expected) => {
    expect(classifyTokenLifecycle({ observedAt: 10 * DAY, launchedAt: 10 * DAY - age })).toBe(expected);
  });

  it("does not guess when launch facts are missing", () => {
    expect(classifyTokenLifecycle({ observedAt: 10_000 })).toBe("unknown");
  });
});
