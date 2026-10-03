import { describe, expect, it } from "vitest";
import * as database from "@address-radar/database";

describe("forward capability consumer contract", () => {
  it("exports a dedicated fenced capability work repository", () => {
    expect(Reflect.get(database, "createPostgresForwardTraderCapabilityWorkRepository")).toBeTypeOf("function");
  });
});
