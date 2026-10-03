import { expect, it } from "vitest";
import * as scoring from "../src/index.js";

it("exports the approved forward stable-capability evaluator", () => {
  expect((scoring as Record<string, unknown>).evaluateForwardTraderCapability).toBeTypeOf("function");
});
