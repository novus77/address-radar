import { afterEach, describe, expect, it } from "vitest";
import { createAutomationJobStore, createTokenFactStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { createSourceFactRevisionReconciler } from "../src/source-fact-revision-reconciler.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
describe("source fact revision replay", () => {
  it("triggers a candidate revision once and ignores unrelated identity facts", () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const facts = createTokenFactStore(database);
    for (const factType of ["price_history", "token_identity"] as const) {
      facts.ensure("base:token", factType, "test", 1);
      facts.transition({ tokenId: "base:token", factType, status: "available", primarySource: "test", observedAt: 1, strategyVersion: "test", updatedAt: 1 });
    }
    const reconciler = createSourceFactRevisionReconciler({ database, jobs: createAutomationJobStore(database), now: () => 2 });
    expect(reconciler.runOnce()).toMatchObject({ processed: 1 });
    expect(reconciler.runOnce()).toMatchObject({ processed: 0 });
    expect(database.prepare("SELECT COUNT(*) count FROM candidate_evaluation_triggers").get()).toEqual({ count: 1 });
  });
});
