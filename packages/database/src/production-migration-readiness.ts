import { createHash, createPublicKey, verify } from "node:crypto";

export type MigrationAcceptance = "preservation" | "operationalCutover" | "businessActivation";
export type MigrationApprovalScope = MigrationAcceptance | "purge";
export type MigrationGateId =
  | "G01" | "G02" | "G03" | "G04" | "G05" | "G06" | "G07" | "G08"
  | "G09" | "G10" | "G11" | "G12" | "G13" | "G14" | "G15" | "G16"
  | "G17" | "G18" | "G19" | "G20" | "G21" | "G22" | "G23";

export const EXPECTED_PRODUCTION_SERVICES = [
  "address-radar-scanner.service", "address-radar-automation.service",
  "address-radar-wallet-monitor.service", "address-radar-wallet-analysis.service",
  "address-radar-historical-backfill.service", "address-radar-console.service",
] as const;
export const EXPECTED_PRODUCTION_TIMERS = [
  "address-radar-fomo-verification-sync.timer", "address-radar-backup.timer",
] as const;
export const EXPECTED_PRODUCTION_INPUT_SERVICES = [
  "address-radar-fomo-verification-sync.service", "address-radar-backup.service",
] as const;
export const PRODUCTION_MIGRATION_SERVICE_IDS = [
  "scanner", "automation", "wallet-monitor", "wallet-analysis", "historical-backfill", "console",
] as const;
export type MigrationServiceId = typeof PRODUCTION_MIGRATION_SERVICE_IDS[number];
export interface MigrationBusinessRole {
  name: string;
  service: MigrationServiceId | null;
  access: "migration" | "runtime" | "read";
  connectionLimit: number;
  superuser: boolean;
  leastPrivilegeProved: boolean;
}

// Each requirement belongs to one acceptance boundary; legacy activation gaps
// must not accidentally veto lossless historical preservation.
export const PRODUCTION_MIGRATION_REQUIREMENTS = [
  { gateId: "G01", check: "exact-ddl", acceptance: "preservation" },
  { gateId: "G02", check: "immutable-snapshot", acceptance: "preservation" },
  { gateId: "G02", check: "safe-online-backup", acceptance: "preservation" },
  { gateId: "G02", check: "readonly-restore", acceptance: "preservation" },
  { gateId: "G03", check: "lossless-all-tables", acceptance: "preservation" },
  { gateId: "G04", check: "reference-crosswalk", acceptance: "preservation" },
  { gateId: "G04", check: "protected-ledgers", acceptance: "preservation" },
  { gateId: "G05", check: "production-roles", acceptance: "operationalCutover" },
  { gateId: "G06", check: "measured-capacity", acceptance: "operationalCutover" },
  { gateId: "G07", check: "typed-schema", acceptance: "preservation" },
  { gateId: "G08", check: "atomic-import-resume", acceptance: "preservation" },
  { gateId: "G09", check: "preserve-identities", acceptance: "preservation" },
  { gateId: "G09", check: "active-cohort", acceptance: "businessActivation" },
  { gateId: "G10", check: "preserve-market-history", acceptance: "preservation" },
  { gateId: "G10", check: "active-market-proof", acceptance: "businessActivation" },
  { gateId: "G11", check: "production-entrypoints", acceptance: "operationalCutover" },
  { gateId: "G12", check: "atomic-consumers", acceptance: "operationalCutover" },
  { gateId: "G12", check: "generation-leases", acceptance: "operationalCutover" },
  { gateId: "G12", check: "fair-work", acceptance: "operationalCutover" },
  { gateId: "G12", check: "committed-consumers", acceptance: "businessActivation" },
  { gateId: "G13", check: "external-coverage", acceptance: "businessActivation" },
  { gateId: "G14", check: "final-boundary", acceptance: "operationalCutover" },
  { gateId: "G15", check: "complete-writer-fence", acceptance: "operationalCutover" },
  { gateId: "G16", check: "queue-cursor-handoff", acceptance: "operationalCutover" },
  { gateId: "G17", check: "preserved-consumption-guards", acceptance: "preservation" },
  { gateId: "G17", check: "delivery-idempotency", acceptance: "operationalCutover" },
  { gateId: "G17", check: "readiness-risk", acceptance: "businessActivation" },
  { gateId: "G18", check: "rollback-before-writes", acceptance: "operationalCutover" },
  { gateId: "G18", check: "rollback-after-writes", acceptance: "operationalCutover" },
  { gateId: "G19", check: "preservation-retention", acceptance: "preservation" },
  { gateId: "G19", check: "excluded-purge-jobs", acceptance: "operationalCutover" },
  { gateId: "G20", check: "pg-console-trace", acceptance: "operationalCutover" },
  { gateId: "G21", check: "all-table-fault-tests", acceptance: "preservation" },
  { gateId: "G21", check: "full-suite-and-types", acceptance: "operationalCutover" },
  { gateId: "G21", check: "real-isolated-pg-tests", acceptance: "operationalCutover" },
  { gateId: "G21", check: "business-tests", acceptance: "businessActivation" },
  { gateId: "G22", check: "real-wallet-e2e", acceptance: "businessActivation" },
  { gateId: "G22", check: "natural-two-trader", acceptance: "businessActivation" },
  { gateId: "G23", check: "manifest-preservation-approval", acceptance: "preservation" },
  { gateId: "G23", check: "manifest-cutover-approval", acceptance: "operationalCutover" },
  { gateId: "G23", check: "manifest-activation-approval", acceptance: "businessActivation" },
] as const satisfies ReadonlyArray<{ gateId: MigrationGateId; check: string; acceptance: MigrationAcceptance }>;
export type MigrationEvidenceCheck = typeof PRODUCTION_MIGRATION_REQUIREMENTS[number]["check"];
export type MigrationArtifactCheck = MigrationEvidenceCheck | "purge-dry-run";

