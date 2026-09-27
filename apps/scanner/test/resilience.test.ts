import { describe, expect, it, vi } from "vitest";

import { createDiskHeadroomGuard, createRateLimitedErrorReporter } from "../src/resilience.js";

describe("scanner resilience", () => {
  it("aggregates repeated errors within the reporting window", () => {
    let now = 1_000;
    const emit = vi.fn();
    const reporter = createRateLimitedErrorReporter({ emit, windowMs: 1_000, now: () => now });

    reporter.report("collector", new Error("failed"));
    reporter.report("collector", new Error("failed"));
    now = 2_001;
    reporter.report("collector", new Error("failed"));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[0]).toContain("1 similar errors suppressed");
  });

  it("blocks scanning below the configured disk headroom", async () => {
    const guard = createDiskHeadroomGuard({
      path: "/data",
      minimumFreeBytes: 2_000,
      checkIntervalMs: 60_000,
      freeBytes: async () => 1_000,
    });

    await expect(guard.assertHealthy()).rejects.toThrow(/scanner_disk_headroom_low/);
  });
});
