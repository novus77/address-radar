import { describe, expect, it } from "vitest";
import { summarizeAssessmentCoverage } from "../src/data-flow-progress.js";

describe("assessment coverage", () => {
  const assessments = [
    { traderId: "a", strategyVersion: "v4", evaluatedAt: 10, state: "candidate" },
    { traderId: "a", strategyVersion: "v4", evaluatedAt: 20, state: "stable" },
    { traderId: "b", strategyVersion: "v3", evaluatedAt: 20, state: "stable" },
    { traderId: "c", strategyVersion: "v4", evaluatedAt: 100, state: "stable" },
  ];
  it("counts latest distinct traders within one strategy and as-of", () => {
    expect(summarizeAssessmentCoverage({ assessments, strategyVersion: "v4", asOf: 30 })).toEqual({
      strategyVersion: "v4", evaluatedTraders: 1, eligibleTraders: null,
      coverage: null, states: { stable: 1 }, lastEvaluationAt: 20,
    });
  });
  it("uses only a supplied matching eligible population", () => {
    expect(summarizeAssessmentCoverage({ assessments, strategyVersion: "v4", asOf: 30,
      eligibleTraderIds: ["a", "b", "b"] })).toMatchObject({ eligibleTraders: 2, coverage: 0.5 });
    expect(summarizeAssessmentCoverage({ assessments, strategyVersion: "v4", asOf: 30,
      eligibleTraderIds: [] })).toMatchObject({ evaluatedTraders: 0, coverage: null });
  });
});
