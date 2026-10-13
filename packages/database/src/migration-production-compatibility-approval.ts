import { createPublicKey, verify } from "node:crypto";
import { migrationCutoverCanonicalJson, migrationCutoverDigest,
  type WriterFencePolicy } from "./migration-cutover-coordinator.js";
import type { NativeCompatibilityProgram } from "./migration-native-compatibility-collector.js";

export interface ProductionCompatibilityApproval {
  version: 1; approvalRef: string; issuerId: string; keyId: string;
  policySha256: string; programSha256: string; issuedAt: string; expiresAt: string; signatureBase64: string;
}
export function productionCompatibilityApprovalPayload(approval: ProductionCompatibilityApproval): string {
  const { signatureBase64: _signature, ...body } = approval;
  return "address-radar/production-compatibility-approval/v1\n" + migrationCutoverCanonicalJson(body);
}
const need = (value: unknown): void => {
  if (!value) throw new Error("production_compatibility_scoped_approval_required");
};
const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  need(Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value);
  return parsed;
};
/** The expected policy is native protected input, not a trust root chosen by an untrusted job.
 * This authenticates a probe scope only, never cutover, service startup or a completed native proof.
 */
export function verifyProductionCompatibilityApproval(options: {
  policy: WriterFencePolicy; program: NativeCompatibilityProgram;
  approval: ProductionCompatibilityApproval; now: number;
}): void {
  const { policy, program, approval, now } = options;
  need(policy.version === 2 && policy.evidenceMode === "production-observation" && policy.closureTrust);
  need(Object.keys(approval).sort().join(",") === ["version", "approvalRef", "issuerId", "keyId", "policySha256",
    "programSha256", "issuedAt", "expiresAt", "signatureBase64"].sort().join(","));
  need(approval.version === 1 && typeof approval.approvalRef === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(approval.approvalRef)
    && approval.policySha256 === migrationCutoverDigest(policy, 2)
    && approval.programSha256 === migrationCutoverDigest(program, 2));
  need(Number.isSafeInteger(now) && timestamp(approval.issuedAt) <= now && timestamp(approval.expiresAt) > now
    && timestamp(approval.issuedAt) >= timestamp(policy.deadlines.windowStart)
    && timestamp(approval.expiresAt) <= timestamp(policy.deadlines.windowEnd)
    && timestamp(approval.expiresAt) - timestamp(approval.issuedAt) <= policy.deadlines.maximumOperationMs);
  for (const target of [policy.binding.target, policy.binding.rollbackTarget]) {
    need(target.serverAddress === "127.0.0.1" && target.serverPort === 5432
      && /^[1-9][0-9]{0,19}$/.test(target.systemIdentifier)
      && [target.database, target.schema].every(name => /^[a-z_][a-z0-9_]{0,62}$/.test(name)
        && !/^(?:pg_|radar_rehearsal_)/.test(name)
        && !["postgres", "template0", "template1", "public", "information_schema"].includes(name)));
  }
  need(policy.binding.target.systemIdentifier === policy.binding.rollbackTarget.systemIdentifier);
  const reviewer = policy.reviewers.find(item => item.issuerId === approval.issuerId && item.keyId === approval.keyId
    && item.actions.includes("first-postgres-write"));
  const verifier = policy.collectors.find(item => item.issuerId === policy.postgresRollbackVerifier?.issuerId
    && item.keyId === policy.postgresRollbackVerifier.keyId);
  need(reviewer && verifier && reviewer.publicKeyBase64 !== verifier.publicKeyBase64);
  if (!reviewer || !policy.closureTrust) throw new Error("production_compatibility_missing_authority");
  const key = createPublicKey({ key: Buffer.from(reviewer.publicKeyBase64, "base64"), format: "der", type: "spki" });
  const approvedKey = createPublicKey(policy.closureTrust.authorizationPublicKeyPem);
  need(key.asymmetricKeyType === "ed25519" && approvedKey.asymmetricKeyType === "ed25519"
    && key.export({ type: "spki", format: "der" }).equals(approvedKey.export({ type: "spki", format: "der" })));
  need(typeof approval.signatureBase64 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(approval.signatureBase64)
    && verify(null, Buffer.from(productionCompatibilityApprovalPayload(approval)), key, Buffer.from(approval.signatureBase64, "base64")));
}
