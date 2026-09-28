import type { CandidateEvidenceV3 } from "@address-radar/domain";
import type { DatabaseSync } from "node:sqlite";

import {
  createCandidateHistoryStore,
  type CandidateEvidenceWriteResult,
} from "./candidate-history-store.js";

export interface AddressRadarWritePort {
  saveCandidateEvidence(evidence: CandidateEvidenceV3): CandidateEvidenceWriteResult;
}

export function createSqliteAddressRadarWritePort(database: DatabaseSync): AddressRadarWritePort {
  const candidateHistory = createCandidateHistoryStore(database);
  return Object.freeze({
    saveCandidateEvidence(evidence: CandidateEvidenceV3): CandidateEvidenceWriteResult {
      return candidateHistory.saveEvidence(evidence);
    },
  });
}
