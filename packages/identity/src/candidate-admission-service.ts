import {
  CANDIDATE_ADMISSION_WINDOW_MS,
  evaluateCandidateAdmission,
  evidenceAdmissionClass,
  type CandidateEvidenceType,
} from "@address-radar/scoring"
import type { AddressRadarRepository, CandidateDiscoveryInput } from "@address-radar/database"

interface ParsedCandidateEvidence {
  discovery: CandidateDiscoveryInput
  discoveryType: CandidateEvidenceType
  tokenKey: string
  tierRank: number
}

const parseEvidence = (discovery: CandidateDiscoveryInput): ParsedCandidateEvidence | null => {
  try {
    const payload = JSON.parse(discovery.payload) as Record<string, unknown>
    const chain = typeof payload.chain === "string" ? payload.chain.trim().toLowerCase() : ""
    const tokenAddress = typeof payload.tokenAddress === "string" ? payload.tokenAddress.trim() : ""
    const tierRank = typeof payload.tierRank === "number" && Number.isFinite(payload.tierRank)
      ? payload.tierRank
      : 0
    if (!chain || !tokenAddress || tierRank <= 0) return null
    const discoveryType = discovery.discoveryType as CandidateEvidenceType
    evidenceAdmissionClass(discoveryType)
    const normalizedAddress = chain === "solana" ? tokenAddress : tokenAddress.toLowerCase()
    return { discovery, discoveryType, tokenKey: `${chain}:${normalizedAddress}`, tierRank }
  } catch {
    return null
  }
}

export const strongestCandidateEvidenceByToken = (
  discoveries: readonly CandidateDiscoveryInput[],
): readonly ParsedCandidateEvidence[] => {
  const strongestByToken = new Map<string, ParsedCandidateEvidence>()
  for (const discovery of discoveries) {
    const evidence = parseEvidence(discovery)
    if (!evidence) continue
    const current = strongestByToken.get(evidence.tokenKey)
    if (!current
      || evidence.tierRank > current.tierRank
      || (evidence.tierRank === current.tierRank && discovery.discoveredAt > current.discovery.discoveredAt)) {
      strongestByToken.set(evidence.tokenKey, evidence)
    }
  }
  return Object.freeze([...strongestByToken.values()].sort(
    (left, right) => right.tierRank - left.tierRank || left.tokenKey.localeCompare(right.tokenKey),
  ))
}

export const createCandidateAdmissionService = (input: { readonly repository: AddressRadarRepository }) => ({
  evaluate(request: { readonly accountId: string; readonly observedAt: number }) {
    const evidence = strongestCandidateEvidenceByToken(
      input.repository.candidateDiscoveries(request.accountId),
    )
    const snapshot = evaluateCandidateAdmission(evidence.map(item => ({
      tokenKey: item.tokenKey,
      evidenceType: item.discoveryType,
      evidenceAt: item.discovery.discoveredAt,
    })), request.observedAt)
    const admitted = snapshot.currentAdmission

    if (admitted) {
      input.repository.activateDiscoveredCandidate(request.accountId, request.observedAt)
      const strongest = evidence.find(item => (
        item.discovery.discoveredAt >= request.observedAt - CANDIDATE_ADMISSION_WINDOW_MS
        && item.discovery.discoveredAt <= request.observedAt
      ))
      const account = input.repository.account(request.accountId)
      if (strongest && account) {
        input.repository.enqueueIdentityResolution({
          handle: account.handle,
          accountId: request.accountId,
          priority: Math.min(100, 85 + strongest.tierRank),
          reason: strongest.discoveryType,
          observedAt: request.observedAt,
        })
      }
    }

    return Object.freeze({
      admitted,
      distinctTokenCount: evidence.length,
      earlyTokenCount: snapshot.earlyDistinctTokenCount,
      strongTokenCount: snapshot.strongDistinctTokenCount,
      strongestEvidenceType: evidence[0]?.discoveryType ?? null,
      historicalCapability: snapshot.historicalCapability,
      status: snapshot.status,
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
    })
  },
})
