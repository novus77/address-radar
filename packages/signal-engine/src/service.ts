import { addressRadarBroadcastId, addressRadarTokenId } from "@address-radar/domain";
import type { RadarSignalV1 } from "@address-radar/radar-signal";
import {
  createTokenAggregationService,
  type AddressSignalEvidence,
  type TokenAggregationRepository,
  type AggregationDecision,
} from "@address-radar/aggregation";
import { evaluateTokenSignal, type TokenSignalDecision } from "./policy.js";

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
const supportedChains = new Set(["eth", "bnb", "bsc", "monad", "robinhood", "base", "solana", "sol"]);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export class RadarSignalValidationError extends Error {
  readonly name = "RadarSignalValidationError";
  constructor(readonly field: string, message: string) { super(`Invalid RadarSignalV1 ${field}: ${message}`); }
}

const invalid = (field: string, message: string): never => { throw new RadarSignalValidationError(field, message); };

function parseCurrentRadarSignalEnvelope(payload: unknown): RadarSignalV1 {
  let decoded = payload;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded) as unknown; } catch { throw new Error("Corrupt RadarSignalV1 replay payload"); }
  }
  if (!record(decoded) || decoded.kind !== "radar_signal_evaluation" || decoded.version !== 1 || !record(decoded.publicSignal)) return invalid("envelope", "corrupt replay envelope");
  const signal = decoded.publicSignal;
  if (!exactKeys(signal, ["schemaVersion", "signalId", "idempotencyKey", "token", "category", "broadcastSequence", "score", "confidence", "marketCapUsd", "priceUsd", "triggeredAt", "expiresAt", "display"]) || signal.schemaVersion !== "1") return invalid("keys", "contract keys are not exact");
  if (!nonempty(signal.signalId) || !nonempty(signal.idempotencyKey)) return invalid("identity", "IDs must be nonempty");
  if (!record(signal.token) || !exactKeys(signal.token, ["chain", "contractAddress", "symbol", "name", "imageUrl"]) || !nonempty(signal.token.chain) || !supportedChains.has(signal.token.chain.toLowerCase()) || !nonempty(signal.token.contractAddress) || ![signal.token.symbol, signal.token.name, signal.token.imageUrl].every(value => value === null || typeof value === "string")) return invalid("token", "unsupported or malformed token");
  if (signal.category !== "new_token_discovery" && signal.category !== "old_token_momentum") return invalid("category", "unsupported category");
  if (!Number.isSafeInteger(signal.broadcastSequence) || (signal.broadcastSequence as number) < 1) return invalid("broadcastSequence", "must be positive");
  if (typeof signal.score !== "number" || !Number.isFinite(signal.score) || signal.score < 0 || signal.score > 1 || typeof signal.confidence !== "number" || !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) return invalid("score", "score and confidence must be within [0, 1]");
  if (!finiteNullable(signal.marketCapUsd) || !finiteNullable(signal.priceUsd) || (typeof signal.marketCapUsd === "number" && signal.marketCapUsd < 0) || (typeof signal.priceUsd === "number" && signal.priceUsd < 0)) return invalid("market", "market values must be nonnegative finite numbers");
  if (!iso(signal.triggeredAt) || !iso(signal.expiresAt) || Date.parse(signal.expiresAt) <= Date.parse(signal.triggeredAt)) return invalid("dates", "dates must be ISO and expiration must follow trigger");
  if (!record(signal.display) || !exactKeys(signal.display, ["title", "summary", "reasonCodes"]) || !nonempty(signal.display.title) || !nonempty(signal.display.summary) || !Array.isArray(signal.display.reasonCodes) || signal.display.reasonCodes.length === 0 || !signal.display.reasonCodes.every(nonempty)) return invalid("display", "display fields must be nonempty");
  return Object.freeze({ ...signal, token: Object.freeze({ ...signal.token }), display: Object.freeze({ ...signal.display, reasonCodes: Object.freeze([...signal.display.reasonCodes]) }) }) as unknown as RadarSignalV1;
}

export interface LegacySignalReplayContext {
  readonly category?: RadarSignalV1["category"];
  readonly expiresAt?: string;
  readonly token?: Pick<RadarSignalV1["token"], "symbol" | "name" | "imageUrl">;
}

export type PersistedRadarSignalDecodeResult =
  | { readonly status: "replayed"; readonly source: "current" | "legacy_v1" | "legacy_v2"; readonly signal: RadarSignalV1 }
  | { readonly status: "legacy_unreplayable"; readonly source: "legacy_v2"; readonly reason: "missing_migration_context"; readonly signalId: string; readonly idempotencyKey: string };

export class LegacySignalUnreplayableError extends Error {
  readonly name = "LegacySignalUnreplayableError";
  constructor(readonly result: Extract<PersistedRadarSignalDecodeResult, { status: "legacy_unreplayable" }>) {
    super(`Legacy signal cannot be replayed: ${result.reason}`);
  }
}

