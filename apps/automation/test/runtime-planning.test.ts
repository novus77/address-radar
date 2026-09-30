import { describe, expect, it, vi } from "vitest";

import { createPlanningGate } from "../src/runtime.js";

describe("createPlanningGate", () => {
  it("runs planning immediately and then only after the configured interval", () => {
    let currentTime = 1_000;
    const plan = vi.fn();
    const gate = createPlanningGate({
      intervalMs: 300_000,
      now: () => currentTime,
    });

    expect(gate.runIfDue(plan)).toBe(true);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenLastCalledWith(1_000);

    expect(gate.runIfDue(plan)).toBe(false);
    currentTime += 299_999;
    expect(gate.runIfDue(plan)).toBe(false);

    currentTime += 1;
    expect(gate.runIfDue(plan)).toBe(true);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenLastCalledWith(301_000);
  });
});