export interface MigrationPurgeScope {
  operationId: string;
  targetId: string;
  generation: string;
  snapshotSha256: string;
  protectedExclusionSha256: string;
  dryRunArtifactSha256: string;
  selectors: Array<{ table: string; partitionId: string; cutoffExclusive: string; expectedRows: string; selectionSha256: string }>;
}
export interface MigrationExpectedContext {
  observedAt: string;
  identity: MigrationIdentity;
  sourceTables: string[];
  writerInventory: Array<{ kind: "services" | "timers" | "operators" | "deploy" | "usercron" | "externalInputs"; members: string[] }>;
  purgeScope?: MigrationPurgeScope;
}
export interface MigrationArtifactVerificationRequest {
  check: MigrationArtifactCheck;
  artifactSha256: string;
  claimsSha256: string;
  identity: MigrationIdentity;
}
export interface VerifiedMigrationArtifact {
  bytes: Uint8Array;
  verifierId: string;
  verifiedAt: string;
  assertionsPassed: boolean;
}
export interface MigrationExternalTrust {
  expected: MigrationExpectedContext;
  trustedArtifactVerifierIds: string[];
  // The embedding supplies this independent verifier, never the manifest.
  // It must check actual test/assertion results, not echo receipt booleans.
  verifyArtifact: (request: Readonly<MigrationArtifactVerificationRequest>) => VerifiedMigrationArtifact | null;
}

