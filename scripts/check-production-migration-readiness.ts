import { evaluateProductionMigrationReadiness } from "../packages/database/src/production-migration-readiness.js";
import {
  createProductionMigrationArtifactVerifier, productionMigrationArtifactCanonicalJson,
  readProtectedMigrationArtifactFile, type ProductionMigrationArtifactVerifier,
} from "../packages/database/src/production-migration-artifact-verifier.js";

// Validation of saved files only. No connections, service startup, writes or signals.
const required = ["--manifest", "--trusted-reviewer", "--trusted-key-id", "--trusted-public-key-base64", "--max-age-ms",
  "--max-manifest-bytes", "--max-json-depth", "--max-read-ms", "--max-path-depth", "--trusted-file-owner-uids"];
const artifacts = ["--artifact-policy", "--artifact-policy-sha256", "--artifact-root", "--trusted-artifact-reviewer",
  "--trusted-artifact-key-id", "--trusted-artifact-public-key-base64", "--max-policy-bytes"];
const allowed = new Set([...required, ...artifacts]);

async function main() {
  try {
    const args = process.argv.slice(2), values = new Map<string, string>();
    if (args.length % 2 !== 0) throw new Error("Invalid arguments");
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!, value = args[i + 1]!;
      if (!allowed.has(flag) || values.has(flag) || !value.trim()) throw new Error("Invalid arguments");
      values.set(flag, value);
    }
    const artifactCount = artifacts.filter(flag => values.has(flag)).length;
    if (required.some(flag => !values.has(flag)) || artifactCount !== 0 && artifactCount !== artifacts.length) throw new Error("Missing policy");
    const positive = (flag: string) => {
      const text = values.get(flag)!;
      if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Invalid budget");
      return Number(text);
    };
    const maxEvidenceAgeMs = positive("--max-age-ms"), maxJsonDepth = positive("--max-json-depth"), maxReadMs = positive("--max-read-ms"), maxPathDepth = positive("--max-path-depth");
    if (maxReadMs > 60000 || maxJsonDepth > 64 || maxPathDepth > 64) throw new Error("Invalid budget");
    const ownerText = values.get("--trusted-file-owner-uids")!;
    if (!/^(0|[1-9][0-9]*)(,(0|[1-9][0-9]*))*$/.test(ownerText)) throw new Error("Invalid owner pins");
    const trustedOwnerUids = ownerText.split(",").map(Number);
    if (trustedOwnerUids.some(uid => !Number.isSafeInteger(uid)) || new Set(trustedOwnerUids).size !== trustedOwnerUids.length) throw new Error("Invalid owner pins");
    const read = (path: string, maximum: number) => readProtectedMigrationArtifactFile({ path, trustedOwnerUids,
      maxBytes: String(maximum), retainBytes: true, maxRetainedBytes: maximum, maxReadMs, maxPathDepth });
    const manifestFile = await read(values.get("--manifest")!, positive("--max-manifest-bytes"));
    const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes!));
    // Byte canonicalization prevents duplicate-key/toJSON/digest interpretation mismatches.
    if (!Buffer.from(productionMigrationArtifactCanonicalJson(manifest, maxJsonDepth)).equals(Buffer.from(manifestFile.bytes!))) throw new Error("Noncanonical manifest");
    const trustedReviewers = [{ reviewer: values.get("--trusted-reviewer")!, keyId: values.get("--trusted-key-id")!, publicKeyBase64: values.get("--trusted-public-key-base64")! }];
    let verifier: ProductionMigrationArtifactVerifier | undefined;
    if (artifactCount !== 0) {
      const maxBootstrapBytes = positive("--max-policy-bytes"), policyFile = await read(values.get("--artifact-policy")!, maxBootstrapBytes);
      verifier = await createProductionMigrationArtifactVerifier({ policyBytes: policyFile.bytes!, policySha256: values.get("--artifact-policy-sha256")!,
        manifest, artifactRoot: values.get("--artifact-root")!, maxBootstrapBytes, maxJsonDepth, maxReadMs, maxEvidenceAgeMs, trustedOwnerUids,
        trustedReviewers: [{ reviewer: values.get("--trusted-artifact-reviewer")!, keyId: values.get("--trusted-artifact-key-id")!, publicKeyBase64: values.get("--trusted-artifact-public-key-base64")! }],
        manifestApprovalPublicKeys: trustedReviewers.map(key => key.publicKeyBase64), clock: () => new Date().toISOString() });
    }
    const result = evaluateProductionMigrationReadiness(manifest, { now: new Date().toISOString(), maxEvidenceAgeMs, trustedReviewers,
      ...(verifier ? { externalTrust: verifier.externalTrust } : {}) });
    process.stdout.write(JSON.stringify({ ...result, ...(verifier ? { artifacts: verifier.report } : {}) }) + "\n");
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    // Never echo paths, JSON, credentials, key material, signed inputs or exceptions.
    process.stdout.write(JSON.stringify({ version: 1, validationOnly: true, productionAuthorized: false, ready: false, error: "INVALID_INPUT" }) + "\n");
    process.exitCode = 2;
  }
}
void main();
