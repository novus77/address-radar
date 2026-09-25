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
  readonly traderLifecycle?: "active" | "elite" | "degraded";
  readonly independenceKey?: string;
  readonly bundleRisk?: "suspected" | "strong" | "confirmed";
}

export interface BundleDiagnostics {
  readonly rawParticipantCount: number;
  readonly independentParticipantCount: number;
  readonly bundledParticipantCount: number;
  readonly bundledBuyUsd: number;
  readonly bundleBuyShare: number;
  readonly groups: readonly Readonly<{ independenceKey: string; entityIds: readonly string[]; risk: "suspected" | "strong" | "confirmed" }>[];
}

export interface TokenAggregationPrevious {
  readonly broadcastCount: number;
  readonly consumedEvidenceIds: readonly string[];
  readonly consumedEconomicKeys?: readonly string[];
}

export interface AggregatedTraderEvidence {
  readonly entityId: string;
  readonly contribution: number;
  readonly amountUsd: number;
  readonly maxSingleBuyUsd: number;
  readonly traderTags: ReadonlySet<string>;
  readonly eventIds: readonly string[];
}

export interface TokenEvidenceSnapshot {
  readonly lifecycleStage: TokenLifecycleStage;
  readonly inWindow: readonly AddressSignalEvidence[];
  readonly traders: readonly AggregatedTraderEvidence[];
  readonly sourceState: AddressEvidenceSourceState;
  readonly bundleDiagnostics: BundleDiagnostics;
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
  const emptyDiagnostics: BundleDiagnostics = Object.freeze({ rawParticipantCount: 0, independentParticipantCount: 0, bundledParticipantCount: 0, bundledBuyUsd: 0, bundleBuyShare: 0, groups: Object.freeze([]) });
  const consumed = new Set(input.previous?.consumedEvidenceIds ?? []);
  const consumedEconomic = new Set(input.previous?.consumedEconomicKeys ?? []);
  const freshBuys = input.evidence.filter(item => !consumed.has(item.eventId) && !consumedEconomic.has(item.dedupeKey ?? item.eventId) && (item.side ?? "buy") === "buy");
  if (freshBuys.length === 0) {
    return Object.freeze({
      lifecycleStage: "unknown",
      inWindow: Object.freeze([]),
      traders: Object.freeze([]),
      sourceState: "UNKNOWN",
      bundleDiagnostics: emptyDiagnostics,
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
      bundleDiagnostics: emptyDiagnostics,
    });
  }

  const windowStart = latest.occurredAt - input.windowMs(lifecycleStage);
  const inWindow = freshBuys.filter(item =>
    (item.lifecycleStage ?? "unknown") === lifecycleStage
      && item.occurredAt >= windowStart
      && item.occurredAt <= latest.occurredAt
  );
  const economicEvents = new Map<string, { selected: AddressSignalEvidence; eventIds: string[] }>();
  for (const item of inWindow) {
    const key = item.dedupeKey ?? item.eventId;
    const current = economicEvents.get(key);
    if (!current) economicEvents.set(key, { selected: item, eventIds: [item.eventId] });
    else {
      current.eventIds.push(item.eventId);
      if (item.contribution > current.selected.contribution) current.selected = item;
    }
  }

  const byEntity = new Map<string, {
    contribution: number;
    amountUsd: number;
    maxSingleBuyUsd: number;
    traderTags: Set<string>;
    eventIds: string[];
  }>();
  for (const economic of economicEvents.values()) {
    const item = economic.selected;
    const independenceKey = item.independenceKey ?? item.entityId;
    const current = byEntity.get(independenceKey) ?? {
      contribution: 0,
      amountUsd: 0,
      maxSingleBuyUsd: 0,
      traderTags: new Set<string>(),
      eventIds: [],
    };
    current.contribution = Math.max(current.contribution, clampProbability(item.contribution));
    current.amountUsd += Math.max(0, item.amountUsd ?? 0);
    current.maxSingleBuyUsd = Math.max(current.maxSingleBuyUsd, Math.max(0, item.amountUsd ?? 0));
    for (const tag of item.traderTags ?? []) current.traderTags.add(tag);
    current.eventIds.push(...economic.eventIds);
    byEntity.set(independenceKey, current);
  }

  const rawParticipantCount = new Set(inWindow.map(item => item.entityId)).size;
  const bundleGroups = new Map<string, { entityIds: Set<string>; risk: "suspected" | "strong" | "confirmed" }>();
  for (const item of inWindow) {
    if (!item.independenceKey || !item.bundleRisk) continue;
    const group = bundleGroups.get(item.independenceKey) ?? { entityIds: new Set<string>(), risk: item.bundleRisk };
    group.entityIds.add(item.entityId);
    if (item.bundleRisk === "confirmed" || (item.bundleRisk === "strong" && group.risk === "suspected")) group.risk = item.bundleRisk;
    bundleGroups.set(item.independenceKey, group);
  }
  const bundledEntities = new Set([...bundleGroups.values()].flatMap(group => [...group.entityIds]));
  const bundledEconomicKeys = new Set(inWindow.filter(item => bundledEntities.has(item.entityId)).map(item => item.dedupeKey ?? item.eventId));
  const totalBuyUsd = [...economicEvents.values()].reduce((sum, item) => sum + Math.max(0, item.selected.amountUsd ?? 0), 0);
  const bundledBuyUsd = [...economicEvents].filter(([key]) => bundledEconomicKeys.has(key)).reduce((sum, [, item]) => sum + Math.max(0, item.selected.amountUsd ?? 0), 0);
  const bundleDiagnostics: BundleDiagnostics = Object.freeze({ rawParticipantCount, independentParticipantCount: byEntity.size, bundledParticipantCount: bundledEntities.size, bundledBuyUsd, bundleBuyShare: totalBuyUsd > 0 ? bundledBuyUsd / totalBuyUsd : 0, groups: Object.freeze([...bundleGroups].map(([independenceKey, group]) => Object.freeze({ independenceKey, entityIds: Object.freeze([...group.entityIds].sort()), risk: group.risk }))) });

  return Object.freeze({
    lifecycleStage,
    inWindow: Object.freeze(inWindow),
    traders: Object.freeze([...byEntity].map(([entityId, item]) => Object.freeze({
      entityId,
      contribution: item.contribution,
      amountUsd: item.amountUsd,
      maxSingleBuyUsd: item.maxSingleBuyUsd,
      traderTags: item.traderTags,
      eventIds: Object.freeze(item.eventIds),
    }))),
    sourceState: sourceState(inWindow),
    bundleDiagnostics,
  });
}
