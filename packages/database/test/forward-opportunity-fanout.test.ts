import { expect, it } from "vitest";
import * as database from "../src/index.js";

it("exports durable bounded peak fanout", () => {
  expect((database as Record<string, unknown>).createPostgresForwardOpportunityFanoutRepository).toBeTypeOf("function");
});
