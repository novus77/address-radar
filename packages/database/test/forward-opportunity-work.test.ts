import { expect, it } from "vitest";
import * as database from "../src/index.js";

it("exports the version-fenced opportunity work repository", () => {
  expect((database as Record<string, unknown>).createPostgresForwardOpportunityWorkRepository).toBeTypeOf("function");
});
