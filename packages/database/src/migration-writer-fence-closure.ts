import { createHash, createPublicKey, verify } from "node:crypto";

export type FenceClosureScopeKind = "service" | "timer" | "bridge" | "cron" | "operator" | "deploy" | "external-input";
export interface FenceClosureScope {
  id: string;
  kind: FenceClosureScopeKind;
  paths: string[];
  directions: ("source-to-input" | "output-to-source")[];
}
export interface FenceClosureBinding {
  sourcePath: string;
  sourceDevice: string;
  sourceInode: string;
  generation: string;
  watermark: string;
  cluster: string;
  schemaSha256: string;
  release: string;
  artifactSha256: string;
  cohortSha256: string;
  providerGuardSha256: string;
  deliveryGuardSha256: string;
}
export interface FenceClosureAuthorization {
  binding: FenceClosureBinding;
  scopes: FenceClosureScope[];
  windowStart: string;
  windowEnd: string;
  maximumSqlStatements: number;
  maximumTransactionMs: number;
}
export interface FenceClosureCensus {
  authorizationSha256: string;
  observedAt: string;
  fencedAt: string;
  scopes: {
    id: string;
    admission: "closed";
    controlReceiptSha256: string;
    closedUntil: string;
    processIds: number[];
    timer: "not-applicable" | "disabled-no-pending-trigger";
    bridgeDirections: ("source-to-input" | "output-to-source")[];
    cursorReceiptSha256: string | null;
  }[];
  processes: {
    pid: number;
    children: number[];
    descendants: "complete";
    fdScan: "complete";
    mmapScan: "complete";
    sourceHandles: { path: string; flagsOctal: string }[];
    sourceMappings: string[];
  }[];
  discoveredScopeIds: string[];
  sourceDevice: string;
  sourceInode: string;
  sourcePath: string;
  generation: string;
  watermark: string;
}
export interface FenceClosureSnapshot {
  authorizationSha256: string;
  censusSha256: string;
  binding: FenceClosureBinding;
  kind: "final-full-fenced";
  startedAt: string;
  completedAt: string;
  tableCensusSha256: string;
  tables: { name: string; rowCount: string; sha256: string }[];
  parityReceiptSha256: string;
  restoreReceiptSha256: string;
}
export interface FenceClosureRollback {
  authorizationSha256: string;
  binding: FenceClosureBinding;
  route: "source-before-first-write" | "compatible-postgres-release";
  completedAt: string;
  parityReceiptSha256: string;
  rollbackRelease: string | null;
  rollbackArtifactSha256: string | null;
  compatibilityTestReceiptSha256: string | null;
  preservedProviderGuardSha256: string;
  preservedDeliveryGuardSha256: string;
}
export interface FenceClosureSigned<T> { payload: T; signatureBase64: string }
export interface FenceClosureTrust {
  authorizationPublicKeyPem: string;
  observerPublicKeyPem: string;
  snapshotPublicKeyPem: string;
  independentCompatibilityPublicKeyPem: string;
  expectedBinding: FenceClosureBinding;
  expectedScopesSha256: string;
  expectedTableNames: string[];
  expectedRollbackRelease: string;
  expectedRollbackArtifactSha256: string;
  maximumEvidenceAgeMs: number;
  maximumMaintenanceWindowMs: number;
}
export interface FenceClosureInput {
  authorization: FenceClosureSigned<FenceClosureAuthorization>;
  census: FenceClosureSigned<FenceClosureCensus>;
  snapshot: FenceClosureSigned<FenceClosureSnapshot>;
  rollback: FenceClosureSigned<FenceClosureRollback>;
  phase: "before-first-pg-write" | "after-first-pg-write";
}

