import { addressRadarBroadcastId, addressRadarTokenId } from "@address-radar/domain";
import {
  createTokenAggregationService,
  type AddressSignalEvidence,
  type TokenAggregationRepository,
  type AggregationDecision,
} from "@address-radar/aggregation";
import { evaluateTokenSignal, type TokenSignalDecision } from "./policy.js";

export interface RadarSignalV1 {
  readonly schemaVersion: "1";
  readonly signalId: string;
  readonly idempotencyKey: string;
  readonly action: "new" | "update";
  readonly token: { readonly chain: string; readonly contractAddress: string; readonly symbol: string | null; readonly name: string | null; readonly imageUrl: string | null };
  readonly category: "new_token_discovery" | "old_token_momentum";
  readonly broadcastSequence: number;
  readonly score: number;
  readonly confidence: number;
  readonly lifecycleStage: string;
  readonly windowMs: number;
  readonly marketCapUsd: number | null;
  readonly priceUsd: number | null;
  readonly triggeredAt: string;
  readonly expiresAt: string;
  readonly display: { readonly title: string; readonly summary: string; readonly reasonCodes: readonly string[] };
  readonly evidenceSummary: { readonly participantCount: number; readonly totalBuyUsd: number; readonly maxSingleBuyUsd: number; readonly sourceState: string; readonly entityIds: readonly string[]; readonly evidenceIds: readonly string[] };
}
export type SignalCandidate = RadarSignalV1;
export interface TokenSignalMetadata { readonly symbol: string | null; readonly name: string | null; readonly imageUrl: string | null; readonly marketCapUsd: number | null; readonly priceUsd: number | null }
export interface TokenSignalEvaluation { readonly decision: TokenSignalDecision; readonly shadowDecision: null; readonly candidate: RadarSignalV1 | null }
export interface TokenSignalServiceOptions { readonly repository: TokenAggregationRepository; readonly threshold: number; readonly minimumTotalBuyUsd?: number | undefined; readonly strategyVersion: string; readonly now?: () => number }

export function createTokenSignalService(options: TokenSignalServiceOptions) {
  const service = createTokenAggregationService<RadarSignalV1>({
    repository: options.repository,
    threshold: options.threshold,
    minimumTotalBuyUsd: options.minimumTotalBuyUsd,
    strategyVersion: options.strategyVersion,
    now: options.now ?? Date.now,
    evaluate: evaluateTokenSignal as (input: Parameters<typeof evaluateTokenSignal>[0]) => AggregationDecision,
    createCandidate({ chain, tokenAddress, decision, evidence, triggeredAt, metadata }) {
      const facts = (metadata ?? {}) as Partial<TokenSignalMetadata>;
      const tokenId = addressRadarTokenId(chain, tokenAddress);
      const reasonCodes = [decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "concurrent_qualified_entries" : "qualified_old_token_anomaly"];
      return Object.freeze({
        schemaVersion: "1" as const,
        signalId: tokenId,
        idempotencyKey: addressRadarBroadcastId(tokenId, decision.broadcastNumber),
        action: decision.action === "broadcast" ? "new" as const : "update" as const,
        token: Object.freeze({ chain: chain.toLowerCase(), contractAddress: tokenAddress, symbol: facts.symbol ?? null, name: facts.name ?? null, imageUrl: facts.imageUrl ?? null }),
        category: decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "new_token_discovery" as const : "old_token_momentum" as const,
        broadcastSequence: decision.broadcastNumber,
        score: decision.score,
        confidence: decision.score,
        lifecycleStage: decision.lifecycleStage,
        windowMs: decision.windowMs,
        marketCapUsd: facts.marketCapUsd ?? null,
        priceUsd: facts.priceUsd ?? null,
        triggeredAt: new Date(triggeredAt).toISOString(),
        expiresAt: new Date(triggeredAt + decision.windowMs).toISOString(),
        display: Object.freeze({ title: decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "New token discovery" : "Old token momentum", summary: `${decision.participantCount} qualified traders, $${decision.totalBuyUsd.toFixed(0)} buys`, reasonCodes: Object.freeze(reasonCodes) }),
        evidenceSummary: Object.freeze({ participantCount: decision.participantCount, totalBuyUsd: decision.totalBuyUsd, maxSingleBuyUsd: decision.maxSingleBuyUsd, sourceState: decision.sourceState, entityIds: Object.freeze([...new Set(evidence.filter(item => decision.consumeEvidenceIds.includes(item.eventId)).map(item => item.entityId))]), evidenceIds: decision.consumeEvidenceIds }),
      });
    },
  });
  return Object.freeze({
    evaluate(chain: string, tokenAddress: string, evidence: readonly AddressSignalEvidence[], metadata?: TokenSignalMetadata): TokenSignalEvaluation {
      const result = service.evaluate(chain, tokenAddress, evidence, metadata as unknown as Readonly<Record<string, unknown>> | undefined);
      return Object.freeze({ decision: result.decision as TokenSignalDecision, shadowDecision: null, candidate: result.candidate });
    },
  });
}
