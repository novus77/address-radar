import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  PRODUCTION_MIGRATION_REQUIREMENTS, productionMigrationArtifactClaimsDigest,
  type MigrationArtifactCheck, type MigrationExpectedContext, type MigrationExternalTrust,
  type MigrationIdentity, type ProductionMigrationReadinessManifest,
} from "./production-migration-readiness.js";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export interface MigrationArtifactReviewKey { reviewer: string; keyId: string; publicKeyBase64: string }
export interface MigrationArtifactReadLimits {
  maxFiles: number; maxFileBytes: string; maxTotalBytes: string; maxJsonBytes: number;
  maxRows: number; maxTables: number; maxColumns: number; maxJsonDepth: number;
  maxPathDepth: number; maxReadMs: number;
}
export type MigrationArtifactInputRole = "snapshot" | "source-schema" | "target-schema" | "release"
  | "source-catalog" | "target-catalog" | "source-records" | "retained-records" | "quarantine-records" | "backup" | "restored";
export interface MigrationArtifactFilePin { path: string; sha256: string; size: string }
export interface MigrationArtifactInputPin extends MigrationArtifactFilePin { role: MigrationArtifactInputRole }
export interface MigrationArtifactBinding {
  identity: MigrationIdentity; cohortId: string | null; snapshotWatermark: string; watermark: string;
  liveCatalogSha256: string;
  target: { database: string; schema: string; serverAddress: string; serverPort: number; systemIdentifier: string };
  maintenanceWindow: { start: string; end: string };
}
export interface MigrationArtifactSpecification {
  check: MigrationArtifactCheck; artifact: MigrationArtifactFilePin; claimsSha256: string; testName: string;
  collectorId: string; keyId: string; derivation: string; inputs: MigrationArtifactInputPin[];
}
export interface ProductionMigrationArtifactPolicy {
  version: 1; scope: "independent-artifact-review"; policyId: string; verifierId: string;
  reviewer: string; keyId: string; issuedAt: string; expiresAt: string;
  expected: MigrationExpectedContext; binding: MigrationArtifactBinding; limits: MigrationArtifactReadLimits;
  collectors: Array<{ collectorId: string; keyId: string; publicKeyBase64: string; collectorReleaseSha256: string; derivations: string[] }>;
  artifacts: MigrationArtifactSpecification[]; signatureBase64: string;
}
export interface ProductionMigrationMeasurementReceipt {
  version: 1; scope: "independent-artifact-measurement"; collectorId: string; keyId: string; collectorReleaseSha256: string;
  check: MigrationArtifactCheck; claimsSha256: string; identity: MigrationIdentity; binding: MigrationArtifactBinding;
  observedAt: string; test: { name: string; status: "passed"; executedAt: string; skipped: false };
  measurement: {
    startedAt: string; completedAt: string; derivation: string; inputs: MigrationArtifactInputPin[];
    snapshotScope: "preservation-snapshot" | "fenced-snapshot" | null;
    backupRehearsal: null | { backupStartedAt: string; backupCompletedAt: string; restoreStartedAt: string; restoreCompletedAt: string };
  };
  signatureBase64: string;
}
export type MigrationLosslessCell = { storage: "null" } | { storage: "integer"; decimal: string }
  | { storage: "real"; ieee754Hex: string } | { storage: "text" | "blob"; bytesBase64: string };
export type MigrationLosslessRow = Record<string, MigrationLosslessCell>;
export interface MigrationArtifactCheckReport {
  check: MigrationArtifactCheck; status: "verified" | "blocked" | "unknown";
  measured: string[]; pending: string[];
}
export interface ProductionMigrationArtifactVerifier {
  readonly validationOnly: true; readonly productionAuthorized: false;
  readonly externalTrust: MigrationExternalTrust;
  readonly report: { checks: MigrationArtifactCheckReport[]; filesRead: number; bytesRead: string };
}
export class MigrationArtifactVerificationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MigrationArtifactVerificationError"; }
}
function fail(code: string): never { throw new MigrationArtifactVerificationError(code); }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) fail("INVALID_BYTE_OR_ROW_COUNT");
  return BigInt(value);
}
function time(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail("INVALID_TIME");
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) fail("INVALID_TIME");
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_OBJECT");
  return value as Record<string, unknown>;
}
function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const r = record(value), actual = Object.keys(r);
  if (!required.every(key => Object.hasOwn(r, key)) || actual.some(key => !required.includes(key) && !optional.includes(key))) fail("UNKNOWN_OR_MISSING_FIELDS");
  return r;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => !text(v)) || new Set(value).size !== value.length) fail("INVALID_STRING_SET");
  return value as string[];
}
function sameSet(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every(v => b.includes(v)); }