export interface MigrationIdentity {
  snapshotId: string;
  snapshotSha256: string;
  sourceId: string;
  sourceSchemaSha256: string;
  targetId: string;
  targetSchemaSha256: string;
  generation: string;
  releaseSha256: string;
}
export interface MigrationEvidence {
  status: "passed" | "blocked" | "unknown";
  owner: string;
  artifactSha256: string;
  identity: MigrationIdentity;
  observedAt: string;
  test: { name: string; status: "passed" | "failed" | "unknown"; executedAt: string; skipped: boolean };
}
export interface MigrationApproval {
  scope: MigrationApprovalScope;
  manifestSha256: string;
  reviewer: string;
  keyId: string;
  decision: "approved" | "rejected";
  issuedAt: string;
  expiresAt: string;
  signatureBase64: string;
}
export interface MigrationTableAccounting {
  table: string;
  destination: string;
  sourceRows: string;
  preservedRows: string;
  quarantinedRows: string;
  sourceSha256: string;
  retainedSha256: string;
  quarantineLossless: boolean;
  retrievalTestPassed: boolean;
}
export interface ProductionMigrationReadinessManifest {
  version: 1;
  createdAt: string;
  expiresAt: string;
  identity: MigrationIdentity;
  scope: {
    cohortId: string; snapshotWatermark: string; watermark: string; rollbackTarget: string;
    maintenanceWindow: { start: string; end: string };
  };
  safety: {
    deliveryEnabled: boolean; fomoCaptureEnabled: boolean;
    historicalMiningEnabled: boolean; automaticOwnerMergeEnabled: boolean;
  };
  evidence: Partial<Record<MigrationArtifactCheck, MigrationEvidence>>;
  tables: { reviewedSourceTables: string[]; entries: MigrationTableAccounting[] };
  roles: MigrationBusinessRole[];
  capacity: {
    pools: Array<{ service: MigrationServiceId; instances: number; maxPerInstance: number }>;
    migrationConnections: number; operatorConnections: number; backupConnections: number;
    postgresReservedConnections: number; postgresMaxConnections: number;
    databaseConnectionLimit: number; otherHostConnections: number;
    availableRamBytes: string; measuredPeakRamBytes: string; ramReserveBytes: string;
    availableDiskBytes: string; measuredPeakDiskBytes: string; measuredPeakWalBytes: string;
    measuredPeakTempBytes: string; diskReserveBytes: string; pressureAcceptancePassed: boolean;
  };
  writerFence: {
    generation: string; sourceId: string; enforcedAt: string; validUntil: string;
    mechanism: "generation-rejection-and-input-barrier";
    staleWriteRejected: boolean; newWriterAdmissionBlocked: boolean;
    inventory: Array<{ kind: "services" | "timers" | "operators" | "deploy" | "usercron" | "externalInputs";
      members: string[]; complete: boolean; fenced: boolean }>;
  };
  finalBoundary: {
    mode: "delta" | "full-fenced-snapshot"; snapshotId: string; snapshotSha256: string;
    generation: string; completedAt: string; watermark: string; allTables: string[]; gapFree: boolean;
    delta?: { fromWatermark: string; toWatermark: string; continuous: boolean; allMutationKindsIncluded: boolean };
  };
  rollback: {
    target: string; generation: string; strategy: "reverse-delta" | "compatible-postgres-release";
    compatibleReleaseSha256?: string; journalStartedAt: string; firstNewWriteAt: string;
    durable: boolean; continuous: boolean; retainedInputAndMutations: boolean;
    beforeWrites: { testedAt: string; artifactSha256: string; parityPassed: boolean; commitUnknownReconciled: boolean };
    afterWrites: { testedAt: string; artifactSha256: string; parityPassed: boolean; commitUnknownReconciled: boolean; newWritesRecovered: boolean };
  };
  business: {
    cohortId: string; watermark: string; explicitlySelected: boolean; oldMarketProofComplete: boolean;
    coverageIntervalsProved: boolean; scopeExcludesFomo: boolean; realEventIds: string[];
    naturalTwoTraderCase: boolean; committedConsumerReceipts: boolean; confirmedPolicyPassed: boolean;
  };
  retention: {
    nonDestructiveImport: boolean; protectedEvidenceRetained: boolean; rawHotDays: number;
    purchaseProofDays: number; purgeJobsExcluded: boolean; purgeRequested: boolean;
  };
  approvals: MigrationApproval[];
  purgeScope?: MigrationPurgeScope;
}
export interface ReadinessEvaluationOptions {
  now: string;
  maxEvidenceAgeMs: number;
  trustedReviewers: ReadonlyArray<{ keyId: string; reviewer: string; publicKeyBase64: string }>;
  externalTrust?: MigrationExternalTrust;
}
export interface MigrationReadinessBlocker { gateId: MigrationGateId | null; code: string }
export interface MigrationReadinessGate { ready: boolean; blockers: MigrationReadinessBlocker[] }
export interface ProductionMigrationReadinessResult {
  version: 1;
  validationOnly: true;
  productionAuthorized: false;
  ready: boolean;
  gates: Record<MigrationAcceptance, MigrationReadinessGate>;
  purge: MigrationReadinessGate;
  checks: Array<{ gateId: MigrationGateId; check: MigrationEvidenceCheck; acceptance: MigrationAcceptance; ready: boolean }>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function decimal(value: unknown): bigint | undefined {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  return new Date(time).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z") ? time : NaN;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = record(value);
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Non-JSON value");
  return serialized;
}

// Inspect data descriptors before serialization: getters/toJSON must never run.
// The resulting inert copy is both hashed and evaluated, with no coercive normalization.
function plainJsonSnapshot(value: unknown): unknown {
  const active = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item !== "object" || active.has(item)) throw new Error("Non-plain JSON");
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) throw new Error("Non-plain JSON");
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== "string" || key === "toJSON")) throw new Error("Non-plain JSON");
    active.add(item);
    try {
      const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
      const length = array ? (item as unknown[]).length : 0;
      if (array && keys.length !== length + 1) throw new Error("Sparse or extended array");
      for (const key of keys as string[]) {
        if (array && key === "length") continue;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw new Error("Extended array");
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Non-plain JSON");
        Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { active.delete(item); }
  };
  // Reconstruct standard JSON objects without consulting the original object's hooks.
  return JSON.parse(canonical(visit(value)));
}

/** Digest of strict plain JSON manifest content, excluding all approvals. */
export function productionMigrationManifestDigest(manifest: unknown): string {
  const snapshot = plainJsonSnapshot(manifest);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Manifest must be an object");
  const normalized = record(snapshot);
  const { approvals: _approvals, ...content } = normalized;
  return createHash("sha256").update(canonical(content)).digest("hex");
}
/** Exact UTF-8 payload to sign with an out-of-band trusted Ed25519 key. */
export function productionMigrationApprovalPayload(approval: Omit<MigrationApproval, "signatureBase64"> | MigrationApproval): string {
  const snapshot = plainJsonSnapshot(approval);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Approval must be an object");
  approval = snapshot as MigrationApproval;
  return canonical({
    scope: approval.scope, manifestSha256: approval.manifestSha256, reviewer: approval.reviewer,
    keyId: approval.keyId, decision: approval.decision, issuedAt: approval.issuedAt, expiresAt: approval.expiresAt,
  });
}

