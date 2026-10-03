import { expect, it } from "vitest";
import * as database from "@address-radar/database";

it("exports the read-only legacy target proof adapter", () => {
  expect(Reflect.get(database, "createLegacyForwardTargetSnapshotReader")).toBeTypeOf("function");
});