/** No getters, toJSON, nonplain prototypes, duplicate JSON keys, lossy numbers, holes or coercion. */
export function productionMigrationArtifactCanonicalJson(value: unknown, maxDepth: number): string {
  if (!integer(maxDepth) || maxDepth > 64) fail("INVALID_JSON_DEPTH_BUDGET");
  const active = new Set<object>();
  const encode = (v: unknown, depth: number): string => {
    if (depth > maxDepth) fail("JSON_DEPTH_BUDGET_EXCEEDED");
    if (v === null) return "null";
    if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) { const next = v.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_UNICODE"); }
        else if (c >= 0xdc00 && c <= 0xdfff) fail("INVALID_UNICODE");
      }
      return JSON.stringify(v);
    }
    if (typeof v === "boolean") return String(v);
    if (typeof v === "number") { if (!Number.isSafeInteger(v) || Object.is(v, -0)) fail("LOSSY_JSON_NUMBER"); return String(v); }
    if (!v || typeof v !== "object" || active.has(v)) fail("NON_PLAIN_JSON");
    const prototype = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("NON_PLAIN_JSON");
    const descriptors = Object.getOwnPropertyDescriptors(v), names = Reflect.ownKeys(descriptors);
    if (names.some(n => typeof n !== "string") || names.some(n => !Object.hasOwn(descriptors[n as string]!, "value"))) fail("NON_PLAIN_JSON");
    if (!Array.isArray(v) && names.some(n => !descriptors[n as string]!.enumerable)) fail("NON_PLAIN_JSON");
    active.add(v);
    try {
      if (Array.isArray(v)) {
        if (names.length !== v.length + 1 || v.some((_, index) => !Object.hasOwn(descriptors, String(index)))) fail("NON_PLAIN_JSON");
        const result: string[] = [];
        for (let i = 0; i < v.length; i++) { if (!Object.hasOwn(descriptors, String(i))) fail("NON_PLAIN_JSON"); result.push(encode(descriptors[String(i)]!.value, depth + 1)); }
        return `[${result.join(",")}]`;
      }
      return `{${(names as string[]).sort().map(n => `${JSON.stringify(n)}:${encode(descriptors[n]!.value, depth + 1)}`).join(",")}}`;
    } finally { active.delete(v); }
  };
  return encode(value, 0);
}
function parseCanonical(bytes: Uint8Array, maxDepth: number): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail("INVALID_JSON_BYTES"); }
  if (!Buffer.from(productionMigrationArtifactCanonicalJson(parsed, maxDepth)).equals(Buffer.from(bytes))) fail("NON_CANONICAL_JSON_BYTES");
  return record(parsed);
}
function unsigned(value: unknown, maxDepth: number) {
  const snapshot = record(JSON.parse(productionMigrationArtifactCanonicalJson(value, maxDepth)));
  delete snapshot.signatureBase64;
  return snapshot;
}
export function productionMigrationArtifactPolicyPayload(policy: unknown, maxDepth: number): string {
  return `production-migration-artifact-policy:v1\n${productionMigrationArtifactCanonicalJson(unsigned(policy, maxDepth), maxDepth)}`;
}
export function productionMigrationMeasurementPayload(receipt: unknown, maxDepth: number): string {
  return `production-migration-artifact-measurement:v1\n${productionMigrationArtifactCanonicalJson(unsigned(receipt, maxDepth), maxDepth)}`;
}
function publicKey(base64: unknown) {
  if (typeof base64 !== "string") fail("INVALID_PINNED_KEY");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) fail("INVALID_PINNED_KEY");
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !key.export({ format: "der", type: "spki" }).equals(bytes)) fail("INVALID_PINNED_KEY");
    return key;
  }
  catch { return fail("INVALID_PINNED_KEY"); }
}
function signature(payload: string, base64: unknown, keyBase64: string): void {
  if (typeof base64 !== "string") fail("INVALID_SCOPED_SIGNATURE");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== base64 || !verify(null, Buffer.from(payload), publicKey(keyBase64), bytes)) fail("INVALID_SCOPED_SIGNATURE");
}
function identity(value: unknown): MigrationIdentity {
  const names = ["snapshotId", "snapshotSha256", "sourceId", "sourceSchemaSha256", "targetId", "targetSchemaSha256", "generation", "releaseSha256"];
  const r = keys(value, names);
  if (names.some(n => n.endsWith("Sha256") ? !sha(r[n]) : !text(r[n]))) fail("INVALID_IDENTITY");
  return r as unknown as MigrationIdentity;
}
function equal(a: unknown, b: unknown, depth: number): boolean {
  return productionMigrationArtifactCanonicalJson(a, depth) === productionMigrationArtifactCanonicalJson(b, depth);
}
function validPin(value: unknown): MigrationArtifactFilePin {
  const r = record(value);
  if (!text(r.path) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(r.path) || r.path.split("/").some(p => !p || p === "." || p === "..") || !sha(r.sha256)) fail("INVALID_FILE_PIN");
  decimal(r.size);
  return r as unknown as MigrationArtifactFilePin;
}