/** Binds independently checked artifact assertions to their acceptance-specific claims. */
export function productionMigrationArtifactClaimsDigest(manifest: unknown, check: MigrationArtifactCheck): string {
  return artifactClaimsDigestFromSnapshot(record(plainJsonSnapshot(manifest)), check);
}
function artifactClaimsDigestFromSnapshot(m: Record<string, unknown>, check: MigrationArtifactCheck): string {
  const scope = record(m.scope), retention = record(m.retention);
  const acceptance = PRODUCTION_MIGRATION_REQUIREMENTS.find(requirement => requirement.check === check)?.acceptance;
  if (!acceptance && check !== "purge-dry-run") throw new Error("Unknown artifact check");
  const claims: Record<string, unknown> = { check, identity: m.identity, createdAt: m.createdAt, expiresAt: m.expiresAt, safety: m.safety };
  if (acceptance === "preservation") {
    claims.scope = { snapshotWatermark: scope.snapshotWatermark };
    claims.tables = m.tables;
    claims.retention = { nonDestructiveImport: retention.nonDestructiveImport, protectedEvidenceRetained: retention.protectedEvidenceRetained,
      rawHotDays: retention.rawHotDays, purchaseProofDays: retention.purchaseProofDays };
  } else if (acceptance === "businessActivation") {
    claims.scope = { cohortId: scope.cohortId, watermark: scope.watermark };
    claims.business = m.business;
  } else {
    claims.scope = { snapshotWatermark: scope.snapshotWatermark, watermark: scope.watermark, rollbackTarget: scope.rollbackTarget,
      maintenanceWindow: scope.maintenanceWindow };
    for (const key of ["roles", "capacity", "writerFence", "finalBoundary"]) claims[key] = m[key];
    const rollback = record(m.rollback);
    const { artifactSha256: _beforeDigest, ...beforeClaims } = record(rollback.beforeWrites);
    const { artifactSha256: _afterDigest, ...afterClaims } = record(rollback.afterWrites);
    claims.rollback = { ...rollback, beforeWrites: beforeClaims, afterWrites: afterClaims };
    claims.retention = { purgeJobsExcluded: retention.purgeJobsExcluded };
    if (check === "purge-dry-run") {
      // The dry-run digest cannot include its own artifact digest.
      const { dryRunArtifactSha256: _dryRunDigest, ...purgeClaims } = record(m.purgeScope);
      claims.purgeScope = purgeClaims;
    }
  }
  return createHash("sha256").update(canonical(claims)).digest("hex");
}

const identityFields = ["snapshotId", "snapshotSha256", "sourceId", "sourceSchemaSha256", "targetId", "targetSchemaSha256", "generation", "releaseSha256"] as const;
function identityValid(value: unknown): boolean {
  const identity = record(value);
  return Object.keys(identity).length === identityFields.length && identityFields.every(field =>
    field.endsWith("Sha256") ? digest(identity[field]) : text(identity[field]));
}
function identityMatches(value: unknown, expected: unknown): boolean {
  const a = record(value), b = record(expected);
  return identityValid(a) && identityValid(b) && identityFields.every(field => a[field] === b[field]);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}
function sameSet(a: unknown, b: unknown): boolean {
  return strings(a) && strings(b) && a.length === b.length && a.every(item => b.includes(item));
}

