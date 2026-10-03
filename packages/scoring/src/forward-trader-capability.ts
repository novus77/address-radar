import { FORWARD_OPPORTUNITY_EVIDENCE_VERSION, FORWARD_OPPORTUNITY_WINDOW_MS, FORWARD_TRADER_CAPABILITY_VERSION,
  forwardEvidenceIdentifier, forwardEvidenceTime, forwardQualifyingBuyAmount, normalizeAddressRadarTokenAddress,
  type ForwardTraderCapabilityFact, type ForwardTraderCapabilityProjection } from "@address-radar/domain";
import { evaluateForwardOpportunity } from "./forward-opportunity-evaluator.js";

export function evaluateForwardTraderCapability(input: { readonly generationId: string; readonly entityId: string;
  readonly activatedAt: number; readonly asOf: number; readonly facts: readonly ForwardTraderCapabilityFact[] }): ForwardTraderCapabilityProjection {
  [input.generationId, input.entityId].forEach(forwardEvidenceIdentifier);
  [input.activatedAt, input.asOf].forEach(forwardEvidenceTime);
  if (input.activatedAt > input.asOf) throw new Error("Forward capability generation is not active");
  const cohortStart = Math.max(0, input.asOf - FORWARD_OPPORTUNITY_WINDOW_MS);
  const unique = new Map<string, ForwardTraderCapabilityFact>();
  for (const fact of input.facts) {
    const sample = fact.sample;
    [sample.sampleId, sample.executionFingerprint].forEach(forwardEvidenceIdentifier);
    [sample.boughtAt, fact.sampleCreatedAt].forEach(forwardEvidenceTime);
    if (fact.generationId !== input.generationId || sample.boughtAt < input.activatedAt
      || sample.boughtAt < cohortStart || sample.boughtAt > input.asOf || fact.sampleCreatedAt > input.asOf
      || !forwardQualifyingBuyAmount(sample.amountUsd)) continue;
    if (sample.entityId !== input.entityId) throw new Error("Forward capability purchase belongs to another identity");
    const previous = unique.get(sample.sampleId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) throw new Error("Conflicting forward capability sample input");
    unique.set(sample.sampleId, fact);
  }
  const groups = new Map<string, { screened: boolean; tier: 0 | 3 | 5; waiting: boolean; observing: boolean }>();
  let matureSamples = 0;
  let estimatedAmountSamples = 0;
  for (const fact of unique.values()) {
    const sample = fact.sample;
    const chain = sample.chain.trim().toLowerCase();
    const tokenKey = `${chain}:${normalizeAddressRadarTokenAddress(chain, sample.tokenAddress.trim())}`;
    const group = groups.get(tokenKey) ?? { screened: false, tier: 0, waiting: false, observing: false };
    if (sample.boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS <= input.asOf) matureSamples++;
    if (sample.amountEstimated) estimatedAmountSamples++;
    const screening = fact.screening;
    const screened = screening !== null && Number.isSafeInteger(screening.observedAt) && screening.observedAt >= 0
      && Number.isSafeInteger(screening.knownAt) && screening.knownAt >= screening.observedAt
      && screening.knownAt <= input.asOf && Boolean(screening.evidenceRef.trim());
    group.screened ||= screened;
    const evaluation = fact.evaluation;
    const current = evaluation !== null && fact.evaluationId !== null && evaluation.strategyVersion === FORWARD_OPPORTUNITY_EVIDENCE_VERSION
      && evaluation.sampleId === sample.sampleId && evaluation.executionFingerprint === sample.executionFingerprint
      && evaluation.computedAt >= sample.boughtAt && evaluation.computedAt <= input.asOf;
    if (screened && current) {
      const checked = evaluateForwardOpportunity({ sample, peaks: fact.peak ? [fact.peak] : [], asOf: input.asOf });
      const exact = evaluation.peakId === checked.peakId && evaluation.peakRevisionId === checked.peakRevisionId;
      if (evaluation.status === "hit" && checked.status === "hit" && exact && evaluation.tier === checked.tier) {
        group.tier = Math.max(group.tier, checked.tier) as 3 | 5;
      } else if (evaluation.status === "observing" && checked.status === "observing" && exact) {
        group.observing = true;
      } else { group.waiting = true; }
    } else if (screened) { group.waiting = true; }
    groups.set(tokenKey, group);
  }
  const tokens = [...groups.values()];
  const hit3xTokens = tokens.filter(group => group.tier >= 3).length;
  const hit5xTokens = tokens.filter(group => group.tier >= 5).length;
  const labels: ("repeated_discovery" | "repeated_high_multiple_discovery")[] = [];
  if (hit3xTokens >= 3) labels.push("repeated_discovery");
  if (hit5xTokens >= 2) labels.push("repeated_high_multiple_discovery");
  const screeningReadyTokens = tokens.filter(group => group.screened).length;
  return Object.freeze({ strategyVersion: FORWARD_TRADER_CAPABILITY_VERSION, generationId: input.generationId,
    entityId: input.entityId, asOf: input.asOf, cohortStart, cohortEnd: input.asOf,
    observationStatus: unique.size === 0 ? "no_samples" : hit3xTokens > 0 ? "candidate_observed"
      : screeningReadyTokens === 0 ? "awaiting_screening" : "observing",
    stableCapability: hit3xTokens >= 3 || hit5xTokens >= 2,
    cohortMaturity: input.asOf - input.activatedAt < FORWARD_OPPORTUNITY_WINDOW_MS ? "collecting" : "observation_period_elapsed",
    labels: Object.freeze(labels), sampleIds: Object.freeze([...unique.keys()].sort()),
    metrics: Object.freeze({ samples: unique.size, distinctTokens: tokens.length, screeningReadyTokens, hit3xTokens, hit5xTokens,
      observingTokens: tokens.filter(group => group.screened && group.tier === 0 && group.observing && !group.waiting).length,
      awaitingScreeningTokens: tokens.filter(group => !group.screened).length,
      awaitingEvidenceTokens: tokens.filter(group => group.screened && group.tier === 0 && group.waiting).length,
      matureSamples, estimatedAmountSamples }),
  });
}
