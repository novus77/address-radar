import { describe, expect, it } from "vitest";

import {
  assertCompleteClosedLoopMetrics,
  assertValidStageProgressMetric,
  CLOSED_LOOP_STAGES,
  type ClosedLoopStage,
  type StageProgressMetric,
} from "../src/index.js";

function metric(stage: ClosedLoopStage): StageProgressMetric {
  return {
    stage,
    discovered: 10,
    eligible: 8,
    pending: 2,
    blocked: 1,
    completed: 5,
    terminal: 0,
    producedFacts: 4,
    oldestPendingAt: "2026-09-28T00:00:00.000Z",
    lastProgressAt: "2026-09-28T00:05:00.000Z",
  };
}

describe("closed-loop metrics", () => {
  it("accepts one valid metric for every canonical stage", () => {
    expect(() => assertCompleteClosedLoopMetrics(CLOSED_LOOP_STAGES.map(metric))).not.toThrow();
  });

  it("rejects duplicate stages", () => {
    const metrics = CLOSED_LOOP_STAGES.map(metric);
    metrics.push(metric("token_discovery"));

    expect(() => assertCompleteClosedLoopMetrics(metrics)).toThrow(
      "Duplicate closed-loop stage: token_discovery",
    );
  });

  it("rejects missing stages", () => {
    expect(() => assertCompleteClosedLoopMetrics(CLOSED_LOOP_STAGES.slice(1).map(metric))).toThrow(
      "Missing closed-loop stages: token_discovery",
    );
  });

  it("rejects negative and non-integer counters", () => {
    expect(() => assertValidStageProgressMetric({ ...metric("market_history"), pending: -1 })).toThrow(
      "Invalid pending counter for market_history: -1",
    );
    expect(() => assertValidStageProgressMetric({ ...metric("market_history"), pending: 1.5 })).toThrow(
      "Invalid pending counter for market_history: 1.5",
    );
  });

  it("rejects completed counts above the eligible population", () => {
    expect(() =>
      assertValidStageProgressMetric({
        ...metric("candidate_admission"),
        eligible: 2,
        completed: 3,
      }),
    ).toThrow("Completed count exceeds eligible count for candidate_admission");
  });
});
