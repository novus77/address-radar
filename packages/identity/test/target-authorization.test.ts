import { describe, expect, it } from "vitest";
import { FORWARD_TRADER_CAPABILITY_VERSION, type ForwardTargetChannelFact, type ForwardTargetChannelState, type ForwardManualRadarAuthorization, type ForwardTraderCapabilityProjection } from "@address-radar/domain";
import { evaluateForwardTargetAuthorization } from "../src/target-authorization.js";

const asOf = 1_750_000_000_000;
const fact: ForwardTargetChannelFact = { entityId: "entity", channel: "fomo", subjectId: "account", walletFamily: null,
  associationConfidence: "confirmed", associationSource: "fomo_profile", ownerCount: 1, walletConfidence: null, walletSource: null,
  identityEvidenceRef: "identity", ownershipEvidenceRef: "owner", monitoringEnabled: true, suspended: false };
const target: ForwardTargetChannelState = { fact, versionId: "target-v1", bindingState: "owned", bindingVersion: "binding-v1" };
const grant: ForwardManualRadarAuthorization = { authorizationId: "grant", entityId: "entity", action: "grant", actorId: "operator", basisRef: "approval", effectiveAt: asOf, knownAt: asOf };
const projection: ForwardTraderCapabilityProjection = { strategyVersion: FORWARD_TRADER_CAPABILITY_VERSION, generationId: "generation", entityId: "entity",
  asOf, cohortStart: asOf - 30 * 86400000, cohortEnd: asOf, observationStatus: "candidate_observed", stableCapability: true, cohortMaturity: "collecting",
  labels: ["repeated_high_multiple_discovery"], sampleIds: ["sample-a", "sample-b"], metrics: { samples: 2, distinctTokens: 2, screeningReadyTokens: 2,
    hit3xTokens: 2, hit5xTokens: 2, observingTokens: 0, awaitingScreeningTokens: 0, awaitingEvidenceTokens: 0, matureSamples: 0, estimatedAmountSamples: 2 } };
const capability = { projection, versionId: "cap-v1", evaluatedAt: asOf };
const evaluate = (options: Partial<Parameters<typeof evaluateForwardTargetAuthorization>[0]> = {}) => evaluateForwardTargetAuthorization({ target, generationId: "generation", asOf, manualAuthorization: null, capability: null, ...options });

describe("forward target authorization", () => {
  it("monitors a trusted FOMO-only target without granting radar", () => {
    expect(evaluate()).toMatchObject({ monitoringEligible: true, radarEligible: false, stableCapability: null, reasonCode: "target_capability_refresh_required" });
  });
  it("keeps ordinary note/label metadata separate from explicit authorization", () => {
    expect(evaluate({ target: { ...target, fact: { ...fact, ...{ notes: "重点监控", labels: ["elite"] } } } }).radarEligible).toBe(false);
  });
  it("allows an explicit manual grant without requiring a wallet or stable capability", () => {
    expect(evaluate({ manualAuthorization: grant })).toMatchObject({ radarEligible: true, authorizationBasis: "manual", otherSignalGatesRequired: true });
  });
  it("allows current stable capability without a manual grant", () => {
    expect(evaluate({ capability })).toMatchObject({ radarEligible: true, authorizationBasis: "system_stable", stableCapability: true });
  });
  it("keeps manual and system qualification separately visible", () => {
    expect(evaluate({ capability, manualAuthorization: grant }).authorizationBasis).toBe("manual_and_system_stable");
  });
  it("does not treat a high-confidence association without wallet proof as confirmed", () => {
    expect(evaluate({ target: { ...target, fact: { ...fact, associationConfidence: "high" } }, manualAuthorization: grant })).toMatchObject({ monitoringEligible: false, radarEligible: false });
  });
  it("accepts the existing high-confidence fomolens wallet trust exception", () => {
    expect(evaluate({ target: { ...target, fact: { ...fact, associationConfidence: "high", walletConfidence: "high", walletSource: "fomolens_manual" } } }).monitoringEligible).toBe(true);
  });
  it("does not promote a manual-wallet association into a trusted FOMO identity", () => {
    expect(evaluate({ target: { ...target, fact: { ...fact, associationSource: "manual_wallet" } }, manualAuthorization: grant }).radarEligible).toBe(false);
  });
  it("requires actual identity and ownership evidence references", () => {
    for (const field of ["identityEvidenceRef", "ownershipEvidenceRef"] as const) expect(evaluate({ target: { ...target, fact: { ...fact, [field]: null } }, manualAuthorization: grant }).radarEligible).toBe(false);
  });
  it("blocks conflicting or unbound ownership even with a manual grant", () => {
    for (const bindingState of ["conflict", "unbound"] as const) expect(evaluate({ target: { ...target, bindingState }, manualAuthorization: grant, capability }).radarEligible).toBe(false);
    expect(evaluate({ target: { ...target, fact: { ...fact, ownerCount: 2 } }, manualAuthorization: grant }).reasonCode).toBe("target_ownership_conflict");
  });
  it("never bypasses disabled monitoring or suspension", () => {
    for (const disabled of [{ monitoringEnabled: false }, { suspended: true }]) expect(evaluate({ target: { ...target, fact: { ...fact, ...disabled } }, manualAuthorization: grant, capability }).reasonCode).toBe("target_monitoring_disabled");
  });
  it("requires an explicit current decision instead of trusting an aged capability head", () => {
    expect(evaluate({ capability: { ...capability, evaluatedAt: asOf - 1 } }).radarEligible).toBe(false);
    expect(evaluate({ capability: { ...capability, evaluatedAt: asOf + 1 } }).radarEligible).toBe(false);
    expect(evaluate({ capability: { ...capability, projection: { ...projection, generationId: "other" } } }).radarEligible).toBe(false);
  });
  it("does not count future or revoked manual authorizations", () => {
    for (const authorization of [{ ...grant, action: "revoke" as const }, { ...grant, knownAt: asOf + 1 }, { ...grant, effectiveAt: asOf + 1 }]) expect(evaluate({ manualAuthorization: authorization }).radarEligible).toBe(false);
  });
  it("rejects an authorization belonging to another entity", () => {
    expect(() => evaluate({ manualAuthorization: { ...grant, entityId: "other" } })).toThrow("another entity");
  });
  it("does not turn one observed high multiple into stable system qualification", () => {
    expect(evaluate({ capability: { ...capability, projection: { ...projection, stableCapability: false, metrics: { ...projection.metrics, hit3xTokens: 1, hit5xTokens: 1 } } } })).toMatchObject({ radarEligible: false, candidateObservation: "candidate_observed" });
  });
  it("monitors a verified wallet-only target independently of FOMO", () => {
    const wallet = { ...fact, channel: "wallet" as const, subjectId: "0x0000000000000000000000000000000000000001", walletFamily: "evm" as const,
      associationSource: "manual_wallet", walletConfidence: "confirmed" as const, walletSource: "onchain" };
    expect(evaluate({ target: { ...target, fact: wallet }, manualAuthorization: grant })).toMatchObject({ monitoringEligible: true, radarEligible: true });
  });
});
