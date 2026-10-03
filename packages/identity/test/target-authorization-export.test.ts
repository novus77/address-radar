import { describe, expect, it } from "vitest";
import * as identity from "../src/index.js";

describe("forward target authorization contract", () => {
  it("exports explicit authorization evaluation separately from ordinary labels", () => {
    expect(Reflect.get(identity, "evaluateForwardTargetAuthorization")).toBeTypeOf("function");
  });
});