const hashPattern = /^[a-f0-9]{64}$/;
const bindingKeys = ["sourcePath", "sourceDevice", "sourceInode", "generation", "watermark", "cluster", "schemaSha256", "release", "artifactSha256", "cohortSha256", "providerGuardSha256", "deliveryGuardSha256"] as const;
const scopeKinds = new Set(["service", "timer", "bridge", "cron", "operator", "deploy", "external-input"]);
function demand(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Writer fence closure rejected: ${reason}`);
}
function exactKeys(value: object, keys: readonly string[]): void {
  demand(value !== null && typeof value === "object" && !Array.isArray(value), "object required");
  demand(Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"), "unknown or missing fields");
}
function token(value: unknown): asserts value is string {
  demand(typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value), "literal identity required");
}
function path(value: unknown): asserts value is string {
  demand(typeof value === "string" && /^\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(value) && !value.split("/").some(part => part === "." || part === ".."), "canonical absolute filesystem path required");
}
function hash(value: unknown): void { demand(typeof value === "string" && hashPattern.test(value), "SHA-256 required"); }
function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  demand(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, "bounded integer required");
}
function instant(value: unknown): number {
  demand(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), "canonical UTC instant required");
  const parsed = Date.parse(value);
  demand(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, "valid UTC instant required");
  return parsed;
}
// This serialization is a wire protocol, not JSON.stringify's coercion semantics.
export function canonicalFenceClosureEvidence(value: unknown): string {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): string {
    demand(++nodes <= 20000 && depth <= 24, "canonicalization budget exceeded");
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      demand(Number.isSafeInteger(item) && !Object.is(item, -0), "no numeric coercion");
      return String(item);
    }
    if (typeof item === "string") {
      demand(item.length <= 65536 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item), "invalid string");
      return JSON.stringify(item);
    }
    demand(typeof item === "object" && item !== null, "unsupported canonical value");
    demand(!seen.has(item) && Object.getOwnPropertySymbols(item).length === 0, "cyclic/symbol evidence");
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      demand(Object.getPrototypeOf(item) === Array.prototype, "plain array required");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      demand(Object.getOwnPropertyNames(item).length === item.length + 1 && Object.keys(item).length === item.length && Object.entries(descriptors).every(([key, descriptor]) => key === "length" || ("value" in descriptor && descriptor.enumerable && /^(0|[1-9][0-9]*)$/.test(key))), "sparse/decorated/accessor array");
      result = `[${item.map(element => visit(element, depth + 1)).join(",")}]`;
    } else {
      demand(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "plain evidence required");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      demand(Object.values(descriptors).every(descriptor => "value" in descriptor && descriptor.enumerable), "accessor/hidden evidence");
      const fields = Object.keys(descriptors).sort().map(key => `${visit(key, depth + 1)}:${visit(descriptors[key]?.value, depth + 1)}`);
      result = `{${fields.join(",")}}`;
    }
    seen.delete(item);
    return result;
  }
  const result = visit(value, 0);
  demand(Buffer.byteLength(result) <= 1048576, "evidence bytes exceeded");
  return result;
}
export function fenceClosureEvidenceSha256(value: unknown): string {
  return createHash("sha256").update(canonicalFenceClosureEvidence(value)).digest("hex");
}
export function fenceClosureSigningMessage(kind: "authorization" | "census" | "snapshot" | "rollback", payload: unknown): Buffer {
  return Buffer.from(`address-radar/writer-fence-closure/v2/${kind}\n${canonicalFenceClosureEvidence(payload)}`, "utf8");
}
function signed<T>(kind: "authorization" | "census" | "snapshot" | "rollback", envelope: FenceClosureSigned<T>, pem: string): T {
  canonicalFenceClosureEvidence(envelope);
  exactKeys(envelope, ["payload", "signatureBase64"]);
  demand(typeof envelope.signatureBase64 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signatureBase64), "canonical Ed25519 signature required");
  const key = createPublicKey(pem);
  demand(key.asymmetricKeyType === "ed25519", "pinned Ed25519 key required");
  const signature = Buffer.from(envelope.signatureBase64, "base64");
  demand(signature.length === 64 && signature.toString("base64") === envelope.signatureBase64 && verify(null, fenceClosureSigningMessage(kind, envelope.payload), key, signature), `${kind} signature`);
  return envelope.payload;
}
function binding(value: FenceClosureBinding, expected: FenceClosureBinding): void {
  exactKeys(value, bindingKeys);
  exactKeys(expected, bindingKeys);
  path(value.sourcePath);
  demand(/^[1-9][0-9]*$/.test(value.sourceDevice) && /^[1-9][0-9]*$/.test(value.sourceInode), "source file identity required");
  for (const key of bindingKeys) {
    token(value[key]);
    if (key.endsWith("Sha256")) hash(value[key]);
    demand(value[key] === expected[key], `exact binding mismatch: ${key}`);
  }
}
function unique(values: readonly string[], label: string): void {
  demand(new Set(values).size === values.length, `${label} duplicate`);
}
function sameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  unique(actual, label); unique(expected, label);
  demand([...actual].sort().join("\0") === [...expected].sort().join("\0"), `${label} incomplete/unknown`);
}

/** Independent evidence validation only. Never opens a DB, changes admission, or authorizes writes. */
export function verifyWriterFenceSnapshotRollbackClosure(input: FenceClosureInput, trust: FenceClosureTrust, now: Date): Readonly<{ authorizationSha256: string; censusSha256: string; snapshotSha256: string; rollbackSha256: string; phase: FenceClosureInput["phase"]; writeAuthorized: false; activationEnabled: false }> {
  integer(trust.maximumEvidenceAgeMs, 1, 300000);
  integer(trust.maximumMaintenanceWindowMs, 1, 7200000);
  demand(Number.isFinite(now.getTime()), "trusted current clock required");
  demand(input.phase === "before-first-pg-write" || input.phase === "after-first-pg-write", "explicit persisted first-write phase required");
  const keyId = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" }).toString("hex");
  demand(keyId(trust.independentCompatibilityPublicKeyPem) !== keyId(trust.authorizationPublicKeyPem) && keyId(trust.independentCompatibilityPublicKeyPem) !== keyId(trust.observerPublicKeyPem), "independent compatibility verifier required");
  const a = signed("authorization", input.authorization, trust.authorizationPublicKeyPem);
  exactKeys(a, ["binding", "scopes", "windowStart", "windowEnd", "maximumSqlStatements", "maximumTransactionMs"]);
  binding(a.binding, trust.expectedBinding);
  integer(a.maximumSqlStatements, 1, 10000); integer(a.maximumTransactionMs, 1, 60000);
  const start = instant(a.windowStart), end = instant(a.windowEnd), current = now.getTime();
  demand(start <= current && current <= end && end > start && end - start <= trust.maximumMaintenanceWindowMs, "approved bounded active maintenance window required");
  demand(Array.isArray(a.scopes) && a.scopes.length >= 1 && a.scopes.length <= 256, "bounded externally expected scopes required");
  const requiredKinds = new Set<string>();
  for (const scope of a.scopes) {
    exactKeys(scope, ["id", "kind", "paths", "directions"]); token(scope.id);
    demand(scopeKinds.has(scope.kind), "opaque approved scope forbidden"); requiredKinds.add(scope.kind);
    demand(Array.isArray(scope.paths) && scope.paths.length > 0 && scope.paths.length <= 32, "explicit writable/input paths required");
    for (const item of scope.paths) path(item); unique(scope.paths, "scope paths");
    demand(Array.isArray(scope.directions), "bridge direction census required");
    sameSet(scope.directions, scope.kind === "bridge" ? ["source-to-input", "output-to-source"] : [], "bridge directions");
  }
  demand([...scopeKinds].every(kind => requiredKinds.has(kind)), "missing writer/input scope family");
  hash(trust.expectedScopesSha256);
  demand(fenceClosureEvidenceSha256(a.scopes) === trust.expectedScopesSha256, "externally pinned complete scope set mismatch");
  demand(a.scopes.filter(scope => scope.kind === "service").length >= 12 && a.scopes.filter(scope => scope.kind === "timer").length >= 5, "known minimum service/timer census omitted");
  const authHash = fenceClosureEvidenceSha256(a);
  const c = signed("census", input.census, trust.observerPublicKeyPem);
  exactKeys(c, ["authorizationSha256", "observedAt", "fencedAt", "scopes", "processes", "discoveredScopeIds", "sourceDevice", "sourceInode", "sourcePath", "generation", "watermark"]);
  demand(c.authorizationSha256 === authHash, "census authorization linkage");
  const observed = instant(c.observedAt), fenced = instant(c.fencedAt);
  demand(start <= fenced && fenced <= observed, "historical fence boundary outside approved window");
  demand(observed >= start && observed <= current && current - observed <= trust.maximumEvidenceAgeMs, "fresh nonfuture census required");
  for (const key of ["sourceDevice", "sourceInode", "sourcePath", "generation", "watermark"] as const) demand(c[key] === a.binding[key], "exact fenced source identity/generation/watermark");
  demand(Array.isArray(c.scopes) && Array.isArray(c.discoveredScopeIds) && Array.isArray(c.processes) && c.processes.length <= 128, "bounded census arrays required");
  sameSet(c.scopes.map(scope => scope.id), a.scopes.map(scope => scope.id), "observed scope census");
  sameSet(c.discoveredScopeIds, a.scopes.map(scope => scope.id), "discovered scope census");
  const processes = new Map<number, FenceClosureCensus["processes"][number]>();
  for (const process of c.processes) {
    exactKeys(process, ["pid", "children", "descendants", "fdScan", "mmapScan", "sourceHandles", "sourceMappings"]);
    integer(process.pid, 1, 2147483647); demand(!processes.has(process.pid), "duplicate process"); processes.set(process.pid, process);
    demand(process.descendants === "complete" && process.fdScan === "complete" && process.mmapScan === "complete", "denied/unavailable/unknown/truncated process scan");
    demand(Array.isArray(process.children) && process.children.length <= 128 && Array.isArray(process.sourceHandles) && process.sourceHandles.length <= 256 && Array.isArray(process.sourceMappings), "bounded process observations required");
    unique(process.children.map(String), "children");
    for (const child of process.children) integer(child, 1, 2147483647);
    for (const handle of process.sourceHandles) {
      exactKeys(handle, ["path", "flagsOctal"]); path(handle.path);
      demand(typeof handle.flagsOctal === "string" && /^[0-7]{1,12}$/.test(handle.flagsOctal), "exact FD access flags required");
      demand((Number.parseInt(handle.flagsOctal, 8) % 4) === 0, "writable or unknown source FD holder");
    }
    // mmap access cannot be inferred from a different FD's flags. Drain all source mappings.
    demand(process.sourceMappings.length === 0, "source mmap holder remains");
  }
  const roots: number[] = [];
  for (const scope of c.scopes) {
    exactKeys(scope, ["id", "admission", "controlReceiptSha256", "closedUntil", "processIds", "timer", "bridgeDirections", "cursorReceiptSha256"]);
    const expected = a.scopes.find(item => item.id === scope.id); demand(expected !== undefined, "unknown scope");
    demand(scope.admission === "closed" && instant(scope.closedUntil) >= end, "admission not closed throughout approved window"); hash(scope.controlReceiptSha256);
    demand(scope.timer === (expected.kind === "timer" ? "disabled-no-pending-trigger" : "not-applicable"), "timer active/pending/unknown");
    demand(Array.isArray(scope.processIds), "scope process census required");
    for (const pid of scope.processIds) { integer(pid, 1, 2147483647); roots.push(pid); }
    sameSet(scope.bridgeDirections, expected.directions, "observed bridge directions");
    if (expected.kind === "bridge") hash(scope.cursorReceiptSha256); else demand(scope.cursorReceiptSha256 === null, "unexpected cursor proof");
  }
  const visited = new Set<number>(), visiting = new Set<number>();
  function walk(pid: number): void {
    demand(!visiting.has(pid), "cyclic process lineage"); if (visited.has(pid)) return;
    const process = processes.get(pid); demand(process !== undefined, "missing descendant process");
    visiting.add(pid); for (const child of process.children) walk(child); visiting.delete(pid); visited.add(pid);
  }
  for (const root of roots) walk(root);
  demand(visited.size === processes.size, "unknown unscoped process");
  const censusHash = fenceClosureEvidenceSha256(c);
  const s = signed("snapshot", input.snapshot, trust.snapshotPublicKeyPem);
  exactKeys(s, ["authorizationSha256", "censusSha256", "binding", "kind", "startedAt", "completedAt", "tableCensusSha256", "tables", "parityReceiptSha256", "restoreReceiptSha256"]);
  binding(s.binding, a.binding);
  demand(s.authorizationSha256 === authHash && s.censusSha256 === censusHash && s.kind === "final-full-fenced", "final full fenced snapshot required, no guessed delta");
  const snapshotStart = instant(s.startedAt), snapshotEnd = instant(s.completedAt);
  demand(fenced <= snapshotStart && snapshotStart <= snapshotEnd && snapshotEnd <= observed && snapshotEnd <= current && snapshotEnd <= end, "snapshot boundaries outside ordered approved fence/window");
  demand(Array.isArray(trust.expectedTableNames) && trust.expectedTableNames.length > 0 && trust.expectedTableNames.length <= 256 && Array.isArray(s.tables) && s.tables.length <= 256, "explicit bounded full-table census required");
  for (const name of trust.expectedTableNames) token(name);
  for (const table of s.tables) { exactKeys(table, ["name", "rowCount", "sha256"]); token(table.name); demand(typeof table.rowCount === "string" && /^(0|[1-9][0-9]{0,99})$/.test(table.rowCount), "canonical decimal table count required"); hash(table.sha256); }
  sameSet(s.tables.map(table => table.name), trust.expectedTableNames, "snapshot full-table census");
  demand(s.tableCensusSha256 === fenceClosureEvidenceSha256(s.tables), "table census digest mismatch");
  hash(s.tableCensusSha256); hash(s.parityReceiptSha256); hash(s.restoreReceiptSha256);
  const r = signed("rollback", input.rollback, trust.independentCompatibilityPublicKeyPem);
  exactKeys(r, ["authorizationSha256", "binding", "route", "completedAt", "parityReceiptSha256", "rollbackRelease", "rollbackArtifactSha256", "compatibilityTestReceiptSha256", "preservedProviderGuardSha256", "preservedDeliveryGuardSha256"]);
  binding(r.binding, a.binding); demand(r.authorizationSha256 === authHash, "rollback authorization linkage");
  const rehearsalEnd = instant(r.completedAt);
  demand(rehearsalEnd >= snapshotEnd && rehearsalEnd <= current && rehearsalEnd <= end, "rollback rehearsal outside ordered maintenance window");
  hash(r.parityReceiptSha256);
  demand(r.preservedProviderGuardSha256 === a.binding.providerGuardSha256 && r.preservedDeliveryGuardSha256 === a.binding.deliveryGuardSha256, "provider/delivery guards changed");
  if (r.route === "compatible-postgres-release") {
    token(trust.expectedRollbackRelease); hash(trust.expectedRollbackArtifactSha256);
    token(r.rollbackRelease); hash(r.rollbackArtifactSha256); hash(r.compatibilityTestReceiptSha256);
    demand(r.rollbackRelease === trust.expectedRollbackRelease && r.rollbackArtifactSha256 === trust.expectedRollbackArtifactSha256, "exact retained compatible PostgreSQL release/artifact required");
  } else {
    demand(input.phase === "before-first-pg-write" && r.route === "source-before-first-write", "SQLite/source rollback forbidden after first PostgreSQL write");
    demand(r.rollbackRelease === null && r.rollbackArtifactSha256 === null && r.compatibilityTestReceiptSha256 === null, "ambiguous source rollback proof");
  }
  return Object.freeze({ authorizationSha256: authHash, censusSha256: censusHash, snapshotSha256: fenceClosureEvidenceSha256(s), rollbackSha256: fenceClosureEvidenceSha256(r), phase: input.phase, writeAuthorized: false, activationEnabled: false });
}