export function decodePersistedRadarSignal(payload: unknown, context: LegacySignalReplayContext = {}): PersistedRadarSignalDecodeResult {
  let decoded = payload;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded) as unknown; } catch { throw new Error("Malformed persisted radar signal JSON"); }
  }
  if (!record(decoded)) throw new Error("Malformed persisted radar signal");
  if (Object.hasOwn(decoded, "publicSignal")) {
    return Object.freeze({ status: "replayed" as const, source: "current" as const, signal: parseCurrentRadarSignalEnvelope(decoded) });
  }
  if (decoded.schemaVersion === "1") {
    const publicSignal = {
      schemaVersion: decoded.schemaVersion,
      signalId: decoded.signalId,
      idempotencyKey: decoded.idempotencyKey,
      token: decoded.token,
      category: decoded.category,
      broadcastSequence: decoded.broadcastSequence,
      score: decoded.score,
      confidence: decoded.confidence,
      marketCapUsd: decoded.marketCapUsd,
      priceUsd: decoded.priceUsd,
      triggeredAt: decoded.triggeredAt,
      expiresAt: decoded.expiresAt,
      display: decoded.display,
    };
    return Object.freeze({ status: "replayed" as const, source: "legacy_v1" as const, signal: parseCurrentRadarSignalEnvelope({ kind: "radar_signal_evaluation", version: 1, publicSignal }) });
  }
  if (decoded.version === 2) return decodeLegacyV2(decoded, context);
  throw new Error("Unsupported persisted radar signal version");
}

export function replayRadarSignalV1(payload: unknown, context: LegacySignalReplayContext = {}): RadarSignalV1 {
  const decoded = decodePersistedRadarSignal(payload, context);
  if (decoded.status === "legacy_unreplayable") throw new LegacySignalUnreplayableError(decoded);
  return decoded.signal;
}

function decodeLegacyV2(value: Record<string, unknown>, context: LegacySignalReplayContext): PersistedRadarSignalDecodeResult {
  if (typeof value.signalId !== "string" || !value.signalId || typeof value.decisionId !== "string" || !value.decisionId || typeof value.tokenId !== "string" || !value.tokenId || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || !Number.isSafeInteger(value.publishedAt) || (value.publishedAt as number) < 0 || typeof value.overallScore !== "number" || !Number.isFinite(value.overallScore) || typeof value.confidenceScore !== "number" || !Number.isFinite(value.confidenceScore) || !Array.isArray(value.keyReasons)) throw new Error("Malformed legacy RadarSignalV2");
  const separator = value.tokenId.indexOf(":");
  if (separator <= 0 || separator === value.tokenId.length - 1) throw new Error("Malformed legacy RadarSignalV2 tokenId");
  const reasonCodes: string[] = [];
  for (const reason of value.keyReasons) {
    if (!record(reason) || typeof reason.code !== "string" || !reason.code.trim()) throw new Error("Malformed legacy RadarSignalV2 reason");
    reasonCodes.push(reason.code);
  }
  if (!context.category || !context.expiresAt) {
    return Object.freeze({ status: "legacy_unreplayable" as const, source: "legacy_v2" as const, reason: "missing_migration_context" as const, signalId: value.signalId, idempotencyKey: value.decisionId });
  }
  if (!iso(context.expiresAt)) throw new Error("Malformed legacy RadarSignalV2 migration context");
  const chain = value.tokenId.slice(0, separator).toLowerCase();
  const contractAddress = value.tokenId.slice(separator + 1);
  const triggeredAt = new Date(value.publishedAt as number).toISOString();
  if (Date.parse(context.expiresAt) <= Date.parse(triggeredAt)) throw new Error("Malformed legacy RadarSignalV2 expiration");
  const title = context.category === "new_token_discovery" ? "New token discovery" : "Old token momentum";
  const publicSignal = {
    schemaVersion: "1" as const,
    signalId: value.tokenId,
    idempotencyKey: value.decisionId,
    token: { chain, contractAddress, symbol: context.token?.symbol ?? null, name: context.token?.name ?? null, imageUrl: context.token?.imageUrl ?? null },
    category: context.category,
    broadcastSequence: value.sequence,
    score: value.overallScore,
    confidence: value.confidenceScore,
    marketCapUsd: null,
    priceUsd: null,
    triggeredAt,
    expiresAt: context.expiresAt,
    display: { title, summary: "Migrated legacy address-intelligence signal", reasonCodes: [...new Set(reasonCodes)] },
  };
  return Object.freeze({ status: "replayed" as const, source: "legacy_v2" as const, signal: parseCurrentRadarSignalEnvelope({ kind: "radar_signal_evaluation", version: 1, publicSignal }) });
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
    publicSignal: candidate => candidate.publicSignal,
  });
  return Object.freeze({
    evaluate(chain: string, tokenAddress: string, evidence: readonly AddressSignalEvidence[], metadata?: TokenSignalMetadata): TokenSignalEvaluation {
      const result = service.evaluate(chain, tokenAddress, evidence, metadata as unknown as Readonly<Record<string, unknown>> | undefined);
      return Object.freeze({ decision: result.decision as TokenSignalDecision, shadowDecision: null, candidate: result.candidate?.publicSignal ?? null });
    },
  });
}
