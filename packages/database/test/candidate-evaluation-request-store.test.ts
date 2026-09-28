import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCandidateEvaluationRequestStore, migrateAddressRadarDatabase, openAddressRadarDatabase } from "../src/index.js";

describe("candidate evaluation requests", () => {
  it("coalesces duplicate triggers and preserves a newer revision", () => {
    const database = openAddressRadarDatabase(join(mkdtempSync(join(tmpdir(), "candidate-request-")), "radar.sqlite"));
    migrateAddressRadarDatabase(database);
    const store = createCandidateEvaluationRequestStore(database);
    const first = store.request("base:0xabc", "candidate-evidence-v2", "event:1", 100);
    expect(store.request("base:0xabc", "candidate-evidence-v2", "event:1", 101).requestedRevision).toBe(1);
    store.bindJob(first.requestKey, "job-1", 1, 110);
    expect(store.request("base:0xabc", "candidate-evidence-v2", "event:2", 120).requestedRevision).toBe(2);
    expect(store.complete(first.requestKey, "job-1", 1, "produced", 130)).toMatchObject({ processedRevision: 1, requestedRevision: 2, needsFollowUp: true });
    database.close();
  });
});
