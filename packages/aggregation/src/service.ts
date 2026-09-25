import type { AddressSignalEvidence } from "./evidence.js";
import type { TokenAggregationRepository } from "./repository.js";
import { applyWalletBundleGroups, detectTemporalBundlePairs } from "./bundle.js";

export const DEGRADED_TRADER_DISCOUNT = 0.7;

export interface AggregationDecision {
  readonly action: "observe" | "broadcast" | "rebroadcast";
  readonly score: number; readonly broadcastNumber: number; readonly consumeEvidenceIds: readonly string[];
  readonly signalFamily: "NEW_TOKEN_DISCOVERY" | "OLD_TOKEN_MOVEMENT" | null;
  readonly lifecycleStage: string; readonly windowMs: number; readonly participantCount: number;
  readonly totalBuyUsd: number; readonly maxSingleBuyUsd: number; readonly sourceState: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN" | "UNKNOWN";
  readonly missingConditions: readonly string[];
  readonly bundleDiagnostics: import("./evidence.js").BundleDiagnostics;
}

export function createTokenAggregationService<TCandidate>(input: {
  readonly repository: TokenAggregationRepository;
  readonly threshold: number;
  readonly minimumTotalBuyUsd?: number | undefined;
  readonly strategyVersion: string;
  readonly now: () => number;
  readonly evaluate: (input: { previous: TokenAggregationStateLike | null; threshold: number; minimumTotalBuyUsd?: number | undefined; evidence: readonly AddressSignalEvidence[] }) => AggregationDecision;
  readonly createCandidate: (input: { chain: string; tokenAddress: string; decision: AggregationDecision; evidence: readonly AddressSignalEvidence[]; triggeredAt: number; metadata?: Readonly<Record<string, unknown>> }) => TCandidate;
  readonly publicSignal: (candidate: TCandidate) => unknown;
}) {
  return Object.freeze({
    evaluate(chain: string, tokenAddress: string, evidence: readonly AddressSignalEvidence[], metadata?: Readonly<Record<string, unknown>>) {
      const previous = input.repository.tokenAggregationState(chain, tokenAddress);
      const eligible = evidence.flatMap(item => {
        const profile = input.repository.traderSignalProfile(item.entityId);
        const sourceEnabled = item.source === "onchain" ? profile?.onchainMonitoringEnabled : profile?.fomoMonitoringEnabled;
        if (!profile?.mapped || !profile.monitoringEnabled || !sourceEnabled || !["active", "elite", "degraded"].includes(profile.lifecycle)) return [];
        return [{ ...item, contribution: item.contribution * (profile.lifecycle === "degraded" ? DEGRADED_TRADER_DISCOUNT : 1), traderLifecycle: profile.lifecycle as "active" | "elite" | "degraded" }];
      });
      const temporalPairs = detectTemporalBundlePairs(eligible);
      input.repository.recordWalletBundlePairs?.(chain, tokenAddress, temporalPairs);
      const relations = input.repository.walletBundleRelations?.([...new Set(eligible.map(item => item.entityId))]) ?? [];
      const independentEvidence = applyWalletBundleGroups({ evidence: eligible, temporalPairs, relations });
      const decision = input.evaluate({ previous, threshold: input.threshold, minimumTotalBuyUsd: input.minimumTotalBuyUsd, evidence: independentEvidence });
      const at = input.now();
      if (decision.action === "observe") {
        save(input.repository, chain, tokenAddress, decision, at);
        return Object.freeze({ decision, candidate: null });
      }
      const candidate = input.createCandidate({ chain, tokenAddress, decision, evidence: independentEvidence, triggeredAt: at, ...(metadata ? { metadata } : {}) });
      const selected = independentEvidence.filter(item => decision.consumeEvidenceIds.includes(item.eventId));
      const economicKeys = [...new Set(selected.map(item => item.dedupeKey ?? item.eventId))];
      const evaluation = evaluationInput(chain, tokenAddress, decision, at);
      const committed = input.repository.commitTokenBroadcast({ chain, tokenAddress, expectedPreviousBroadcastCount: previous?.broadcastCount ?? 0, strategyVersion: input.strategyVersion, score: decision.score, triggeredAt: at, evidenceIds: decision.consumeEvidenceIds, economicKeys, evaluation, payload: candidate, publicSignal: input.publicSignal(candidate) });
      if (!committed.inserted) return Object.freeze({ decision: { ...decision, action: "observe" as const, broadcastNumber: committed.broadcastNumber, consumeEvidenceIds: [] }, candidate: null });
      return Object.freeze({ decision, candidate });
    },
  });
}

interface TokenAggregationStateLike { readonly broadcastCount: number; readonly consumedEvidenceIds: readonly string[]; readonly consumedEconomicKeys?: readonly string[] }
function save(repository: TokenAggregationRepository, chain: string, tokenAddress: string, decision: AggregationDecision, updatedAt: number): void {
  repository.saveTokenEvaluation(evaluationInput(chain, tokenAddress, decision, updatedAt));
}
const evaluationInput = (chain: string, tokenAddress: string, decision: AggregationDecision, updatedAt: number) => ({ chain, tokenAddress, action: decision.action, signalFamily: decision.signalFamily, lifecycleStage: decision.lifecycleStage, score: decision.score, participantCount: decision.participantCount, totalBuyUsd: decision.totalBuyUsd, sourceState: decision.sourceState, windowMs: decision.windowMs, missingConditions: decision.missingConditions, bundleDiagnostics: decision.bundleDiagnostics, updatedAt });
