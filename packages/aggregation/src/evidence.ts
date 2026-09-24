import type { TokenLifecycleStage } from "@address-radar/domain";

export type AddressEvidenceSource = "fomo" | "onchain";
export type AddressEvidenceSourceState = "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN" | "UNKNOWN";

export interface AddressSignalEvidence {
  readonly eventId: string;
  readonly entityId: string;
  readonly contribution: number;
  readonly occurredAt: number;
  readonly source?: AddressEvidenceSource;
  readonly side?: "buy" | "sell";
  readonly amountUsd?: number | null;
  readonly lifecycleStage?: TokenLifecycleStage;
  readonly traderTags?: readonly string[];
  readonly dedupeKey?: string;
}

export interface TokenAggregationPrevious {
  readonly broadcastCount: number;
  readonly consumedEvidenceIds: readonly string[];
}

export interface AggregatedTraderEvidence {
  readonly entityId: string;
  readonly contribution: number;
  readonly amountUsd: number;
  readonly traderTags: ReadonlySet<string>;
  readonly eventIds: readonly string[];
}

export interface TokenEvidenceSnapshot {
  readonly lifecycleStage: TokenLifecycleStage;
  readonly inWindow: readonly AddressSignalEvidence[];
  readonly traders: readonly AggregatedTraderEvidence[];
  readonly sourceState: AddressEvidenceSourceState;
}

const clampProbability = (value: number): number => Math.max(0, Math.min(1, value));

const sourceState = (evidence: readonly AddressSignalEvidence[]): AddressEvidenceSourceState => {
  const sources = new Set(evidence.map(item => item.source).filter(
    (value): value is AddressEvidenceSource => value === "fomo" || value === "onchain",
  ));
  if (sources.size === 2) return "FOMO_AND_ONCHAIN";
  if (sources.has("fomo")) return "FOMO_ONLY";
  if (sources.has("onchain")) return "ONCHAIN_ONLY";
  return "UNKNOWN";
};

export function aggregateEvidenceWindow(input: {
  readonly previous: TokenAggregationPrevious | null | undefined;
  readonly evidence: readonly AddressSignalEvidence[];
  readonly windowMs: (stage: TokenLifecycleStage) => number;
}): TokenEvidenceSnapshot {
  const consumed = new Set(input.previous?.consumedEvidenceIds ?? []);
  const freshBuys = input.evidence.filter(item => !consumed.has(item.eventId) && (item.side ?? "buy") === "buy");
  if (freshBuys.length === 0) {
    return Object.freeze({
      lifecycleStage: "unknown",
      inWindow: Object.freeze([]),
      traders: Object.freeze([]),
      sourceState: "UNKNOWN",
    });
  }

  const latest = freshBuys.reduce((candidate, item) => item.occurredAt > candidate.occurredAt ? item : candidate);
  const lifecycleStage = latest.lifecycleStage ?? "unknown";
  if (lifecycleStage === "unknown") {
    return Object.freeze({
      lifecycleStage,
      inWindow: Object.freeze([...freshBuys]),
      traders: Object.freeze([]),
      sourceState: sourceState(freshBuys),
    });
  }

  const windowStart = latest.occurredAt - input.windowMs(lifecycleStage);
  const inWindow = freshBuys.filter(item =>
    (item.lifecycleStage ?? "unknown") === lifecycleStage
      && item.occurredAt >= windowStart
      && item.occurredAt <= latest.occurredAt
  );
  const economicEvents = new Map<string, AddressSignalEvidence>();
  for (const item of inWindow) {
    const key = item.dedupeKey ?? item.eventId;
    const current = economicEvents.get(key);
    if (!current || item.contribution > current.contribution) economicEvents.set(key, item);
  }

  const byEntity = new Map<string, {
    contribution: number;
    amountUsd: number;
    traderTags: Set<string>;
    eventIds: string[];
  }>();
  for (const item of economicEvents.values()) {
    const current = byEntity.get(item.entityId) ?? {
      contribution: 0,
      amountUsd: 0,
      traderTags: new Set<string>(),
      eventIds: [],
    };
    current.contribution = Math.max(current.contribution, clampProbability(item.contribution));
    current.amountUsd += Math.max(0, item.amountUsd ?? 0);
    for (const tag of item.traderTags ?? []) current.traderTags.add(tag);
    current.eventIds.push(item.eventId);
    byEntity.set(item.entityId, current);
  }

  return Object.freeze({
    lifecycleStage,
    inWindow: Object.freeze(inWindow),
    traders: Object.freeze([...byEntity].map(([entityId, item]) => Object.freeze({
      entityId,
      contribution: item.contribution,
      amountUsd: item.amountUsd,
      traderTags: item.traderTags,
      eventIds: Object.freeze(item.eventIds),
    }))),
    sourceState: sourceState(inWindow),
  });
}
