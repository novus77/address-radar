import { describe, expect, it } from "vitest";

import { loadAutomationConfig } from "../src/config.js";

describe("automation planning configuration", () => {
  it("uses a five-minute planning interval by default", () => {
    expect(loadAutomationConfig({}).planningIntervalMs).toBe(300_000);
  });

  it("rejects a non-positive planning interval", () => {
    expect(() => loadAutomationConfig({
      ADDRESS_RADAR_AUTOMATION_PLANNING_INTERVAL_MS: "0",
    })).toThrow("Invalid automation planning interval");
  });
});
