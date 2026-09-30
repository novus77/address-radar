import { describe, expect, it } from "vitest";
import { recoveryHandoffAction } from "../src/recovery-handoff.js";

const handoff = { kind: "fomo_milestone_lookup", lookupId: "lookup", milestoneId: "m", beforeAt: 100, submittedAt: 1_000, checkAt: 31_000, lookupRevision: 0 } as const;
describe("recovery handoff retries", () => {
  it("does not reissue a request before its waiting deadline", () => {
    expect(recoveryHandoffAction(handoff, 30_000, false)).toEqual({ action: "wait", retryAt: 31_000, reason: "waiting_result" });
  });
  it("reissues a timed-out request under a new revision", () => {
    expect(recoveryHandoffAction(handoff, 31_000, false)).toEqual({ action: "resubmit", lookupRevision: 1, retryAt: 31_000 + 2 * 3_600_000 });
  });
  it("waits for canonical ingestion rather than resubmitting a received result", () => {
    expect(recoveryHandoffAction(handoff, 31_000, true)).toMatchObject({ action: "wait", reason: "waiting_canonical_trade" });
  });
  it("caps automatic reissues while keeping the missing data visible", () => {
    expect(recoveryHandoffAction({ ...handoff, lookupRevision: 3 }, 31_000, false)).toMatchObject({ action: "wait", reason: "lookup_retries_exhausted" });
  });
});
