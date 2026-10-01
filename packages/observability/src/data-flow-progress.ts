export interface VersionedTraderAssessment {
  readonly traderId: string;
  readonly strategyVersion: string;
  readonly evaluatedAt: number;
  readonly state: string;
}

export interface AssessmentCoverage {
  readonly strategyVersion: string;
  readonly evaluatedTraders: number;
  readonly eligibleTraders: number | null;
  readonly coverage: number | null;
  readonly states: Readonly<Record<string, number>>;
  readonly lastEvaluationAt: number | null;
}

/** Evaluation timestamps measure execution, not arrival of new business facts. */
export function summarizeAssessmentCoverage(input: {
  readonly assessments: readonly VersionedTraderAssessment[];
  readonly strategyVersion: string;
  readonly asOf: number;
  readonly eligibleTraderIds?: readonly string[];
}): AssessmentCoverage {
  const eligible = input.eligibleTraderIds === undefined ? null : new Set(input.eligibleTraderIds);
  const latest = new Map<string, VersionedTraderAssessment>();
  for (const assessment of input.assessments) {
    if (assessment.strategyVersion !== input.strategyVersion || assessment.evaluatedAt > input.asOf) continue;
    if (eligible !== null && !eligible.has(assessment.traderId)) continue;
    const previous = latest.get(assessment.traderId);
    if (!previous || assessment.evaluatedAt > previous.evaluatedAt
      || (assessment.evaluatedAt === previous.evaluatedAt && assessment.state.localeCompare(previous.state) > 0)) {
      latest.set(assessment.traderId, assessment);
    }
  }
  const states: Record<string, number> = {};
  let lastEvaluationAt: number | null = null;
  for (const assessment of latest.values()) {
    states[assessment.state] = (states[assessment.state] ?? 0) + 1;
    lastEvaluationAt = Math.max(lastEvaluationAt ?? assessment.evaluatedAt, assessment.evaluatedAt);
  }
  return Object.freeze({
    strategyVersion: input.strategyVersion,
    evaluatedTraders: latest.size,
    eligibleTraders: eligible?.size ?? null,
    coverage: eligible === null || eligible.size === 0 ? null : latest.size / eligible.size,
    states: Object.freeze(states),
    lastEvaluationAt,
  });
}