/** Pure saved-artifact evaluation. It never queries databases, changes writers, or delivers events. */
export function evaluateProductionMigrationReadiness(input: unknown, options: ReadinessEvaluationOptions): ProductionMigrationReadinessResult {
  const result: ProductionMigrationReadinessResult = {
    version: 1, validationOnly: true, productionAuthorized: false, ready: false,
    gates: { preservation: { ready: false, blockers: [] }, operationalCutover: { ready: false, blockers: [] }, businessActivation: { ready: false, blockers: [] } },
    purge: { ready: false, blockers: [] }, checks: [],
  };
  const acceptances: MigrationAcceptance[] = ["preservation", "operationalCutover", "businessActivation"];
  const add = (acceptance: MigrationAcceptance, gateId: MigrationGateId | null, code: string) => {
    result.gates[acceptance].blockers.push({ gateId, code });
  };
  const common = (code: string) => { for (const acceptance of acceptances) add(acceptance, null, code); };
  let snapshot: unknown;
  try { snapshot = plainJsonSnapshot(input); } catch {
    common("NON_PLAIN_JSON_MANIFEST");
    result.purge.blockers.push({ gateId: null, code: "NON_PLAIN_JSON_MANIFEST" });
    result.checks = PRODUCTION_MIGRATION_REQUIREMENTS.map(requirement => ({ ...requirement, ready: false }));
    return result;
  }
  const m = record(snapshot), policy = record(options), now = timestamp(policy.now);
  const maxAge = policy.maxEvidenceAgeMs;
  const fresh = (value: unknown) => {
    const time = timestamp(value);
    return positive(maxAge) && Number.isFinite(now) && time <= now && now - time <= maxAge;
  };
  const created = timestamp(m.createdAt), expires = timestamp(m.expiresAt);
  const scope = record(m.scope), evidence = record(m.evidence), identity = record(m.identity);
  const external = record(policy.externalTrust);
  let expected: Record<string, unknown> = {};
  try { expected = record(plainJsonSnapshot(external.expected)); } catch { /* Missing or malformed external trust fails closed below. */ }
  if (!fresh(expected.observedAt) || !identityMatches(identity, expected.identity) ||
      !strings(expected.sourceTables) || expected.sourceTables.length !== 141 ||
      !strings(external.trustedArtifactVerifierIds) || external.trustedArtifactVerifierIds.length === 0 ||
      typeof external.verifyArtifact !== "function") common("TRUSTED_EXTERNAL_CONTEXT_AND_VERIFIER_REQUIRED");
  const reviewers = list(policy.trustedReviewers);
  if (!positive(maxAge) || !Number.isFinite(now) || reviewers.length === 0 || reviewers.some(value => {
    const reviewer = record(value);
    return !text(reviewer.keyId) || !text(reviewer.reviewer) || !text(reviewer.publicKeyBase64);
  }) || new Set(reviewers.map(value => record(value).keyId)).size !== reviewers.length) common("INVALID_EVALUATION_POLICY");
  if (m.version !== 1 || !identityValid(identity) || !fresh(m.createdAt) || !(expires > now && expires > created) ||
      !text(scope.snapshotWatermark)) common("INVALID_OR_STALE_MANIFEST");
  if (!text(scope.watermark) || !text(scope.rollbackTarget)) add("operationalCutover", "G23", "EXACT_CUTOVER_SCOPE_REQUIRED");
  if (!text(scope.cohortId)) add("businessActivation", "G23", "EXACT_ACTIVATION_SCOPE_REQUIRED");
  const safety = record(m.safety);
  if (["deliveryEnabled", "fomoCaptureEnabled", "historicalMiningEnabled", "automaticOwnerMergeEnabled"].some(key => safety[key] !== false)) common("UNSAFE_OR_UNKNOWN_ACTIVATION_FLAGS");

  const evidenceValid = (value: unknown, check: MigrationArtifactCheck) => {
    const receipt = record(value), test = record(receipt.test);
    const receiptValid = receipt.status === "passed" && text(receipt.owner) && digest(receipt.artifactSha256) &&
      identityMatches(receipt.identity, identity) && fresh(receipt.observedAt) && timestamp(receipt.observedAt) <= created &&
      text(test.name) && test.status === "passed" && test.skipped === false && fresh(test.executedAt) &&
      timestamp(test.executedAt) <= timestamp(receipt.observedAt);
    if (!receiptValid || typeof external.verifyArtifact !== "function") return false;
    try {
      const claimsSha256 = artifactClaimsDigestFromSnapshot(m, check);
      const request: MigrationArtifactVerificationRequest = {
        check, artifactSha256: receipt.artifactSha256 as string, claimsSha256,
        identity: plainJsonSnapshot(expected.identity) as MigrationIdentity,
      };
      const verified = record((external.verifyArtifact as MigrationExternalTrust["verifyArtifact"])(request));
      if (!(verified.bytes instanceof Uint8Array) || verified.assertionsPassed !== true || !fresh(verified.verifiedAt) ||
          timestamp(verified.verifiedAt) < timestamp(receipt.observedAt) ||
          !list(external.trustedArtifactVerifierIds).includes(verified.verifierId)) return false;
      const bytes = Buffer.from(verified.bytes);
      if (createHash("sha256").update(bytes).digest("hex") !== receipt.artifactSha256) return false;
      const artifact = record(plainJsonSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))));
      return artifact.check === check && artifact.claimsSha256 === claimsSha256 && identityMatches(artifact.identity, expected.identity) &&
        artifact.observedAt === receipt.observedAt && canonical(artifact.test) === canonical(test);
    } catch { return false; }
  };
  for (const requirement of PRODUCTION_MIGRATION_REQUIREMENTS) {
    const ready = evidenceValid(evidence[requirement.check], requirement.check);
    result.checks.push({ ...requirement, ready });
    if (!ready) add(requirement.acceptance, requirement.gateId, `EVIDENCE_REQUIRED:${requirement.check}`);
  }

  let manifestSha256 = "";
  try { manifestSha256 = productionMigrationManifestDigest(m); } catch { common("INVALID_MANIFEST_CONTENT"); }
  const approvalValid = (acceptance: MigrationApprovalScope) => {
    const candidates = list(m.approvals).filter(value => record(value).scope === acceptance);
    // Duplicate/conflicting authorizations require reconciliation, not first-match wins.
    if (candidates.length !== 1) return false;
    const approval = record(candidates[0]);
    const trusted = reviewers.find(value => record(value).keyId === approval.keyId && record(value).reviewer === approval.reviewer);
    if (!trusted || !digest(manifestSha256) || approval.manifestSha256 !== manifestSha256 || approval.decision !== "approved" ||
        !fresh(approval.issuedAt) || timestamp(approval.issuedAt) < created || !(timestamp(approval.expiresAt) > now) ||
        timestamp(approval.expiresAt) > expires || !text(approval.signatureBase64)) return false;
    try {
      const publicKey = createPublicKey({ key: Buffer.from(String(record(trusted).publicKeyBase64), "base64"), type: "spki", format: "der" });
      const signature = Buffer.from(approval.signatureBase64, "base64");
      return publicKey.asymmetricKeyType === "ed25519" && signature.length === 64 && signature.toString("base64") === approval.signatureBase64 &&
        verify(null, Buffer.from(productionMigrationApprovalPayload(approval as unknown as MigrationApproval)), publicKey, signature);
    } catch { return false; }
  };
  for (const acceptance of acceptances) if (!approvalValid(acceptance)) add(acceptance, "G23", "VALID_SCOPED_APPROVAL_REQUIRED");

  const tables = record(m.tables), entries = list(tables.entries);
  const reviewed = tables.reviewedSourceTables;
  // The approved source catalog contains 141 tables. Drift needs a newly reviewed plan.
  if (!strings(reviewed) || reviewed.length !== 141 || !sameSet(reviewed, expected.sourceTables) || !sameSet(entries.map(value => record(value).table), reviewed) || entries.some(value => {
    const table = record(value), source = decimal(table.sourceRows), preserved = decimal(table.preservedRows), quarantined = decimal(table.quarantinedRows);
    return !text(table.destination) || source === undefined || preserved === undefined || quarantined === undefined ||
      source !== preserved + quarantined || !digest(table.sourceSha256) || table.sourceSha256 !== table.retainedSha256 ||
      table.quarantineLossless !== true || table.retrievalTestPassed !== true;
  })) add("preservation", "G03", "LOSSLESS_ALL_TABLE_ACCOUNTING_REQUIRED");

  const retention = record(m.retention);
  if (retention.nonDestructiveImport !== true || retention.protectedEvidenceRetained !== true || retention.rawHotDays !== 15 ||
      !positive(retention.purchaseProofDays) || retention.purchaseProofDays < 30) add("preservation", "G19", "PROTECTED_RETENTION_REQUIRED");
  if (retention.purgeJobsExcluded !== true) add("operationalCutover", "G19", "PURGE_JOBS_MUST_BE_EXCLUDED");

  const roles = list(m.roles).map(record);
  const migrationRoles = roles.filter(role => role.service === null);
  const serviceRoles = roles.filter(role => role.service !== null);
  const rolesValid = roles.length === PRODUCTION_MIGRATION_SERVICE_IDS.length + 1 && migrationRoles.length === 1 &&
    migrationRoles[0]!.access === "migration" && sameSet(serviceRoles.map(role => role.service), [...PRODUCTION_MIGRATION_SERVICE_IDS]) &&
    strings(roles.map(role => role.name)) && roles.every(role =>
      typeof role.name === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(role.name) &&
      !/(?:^|_)(?:acceptance|test)(?:_|$)/i.test(role.name) && !role.name.startsWith("pg_") && role.name !== "postgres" &&
      positive(role.connectionLimit) && role.superuser === false && role.leastPrivilegeProved === true) &&
    serviceRoles.every(role => role.access === (role.service === "console" ? "read" : "runtime"));
  if (!rolesValid) add("operationalCutover", "G05", "DEDICATED_LEAST_PRIVILEGE_ROLES_REQUIRED");

  const capacity = record(m.capacity), pools = list(capacity.pools).map(record);
  const connectionFields = ["migrationConnections", "operatorConnections", "backupConnections", "postgresReservedConnections", "postgresMaxConnections", "databaseConnectionLimit"];
  let capacityValid = rolesValid && connectionFields.every(field => positive(capacity[field])) &&
    typeof capacity.otherHostConnections === "number" && Number.isSafeInteger(capacity.otherHostConnections) && capacity.otherHostConnections >= 0 &&
    sameSet(pools.map(pool => pool.service), [...PRODUCTION_MIGRATION_SERVICE_IDS]) &&
    pools.every(pool => positive(pool.instances) && positive(pool.maxPerInstance) && pool.maxPerInstance <= 64);
  if (capacityValid) {
    const poolTotal = pools.reduce((sum, pool) => sum + BigInt(pool.instances as number) * BigInt(pool.maxPerInstance as number), 0n);
    const migration = BigInt(capacity.migrationConnections as number), operators = BigInt(capacity.operatorConnections as number), backup = BigInt(capacity.backupConnections as number);
    const databaseRequired = poolTotal + migration + operators + backup;
    capacityValid = pools.every(pool => {
      const role = serviceRoles.find(value => value.service === pool.service)!;
      return BigInt(role.connectionLimit as number) === BigInt(pool.instances as number) * BigInt(pool.maxPerInstance as number);
    }) && BigInt(migrationRoles[0]!.connectionLimit as number) === migration &&
      databaseRequired === BigInt(capacity.databaseConnectionLimit as number) &&
      databaseRequired + BigInt(capacity.postgresReservedConnections as number) + BigInt(capacity.otherHostConnections as number) <= BigInt(capacity.postgresMaxConnections as number);
  }
  const bytes = ["availableRamBytes", "measuredPeakRamBytes", "ramReserveBytes", "availableDiskBytes", "measuredPeakDiskBytes", "measuredPeakWalBytes", "measuredPeakTempBytes", "diskReserveBytes"];
  const measured = bytes.map(field => decimal(capacity[field]));
  if (!measured.every(value => value !== undefined && value > 0n)) capacityValid = false;
  else {
    const [ram, peakRam, reserveRam, disk, peakDisk, wal, temp, reserveDisk] = measured as bigint[];
    if (ram! < peakRam! + reserveRam! || disk! < peakDisk! + wal! + temp! + reserveDisk!) capacityValid = false;
  }
  if (!capacityValid || capacity.pressureAcceptancePassed !== true) add("operationalCutover", "G06", "MEASURED_GLOBAL_CAPACITY_BUDGET_REQUIRED");

  const window = record(scope.maintenanceWindow);
  if (!(timestamp(window.start) <= now && now < timestamp(window.end)) || timestamp(window.end) > expires) add("operationalCutover", "G23", "CURRENT_APPROVED_WINDOW_REQUIRED");
  const fence = record(m.writerFence), inventory = list(fence.inventory).map(record);
  const expectedInventory = list(expected.writerInventory).map(record);
  const inventoryKinds = ["services", "timers", "operators", "deploy", "usercron", "externalInputs"];
  if (fence.generation !== identity.generation || fence.sourceId !== identity.sourceId || !fresh(fence.enforcedAt) ||
      !(timestamp(fence.validUntil) > now) || timestamp(fence.validUntil) > expires || fence.mechanism !== "generation-rejection-and-input-barrier" ||
      fence.staleWriteRejected !== true || fence.newWriterAdmissionBlocked !== true || !sameSet(inventory.map(group => group.kind), inventoryKinds) ||
      inventory.some(group => !strings(group.members) || group.complete !== true || group.fenced !== true) ||
      !sameSet(expectedInventory.map(group => group.kind), inventoryKinds) || expectedInventory.some(group => !strings(group.members)) ||
      inventory.some(group => !sameSet(group.members, expectedInventory.find(expectedGroup => expectedGroup.kind === group.kind)?.members)) ||
      ![...EXPECTED_PRODUCTION_SERVICES, ...EXPECTED_PRODUCTION_INPUT_SERVICES].every(name => list(inventory.find(group => group.kind === "services")?.members).includes(name)) ||
      !EXPECTED_PRODUCTION_TIMERS.every(name => list(inventory.find(group => group.kind === "timers")?.members).includes(name))) {
    add("operationalCutover", "G15", "PROVED_COMPLETE_WRITER_FENCE_REQUIRED");
  }

  const boundary = record(m.finalBoundary), delta = record(boundary.delta);
  if ((boundary.mode !== "delta" && boundary.mode !== "full-fenced-snapshot") || boundary.snapshotId !== identity.snapshotId ||
      boundary.snapshotSha256 !== identity.snapshotSha256 || boundary.generation !== identity.generation || boundary.watermark !== scope.watermark ||
      !fresh(boundary.completedAt) || timestamp(boundary.completedAt) < timestamp(fence.enforcedAt) || timestamp(boundary.completedAt) > created ||
      boundary.gapFree !== true || !sameSet(boundary.allTables, reviewed) ||
      (boundary.mode === "delta" && (delta.fromWatermark !== scope.snapshotWatermark || delta.toWatermark !== scope.watermark || delta.continuous !== true || delta.allMutationKindsIncluded !== true))) {
    add("operationalCutover", "G14", "FINAL_FENCED_BOUNDARY_REQUIRED");
  }

  const rollback = record(m.rollback), before = record(rollback.beforeWrites), after = record(rollback.afterWrites);
  const journalStart = timestamp(rollback.journalStartedAt), beforeTime = timestamp(before.testedAt), firstWrite = timestamp(rollback.firstNewWriteAt), afterTime = timestamp(after.testedAt);
  if (rollback.target !== scope.rollbackTarget || rollback.generation !== identity.generation ||
      (rollback.strategy !== "reverse-delta" && rollback.strategy !== "compatible-postgres-release") ||
      (rollback.strategy === "compatible-postgres-release" && !digest(rollback.compatibleReleaseSha256)) ||
      rollback.durable !== true || rollback.continuous !== true || rollback.retainedInputAndMutations !== true ||
      !fresh(rollback.journalStartedAt) || !fresh(rollback.firstNewWriteAt) || !(journalStart <= beforeTime && beforeTime < firstWrite && firstWrite < afterTime) ||
      !fresh(before.testedAt) || !fresh(after.testedAt) || afterTime > created ||
      before.parityPassed !== true || after.parityPassed !== true || before.commitUnknownReconciled !== true || after.commitUnknownReconciled !== true ||
      after.newWritesRecovered !== true || !digest(before.artifactSha256) || !digest(after.artifactSha256) ||
      before.artifactSha256 !== record(evidence["rollback-before-writes"]).artifactSha256 || after.artifactSha256 !== record(evidence["rollback-after-writes"]).artifactSha256) {
    add("operationalCutover", "G18", "DURABLE_JOURNAL_AND_BOTH_ROLLBACK_REHEARSALS_REQUIRED");
  }

  const business = record(m.business);
  if (business.cohortId !== scope.cohortId || business.watermark !== scope.watermark || business.explicitlySelected !== true || business.scopeExcludesFomo !== true) add("businessActivation", "G09", "EXPLICIT_COHORT_REQUIRED");
  if (business.oldMarketProofComplete !== true) add("businessActivation", "G10", "ACTIVE_SAMPLE_MARKET_PROOF_REQUIRED");
  if (business.coverageIntervalsProved !== true) add("businessActivation", "G13", "REAL_COVERAGE_INTERVALS_REQUIRED");
  if (business.committedConsumerReceipts !== true) add("businessActivation", "G12", "COMMITTED_CONSUMER_RECEIPTS_REQUIRED");
  if (!strings(business.realEventIds) || business.realEventIds.length === 0 || business.naturalTwoTraderCase !== true || business.confirmedPolicyPassed !== true) add("businessActivation", "G22", "REAL_CONFIRMED_POLICY_E2E_REQUIRED");

  result.gates.preservation.ready = result.gates.preservation.blockers.length === 0;
  if (!result.gates.preservation.ready) add("operationalCutover", null, "PRESERVATION_NOT_READY");
  result.gates.operationalCutover.ready = result.gates.operationalCutover.blockers.length === 0;
  if (!result.gates.operationalCutover.ready) add("businessActivation", null, "OPERATIONAL_CUTOVER_NOT_READY");
  result.gates.businessActivation.ready = result.gates.businessActivation.blockers.length === 0;
  result.ready = acceptances.every(acceptance => result.gates[acceptance].ready);
  if (!result.gates.operationalCutover.ready) result.purge.blockers.push({ gateId: "G19", code: "OPERATIONAL_WRITE_SAFETY_NOT_READY" });
  if (retention.purgeRequested !== true) result.purge.blockers.push({ gateId: "G19", code: "PURGE_NOT_REQUESTED" });
  if (!approvalValid("purge")) result.purge.blockers.push({ gateId: "G23", code: "VALID_PURGE_APPROVAL_REQUIRED" });
  const purgeScope = record(m.purgeScope), selectors = list(purgeScope.selectors).map(record);
  if (!text(purgeScope.operationId) || purgeScope.targetId !== identity.targetId || purgeScope.generation !== identity.generation ||
      purgeScope.snapshotSha256 !== identity.snapshotSha256 || !digest(purgeScope.protectedExclusionSha256) ||
      !digest(purgeScope.dryRunArtifactSha256) || selectors.length === 0 || selectors.some(selector =>
        !list(expected.sourceTables).includes(selector.table) || !text(selector.partitionId) || selector.partitionId.includes("*") ||
        !(timestamp(selector.cutoffExclusive) <= now - 15 * 24 * 60 * 60 * 1000) || decimal(selector.expectedRows) === undefined || !digest(selector.selectionSha256)) ||
      new Set(selectors.map(selector => canonical(selector))).size !== selectors.length ||
      canonical(purgeScope) !== canonical(expected.purgeScope ?? null) ||
      purgeScope.dryRunArtifactSha256 !== record(evidence["purge-dry-run"]).artifactSha256 ||
      !evidenceValid(evidence["purge-dry-run"], "purge-dry-run")) {
    result.purge.blockers.push({ gateId: "G19", code: "EXACT_EXTERNALLY_VERIFIED_PURGE_SCOPE_REQUIRED" });
  }
  result.purge.ready = result.purge.blockers.length === 0;
  return result;
}
