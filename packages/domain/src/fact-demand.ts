export type FactDemandPurpose = "positive_hit" | "complete_range";

export interface FactDemandProof {
  readonly executionRevision?: number;
  readonly kind: FactDemandPurpose;
  readonly from: number;
  readonly to: number;
  readonly knownAt: number;
  readonly reference: string;
  readonly maximumMultiple?: number;
}

export interface ConsumerFactDemand {
  readonly executionRevision?: number;
  readonly demandId: string;
  readonly consumerId: string;
  readonly purchaseId: string;
  readonly tokenId: string;
  readonly strategyVersion: string;
  readonly purpose: FactDemandPurpose;
  readonly requiredFrom: number;
  readonly requiredTo: number;
  readonly evaluatedAt: number;
  readonly reasonCode: string;
  readonly proof: FactDemandProof | null;
}

export function satisfiesFactDemand(demand: ConsumerFactDemand, proof = demand.proof): boolean {
  if (!proof || proof.kind !== demand.purpose || !proof.reference.trim()
    || !validTime(demand.executionRevision ?? 0) || !validTime(proof.executionRevision ?? 0)
    || (proof.executionRevision ?? 0) !== (demand.executionRevision ?? 0)
    || !validTime(proof.from) || !validTime(proof.to) || !validTime(proof.knownAt)
    || proof.to < proof.from || proof.knownAt < proof.to || proof.knownAt > demand.evaluatedAt) return false;
  if (demand.purpose === "complete_range") {
    return demand.requiredTo > demand.requiredFrom && proof.from <= demand.requiredFrom && proof.to >= demand.requiredTo;
  }
  return proof.from >= demand.requiredFrom && proof.to <= demand.requiredTo
    && Number.isFinite(proof.maximumMultiple) && proof.maximumMultiple! >= 3;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
