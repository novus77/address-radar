import { describe, expect, it } from "vitest";
import { readPreservationRunDeadline, preservationStageDeadline } from "../preservation-run-deadline.js";

const now = 1_791_111_111_000;

describe("bounded preservation rehearsal window", () => {
  it("does not turn an absent deadline into operation authority", () => {
    expect(readPreservationRunDeadline(undefined, now)).toBeUndefined();
    expect(readPreservationRunDeadline(String(now + 3_600_000), now)).toBe(now + 3_600_000);
  });
  it.each(["", "0", "01", "-1", "Infinity", "1.5", " 1791111112000", "9007199254740992",
    String(now), String(now - 1), String(now + 3_600_001)])("refuses invalid absolute deadline %s", value => {
    expect(() => readPreservationRunDeadline(value, now)).toThrow("INVALID_RUN_DEADLINE");
  });
  it.each([NaN, Infinity, -1, 0.5])("refuses an invalid clock %s", value => {
    expect(() => readPreservationRunDeadline(undefined, value)).toThrow("INVALID_CLOCK");
    expect(() => preservationStageDeadline("install", value)).toThrow("INVALID_CLOCK");
  });
  it.each(["install", "calibrate"])("preserves the existing shorter %s budget", stage => {
    expect(preservationStageDeadline(stage, now)).toEqual({ deadlineAtMs: now + 180_000,
      timeoutSeconds: 190, transportTimeoutMs: 220_000 });
  });
  it.each(["interrupt", "import", "resume", "parity"])("preserves the existing %s budget", stage => {
    expect(preservationStageDeadline(stage, now)).toEqual({ deadlineAtMs: now + 900_000,
      timeoutSeconds: 910, transportTimeoutMs: 940_000 });
  });
  it("shrinks work and transport budgets while leaving time for owned cleanup", () => {
    const deadline = now + 200_000;
    expect(preservationStageDeadline("resume", now, deadline)).toEqual({ deadlineAtMs: now + 100_000,
      timeoutSeconds: 110, transportTimeoutMs: 140_000 });
    expect(now + preservationStageDeadline("resume", now, deadline).transportTimeoutMs).toBe(deadline - 60_000);
  });
  it("counts fractional seconds without consuming the cleanup reserve", () => {
    const deadline = now + 101_001;
    const budget = preservationStageDeadline("parity", now, deadline);
    expect(budget.timeoutSeconds).toBe(12);
    expect(budget.transportTimeoutMs).toBe(41_001);
    expect(now + budget.transportTimeoutMs).toBe(deadline - 60_000);
  });
  it("recomputes remaining time rather than resetting the total window at every phase", () => {
    const deadline = now + 3_600_000;
    expect(preservationStageDeadline("resume", now + 3_000_000, deadline).deadlineAtMs).toBe(deadline - 100_000);
    expect(() => preservationStageDeadline("parity", deadline - 100_000, deadline)).toThrow("DEADLINE_EXHAUSTED");
  });
  it.each(["unknown", "", "install/../parity"])("refuses unknown stage %s", stage => {
    expect(() => preservationStageDeadline(stage, now)).toThrow("INVALID_STAGE");
  });
  it.each([NaN, Infinity, -1, 0.5])("refuses invalid remaining window %s", value => {
    expect(() => preservationStageDeadline("resume", now, value)).toThrow("INVALID_RUN_DEADLINE");
  });
});