export interface ProtectedMigrationArtifactRead {
  path: string; trustedOwnerUids: readonly number[]; maxBytes: string;
  retainBytes: boolean; maxRetainedBytes: number; maxReadMs: number; maxPathDepth: number;
}
/** Bounded streamed reads; only bounded JSON inputs retain bytes. No production writes or signals. */
export async function readProtectedMigrationArtifactFile(options: ProtectedMigrationArtifactRead): Promise<{
  sha256: string; size: string; bytes: Uint8Array | null; readonlyMode: boolean;
}> {
  const limit = decimal(options.maxBytes);
  if (limit < 1n || !integer(options.maxRetainedBytes) || !integer(options.maxReadMs) || options.maxReadMs > 60_000
    || !integer(options.maxPathDepth) || options.maxPathDepth > 64 || options.trustedOwnerUids.length === 0
    || options.trustedOwnerUids.some(uid => !Number.isSafeInteger(uid) || uid < 0)) fail("INVALID_READ_BUDGET_OR_OWNER_PIN");
  const deadline = performance.now() + options.maxReadMs;
  const check = () => { if (performance.now() >= deadline) fail("READ_DEADLINE_EXCEEDED"); };
  const bounded = async <T>(work: Promise<T>, late?: (value: T) => void): Promise<T> => {
    check(); let timer: ReturnType<typeof setTimeout>;
    let expired = false;
    try {
      const value = await Promise.race([work.then(v => { if (expired) late?.(v); return v; }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new MigrationArtifactVerificationError("READ_DEADLINE_EXCEEDED")); }, Math.max(1, deadline - performance.now())); })]);
      check(); return value;
    } finally { clearTimeout(timer!); }
  };
  if (!isAbsolute(options.path) || resolve(options.path) !== options.path || await bounded(realpath(options.path)) !== options.path) fail("UNPROTECTED_ARTIFACT_PATH");
  let cursor = options.path, count = 0;
  for (;;) {
    if (++count > options.maxPathDepth) fail("PATH_DEPTH_BUDGET_EXCEEDED");
    const stat = await bounded(lstat(cursor));
    if (stat.isSymbolicLink() || !options.trustedOwnerUids.includes(stat.uid) || (stat.mode & 0o022) !== 0
      || (cursor !== options.path && !stat.isDirectory())) fail("UNPROTECTED_ARTIFACT_ANCESTOR");
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const handle = await bounded(open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), h => { void h.close().catch(() => {}); });
  try {
    const before = await bounded(handle.stat({ bigint: true }));
    if (!before.isFile() || before.nlink !== 1n || before.size > limit || !options.trustedOwnerUids.includes(Number(before.uid)) || (before.mode & 0o022n) !== 0n) fail("UNSAFE_ARTIFACT_FILE");
    if (options.retainBytes && before.size > BigInt(options.maxRetainedBytes)) fail("JSON_BYTE_BUDGET_EXCEEDED");
    const chunks: Buffer[] = [], buffer = Buffer.alloc(64 * 1024), digest = createHash("sha256");
    let total = 0n;
    for (;;) {
      const { bytesRead } = await bounded(handle.read(buffer, 0, buffer.length, null));
      if (bytesRead === 0) break;
      total += BigInt(bytesRead); if (total > limit || total > before.size) fail("FILE_BYTE_BUDGET_EXCEEDED");
      const bytes = buffer.subarray(0, bytesRead); digest.update(bytes);
      if (options.retainBytes) chunks.push(Buffer.from(bytes));
    }
    const after = await bounded(handle.stat({ bigint: true }));
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || total !== before.size
      || before.uid !== after.uid || before.mode !== after.mode || after.nlink !== 1n || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail("ARTIFACT_CHANGED_DURING_READ");
    return { sha256: digest.digest("hex"), size: total.toString(), bytes: options.retainBytes ? Buffer.concat(chunks) : null,
      readonlyMode: (after.mode & 0o222n) === 0n };
  } finally {
    await bounded(handle.close());
  }
}

function cell(value: unknown): void {
  const r = record(value);
  if (r.storage === "null") keys(r, ["storage"]);
  else if (r.storage === "integer") {
    keys(r, ["storage", "decimal"]);
    if (typeof r.decimal !== "string" || !/^(0|-?[1-9][0-9]{0,18})$/.test(r.decimal)) fail("INVALID_LOSSLESS_CELL");
    const n = BigInt(r.decimal); if (n < -(1n << 63n) || n >= 1n << 63n) fail("INVALID_LOSSLESS_CELL");
  } else if (r.storage === "real") {
    keys(r, ["storage", "ieee754Hex"]); if (typeof r.ieee754Hex !== "string" || !/^[a-f0-9]{16}$/.test(r.ieee754Hex)) fail("INVALID_LOSSLESS_CELL");
  } else if (r.storage === "text" || r.storage === "blob") {
    keys(r, ["storage", "bytesBase64"]);
    if (typeof r.bytesBase64 !== "string" || Buffer.from(r.bytesBase64, "base64").toString("base64") !== r.bytesBase64) fail("INVALID_LOSSLESS_CELL");
  } else fail("INVALID_LOSSLESS_CELL");
}
export function productionMigrationLosslessRowsDigest(rows: readonly MigrationLosslessRow[], maxDepth: number): string {
  const encoded = rows.map(row => {
    const bytes = productionMigrationArtifactCanonicalJson(row, maxDepth);
    for (const value of Object.values(record(row))) cell(value);
    return bytes;
  });
  return hash(`production-migration-table-rows:v1\n${encoded.sort().join("\n")}\n`);
}
const allChecks = [...new Set(PRODUCTION_MIGRATION_REQUIREMENTS.map(r => r.check)), "purge-dry-run"] as MigrationArtifactCheck[];
const roles: MigrationArtifactInputRole[] = ["snapshot", "source-schema", "target-schema", "release", "source-catalog", "target-catalog", "source-records", "retained-records", "quarantine-records", "backup", "restored"];

