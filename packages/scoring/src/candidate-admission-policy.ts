import {
  evidenceAdmissionClass,
  type CandidateEvidenceAdmissionClass,
  type CandidateEvidenceType,
} from "./candidate-tier-policy.js";

export const CANDIDATE_ADMISSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CandidateEvidenceFact {
  readonly tokenKey: string;
  readonly evidenceType: CandidateEvidenceType;
  readonly evidenceAt: number;
}

export type CandidateAdmissionStatus =
  | "no_evidence"
  | "awaiting_second_early_token"
  | "awaiting_recent_confirmation"
  | "current_admitted";

export interface CandidateAdmissionSnapshot {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly earlyDistinctTokenCount: number;
  readonly strongDistinctTokenCount: number;
  readonly historicalDistinctTokenCount: number;
  readonly currentAdmission: boolean;
  readonly historicalCapability: boolean;
  readonly status: CandidateAdmissionStatus;
  readonly reasonCodes: readonly string[];
}

function strongestClassByToken(
  evidence: readonly CandidateEvidenceFact[],
): ReadonlyMap<string, CandidateEvidenceAdmissionClass> {
  const classes = new Map<string, CandidateEvidenceAdmissionClass>();
  for (const fact of evidence) {
    const current = classes.get(fact.tokenKey);
    const next = evidenceAdmissionClass(fact.evidenceType);
    if (current !== "strong" || next === "strong") classes.set(fact.tokenKey, next);
  }
  return classes;
}

export function evaluateCandidateAdmission(
  evidence: readonly CandidateEvidenceFact[],
  evaluatedAt: number,
): CandidateAdmissionSnapshot {
  const windowStart = evaluatedAt - CANDIDATE_ADMISSION_WINDOW_MS;
  const historicalEvidence = evidence.filter(fact => fact.evidenceAt <= evaluatedAt);
  const currentEvidence = historicalEvidence.filter(fact => fact.evidenceAt >= windowStart);
  const historicalDistinctTokenCount = strongestClassByToken(historicalEvidence).size;
  const currentClasses = strongestClassByToken(currentEvidence);
  let earlyDistinctTokenCount = 0;
  let strongDistinctTokenCount = 0;
  for (const admissionClass of currentClasses.values()) {
    if (admissionClass === "strong") strongDistinctTokenCount += 1;
    else earlyDistinctTokenCount += 1;
  }

  const currentAdmission = strongDistinctTokenCount >= 1 || earlyDistinctTokenCount >= 2;
  const historicalCapability = historicalDistinctTokenCount > 0;
  const status: CandidateAdmissionStatus = currentAdmission
    ? "current_admitted"
    : earlyDistinctTokenCount === 1
      ? "awaiting_second_early_token"
      : historicalCapability
        ? "awaiting_recent_confirmation"
        : "no_evidence";
  const reasonCodes = currentAdmission
    ? [strongDistinctTokenCount > 0 ? "strong_evidence_in_30d" : "two_early_tokens_in_30d"]
    : status === "awaiting_second_early_token"
      ? ["only_one_early_token"]
      : status === "awaiting_recent_confirmation"
        ? ["evidence_outside_30d_window"]
        : ["candidate_evidence_missing"];

  return Object.freeze({
    windowStart,
    windowEnd: evaluatedAt,
    earlyDistinctTokenCount,
    strongDistinctTokenCount,
    historicalDistinctTokenCount,
    currentAdmission,
    historicalCapability,
    status,
    reasonCodes: Object.freeze(reasonCodes),
  });
}
