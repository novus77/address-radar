import { describe, expect, it } from "vitest";
import * as database from "../src/index.js";

describe("forward target identity revalidation", () => {
  it("exports an explicit fresh identity receipt boundary", () => {
    const exports = database as unknown as Record<string, unknown>;
    expect(typeof exports.refreshPostgresForwardTargetIdentity).toBe("function");
    expect(typeof exports.readPostgresFreshForwardTargetAuthorization).toBe("function");
  });
});
