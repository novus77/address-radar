import type { AddressSignalEvidence } from "./evidence.js";

export const STRONG_BUNDLE_WINDOW_MS = 5_000;
export const SUSPECTED_BUNDLE_WINDOW_MS = 10_000;

export interface WalletBundlePairObservation {
  readonly pairKey: string;
  readonly leftEntityId: string;
  readonly rightEntityId: string;
  readonly deltaMs: number;
  readonly observedAt: number;
}

export interface WalletBundleRelation extends WalletBundlePairObservation {
  readonly distinctTokenCount: number;
  readonly recurring: boolean;
}

const orderedPair = (left: string, right: string): readonly [string, string] => left < right ? [left, right] : [right, left];
export const walletBundlePairKey = (left: string, right: string): string => orderedPair(left, right).join("::");

export function detectTemporalBundlePairs(evidence: readonly AddressSignalEvidence[]): readonly WalletBundlePairObservation[] {
  const byEntity = new Map<string, AddressSignalEvidence[]>();
  for (const item of evidence) {
    if ((item.side ?? "buy") !== "buy") continue;
    const items = byEntity.get(item.entityId) ?? [];
    items.push(item);
    byEntity.set(item.entityId, items);
  }
  const entities = [...byEntity].sort(([left], [right]) => left.localeCompare(right));
  const pairs: WalletBundlePairObservation[] = [];
  for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
      const [leftEntityId, leftEvents] = entities[leftIndex]!;
      const [rightEntityId, rightEvents] = entities[rightIndex]!;
      let closest: { deltaMs: number; observedAt: number } | null = null;
      for (const left of leftEvents) for (const right of rightEvents) {
        const deltaMs = Math.abs(left.occurredAt - right.occurredAt);
        if (deltaMs <= SUSPECTED_BUNDLE_WINDOW_MS && (!closest || deltaMs < closest.deltaMs)) closest = { deltaMs, observedAt: Math.max(left.occurredAt, right.occurredAt) };
      }
      if (closest) pairs.push(Object.freeze({ pairKey: walletBundlePairKey(leftEntityId, rightEntityId), leftEntityId, rightEntityId, deltaMs: closest.deltaMs, observedAt: closest.observedAt }));
    }
  }
  return Object.freeze(pairs);
}

export function applyWalletBundleGroups(input: {
  readonly evidence: readonly AddressSignalEvidence[];
  readonly temporalPairs: readonly WalletBundlePairObservation[];
  readonly relations?: readonly WalletBundleRelation[];
}): readonly AddressSignalEvidence[] {
  const parents = new Map<string, string>();
  const find = (entityId: string): string => {
    const parent = parents.get(entityId) ?? entityId;
    if (parent === entityId) { parents.set(entityId, entityId); return entityId; }
    const root = find(parent);
    parents.set(entityId, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parents.set(rightRoot, leftRoot);
    else parents.set(leftRoot, rightRoot);
  };
  for (const item of input.evidence) find(item.entityId);
  for (const pair of input.temporalPairs) union(pair.leftEntityId, pair.rightEntityId);
  for (const relation of input.relations ?? []) if (relation.recurring) union(relation.leftEntityId, relation.rightEntityId);

  const membersByRoot = new Map<string, string[]>();
  for (const entityId of parents.keys()) {
    const root = find(entityId);
    const members = membersByRoot.get(root) ?? [];
    members.push(entityId);
    membersByRoot.set(root, members);
  }
  const recurringKeys = new Set((input.relations ?? []).filter(item => item.recurring).map(item => item.pairKey));
  return Object.freeze(input.evidence.map(item => {
    const members = [...(membersByRoot.get(find(item.entityId)) ?? [item.entityId])].sort();
    if (members.length < 2) return item;
    const memberPairs = members.flatMap((left, index) => members.slice(index + 1).map(right => walletBundlePairKey(left, right)));
    const recurring = memberPairs.some(key => recurringKeys.has(key));
    const strongestDelta = input.temporalPairs.filter(pair => memberPairs.includes(pair.pairKey)).reduce((minimum, pair) => Math.min(minimum, pair.deltaMs), Number.POSITIVE_INFINITY);
    return Object.freeze({ ...item, independenceKey: `bundle:${members.join("+")}`, bundleRisk: recurring ? "confirmed" as const : strongestDelta <= STRONG_BUNDLE_WINDOW_MS ? "strong" as const : "suspected" as const });
  }));
}
