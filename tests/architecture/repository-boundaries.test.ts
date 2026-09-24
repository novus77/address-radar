import { describe, expect, it } from "vitest";

import { findRepositoryBoundaryViolations } from "../../scripts/check-boundaries.js";

describe("repository boundaries", () => {
  it("does not depend on browser extension, licensing, or customer gateway code", async () => {
    await expect(findRepositoryBoundaryViolations()).resolves.toEqual([]);
  });
});