export interface CreateProductionMigrationArtifactVerifierOptions {
  policyBytes: Uint8Array; policySha256: string; manifest: unknown; artifactRoot: string;
  trustedReviewers: readonly MigrationArtifactReviewKey[]; manifestApprovalPublicKeys: readonly string[];
  trustedOwnerUids: readonly number[]; maxJsonDepth: number; maxBootstrapBytes: number; maxReadMs: number;
  clock: () => string; maxEvidenceAgeMs: number;
}
/**
 * Reviewer signatures authorize exact offline scope; they do not certify execution.
 * Snapshot checks measure pinned readonly bytes, not SQLite integrity or fencing.
 * Export parity and backup roundtrips remain unknown without independent source replay.
 */
export async function createProductionMigrationArtifactVerifier(options: CreateProductionMigrationArtifactVerifierOptions): Promise<ProductionMigrationArtifactVerifier> {
  if (!sha(options.policySha256) || hash(options.policyBytes) !== options.policySha256 || !integer(options.maxBootstrapBytes)
    || options.policyBytes.byteLength > options.maxBootstrapBytes || !integer(options.maxEvidenceAgeMs)
    || !options.manifestApprovalPublicKeys.length || !integer(options.maxReadMs) || options.maxReadMs > 60_000) fail("INVALID_POLICY_PIN_OR_BUDGET");
  const p = parseCanonical(options.policyBytes, options.maxJsonDepth);
  keys(p, ["version", "scope", "policyId", "verifierId", "reviewer", "keyId", "issuedAt", "expiresAt", "expected", "binding", "limits", "collectors", "artifacts", "signatureBase64"]);
  if (p.version !== 1 || p.scope !== "independent-artifact-review" || !text(p.policyId) || !text(p.verifierId)) fail("INVALID_POLICY_SCOPE");
  const reviewer = options.trustedReviewers.filter(k => k.keyId === p.keyId && k.reviewer === p.reviewer);
  if (reviewer.length !== 1) fail("PINNED_REVIEWER_REQUIRED");
  const reviewerKey = reviewer[0]!.publicKeyBase64;
  publicKey(reviewerKey);
  if (options.manifestApprovalPublicKeys.some(k => { publicKey(k); return k === reviewerKey; })) fail("INDEPENDENT_REVIEW_KEY_REQUIRED");
  signature(productionMigrationArtifactPolicyPayload(p, options.maxJsonDepth), p.signatureBase64, reviewerKey);
  const policy = p as unknown as ProductionMigrationArtifactPolicy, limits = policy.limits;
  keys(limits, ["maxFiles", "maxFileBytes", "maxTotalBytes", "maxJsonBytes", "maxRows", "maxTables", "maxColumns", "maxJsonDepth", "maxPathDepth", "maxReadMs"]);
  for (const n of [limits.maxFiles, limits.maxJsonBytes, limits.maxRows, limits.maxTables, limits.maxColumns, limits.maxJsonDepth, limits.maxPathDepth, limits.maxReadMs]) if (!integer(n)) fail("INVALID_READ_BUDGET_OR_OWNER_PIN");
  if (limits.maxJsonDepth > options.maxJsonDepth || limits.maxJsonDepth > 64 || limits.maxPathDepth > 64 || limits.maxReadMs > options.maxReadMs || limits.maxReadMs > 60_000
    || decimal(limits.maxFileBytes) < 1n || decimal(limits.maxTotalBytes) < decimal(limits.maxFileBytes)) fail("INVALID_READ_BUDGET_OR_OWNER_PIN");
  const depth = limits.maxJsonDepth, clock = () => time(options.clock());
  const fresh = (v: unknown) => { const t = time(v), now = clock(); return t <= now && now - t <= options.maxEvidenceAgeMs; };
  const currentPolicy = () => {
    if (!fresh(policy.issuedAt) || time(policy.expiresAt) <= clock() || time(policy.expiresAt) <= time(policy.issuedAt)) fail("STALE_POLICY_REVIEW");
  };
  currentPolicy();
  const expected = keys(policy.expected, ["observedAt", "identity", "sourceTables", "writerInventory"], ["purgeScope"]);
  identity(expected.identity);
  if (!fresh(expected.observedAt)) fail("STALE_EXPECTED_CONTEXT");
  const sourceTables = strings(expected.sourceTables);
  if (!sourceTables.length || sourceTables.length > limits.maxTables || !Array.isArray(expected.writerInventory)) fail("INVALID_EXPECTED_CATALOG");
  const inventoryKinds = new Set<string>();
  for (const item of expected.writerInventory) {
    const r = keys(item, ["kind", "members"]);
    if (typeof r.kind !== "string" || !["services", "timers", "operators", "deploy", "usercron", "externalInputs"].includes(r.kind) || inventoryKinds.has(r.kind)) fail("INVALID_EXPECTED_INVENTORY");
    inventoryKinds.add(r.kind); strings(r.members);
  }
  if (inventoryKinds.size !== 6) fail("INVALID_EXPECTED_INVENTORY");
  const binding = policy.binding;
  keys(binding, ["identity", "cohortId", "snapshotWatermark", "watermark", "liveCatalogSha256", "target", "maintenanceWindow"]);
  identity(binding.identity);
  if (!equal(binding.identity, expected.identity, depth) || binding.cohortId !== null && !text(binding.cohortId)
    || !text(binding.snapshotWatermark) || !text(binding.watermark) || !sha(binding.liveCatalogSha256)) fail("INVALID_SCOPE_BINDING");
  const target = keys(binding.target, ["database", "schema", "serverAddress", "serverPort", "systemIdentifier"]);
  if (![target.database, target.schema, target.serverAddress, target.systemIdentifier].every(text) || !integer(target.serverPort) || target.serverPort > 65535) fail("INVALID_SCOPE_BINDING");
  keys(binding.maintenanceWindow, ["start", "end"]);
  const windowStart = time(binding.maintenanceWindow.start), windowEnd = time(binding.maintenanceWindow.end);
  if (windowEnd <= windowStart || windowEnd - windowStart > 3_600_000) fail("INVALID_MEASUREMENT_WINDOW");
  const manifest = record(JSON.parse(productionMigrationArtifactCanonicalJson(options.manifest, options.maxJsonDepth))) as unknown as ProductionMigrationReadinessManifest;
  if (!equal(manifest.identity, expected.identity, depth) || manifest.scope?.snapshotWatermark !== binding.snapshotWatermark
    || manifest.scope?.cohortId !== binding.cohortId || manifest.scope?.watermark !== binding.watermark
    || !equal(manifest.scope?.maintenanceWindow, binding.maintenanceWindow, depth)) fail("MANIFEST_SCOPE_MISMATCH");
  if (!Array.isArray(policy.collectors) || !policy.collectors.length || !Array.isArray(policy.artifacts)) fail("INDEPENDENT_COLLECTOR_REQUIRED");
  const collectorIds = new Set<string>(), collectorKeys = new Set<string>();
  for (const c of policy.collectors) {
    keys(c, ["collectorId", "keyId", "publicKeyBase64", "collectorReleaseSha256", "derivations"]); publicKey(c.publicKeyBase64);
    if (!text(c.collectorId) || !text(c.keyId) || !sha(c.collectorReleaseSha256) || collectorIds.has(`${c.collectorId}:${c.keyId}`)
      || collectorKeys.has(c.publicKeyBase64) || c.publicKeyBase64 === reviewerKey || options.manifestApprovalPublicKeys.includes(c.publicKeyBase64)) fail("INDEPENDENT_COLLECTOR_REQUIRED");
    collectorIds.add(`${c.collectorId}:${c.keyId}`); collectorKeys.add(c.publicKeyBase64); strings(c.derivations);
  }
  if (!isAbsolute(options.artifactRoot) || resolve(options.artifactRoot) !== options.artifactRoot) fail("UNPROTECTED_ARTIFACT_PATH");
  const cache = new Map<string, Awaited<ReturnType<typeof readProtectedMigrationArtifactFile>>>();
  let bytesRead = 0n;
  const read = async (pin: MigrationArtifactFilePin, retainBytes: boolean) => {
    validPin(pin);
    let result = cache.get(pin.path);
    if (result && retainBytes && result.bytes === null) fail("CONFLICTING_FILE_PURPOSE");
    if (!result) {
      if (cache.size >= limits.maxFiles || bytesRead + decimal(pin.size) > decimal(limits.maxTotalBytes)) fail("TOTAL_READ_BUDGET_EXCEEDED");
      result = await readProtectedMigrationArtifactFile({ path: join(options.artifactRoot, pin.path), trustedOwnerUids: options.trustedOwnerUids,
        maxBytes: limits.maxFileBytes, retainBytes, maxRetainedBytes: limits.maxJsonBytes, maxReadMs: limits.maxReadMs, maxPathDepth: limits.maxPathDepth });
      bytesRead += decimal(result.size); cache.set(pin.path, result);
    }
    if (result.sha256 !== pin.sha256 || result.size !== pin.size) fail("FILE_CONTENT_PIN_MISMATCH");
    return result;
  };
  const verified = new Map<string, { bytes: Uint8Array; observedAt: string; spec: MigrationArtifactSpecification }>();
  const supplied = new Set<string>(), reports = new Map<MigrationArtifactCheck, MigrationArtifactCheckReport>();
  for (const spec of policy.artifacts) {
    keys(spec, ["check", "artifact", "claimsSha256", "testName", "collectorId", "keyId", "derivation", "inputs"]);
    keys(spec.artifact, ["path", "sha256", "size"]); validPin(spec.artifact);
    if (!allChecks.includes(spec.check) || supplied.has(spec.check) || !sha(spec.claimsSha256) || !text(spec.testName) || !text(spec.derivation) || !Array.isArray(spec.inputs)) fail("INVALID_ARTIFACT_SPECIFICATION");
    supplied.add(spec.check);
    const report: MigrationArtifactCheckReport = { check: spec.check, status: "unknown", measured: [], pending: [] };
    reports.set(spec.check, report);
    try {
      currentPolicy();
      if (productionMigrationArtifactClaimsDigest(manifest, spec.check) !== spec.claimsSha256) fail("CLAIMS_DERIVATION_MISMATCH");
      const data = await read(spec.artifact, true), receipt = parseCanonical(data.bytes!, depth);
      keys(receipt, ["version", "scope", "collectorId", "keyId", "collectorReleaseSha256", "check", "claimsSha256", "identity", "binding", "observedAt", "test", "measurement", "signatureBase64"]);
      const collector = policy.collectors.find(c => c.collectorId === spec.collectorId && c.keyId === spec.keyId);
      if (!collector || !collector.derivations.includes(spec.derivation) || receipt.collectorId !== collector.collectorId || receipt.keyId !== collector.keyId
        || receipt.collectorReleaseSha256 !== collector.collectorReleaseSha256) fail("INDEPENDENT_COLLECTOR_REQUIRED");
      signature(productionMigrationMeasurementPayload(receipt, depth), receipt.signatureBase64, collector.publicKeyBase64);
      if (receipt.version !== 1 || receipt.scope !== "independent-artifact-measurement" || receipt.check !== spec.check || receipt.claimsSha256 !== spec.claimsSha256
        || !equal(receipt.identity, binding.identity, depth) || !equal(receipt.binding, binding, depth) || !fresh(receipt.observedAt)) fail("MEASUREMENT_SCOPE_OR_TIME_MISMATCH");
      const test = keys(receipt.test, ["name", "status", "executedAt", "skipped"]);
      if (test.name !== spec.testName || test.status !== "passed" || test.skipped !== false || !fresh(test.executedAt) || time(test.executedAt) > time(receipt.observedAt)) fail("INVALID_DERIVATION_TEST_METADATA");
      const measurement = keys(receipt.measurement, ["startedAt", "completedAt", "derivation", "inputs", "snapshotScope", "backupRehearsal"]);
      const started = time(measurement.startedAt), completed = time(measurement.completedAt);
      if (started < windowStart || completed > windowEnd || started > completed || completed > time(receipt.observedAt)
        || measurement.derivation !== spec.derivation || !equal(measurement.inputs, spec.inputs, depth)
        || ![null, "preservation-snapshot", "fenced-snapshot"].includes(measurement.snapshotScope as never)) fail("MEASUREMENT_BOUNDARY_MISMATCH");
      const inputs = new Map<MigrationArtifactInputRole, Awaited<ReturnType<typeof read>>>();
      for (const pin of spec.inputs) {
        keys(pin, ["role", "path", "sha256", "size"]);
        if (!roles.includes(pin.role) || inputs.has(pin.role)) fail("INVALID_INPUT_ROLE");
        inputs.set(pin.role, await read(pin, pin.role.endsWith("catalog") || pin.role.endsWith("records")));
      }
      const requireInput = (role: MigrationArtifactInputRole) => { const v = inputs.get(role); if (!v) fail("INDEPENDENT_INPUT_REQUIRED"); return v; };
      for (const [role, expectedHash] of [["snapshot", binding.identity.snapshotSha256], ["source-schema", binding.identity.sourceSchemaSha256],
        ["target-schema", binding.identity.targetSchemaSha256], ["release", binding.identity.releaseSha256], ["target-catalog", binding.liveCatalogSha256]] as const) {
        if (requireInput(role).sha256 !== expectedHash) fail("INDEPENDENT_IDENTITY_BYTES_MISMATCH");
      }
      const catalogs = new Map<string, Map<string, string[]>>();
      for (const side of ["source", "target"] as const) {
        const catalog = parseCanonical(requireInput(`${side}-catalog`).bytes!, depth);
        keys(catalog, ["version", "side", "identity", "cohortId", "snapshotWatermark", "watermark", "measuredAt", "tables"]);
        if (catalog.version !== 1 || catalog.side !== side || !equal(catalog.identity, binding.identity, depth)
          || catalog.cohortId !== binding.cohortId || catalog.snapshotWatermark !== binding.snapshotWatermark || catalog.watermark !== binding.watermark
          || time(catalog.measuredAt) < windowStart || time(catalog.measuredAt) > completed || (side === "target" && !fresh(catalog.measuredAt))
          || !Array.isArray(catalog.tables) || catalog.tables.length > limits.maxTables) fail("CATALOG_SCOPE_OR_TIME_MISMATCH");
        const tables = new Map<string, string[]>();
        for (const value of catalog.tables) {
          const table = keys(value, ["name", "columns"]), columns = strings(table.columns);
          if (!text(table.name) || tables.has(table.name) || !columns.length || columns.length > limits.maxColumns) fail("INVALID_CATALOG_TABLE");
          tables.set(table.name, columns);
        }
        if (side === "source" && !sameSet([...tables.keys()], sourceTables)) fail("EXACT_SOURCE_CATALOG_REQUIRED");
        catalogs.set(side, tables);
      }
      report.measured.push("FILE_HASH_AND_SIZE", "SIGNED_INDEPENDENT_CAPTURE_BINDING", "EXACT_SAVED_CATALOG");
      if (spec.derivation === "snapshot-bytes-v1" && spec.check === "immutable-snapshot") {
        if (!requireInput("snapshot").readonlyMode || measurement.snapshotScope === null || measurement.backupRehearsal !== null) fail("READONLY_SNAPSHOT_SCOPE_REQUIRED");
        report.measured.push("READONLY_SNAPSHOT_BYTES");
      } else if (spec.derivation === "lossless-table-records-v1" && spec.check === "lossless-all-tables") {
        if (measurement.backupRehearsal !== null) fail("WRONG_DERIVATION_SCOPE");
        const exports = new Map<string, Map<string, { destination: string; rows: MigrationLosslessRow[] }>>(); let rowCount = 0;
        for (const side of ["source", "retained", "quarantine"] as const) {
          const doc = parseCanonical(requireInput(`${side}-records`).bytes!, depth);
          keys(doc, ["version", "side", "identity", "cohortId", "snapshotWatermark", "watermark", "tables"]);
          if (doc.version !== 1 || doc.side !== side || !equal(doc.identity, binding.identity, depth) || doc.cohortId !== binding.cohortId
            || doc.snapshotWatermark !== binding.snapshotWatermark || doc.watermark !== binding.watermark || !Array.isArray(doc.tables)
            || doc.tables.length !== sourceTables.length) fail("RECORD_EXPORT_SCOPE_MISMATCH");
          const tables = new Map<string, { destination: string; rows: MigrationLosslessRow[] }>();
          for (const value of doc.tables) {
            const table = keys(value, ["table", "destination", "rows"]);
            if (!text(table.table) || !sourceTables.includes(table.table) || tables.has(table.table) || !text(table.destination) || !Array.isArray(table.rows)
              || (rowCount += table.rows.length) > limits.maxRows) fail("INVALID_TABLE_RECORD_EXPORT");
            const columns = catalogs.get("source")!.get(table.table)!;
            for (const row of table.rows) {
              if (!sameSet(Object.keys(record(row)), columns)) fail("LOSSLESS_COLUMNS_REQUIRED");
              for (const value of Object.values(record(row))) cell(value);
            }
            if (side !== "source" && !catalogs.get("target")!.has(table.destination)) fail("LIVE_DESTINATION_CATALOG_REQUIRED");
            tables.set(table.table, { destination: table.destination, rows: table.rows as MigrationLosslessRow[] });
          }
          exports.set(side, tables);
        }
        if (!sameSet(manifest.tables.reviewedSourceTables, sourceTables) || manifest.tables.entries.length !== sourceTables.length
          || new Set(manifest.tables.entries.map(e => e.table)).size !== sourceTables.length) fail("EXACT_MANIFEST_ACCOUNTING_REQUIRED");
        for (const name of sourceTables) {
          const source = exports.get("source")!.get(name)!, retained = exports.get("retained")!.get(name)!, quarantined = exports.get("quarantine")!.get(name)!;
          const entry = manifest.tables.entries.find(e => e.table === name);
          const sourceHash = productionMigrationLosslessRowsDigest(source.rows, depth), retainedHash = productionMigrationLosslessRowsDigest([...retained.rows, ...quarantined.rows], depth);
          if (!entry || sourceHash !== retainedHash || entry.sourceSha256 !== sourceHash || entry.retainedSha256 !== retainedHash
            || entry.sourceRows !== String(source.rows.length) || entry.preservedRows !== String(retained.rows.length)
            || entry.quarantinedRows !== String(quarantined.rows.length) || entry.destination !== retained.destination) fail("DERIVED_ALL_TABLE_ACCOUNTING_MISMATCH");
        }
        report.measured.push("TYPED_CELL_MULTISET_PARITY", "ALL_TABLE_ROW_COUNTS_AND_DIGESTS");
        // Signed export provenance is not a replay of the pinned SQLite snapshot.
        report.pending.push("SOURCE_SNAPSHOT_TO_TYPED_EXPORT_NOT_INDEPENDENTLY_REPLAYED");
        continue;
      } else if (spec.derivation === "backup-roundtrip-v1") {
        const rehearsal = keys(measurement.backupRehearsal, ["backupStartedAt", "backupCompletedAt", "restoreStartedAt", "restoreCompletedAt"]);
        const a = time(rehearsal.backupStartedAt), b = time(rehearsal.backupCompletedAt), c = time(rehearsal.restoreStartedAt), d = time(rehearsal.restoreCompletedAt);
        if (a < started || a > b || b > c || c > d || d > completed) fail("BACKUP_REHEARSAL_COMPLETION_REQUIRED");
        const backup = requireInput("backup"), restored = requireInput("restored");
        if (backup.sha256 !== restored.sha256 || backup.size !== restored.size) fail("RESTORE_BYTE_ROUNDTRIP_MISMATCH");
        report.measured.push("COMPLETED_RECEIPT_BOUNDARY", "BACKUP_RESTORE_BYTE_ROUNDTRIP");
        report.pending.push("ONLINE_BACKUP_EXECUTION_NOT_INDEPENDENTLY_REPLAYED", "SQLITE_READONLY_INTEGRITY_NOT_MEASURED");
        continue;
      } else { report.pending.push("UNSUPPORTED_CHECK_DERIVATION"); continue; }
      currentPolicy();
      report.status = "verified";
      verified.set(spec.check, { bytes: Buffer.from(data.bytes!), observedAt: String(receipt.observedAt), spec });
    } catch (error) {
      report.status = "blocked";
      report.pending.push(error instanceof MigrationArtifactVerificationError ? error.code : "ARTIFACT_IO_OR_MEASUREMENT_FAILED");
    }
  }
  for (const check of allChecks) if (!reports.has(check)) reports.set(check, { check, status: "unknown", measured: [], pending: ["INDEPENDENT_ARTIFACT_NOT_SUPPLIED"] });
  const externalTrust: MigrationExternalTrust = {
    expected: JSON.parse(productionMigrationArtifactCanonicalJson(policy.expected, depth)), trustedArtifactVerifierIds: [policy.verifierId],
    verifyArtifact(request) {
      try {
        currentPolicy();
        const r = keys(JSON.parse(productionMigrationArtifactCanonicalJson(request, depth)), ["check", "artifactSha256", "claimsSha256", "identity"]);
        const artifact = verified.get(String(r.check));
        if (!artifact || r.artifactSha256 !== artifact.spec.artifact.sha256 || r.claimsSha256 !== artifact.spec.claimsSha256
          || !equal(r.identity, binding.identity, depth) || !fresh(artifact.observedAt)) return null;
        return { bytes: Buffer.from(artifact.bytes), verifierId: policy.verifierId, verifiedAt: options.clock(), assertionsPassed: true };
      } catch { return null; }
    },
  };
  return { validationOnly: true, productionAuthorized: false, externalTrust,
    report: { checks: allChecks.map(c => reports.get(c)!), filesRead: cache.size, bytesRead: bytesRead.toString() } };
}

