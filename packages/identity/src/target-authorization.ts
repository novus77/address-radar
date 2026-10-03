import { FORWARD_TRADER_CAPABILITY_VERSION, forwardEvidenceIdentifier, forwardEvidenceTime, forwardTargetIdentityTrusted,
  type ForwardTargetChannelState, type ForwardManualRadarAuthorization, type ForwardTraderCapabilityProjection } from "@address-radar/domain";

export function evaluateForwardTargetAuthorization(input: {
  readonly target: ForwardTargetChannelState; readonly generationId: string; readonly asOf: number;
  readonly manualAuthorization: ForwardManualRadarAuthorization | null;
  readonly capability: { readonly projection: ForwardTraderCapabilityProjection; readonly versionId: string; readonly evaluatedAt: number } | null;
}) {
  forwardEvidenceIdentifier(input.generationId); forwardEvidenceTime(input.asOf);
  const { fact } = input.target;
  const manual = input.manualAuthorization;
  if (manual && manual.entityId !== fact.entityId) throw new Error("Manual authorization belongs to another entity");
  const manualActive = manual !== null && manual.action === "grant" && manual.effectiveAt <= input.asOf && manual.knownAt <= input.asOf;
  const capability = input.capability; const projection = capability?.projection;
  const capabilityCurrent = capability !== null && projection?.entityId === fact.entityId && projection.generationId === input.generationId &&
    projection.strategyVersion === FORWARD_TRADER_CAPABILITY_VERSION && projection.asOf <= capability.evaluatedAt && capability.evaluatedAt === input.asOf;
  const stable = capabilityCurrent ? projection!.stableCapability && (projection!.metrics.hit3xTokens >= 3 || projection!.metrics.hit5xTokens >= 2) : null;
  const identityTrusted = input.target.bindingState === "owned" && forwardTargetIdentityTrusted(fact);
  const monitoringEligible = identityTrusted && fact.monitoringEnabled && !fact.suspended;
  const radarEligible = monitoringEligible && (manualActive || stable === true);
  const authorizationBasis = radarEligible ? manualActive && stable === true ? "manual_and_system_stable" as const
    : manualActive ? "manual" as const : "system_stable" as const : "none" as const;
  const reasonCode = !fact.monitoringEnabled || fact.suspended ? "target_monitoring_disabled"
    : input.target.bindingState === "conflict" || fact.ownerCount > 1 ? "target_ownership_conflict"
    : !identityTrusted ? "target_identity_unverified" : radarEligible ? "target_authorized"
    : stable === null ? "target_capability_refresh_required" : "target_not_radar_qualified";
  return { entityId: fact.entityId, channel: fact.channel, subjectId: fact.subjectId, monitoringEligible, radarEligible,
    identityTrusted, manualAuthorizationActive: manualActive, stableCapability: stable,
    candidateObservation: capabilityCurrent ? projection!.observationStatus : null, authorizationBasis, reasonCode,
    otherSignalGatesRequired: true as const };
}
