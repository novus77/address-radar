import { describe, expect, it } from "vitest";
import * as database from "../src/index.js";

describe("forward trace read model", () => {
  it("exports the bounded, read-only trace reader", () => {
    expect((database as unknown as Record<string, unknown>).readPostgresForwardTrace).toBeTypeOf("function");
  });
});
