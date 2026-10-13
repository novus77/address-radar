import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { expect, test } from "vitest";
import { migrationCutoverDigest } from "./migration-cutover-coordinator.js";
import { productionCompatibilityApprovalPayload, verifyProductionCompatibilityApproval } from "./migration-production-compatibility-approval.js";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const reviewer = { issuerId: "operator", keyId: "key", actions: ["first-postgres-write"],
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const target = { database: "address_radar", schema: "address_radar_business", serverAddress: "127.0.0.1", serverPort: 5432, systemIdentifier: "7693392208475083526" };
  const now = Date.parse("2026-10-08T00:00:10.000Z");
  const policy: any = { version: 2, evidenceMode: "production-observation", binding: { target, rollbackTarget: { ...target } }, reviewers: [reviewer],
    closureTrust: { authorizationPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
    postgresRollbackVerifier: { issuerId: "independent", keyId: "other" }, collectors: [{ issuerId: "independent", keyId: "other", publicKeyBase64: "different" }],
    deadlines: { windowStart: "2026-10-08T00:00:00.000Z", windowEnd: "2026-10-08T00:01:00.000Z", maximumOperationMs: 60000 } };
  const program: any = { cases: [], guards: [], rollbackProbe: {} };
  const approval: any = { version: 1, approvalRef: "approved-native-production-probe", issuerId: "operator", keyId: "key",
    policySha256: migrationCutoverDigest(policy, 2), programSha256: migrationCutoverDigest(program, 2),
    issuedAt: "2026-10-08T00:00:00.000Z", expiresAt: "2026-10-08T00:00:50.000Z", signatureBase64: "" };
  const seal = () => { approval.signatureBase64 = sign(null, Buffer.from(productionCompatibilityApprovalPayload(approval)), privateKey).toString("base64"); };
  seal();
  return { policy, program, approval, now, seal };
}
test("authenticates a bounded exact-target production approval", () => {
  const f = fixture(); expect(() => verifyProductionCompatibilityApproval(f)).not.toThrow();
});
test("rejects changed program and target without a new signature", () => {
  const f = fixture(); f.program.cases.push({ changed: true });
  expect(() => verifyProductionCompatibilityApproval(f)).toThrow();
  const g = fixture(); g.policy.binding.target.serverPort = 5434;
  expect(() => verifyProductionCompatibilityApproval(g)).toThrow();
});
test("rejects expiration, unknown fields and unsupported signer", () => {
  const f = fixture(); f.now += 60000; expect(() => verifyProductionCompatibilityApproval(f)).toThrow();
  const g = fixture(); g.approval.extra = true; expect(() => verifyProductionCompatibilityApproval(g)).toThrow();
  const h = fixture(); h.approval.issuerId = "unknown"; h.seal(); expect(() => verifyProductionCompatibilityApproval(h)).toThrow();
});
test("rejects signer key substitution and non-independent verifier", () => {
  const f = fixture(); const other = generateKeyPairSync("ed25519");
  f.policy.closureTrust.authorizationPublicKeyPem = createPublicKey(createPrivateKey(other.privateKey.export({ type: "pkcs8", format: "pem" }))).export({ type: "spki", format: "pem" }).toString();
  expect(() => verifyProductionCompatibilityApproval(f)).toThrow();
  const g = fixture(); g.policy.collectors[0].publicKeyBase64 = g.policy.reviewers[0].publicKeyBase64;
  g.approval.policySha256 = migrationCutoverDigest(g.policy, 2); g.seal();
  expect(() => verifyProductionCompatibilityApproval(g)).toThrow();
});

test("production collector stops when scoped approval expires during probing", async () => {
  const { collectNativeProductionPostgresCompatibility } = await import("./migration-native-compatibility-collector.js");
  const { POSTGRES_COMPATIBILITY_GUARD_CHECKS } = await import("./migration-cutover-coordinator.js");
  const f = fixture();
  for (const target of [f.policy.binding.target, f.policy.binding.rollbackTarget]) {
    target.generation = "new"; target.schemaSha256 = "a".repeat(64);
  }
  f.policy.postgresRollbackCatalog = [{ table: "sample", operations: ["insert"] }];
  f.policy.budgets = { maximumSqlStatements: 100 };
  const statement = { sql: "SELECT 1", values: [] };
  f.program.cases = [{ table: "sample", operation: "insert", candidate: { sql: "INSERT INTO sample VALUES ($1)", values: [1] },
    compatibleRead: statement, expectedReadSha256: "a".repeat(64), compatibleWrite: { sql: "INSERT INTO sample VALUES ($1)", values: [2] } }];
  f.program.guards = POSTGRES_COMPATIBILITY_GUARD_CHECKS.map(check => ({ check, precondition: statement,
    preconditionSha256: "a".repeat(64), attempt: statement, expectedSqlState: null,
    preserved: statement, preservedSha256: "a".repeat(64) }));
  f.approval.policySha256 = migrationCutoverDigest(f.policy, 2);
  f.approval.programSha256 = migrationCutoverDigest(f.program, 2);
  f.seal();
  let writes = 0;
  const runtime: any = { probe: async () => {
    f.now = Date.parse(f.approval.expiresAt);
    return { ...f.policy.binding.target, schemaFingerprint: "a".repeat(64) };
  }, run: async () => { writes++; throw new Error("unexpected-write"); } };
  await expect(collectNativeProductionPostgresCompatibility({ policy: f.policy, program: f.program,
    approval: f.approval, candidate: runtime, compatible: runtime,
    clock: () => f.now, deadline: Date.parse(f.policy.deadlines.windowEnd),
    reconcileCommitUnknown: async () => { throw new Error("unexpected-reconciliation"); } })).rejects.toThrow("original-budget");
  expect(writes).toBe(0);
});
