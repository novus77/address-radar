import type { ChainFamily, IdentityConfidence } from "./model.js";
import { forwardEvidenceIdentifier } from "./forward-opportunity-evidence.js";
import { normalizeManualWalletMapping } from "./wallet-mapping.js";

export type ForwardTargetChannel = "fomo" | "wallet";
export interface ForwardTargetChannelFact {
  readonly entityId: string; readonly channel: ForwardTargetChannel; readonly subjectId: string;
  readonly walletFamily: ChainFamily | null; readonly associationConfidence: IdentityConfidence;
  readonly associationSource: string; readonly ownerCount: number; readonly walletConfidence: IdentityConfidence | null;
  readonly walletSource: string | null; readonly identityEvidenceRef: string | null; readonly ownershipEvidenceRef: string | null;
  readonly monitoringEnabled: boolean; readonly suspended: boolean;
}
export interface ForwardTargetChannelState {
  readonly fact: ForwardTargetChannelFact; readonly versionId: string;
  readonly bindingState: "owned" | "unbound" | "conflict"; readonly bindingVersion: string | null;
}
export interface ForwardTargetPrincipal {
  readonly actorId: string; readonly authorizationEvidenceRef: string;
  readonly permissions: readonly ("target_registry_write" | "radar_authorization_write")[];
}
export interface ForwardManualRadarAuthorization {
  readonly authorizationId: string; readonly entityId: string; readonly action: "grant" | "revoke";
  readonly actorId: string; readonly basisRef: string; readonly effectiveAt: number; readonly knownAt: number;
}
const confidences = ["low", "medium", "high", "confirmed"];
export function forwardTargetSubjectKey(input: Pick<ForwardTargetChannelFact, "channel" | "subjectId" | "walletFamily">): string {
  if (input.channel === "fomo") {
    if (input.walletFamily !== null) throw new Error("FOMO subject cannot have a wallet family");
    forwardEvidenceIdentifier(input.subjectId); return JSON.stringify(["fomo", input.subjectId]);
  }
  if (input.channel !== "wallet" || input.walletFamily === null) throw new Error("Invalid target channel");
  const normalized = normalizeManualWalletMapping({ family: input.walletFamily, address: input.subjectId });
  return JSON.stringify(["wallet", normalized.family, normalized.address]);
}
export function canonicalForwardTargetChannelFact(input: ForwardTargetChannelFact): ForwardTargetChannelFact {
  forwardEvidenceIdentifier(input.entityId); forwardEvidenceIdentifier(input.associationSource);
  forwardTargetSubjectKey(input);
  if (!confidences.includes(input.associationConfidence) || (input.walletConfidence !== null && !confidences.includes(input.walletConfidence))) throw new Error("Invalid identity confidence");
  if (!Number.isSafeInteger(input.ownerCount) || input.ownerCount < 0 || typeof input.monitoringEnabled !== "boolean" || typeof input.suspended !== "boolean") throw new Error("Invalid target state");
  for (const ref of [input.identityEvidenceRef, input.ownershipEvidenceRef, input.walletSource]) if (ref !== null) forwardEvidenceIdentifier(ref);
  if ((input.walletConfidence === null) !== (input.walletSource === null)) throw new Error("Incomplete wallet trust basis");
  const subjectId = input.channel === "wallet" ? normalizeManualWalletMapping({ family: input.walletFamily!, address: input.subjectId }).address : input.subjectId;
  return Object.freeze({ entityId: input.entityId, channel: input.channel, subjectId, walletFamily: input.walletFamily,
    associationConfidence: input.associationConfidence, associationSource: input.associationSource, ownerCount: input.ownerCount,
    walletConfidence: input.walletConfidence, walletSource: input.walletSource, identityEvidenceRef: input.identityEvidenceRef,
    ownershipEvidenceRef: input.ownershipEvidenceRef, monitoringEnabled: input.monitoringEnabled, suspended: input.suspended });
}
export function forwardTargetIdentityTrusted(input: ForwardTargetChannelFact): boolean {
  const fact = canonicalForwardTargetChannelFact(input);
  if (fact.ownerCount !== 1 || fact.identityEvidenceRef === null || fact.ownershipEvidenceRef === null) return false;
  const walletTrusted = (fact.associationConfidence === "confirmed" && fact.walletConfidence === "confirmed") ||
    (["high", "confirmed"].includes(fact.associationConfidence) && fact.walletConfidence === "high" && fact.walletSource === "fomolens_manual");
  if (fact.channel === "wallet") return walletTrusted;
  return fact.associationSource !== "manual_wallet" && (fact.associationConfidence === "confirmed" || walletTrusted);
}
