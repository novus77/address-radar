import { signalFamilyForStage, type AddressSignalFamily, type TokenLifecycleStage } from "@address-radar/domain";
import {
  aggregateEvidenceWindow,
  type AddressEvidenceSourceState,
  type AddressSignalEvidence,
  type TokenAggregationPrevious,
} from "@address-radar/aggregation";

export interface TokenSignalDecision {
  readonly action: "observe" | "broadcast" | "rebroadcast";
  readonly score: number;
  readonly broadcastNumber: number;
  readonly consumeEvidenceIds: readonly string[];
  readonly signalFamily: AddressSignalFamily | null;
  readonly lifecycleStage: TokenLifecycleStage;
  readonly windowMs: number;
  readonly participantCount: number;
  readonly totalBuyUsd: number;
  readonly sourceState: AddressEvidenceSourceState;
  readonly missingConditions: readonly string[];
}

export interface TokenSignalPolicyInput {
  readonly previous?: TokenAggregationPrevious | null | undefined;
  readonly threshold: number;
  readonly minimumTotalBuyUsd?: number | undefined;
  readonly evidence: readonly AddressSignalEvidence[];
}

interface RoutePolicy {
  readonly windowMs: number;
  readonly minimumTraders: number;
}

const MINUTE_MS = 60_000;
export const TOKEN_SIGNAL_ROUTE_POLICIES: Readonly<Record<Exclude<TokenLifecycleStage, "unknown">, RoutePolicy>> = Object.freeze({
  created: { windowMs: 10 * MINUTE_MS, minimumTraders: 3 },
  launched_0_2h: { windowMs: 5 * MINUTE_MS, minimumTraders: 2 },
  launched_2_12h: { windowMs: 15 * MINUTE_MS, minimumTraders: 2 },
  launched_12_24h: { windowMs: 30 * MINUTE_MS, minimumTraders: 3 },
  older_1_7d: { windowMs: 30 * MINUTE_MS, minimumTraders: 2 },
  older_7d_plus: { windowMs: 60 * MINUTE_MS, minimumTraders: 2 },
});

const observed = (
  previous: TokenAggregationPrevious | null | undefined,
  stage: TokenLifecycleStage,
  windowMs: number,
  participantCount: number,
  totalBuyUsd: number,
  sourceState: AddressEvidenceSourceState,
  missingConditions: readonly string[],
  score = 0,
): TokenSignalDecision => Object.freeze({
  action: "observe",
  score,
  broadcastNumber: previous?.broadcastCount ?? 0,
  consumeEvidenceIds: Object.freeze([]),
  signalFamily: signalFamilyForStage(stage),
  lifecycleStage: stage,
  windowMs,
  participantCount,
  totalBuyUsd,
  sourceState,
  missingConditions: Object.freeze([...missingConditions]),
});

export function evaluateTokenSignal({
  previous,
  threshold,
  minimumTotalBuyUsd = 0,
  evidence,
}: TokenSignalPolicyInput): TokenSignalDecision {
  const snapshot = aggregateEvidenceWindow({
    previous,
    evidence,
    windowMs: stage => stage === "unknown" ? 0 : TOKEN_SIGNAL_ROUTE_POLICIES[stage].windowMs,
  });
  const stage = snapshot.lifecycleStage;
  if (snapshot.inWindow.length === 0) {
    return observed(previous, "unknown", 0, 0, 0, "UNKNOWN", ["fresh_evidence"]);
  }
  if (stage === "unknown") {
    return observed(previous, stage, 0, new Set(snapshot.inWindow.map(item => item.entityId)).size, snapshot.inWindow.reduce(
      (sum, item) => sum + Math.max(0, item.amountUsd ?? 0),
      0,
    ), snapshot.sourceState, ["token_lifecycle"]);
  }

  const policy = TOKEN_SIGNAL_ROUTE_POLICIES[stage];
  const qualified = snapshot.traders.filter(item => item.contribution >= 0.55);
  const missing: string[] = [];
  if (qualified.length < policy.minimumTraders) missing.push(`distinct_traders:${policy.minimumTraders}`);

  if (stage === "launched_0_2h" || stage === "launched_2_12h") {
    const hasEarlyAlpha = qualified.some(item =>
      item.contribution >= 0.8
      || item.traderTags.has("EARLY_LAUNCH")
      || item.traderTags.has("HIGH_MULTIPLE")
    );
    if (!hasEarlyAlpha) missing.push("early_or_high_multiple_trader");
  }
  if (stage === "launched_12_24h" && qualified.filter(item => item.contribution >= 0.7).length < 2) {
    missing.push("repeatable_traders:2");
  }

  const totalBuyUsd = qualified.reduce((sum, item) => sum + item.amountUsd, 0);
  if (totalBuyUsd < minimumTotalBuyUsd) missing.push(`minimum_total_buy_usd:${minimumTotalBuyUsd}`);
  if (stage === "older_1_7d") {
    if (!qualified.some(item => item.amountUsd >= 10_000)) missing.push("single_buy_usd:10000");
    if (totalBuyUsd < 20_000) missing.push("aggregate_buy_usd:20000");
  }
  if (stage === "older_7d_plus" && qualified.filter(item => item.amountUsd >= 10_000).length < 2) {
    missing.push("large_buy_traders:2");
  }

  const score = qualified.reduce((combined, item) => 1 - (1 - combined) * (1 - item.contribution), 0);
  if (score < threshold) missing.push(`score:${threshold}`);
  if (missing.length > 0) {
    return observed(previous, stage, policy.windowMs, qualified.length, totalBuyUsd, snapshot.sourceState, missing, score);
  }

  const priorBroadcastCount = previous?.broadcastCount ?? 0;
  return Object.freeze({
    action: priorBroadcastCount === 0 ? "broadcast" : "rebroadcast",
    score,
    broadcastNumber: priorBroadcastCount + 1,
    consumeEvidenceIds: Object.freeze(snapshot.inWindow.map(item => item.eventId)),
    signalFamily: signalFamilyForStage(stage),
    lifecycleStage: stage,
    windowMs: policy.windowMs,
    participantCount: qualified.length,
    totalBuyUsd,
    sourceState: snapshot.sourceState,
    missingConditions: Object.freeze([]),
  });
}
