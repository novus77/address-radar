export type CandidateEvidenceType =
  | "market_cap_100k_3x"
  | "market_cap_100k_5x"
  | "market_cap_200k_3x"
  | "market_cap_200k_5x"
  | "market_cap_300k_5x"
  | "market_cap_500k_5x"
  | "market_cap_500k_10x"
  | "market_cap_1m_10x"
  | "market_cap_1m_20x"

export type CandidateEvidenceAdmissionClass = "early" | "strong"

export const CANDIDATE_MILESTONE_STRATEGY_VERSION = "candidate-milestone-v2-tiered"

export interface CandidateEvidenceTier {
  type: CandidateEvidenceType
  label: string
  minimumMultiple: number
  rank: number
  admissionClass: CandidateEvidenceAdmissionClass
}

export interface CandidateMilestoneDefinition {
  marketCapUsd: number
  tiers: readonly CandidateEvidenceTier[]
}

export const CANDIDATE_MILESTONES: readonly CandidateMilestoneDefinition[] = [
  {
    marketCapUsd: 100_000,
    tiers: [
      {
        type: "market_cap_100k_3x",
        label: "100K / 3x",
        minimumMultiple: 3,
        rank: 1,
        admissionClass: "early",
      },
      {
        type: "market_cap_100k_5x",
        label: "100K / 5x",
        minimumMultiple: 5,
        rank: 2,
        admissionClass: "early",
      },
    ],
  },
  {
    marketCapUsd: 200_000,
    tiers: [
      {
        type: "market_cap_200k_3x",
        label: "200K / 3x",
        minimumMultiple: 3,
        rank: 3,
        admissionClass: "early",
      },
      {
        type: "market_cap_200k_5x",
        label: "200K / 5x",
        minimumMultiple: 5,
        rank: 4,
        admissionClass: "early",
      },
    ],
  },
  {
    marketCapUsd: 300_000,
    tiers: [
      {
        type: "market_cap_300k_5x",
        label: "300K / 5x",
        minimumMultiple: 5,
        rank: 5,
        admissionClass: "strong",
      },
    ],
  },
  {
    marketCapUsd: 500_000,
    tiers: [
      {
        type: "market_cap_500k_5x",
        label: "500K / 5x",
        minimumMultiple: 5,
        rank: 6,
        admissionClass: "strong",
      },
      {
        type: "market_cap_500k_10x",
        label: "500K / 10x",
        minimumMultiple: 10,
        rank: 7,
        admissionClass: "strong",
      },
    ],
  },
  {
    marketCapUsd: 1_000_000,
    tiers: [
      {
        type: "market_cap_1m_10x",
        label: "1M / 10x",
        minimumMultiple: 10,
        rank: 8,
        admissionClass: "strong",
      },
      {
        type: "market_cap_1m_20x",
        label: "1M / 20x",
        minimumMultiple: 20,
        rank: 9,
        admissionClass: "strong",
      },
    ],
  },
]

const evidenceTiers = CANDIDATE_MILESTONES.flatMap((milestone) => milestone.tiers)

const evidenceTierByType = new Map<CandidateEvidenceType, CandidateEvidenceTier>(
  evidenceTiers.map((tier) => [tier.type, tier]),
)

export function strongestSatisfiedTier(
  milestoneMarketCapUsd: number,
  opportunityMultiple: number,
): CandidateEvidenceTier | null {
  const milestone = CANDIDATE_MILESTONES.find(
    (definition) => definition.marketCapUsd === milestoneMarketCapUsd,
  )
  if (!milestone) {
    return null
  }

  return (
    [...milestone.tiers]
      .sort((left, right) => right.minimumMultiple - left.minimumMultiple)
      .find((tier) => opportunityMultiple >= tier.minimumMultiple) ?? null
  )
}

export function evidenceAdmissionClass(
  type: CandidateEvidenceType,
): CandidateEvidenceAdmissionClass {
  const tier = evidenceTierByType.get(type)
  if (!tier) {
    throw new Error(`Unsupported candidate evidence type: ${type}`)
  }
  return tier.admissionClass
}

export function isCandidateEvidenceType(type: string): type is CandidateEvidenceType {
  return evidenceTierByType.has(type as CandidateEvidenceType)
}
