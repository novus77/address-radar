import { addressRadarBroadcastId, addressRadarTokenId } from "@address-radar/domain";
import type { AddressRadarRepository } from "@address-radar/database";
import type { AddressSignalEvidence } from "@address-radar/aggregation";
import { evaluateTokenSignal, type TokenSignalDecision } from "./policy.js";

export interface SignalCandidate {
  readonly signalId: string;
  readonly idempotencyKey: string;
  readonly action: "new" | "update";
  readonly category: "new_token_discovery" | "old_token_momentum";
  readonly token: { readonly chain: string; readonly contractAddress: string };
  readonly broadcastSequence: number;
  readonly score: number;
  readonly confidence: number;
  readonly triggeredAt: number;
  readonly evidenceIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface TraderAbilityProjection {
  readonly adjustedQuality: number;
  readonly styles: Readonly<Record<string, number>>;
}

export interface TokenSignalEvaluation {
  readonly decision: TokenSignalDecision;
  readonly shadowDecision: TokenSignalDecision | null;
  readonly candidate: SignalCandidate | null;
}

export interface TokenSignalServiceOptions {
  readonly repository: AddressRadarRepository;
  readonly threshold: number;
  readonly minimumTotalBuyUsd?: number | undefined;
  readonly strategyVersion: string;
  readonly now?: () => number;
  readonly traderAbilityMode?: "disabled" | "shadow" | "active";
  readonly traderAbility?: (entityId: string) => TraderAbilityProjection | null;
}

export class TokenSignalService {
  private readonly now: () => number;

  constructor(private readonly options: TokenSignalServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  evaluate(chain: string, tokenAddress: string, evidence: readonly AddressSignalEvidence[]): TokenSignalEvaluation {
    const previous = this.options.repository.tokenAggregationState(chain, tokenAddress);
    const previousDecision = previous && {
      broadcastCount: previous.broadcastCount,
      consumedEvidenceIds: previous.consumedEvidenceIds,
    };
    const abilityEvidence = enrichWithTraderAbility(evidence, this.options.traderAbility);
    const mode = this.options.traderAbilityMode ?? "disabled";
    const decision = evaluateTokenSignal({
      previous: previousDecision,
      threshold: this.options.threshold,
      minimumTotalBuyUsd: this.options.minimumTotalBuyUsd,
      evidence: mode === "active" ? abilityEvidence : evidence,
    });
    const shadowDecision = mode === "shadow" ? evaluateTokenSignal({
      previous: previousDecision,
      threshold: this.options.threshold,
      minimumTotalBuyUsd: this.options.minimumTotalBuyUsd,
      evidence: abilityEvidence,
    }) : null;
    const evaluatedAt = this.now();

    if (decision.action === "observe") {
      this.saveEvaluation(chain, tokenAddress, decision, evaluatedAt);
      return Object.freeze({ decision, shadowDecision, candidate: null });
    }

    const tokenId = addressRadarTokenId(chain, tokenAddress);
    const candidate: SignalCandidate = Object.freeze({
      signalId: tokenId,
      idempotencyKey: addressRadarBroadcastId(tokenId, decision.broadcastNumber),
      action: decision.action === "broadcast" ? "new" : "update",
      category: decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "new_token_discovery" : "old_token_momentum",
      token: Object.freeze({ chain: chain.toLowerCase(), contractAddress: tokenAddress }),
      broadcastSequence: decision.broadcastNumber,
      score: decision.score,
      confidence: decision.score,
      triggeredAt: evaluatedAt,
      evidenceIds: decision.consumeEvidenceIds,
      reasonCodes: Object.freeze([
        decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "concurrent_qualified_entries" : "qualified_old_token_anomaly",
      ]),
    });
    const committed = this.options.repository.commitTokenBroadcast({
      chain,
      tokenAddress,
      expectedPreviousBroadcastCount: previous?.broadcastCount ?? 0,
      strategyVersion: this.options.strategyVersion,
      score: decision.score,
      triggeredAt: evaluatedAt,
      evidenceIds: decision.consumeEvidenceIds,
      payload: candidate,
    });

    if (!committed.inserted) {
      const concurrentDecision: TokenSignalDecision = Object.freeze({
        ...decision,
        action: "observe",
        broadcastNumber: committed.broadcastNumber,
        consumeEvidenceIds: Object.freeze([]),
        missingConditions: Object.freeze(["concurrent_evaluation"]),
      });
      this.saveEvaluation(chain, tokenAddress, concurrentDecision, evaluatedAt);
      return Object.freeze({ decision: concurrentDecision, shadowDecision, candidate: null });
    }

    this.saveEvaluation(chain, tokenAddress, decision, evaluatedAt);
    return Object.freeze({ decision, shadowDecision, candidate });
  }

  private saveEvaluation(chain: string, tokenAddress: string, decision: TokenSignalDecision, updatedAt: number): void {
    this.options.repository.saveTokenEvaluation({
      chain,
      tokenAddress,
      action: decision.action,
      signalFamily: decision.signalFamily,
      lifecycleStage: decision.lifecycleStage,
      score: decision.score,
      participantCount: decision.participantCount,
      totalBuyUsd: decision.totalBuyUsd,
      sourceState: decision.sourceState,
      windowMs: decision.windowMs,
      missingConditions: decision.missingConditions,
      updatedAt,
    });
  }
}

export const createTokenSignalService = (options: TokenSignalServiceOptions): TokenSignalService =>
  new TokenSignalService(options);

function enrichWithTraderAbility(
  evidence: readonly AddressSignalEvidence[],
  resolveAbility: TokenSignalServiceOptions["traderAbility"],
): readonly AddressSignalEvidence[] {
  if (!resolveAbility) return evidence;
  return Object.freeze(evidence.map(item => {
    const ability = resolveAbility(item.entityId);
    if (!ability) return item;
    const abilityTags = Object.entries(ability.styles)
      .filter(([, score]) => Number.isFinite(score) && score >= 0.6)
      .map(([style]) => style);
    return Object.freeze({
      ...item,
      contribution: Math.max(item.contribution, Math.max(0, Math.min(1, ability.adjustedQuality))),
      traderTags: Object.freeze([...new Set([...(item.traderTags ?? []), ...abilityTags])]),
    });
  }));
}
