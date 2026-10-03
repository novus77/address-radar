import { forwardQualifyingBuyAmount,forwardDecimal } from "./forward-opportunity-policy.js";
import { forwardEvidenceIdentifier,forwardEvidenceTime,type ForwardOpportunitySample } from "./forward-opportunity-evidence.js";
export const FORWARD_SIGNAL_WINDOW_MS = 15 * 60_000;
export const FORWARD_SIGNAL_STRATEGY_VERSION = "forward-signal-v1";
export interface ForwardSignalEvidence {
  readonly sample: ForwardOpportunitySample; readonly economicKey: string;
  readonly radarEligible: boolean; readonly qualificationPending: boolean; readonly authorizationStamp: string | null; readonly refreshReceiptId: string | null;
  readonly liveSourceVerified: boolean; readonly sourceEvidenceRef: string | null;
  readonly independenceKey: string | null; readonly riskVerdict: "validated" | "pending" | "blocked"; readonly riskEvidenceRef: string | null;
}
export function evaluateForwardSignal(input: { readonly asOf: number; readonly evidence: readonly ForwardSignalEvidence[] }) {
  forwardEvidenceTime(input.asOf);
  const reasons = new Set<string>(), groups = new Map<string,ForwardSignalEvidence[]>();
  for (const item of input.evidence) {
    const sample = item.sample;
    for (const id of [sample.sampleId,sample.entityId,sample.executionFingerprint,sample.chain,sample.tokenAddress,item.economicKey]) forwardEvidenceIdentifier(id);
    forwardEvidenceTime(sample.boughtAt);
    if (sample.boughtAt > input.asOf) { reasons.add("future_execution"); continue; }
    if (sample.boughtAt < input.asOf-FORWARD_SIGNAL_WINDOW_MS) continue;
    const group = groups.get(item.economicKey) ?? []; group.push(item); groups.set(item.economicKey,group);
  }
  const candidates: ForwardSignalEvidence[] = [];
  for (const items of groups.values()) {
    const identities = new Set(items.map(item => JSON.stringify([item.sample.entityId,item.sample.chain,item.sample.tokenAddress,item.sample.executionFingerprint,
      item.sample.boughtAt,forwardDecimal(item.sample.amountUsd),item.sample.entryPriceUsd])));
    if (identities.size !== 1) { reasons.add("economic_event_conflict"); continue; }
    let selected: ForwardSignalEvidence | null = null;
    for (const item of items) {
      const sample = item.sample;
      if (!forwardQualifyingBuyAmount(sample.amountUsd)) continue;
      if (!sample.entryBasisVerified || !sample.executionEvidenceRef || !sample.entryPriceUsd || forwardDecimal(sample.entryPriceUsd) === "0") { reasons.add("missing_execution_basis"); continue; }
      if (item.qualificationPending) { reasons.add("identity_refresh_required"); continue; }
      if (!item.radarEligible) continue;
      if (!item.authorizationStamp || !item.refreshReceiptId) { reasons.add("missing_authorization_proof"); continue; }
      if (!item.liveSourceVerified || !item.sourceEvidenceRef) { reasons.add("live_source_unverified"); continue; }
      if (item.riskVerdict === "blocked") continue;
      if (item.riskVerdict !== "validated" || !item.independenceKey || !item.riskEvidenceRef) { reasons.add("risk_assessment_pending"); continue; }
      if (selected && selected.independenceKey !== item.independenceKey) { reasons.add("independence_conflict"); selected = null; break; }
      selected = item;
    }
    if (selected) candidates.push(selected);
  }
  const keysByEntity = new Map<string,Set<string>>();
  for (const item of candidates) { const keys = keysByEntity.get(item.sample.entityId) ?? new Set<string>(); keys.add(item.independenceKey!); keysByEntity.set(item.sample.entityId,keys); }
  const qualified = candidates.filter(item => { const valid = keysByEntity.get(item.sample.entityId)!.size === 1; if (!valid) reasons.add("independence_conflict"); return valid; });
  const participantCount = new Set(qualified.map(item => item.independenceKey)).size;
  const action = participantCount >= 2 ? "ready" : reasons.size ? "deferred" : "observe";
  if (participantCount < 2) reasons.add("distinct_eligible_traders:2");
  return Object.freeze({ strategyVersion: FORWARD_SIGNAL_STRATEGY_VERSION,asOf: input.asOf,windowMs: FORWARD_SIGNAL_WINDOW_MS,action,
    participantCount,reasonCodes: Object.freeze([...reasons].sort()),accepted: Object.freeze(action === "ready" ? qualified : []),
    consumedEconomicKeys: Object.freeze(action === "ready" ? qualified.map(item => item.economicKey).sort() : []) });
}
