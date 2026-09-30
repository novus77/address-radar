import {
  evaluateCandidateAdmission,
  evidenceAdmissionClass,
  type CandidateEvidenceType,
} from "@address-radar/scoring";

export type CandidateDiscoverySource = "leaderboard_30d" | "manual" | "wallet" | "fomo" | "milestone" | "runtime" | "shared_holding";

export interface MultiSourceCandidateObservation {
  readonly identityKey: string;
  readonly identityKind?: "wallet" | "fomo";
  readonly source: CandidateDiscoverySource;
  readonly tokenId?: string;
  readonly evidenceType?: CandidateEvidenceType;
  readonly sourceStatus?: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN";
  readonly observedAt: number;
  readonly bundleKey?: string | null;
  readonly independentlyPositive?: boolean;
}

export interface MultiSourceCandidateResult {
  readonly traderId: string;
  readonly admitted: boolean;
  readonly admissionReason: "trusted_observation" | "candidate_policy";
  readonly distinctTokenCount: number;
  readonly earlyTokenCount: number;
  readonly strongTokenCount: number;
  readonly strongestEvidenceType: CandidateEvidenceType | null;
  readonly sources: readonly CandidateDiscoverySource[];
}

const EVIDENCE_RANK: Readonly<Record<CandidateEvidenceType, number>> = Object.freeze({
  market_cap_100k_3x: 1,
  market_cap_100k_5x: 2,
  market_cap_200k_3x: 3,
  market_cap_200k_5x: 4,
  market_cap_300k_5x: 5,
  market_cap_500k_5x: 6,
  market_cap_500k_10x: 7,
  market_cap_1m_10x: 8,
  market_cap_1m_20x: 9,
});

const trustedSource = (source: CandidateDiscoverySource): boolean => source === "leaderboard_30d" || source === "manual";

export function createMultiSourceCandidateDiscovery(input: {
  readonly resolveCanonicalTraderId: (identityKey: string, identityKind?: "wallet" | "fomo") => string | null;
  readonly requestIdentityResolution?: (identityKey: string) => void;
}) {
  return Object.freeze({
    evaluate(observations: readonly MultiSourceCandidateObservation[], evaluatedAt: number): readonly MultiSourceCandidateResult[] {
      const unresolved = new Set<string>();
      const byTrader = new Map<string, MultiSourceCandidateObservation[]>();
      for (const observation of observations) {
        const identityKey = observation.identityKey.trim();
        if (!identityKey) continue;
        const canonical = input.resolveCanonicalTraderId(identityKey, observation.identityKind);
        const traderId = canonical ?? `${observation.identityKind ?? (observation.source === "fomo" ? "fomo" : "wallet")}:${identityKey}`;
        if (!canonical && !unresolved.has(identityKey)) {
          unresolved.add(identityKey);
          input.requestIdentityResolution?.(identityKey);
        }
        byTrader.set(traderId, [...(byTrader.get(traderId) ?? []), { ...observation, identityKey }]);
      }

      const results: MultiSourceCandidateResult[] = [];
      for (const [traderId, rows] of byTrader) {
        const sources = Object.freeze([...new Set(rows.map(row => row.source))].sort());
        if (rows.some(row => trustedSource(row.source))) {
          results.push(Object.freeze({ traderId, admitted: true, admissionReason: "trusted_observation", distinctTokenCount: 0, earlyTokenCount: 0, strongTokenCount: 0, strongestEvidenceType: null, sources }));
          continue;
        }

        const shared = rows.filter(row => row.source === "shared_holding" && row.tokenId && row.evidenceType);
        const sharedTokens = new Set(shared.map(row => row.tokenId));
        const sharedEligible = sharedTokens.size >= 2 && shared.some(row => row.independentlyPositive === true);
        const eligibleRows = rows.filter(row => row.source !== "shared_holding" || sharedEligible);

        const strongestByToken = new Map<string, MultiSourceCandidateObservation>();
        const bundleTokenKeys = new Set<string>();
        for (const row of eligibleRows) {
          if (!row.tokenId || !row.evidenceType) continue;
          const bundleTokenKey = row.bundleKey ? `${row.bundleKey}:${row.tokenId}` : null;
          if (bundleTokenKey && bundleTokenKeys.has(bundleTokenKey)) continue;
          if (bundleTokenKey) bundleTokenKeys.add(bundleTokenKey);
          const current = strongestByToken.get(row.tokenId);
          if (!current || EVIDENCE_RANK[row.evidenceType] > EVIDENCE_RANK[current.evidenceType!]
            || (EVIDENCE_RANK[row.evidenceType] === EVIDENCE_RANK[current.evidenceType!] && row.observedAt > current.observedAt)) {
            strongestByToken.set(row.tokenId, row);
          }
        }
        if (strongestByToken.size === 0) continue;

        const evidence = [...strongestByToken.entries()].map(([tokenKey, row]) => ({ tokenKey, evidenceType: row.evidenceType!, evidenceAt: row.observedAt }));
        const snapshot = evaluateCandidateAdmission(evidence, evaluatedAt);
        const strongest = [...strongestByToken.values()].sort((left, right) => EVIDENCE_RANK[right.evidenceType!] - EVIDENCE_RANK[left.evidenceType!])[0]!;
        results.push(Object.freeze({
          traderId,
          admitted: snapshot.currentAdmission,
          admissionReason: "candidate_policy",
          distinctTokenCount: strongestByToken.size,
          earlyTokenCount: snapshot.earlyDistinctTokenCount,
          strongTokenCount: snapshot.strongDistinctTokenCount,
          strongestEvidenceType: strongest.evidenceType!,
          sources,
        }));
      }
      return Object.freeze(results.sort((left, right) => left.traderId.localeCompare(right.traderId)));
    },
  });
}
