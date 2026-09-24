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
  readonly token: { readonly chain: string; readonly contractAddress: string; readonly symbol: string | null; readonly name: string | null; readonly imageUrl: string | null };
  readonly category: "new_token_discovery" | "old_token_momentum";
  readonly broadcastSequence: number;
  readonly score: number;
  readonly confidence: number;
  readonly marketCapUsd: number | null;
  readonly priceUsd: number | null;
  readonly triggeredAt: string;
  readonly expiresAt: string;
  readonly display: { readonly title: string; readonly summary: string; readonly reasonCodes: readonly string[] };
}
export type SignalCandidate = RadarSignalV1;
export interface TokenSignalMetadata { readonly symbol: string | null; readonly name: string | null; readonly imageUrl: string | null; readonly marketCapUsd: number | null; readonly priceUsd: number | null }
export interface TokenSignalEvaluation { readonly decision: TokenSignalDecision; readonly shadowDecision: null; readonly candidate: RadarSignalV1 | null }
export interface TokenSignalServiceOptions { readonly repository: TokenAggregationRepository; readonly threshold: number; readonly minimumTotalBuyUsd?: number | undefined; readonly strategyVersion: string; readonly now?: () => number }

interface PersistedSignalEnvelopeV1 {
  readonly kind: "radar_signal_evaluation";
  readonly version: 1;
  readonly publicSignal: RadarSignalV1;
  readonly audit: {
    readonly action: "new" | "update";
    readonly lifecycleStage: string;
    readonly windowMs: number;
    readonly participantCount: number;
    readonly totalBuyUsd: number;
    readonly maxSingleBuyUsd: number;
    readonly sourceState: string;
    readonly entityIds: readonly string[];
    readonly evidenceIds: readonly string[];
  };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};
const finiteNullable = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));
const iso = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

export function replayRadarSignalV1(payload: unknown): RadarSignalV1 {
  let decoded = payload;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded) as unknown; } catch { throw new Error("Corrupt RadarSignalV1 replay payload"); }
  }
  if (!record(decoded) || decoded.kind !== "radar_signal_evaluation" || decoded.version !== 1 || !record(decoded.publicSignal)) throw new Error("Corrupt RadarSignalV1 replay envelope");
  const signal = decoded.publicSignal;
  if (!exactKeys(signal, ["schemaVersion", "signalId", "idempotencyKey", "token", "category", "broadcastSequence", "score", "confidence", "marketCapUsd", "priceUsd", "triggeredAt", "expiresAt", "display"]) || signal.schemaVersion !== "1" || typeof signal.signalId !== "string" || typeof signal.idempotencyKey !== "string") throw new Error("Corrupt RadarSignalV1 public contract");
  if (!record(signal.token) || !exactKeys(signal.token, ["chain", "contractAddress", "symbol", "name", "imageUrl"]) || typeof signal.token.chain !== "string" || typeof signal.token.contractAddress !== "string" || ![signal.token.symbol, signal.token.name, signal.token.imageUrl].every(value => value === null || typeof value === "string")) throw new Error("Corrupt RadarSignalV1 token");
  if (signal.category !== "new_token_discovery" && signal.category !== "old_token_momentum") throw new Error("Corrupt RadarSignalV1 category");
  if (!Number.isSafeInteger(signal.broadcastSequence) || (signal.broadcastSequence as number) < 1 || typeof signal.score !== "number" || !Number.isFinite(signal.score) || typeof signal.confidence !== "number" || !Number.isFinite(signal.confidence) || !finiteNullable(signal.marketCapUsd) || !finiteNullable(signal.priceUsd) || !iso(signal.triggeredAt) || !iso(signal.expiresAt)) throw new Error("Corrupt RadarSignalV1 values");
  if (!record(signal.display) || !exactKeys(signal.display, ["title", "summary", "reasonCodes"]) || typeof signal.display.title !== "string" || typeof signal.display.summary !== "string" || !Array.isArray(signal.display.reasonCodes) || !signal.display.reasonCodes.every(value => typeof value === "string")) throw new Error("Corrupt RadarSignalV1 display");
  return Object.freeze({ ...signal, token: Object.freeze({ ...signal.token }), display: Object.freeze({ ...signal.display, reasonCodes: Object.freeze([...signal.display.reasonCodes]) }) }) as unknown as RadarSignalV1;
}

export function createTokenSignalService(options: TokenSignalServiceOptions) {
  const service = createTokenAggregationService<PersistedSignalEnvelopeV1>({
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
      const publicSignal: RadarSignalV1 = Object.freeze({
        schemaVersion: "1" as const,
        signalId: tokenId,
        idempotencyKey: addressRadarBroadcastId(tokenId, decision.broadcastNumber),
        token: Object.freeze({ chain: chain.toLowerCase(), contractAddress: tokenAddress, symbol: facts.symbol ?? null, name: facts.name ?? null, imageUrl: facts.imageUrl ?? null }),
        category: decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "new_token_discovery" as const : "old_token_momentum" as const,
        broadcastSequence: decision.broadcastNumber,
        score: decision.score,
        confidence: decision.score,
        marketCapUsd: facts.marketCapUsd ?? null,
        priceUsd: facts.priceUsd ?? null,
        triggeredAt: new Date(triggeredAt).toISOString(),
        expiresAt: new Date(triggeredAt + decision.windowMs).toISOString(),
        display: Object.freeze({ title: decision.signalFamily === "NEW_TOKEN_DISCOVERY" ? "New token discovery" : "Old token momentum", summary: `${decision.participantCount} qualified traders, $${decision.totalBuyUsd.toFixed(0)} buys`, reasonCodes: Object.freeze(reasonCodes) }),
      });
      return Object.freeze({
        kind: "radar_signal_evaluation" as const,
        version: 1 as const,
        publicSignal,
        audit: Object.freeze({
          action: decision.action === "broadcast" ? "new" as const : "update" as const,
          lifecycleStage: decision.lifecycleStage,
          windowMs: decision.windowMs,
          participantCount: decision.participantCount,
          totalBuyUsd: decision.totalBuyUsd,
          maxSingleBuyUsd: decision.maxSingleBuyUsd,
          sourceState: decision.sourceState,
          entityIds: Object.freeze([...new Set(evidence.filter(item => decision.consumeEvidenceIds.includes(item.eventId)).map(item => item.entityId))]),
          evidenceIds: decision.consumeEvidenceIds,
        }),
      });
    },
  });
  return Object.freeze({
    evaluate(chain: string, tokenAddress: string, evidence: readonly AddressSignalEvidence[], metadata?: TokenSignalMetadata): TokenSignalEvaluation {
      const result = service.evaluate(chain, tokenAddress, evidence, metadata as unknown as Readonly<Record<string, unknown>> | undefined);
      return Object.freeze({ decision: result.decision as TokenSignalDecision, shadowDecision: null, candidate: result.candidate?.publicSignal ?? null });
    },
  });
}