/** Reusable with a verified migration runtime. Facts only: no source, cohort, fencing or readiness inference. */
export async function measureProductionMigrationLiveCatalog(options: {
  runtime: { run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> };
  schema: string; maxTables: number; maxReadMs: number; clock: () => string;
}): Promise<{ observedAt: string; database: string; schema: string; generation: string; schemaFingerprint: string;
  serverAddress: string; serverPort: number; systemIdentifier: string; tables: string[]; tableNamesSha256: string; catalogSha256: null;
  cohortId: null; readiness: "unknown"; pending: readonly string[] }> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema) || ["public", "information_schema"].includes(options.schema)
    || options.schema.startsWith("pg_") || !integer(options.maxTables) || options.maxTables >= Number.MAX_SAFE_INTEGER
    || !integer(options.maxReadMs) || options.maxReadMs > 60_000) fail("INVALID_LIVE_MEASUREMENT_BUDGET");
  let timer: ReturnType<typeof setTimeout>, expired = false;
  try {
    return await Promise.race([options.runtime.run(async tx => {
      if (expired) fail("LIVE_MEASUREMENT_DEADLINE");
      await tx.query("SET TRANSACTION READ ONLY");
      if (expired) fail("LIVE_MEASUREMENT_DEADLINE");
      const schema = `"${options.schema}"`;
      const rows = (await tx.query(`SELECT current_database() AS database,host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
        (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,i.schema_name,i.generation_id,l.fingerprint
        FROM ${schema}.business_schema_identity i CROSS JOIN ${schema}.business_schema_ledger l WHERE i.singleton=true ORDER BY l.version DESC LIMIT 1`)).rows;
      if (expired) fail("LIVE_MEASUREMENT_DEADLINE");
      const row = rows[0];
      if (rows.length !== 1 || !row || ![row.database, row.schema_name, row.generation_id, row.server_address, row.system_identifier].every(text)
        || row.schema_name !== options.schema || !sha(row.fingerprint) || !integer(row.server_port) || row.server_port > 65535) fail("LIVE_IDENTITY_MEASUREMENT_REQUIRED");
      const catalog = (await tx.query("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND c.relpersistence='p' ORDER BY c.relname LIMIT $2",
        [options.schema, options.maxTables + 1])).rows;
      const tables = strings(catalog.map(r => r.name));
      if (!tables.length || tables.length > options.maxTables || expired) fail("LIVE_CATALOG_BUDGET_OR_DEADLINE");
      const observedAt = options.clock(); time(observedAt);
      return { observedAt, database: String(row.database), schema: options.schema, generation: String(row.generation_id), schemaFingerprint: String(row.fingerprint),
        serverAddress: String(row.server_address), serverPort: Number(row.server_port), systemIdentifier: String(row.system_identifier), tables,
        tableNamesSha256: hash(productionMigrationArtifactCanonicalJson(tables, 1)), catalogSha256: null, cohortId: null, readiness: "unknown" as const,
        pending: ["FULL_CATALOG_COLUMNS_NOT_MEASURED", "SOURCE_SNAPSHOT_NOT_MEASURED", "COHORT_BINDING_NOT_MEASURED", "FENCING_NOT_MEASURED", "RELEASE_EXECUTION_NOT_MEASURED"] };
    }), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new MigrationArtifactVerificationError("LIVE_MEASUREMENT_DEADLINE")); }, options.maxReadMs); })]);
  } finally { clearTimeout(timer!); }
}
