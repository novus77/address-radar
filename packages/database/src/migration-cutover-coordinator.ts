import { createHash, createPublicKey, verify } from "node:crypto";
import { posix } from "node:path";
import { isIP } from "node:net";
import { PostgresCommitUncertainError, type PostgresPool, type PostgresTransaction } from "./postgres-unit-of-work.js";
import type { createPostgresMigrationRuntime } from "./postgres-migration-runtime.js";
import { verifyWriterFenceSnapshotRollbackClosure as verifyClosureV2, fenceClosureEvidenceSha256 as closureDigestV2, type FenceClosureInput as ClosureInputV2, type FenceClosureTrust as ClosureTrustV2 } from "./migration-writer-fence-closure.js";

/** Trusted schema fragment for the parent's actual v2 extension. Never executed by this module. */
export const MIGRATION_CUTOVER_TRANSITIONS_DDL = `CREATE TABLE migration_cutover_transitions (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 64),
  state jsonb NOT NULL CHECK (
    jsonb_typeof(state) = 'object'
    AND state ?& ARRAY['version','revision','phase','binding','policySha256','planSha256','activationEnabled','preparation','snapshotTables','firstPostgresWrite','journal']
    AND state->>'version' = '1'
    AND state->>'revision' = revision::text
    AND state->>'activationEnabled' = 'false'
    AND jsonb_typeof(state->'journal') = 'array'
  )
)`;

/** Qualifies the trusted DDL without accepting SQL or hiding drift with IF NOT EXISTS. */
export function migrationCutoverTransitionsDdl(schema: string): string {
  if (typeof schema !== "string" || !sqlIdentifier.test(schema) || schema.startsWith("pg_")
    || ["public", "information_schema"].includes(schema)) fail("INVALID_LEDGER_SCHEMA");
  return MIGRATION_CUTOVER_TRANSITIONS_DDL.replace("CREATE TABLE migration_cutover_transitions", () => `CREATE TABLE "${schema}"."migration_cutover_transitions"`);
}

const LEGACY_CUTOVER_SERVICES = [
  "address-radar-scanner.service", "address-radar-automation.service",
  "address-radar-wallet-monitor.service", "address-radar-wallet-analysis.service",
  "address-radar-historical-backfill.service", "address-radar-console.service",
  "address-radar-fomo-verification-sync.service", "address-radar-backup.service",
  "address-radar-migrate.service",
] as const;
const LEGACY_CUTOVER_TIMERS = ["address-radar-fomo-verification-sync.timer", "address-radar-backup.timer"] as const;
export const CUTOVER_SERVICES = [...LEGACY_CUTOVER_SERVICES, "fomo-address-radar-input-sync.service", "fomo-address-radar-backup.service", "fomo-radar-protocol-audit.service"] as const;
export const CUTOVER_TIMERS = [...LEGACY_CUTOVER_TIMERS, "fomo-address-radar-input-sync.timer", "fomo-address-radar-backup.timer", "fomo-radar-protocol-audit.timer"] as const;
export const WRITER_KINDS = ["services", "timers", "operators", "deploy", "usercron", "externalInputs"] as const;
export const CENSUS_METHODS = [
  "systemd-units", "systemd-timers", "processes", "open-files", "operator-sessions",
  "deployment-jobs", "user-crontabs", "external-inputs",
] as const;
export const MAXIMUM_CUTOVER_WRITE_SQL_STATEMENTS = 10_000;
export const MAXIMUM_CUTOVER_STARTUP_SQL_STATEMENTS = 1000;
export const PREPARATION_OBSERVATIONS = ["census", "fence", "snapshot", "parity", "target", "guards", "capacity", "rehearsal"] as const;
export type WriterKind = typeof WRITER_KINDS[number];
export type ObservationKind = typeof PREPARATION_OBSERVATIONS[number] | "rollback";
export type EvidenceMode = "production-observation" | "injected-protocol-fixture";
export type CutoverAction = "prepare" | "select-postgres" | "first-postgres-write" | "rollback" | "abort";
export type CutoverPhase = "prepared" | "postgres-selected" | "postgres-written" | "source-rollback-selected" | "postgres-rollback-selected" | "aborted";

export interface CutoverPostgresTarget {
  database: string; schema: string; schemaSha256: string; releaseSha256: string; generation: string;
  serverAddress: string; serverPort: number; systemIdentifier: string;
}
export interface CutoverBinding {
  source: { id: string; canonicalPath: string; device: string; inode: string; schemaSha256: string };
  sourceGeneration: string; generation: string; watermark: string; cohortId: string;
  snapshot: { id: string; sha256: string };
  target: CutoverPostgresTarget;
  rollbackTarget: CutoverPostgresTarget;
}
export interface ExpectedWriter { id: string; kind: WriterKind; executableSha256: string }
export interface GuardBaseline { id: string; kind: "provider" | "delivery"; rows: string; sha256: string }
export interface CutoverBudgets {
  connections: Array<{ writerId: string; instances: number; maximumEach: number }>;
  migrationConnections: number; operatorConnections: number; backupConnections: number;
  reservedConnections: number; maximumConnections: number;
  availableRamBytes: string; peakRamBytes: string; reserveRamBytes: string;
  availableDiskBytes: string; peakDiskBytes: string; peakWalBytes: string; peakTempBytes: string; reserveDiskBytes: string;
  maximumTransitions: number; maximumSqlStatements: number;
}
export interface WriterFencePolicy {
  version: 1 | 2; closureTrust?: ClosureTrustV2; evidenceMode: EvidenceMode; hostId: string; bootId: string; challengeId: string;
  binding: CutoverBinding;
  writers: ExpectedWriter[];
  catalog: string[];
  postgresRollbackCatalog?: PostgresRollbackCatalogEntry[];
  postgresRollbackVerifier?: { issuerId: string; keyId: string };
  guards: GuardBaseline[];
  collectors: Array<{ issuerId: string; keyId: string; publicKeyBase64: string; collectorSha256: string; kinds: ObservationKind[] }>;
  reviewers: Array<{ issuerId: string; keyId: string; publicKeyBase64: string; actions: CutoverAction[] }>;
  deadlines: { windowStart: string; windowEnd: string; maximumEvidenceAgeMs: number; maximumOperationMs: number; maximumLockMs: number };
  budgets: CutoverBudgets;
}
export interface CutoverObservation {
  version: 1 | 2; kind: ObservationKind; issuerId: string; keyId: string; evidenceMode: EvidenceMode;
  binding: CutoverBinding; observedAt: string; expiresAt: string;
  provenance: { hostId: string; bootId: string; collectorSha256: string; runId: string; sequence: string; challengeId: string };
  body: Record<string, unknown>;
  signatureBase64: string;
}
export type WriterFenceClosureV2 = Omit<ClosureInputV2, "phase">;
export interface WriterFenceBundle {
  version: 1 | 2;
  closure?: WriterFenceClosureV2;
  activation: { delivery: false; fomo: false; history: false; ownerMerge: false };
  observations: Record<typeof PREPARATION_OBSERVATIONS[number], CutoverObservation>;
}
export interface WriterFenceEvaluation {
  preparationReady: boolean; writeAuthorized: false; activationEnabled: false;
  evidenceMode: EvidenceMode | null; planSha256: string | null; blockers: string[];
}

export class CutoverProtocolError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CutoverProtocolError"; }
}
function fail(code: string): never { throw new CutoverProtocolError(code); }
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const sqlIdentifier = /^[a-z_][a-z0-9_]{0,62}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_OBJECT");
  return value as Record<string, unknown>;
}
function keys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const v = object(value);
  if (!sameStrings(Object.keys(v), expected)) fail("UNKNOWN_OR_MISSING_FIELDS");
  return v;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail("INVALID_ARRAY"); return value; }
function id(value: unknown): value is string { return typeof value === "string" && idPattern.test(value); }
function sha(value: unknown): value is string { return typeof value === "string" && hashPattern.test(value); }
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function count(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,99})$/.test(value)) fail("INVALID_DECIMAL");
  return BigInt(value);
}
function time(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail("INVALID_TIME");
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) fail("INVALID_TIME");
  return result;
}
function sameStrings(a: unknown, b: readonly unknown[]): boolean {
  return Array.isArray(a) && a.every(v => typeof v === "string") && new Set(a).size === a.length
    && a.length === b.length && a.every(v => b.includes(v));
}

/** Versioned JSON encoding: no coercion, accessors, prototypes, holes or non-finite numbers. */
export function migrationCutoverCanonicalJson(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  const encode = (item: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 64) fail("JSON_LIMIT_EXCEEDED");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail("NON_CANONICAL_NUMBER");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") fail("NON_JSON_VALUE");
    if (active.has(item)) fail("CYCLIC_JSON");
    const isArray = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("NON_JSON_PROTOTYPE");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== "string")) fail("NON_JSON_PROPERTY");
    active.add(item);
    try {
      if (isArray) {
        const size = (item as unknown[]).length;
        if (Object.keys(descriptors).length !== size + 1) fail("NON_JSON_ARRAY");
        const values: string[] = [];
        for (let i = 0; i < size; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("NON_JSON_ARRAY");
          values.push(encode(descriptor.value, depth + 1));
        }
        return `[${values.join(",")}]`;
      }
      return `{${Object.keys(descriptors).sort().map(key => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("NON_JSON_PROPERTY");
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    } finally { active.delete(item); }
  };
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded) > 8_388_608) fail("JSON_LIMIT_EXCEEDED");
  return encoded;
}
function copy<T>(value: T): T { return JSON.parse(migrationCutoverCanonicalJson(value)) as T; }
export function migrationCutoverDigest(value: unknown, version: 1 | 2 = 1): string {
  return createHash("sha256").update(`address-radar/migration-cutover/v${version}\n`).update(migrationCutoverCanonicalJson(value)).digest("hex");
}
export function migrationCutoverPlanDigest(policy: WriterFencePolicy, bundle: WriterFenceBundle): string {
  if (policy.version !== bundle.version) fail("PROTOCOL_VERSION_MISMATCH");
  if (policy.version === 1) return migrationCutoverDigest({ policy, bundle });
  return createHash("sha256").update("address-radar/migration-cutover/plan/v2\n").update(migrationCutoverCanonicalJson({ policy, bundle })).digest("hex");
}
function equal(a: unknown, b: unknown): boolean { return migrationCutoverCanonicalJson(a) === migrationCutoverCanonicalJson(b); }
export function migrationCutoverObservationPayload(value: Omit<CutoverObservation, "signatureBase64"> | CutoverObservation): string {
  const normalized = copy(value), { signatureBase64: _signature, ...payload } = normalized as CutoverObservation;
  return `address-radar/migration-cutover/observation/v${normalized.version}\n` + migrationCutoverCanonicalJson(payload);
}
function publicKey(value: unknown) {
  if (typeof value !== "string") fail("INVALID_TRUST_KEY");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("INVALID_TRUST_KEY");
  try {
    const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519" || !key.export({ type: "spki", format: "der" }).equals(bytes)) fail("INVALID_TRUST_KEY");
    return key;
  } catch { return fail("INVALID_TRUST_KEY"); }
}
function signatureValid(payload: string, signature: unknown, key: string): boolean {
  if (typeof signature !== "string") return false;
  const bytes = Buffer.from(signature, "base64");
  return bytes.length === 64 && bytes.toString("base64") === signature && verify(null, Buffer.from(payload), publicKey(key), bytes);
}
function targetValid(value: unknown): CutoverPostgresTarget {
  const v = keys(value, ["database", "schema", "schemaSha256", "releaseSha256", "generation", "serverAddress", "serverPort", "systemIdentifier"]);
  if (![v.database, v.schema].every(x => typeof x === "string" && sqlIdentifier.test(x))
    || ["postgres", "template0", "template1"].includes(String(v.database))
    || ["public", "information_schema"].includes(String(v.schema))
    || !sha(v.schemaSha256) || !sha(v.releaseSha256) || !id(v.generation)
    || typeof v.serverAddress !== "string" || !isIP(v.serverAddress) || !integer(v.serverPort, 1, 65535) || count(v.systemIdentifier) <= 0n) fail("INVALID_POSTGRES_TARGET");
  return v as unknown as CutoverPostgresTarget;
}
function bindingValid(value: unknown): CutoverBinding {
  const b = keys(value, ["source", "sourceGeneration", "generation", "watermark", "cohortId", "snapshot", "target", "rollbackTarget"]);
  const source = keys(b.source, ["id", "canonicalPath", "device", "inode", "schemaSha256"]);
  if (!id(source.id) || typeof source.canonicalPath !== "string" || !source.canonicalPath.startsWith("/")
    || posix.normalize(source.canonicalPath) !== source.canonicalPath || source.canonicalPath === "/"
    || source.canonicalPath.includes("\0") || !sha(source.schemaSha256)) fail("INVALID_CANONICAL_SOURCE");
  count(source.device); if (count(source.inode) <= 0n) fail("INVALID_CANONICAL_SOURCE");
  if (!id(b.sourceGeneration) || !id(b.generation) || !id(b.cohortId) || b.sourceGeneration === b.generation) fail("INVALID_GENERATION");
  count(b.watermark);
  const snapshot = keys(b.snapshot, ["id", "sha256"]);
  if (!id(snapshot.id) || !sha(snapshot.sha256)) fail("INVALID_SNAPSHOT");
  const target = targetValid(b.target), rollback = targetValid(b.rollbackTarget);
  if (target.generation !== b.generation || rollback.generation !== b.generation
    || rollback.database !== target.database || rollback.schema !== target.schema || rollback.systemIdentifier !== target.systemIdentifier
    || rollback.serverAddress !== target.serverAddress || rollback.serverPort !== target.serverPort) fail("INCOHERENT_POSTGRES_TARGET");
  return b as unknown as CutoverBinding;
}
const actions: CutoverAction[] = ["prepare", "select-postgres", "first-postgres-write", "rollback", "abort"];
function validatePolicy(input: unknown): WriterFencePolicy {
  const copied = copy(input);
  const optional = ["postgresRollbackCatalog", "postgresRollbackVerifier", "closureTrust"].filter(key => Object.hasOwn(object(copied), key));
  const p = keys(copied, [...optional, "version", "evidenceMode", "hostId", "bootId", "challengeId", "binding", "writers", "catalog", "guards", "collectors", "reviewers", "deadlines", "budgets"]);
  if (![1, 2].includes(p.version as number) || !["production-observation", "injected-protocol-fixture"].includes(p.evidenceMode as string)
    || !id(p.hostId) || !id(p.bootId) || !id(p.challengeId)) fail("INVALID_EXPECTED_POLICY");
  bindingValid(p.binding);
  const writers = array(p.writers).map(value => keys(value, ["id", "kind", "executableSha256"]));
  if (!writers.length || writers.length > 512 || writers.some(w => !id(w.id) || !WRITER_KINDS.includes(w.kind as WriterKind) || !sha(w.executableSha256))
    || new Set(writers.map(w => w.id)).size !== writers.length
    || (p.version === 2 ? CUTOVER_SERVICES : LEGACY_CUTOVER_SERVICES).some(name => !writers.some(w => w.id === name && w.kind === "services"))
    || (p.version === 2 ? CUTOVER_TIMERS : LEGACY_CUTOVER_TIMERS).some(name => !writers.some(w => w.id === name && w.kind === "timers"))) fail("INCOMPLETE_EXPECTED_WRITERS");
  if (p.postgresRollbackCatalog !== undefined || p.postgresRollbackVerifier !== undefined) {
    validatePostgresRollbackCatalog(p.postgresRollbackCatalog);
    const verifier = keys(p.postgresRollbackVerifier, ["issuerId", "keyId"]);
    if (!id(verifier.issuerId) || !id(verifier.keyId)) fail("INVALID_COMPATIBILITY_VERIFIER");
  }
  const catalog = array(p.catalog);
  if (!catalog.length || catalog.length > 10_000 || !sameStrings(catalog, catalog) || catalog.some(v => !id(v))) fail("INVALID_EXPECTED_CATALOG");
  const guards = array(p.guards).map(value => keys(value, ["id", "kind", "rows", "sha256"]));
  if (!guards.length || new Set(guards.map(g => g.id)).size !== guards.length
    || guards.some(g => !id(g.id) || !["provider", "delivery"].includes(g.kind as string) || !sha(g.sha256))
    || !["provider", "delivery"].every(kind => guards.some(g => g.kind === kind))) fail("INVALID_EXPECTED_GUARDS");
  guards.forEach(g => count(g.rows));
  const collectors = array(p.collectors).map(value => keys(value, ["issuerId", "keyId", "publicKeyBase64", "collectorSha256", "kinds"]));
  const reviewers = array(p.reviewers).map(value => keys(value, ["issuerId", "keyId", "publicKeyBase64", "actions"]));
  for (const group of [collectors, reviewers]) {
    if (!group.length || new Set(group.map(v => v.keyId)).size !== group.length || group.some(v => !id(v.issuerId) || !id(v.keyId))) fail("INVALID_TRUST_POLICY");
    group.forEach(v => publicKey(v.publicKeyBase64));
  }
  for (const c of collectors) {
    if (!sha(c.collectorSha256) || !array(c.kinds).length || !sameStrings(c.kinds, array(c.kinds))
      || array(c.kinds).some(kind => ![...PREPARATION_OBSERVATIONS, "rollback"].includes(kind as ObservationKind))) fail("INVALID_TRUST_POLICY");
  }
  if ([...PREPARATION_OBSERVATIONS, "rollback"].some(kind => !collectors.some(c => array(c.kinds).includes(kind)))) fail("INCOMPLETE_TRUST_POLICY");
  for (const r of reviewers) if (!array(r.actions).length || !sameStrings(r.actions, array(r.actions)) || array(r.actions).some(a => !actions.includes(a as CutoverAction))) fail("INVALID_TRUST_POLICY");
  const d = keys(p.deadlines, ["windowStart", "windowEnd", "maximumEvidenceAgeMs", "maximumOperationMs", "maximumLockMs"]);
  if (!(time(d.windowStart) < time(d.windowEnd)) || time(d.windowEnd) - time(d.windowStart) > 3_600_000
    || !integer(d.maximumEvidenceAgeMs, 1, 300_000) || !integer(d.maximumOperationMs, 1, 60_000)
    || !integer(d.maximumLockMs, 1, 5_000) || d.maximumLockMs > d.maximumOperationMs) fail("UNBOUNDED_DEADLINES");
  const budgets = keys(p.budgets, ["connections", "migrationConnections", "operatorConnections", "backupConnections", "reservedConnections", "maximumConnections", "availableRamBytes", "peakRamBytes", "reserveRamBytes", "availableDiskBytes", "peakDiskBytes", "peakWalBytes", "peakTempBytes", "reserveDiskBytes", "maximumTransitions", "maximumSqlStatements"]);
  const pools = array(budgets.connections).map(value => keys(value, ["writerId", "instances", "maximumEach"]));
  if (!sameStrings(pools.map(v => v.writerId), writers.map(w => w.id)) || pools.some(pool => !integer(pool.instances, 1, 1024) || !integer(pool.maximumEach, 0, 1024))
    || !integer(budgets.migrationConnections, 1, 1024) || !integer(budgets.operatorConnections, 0, 1024)
    || !integer(budgets.backupConnections, 0, 1024) || !integer(budgets.reservedConnections, 1, 1024)
    || !integer(budgets.maximumConnections, 1, 4096) || !integer(budgets.maximumTransitions, 1, 64)
    || !integer(budgets.maximumSqlStatements, 8, MAXIMUM_CUTOVER_WRITE_SQL_STATEMENTS)) fail("INVALID_CONNECTION_BUDGET");
  const total = pools.reduce((sum, pool) => sum + BigInt(pool.instances as number) * BigInt(pool.maximumEach as number), 0n)
    + BigInt(budgets.migrationConnections as number) + BigInt(budgets.operatorConnections as number)
    + BigInt(budgets.backupConnections as number) + BigInt(budgets.reservedConnections as number);
  if (total > BigInt(budgets.maximumConnections as number)) fail("CONNECTION_BUDGET_EXCEEDED");
  const ram = count(budgets.availableRamBytes), disk = count(budgets.availableDiskBytes);
  if (count(budgets.peakRamBytes) <= 0n || count(budgets.peakDiskBytes) <= 0n || count(budgets.reserveRamBytes) <= 0n || count(budgets.reserveDiskBytes) <= 0n
    || ram < count(budgets.peakRamBytes) + count(budgets.reserveRamBytes)
    || disk < count(budgets.peakDiskBytes) + count(budgets.peakWalBytes) + count(budgets.peakTempBytes) + count(budgets.reserveDiskBytes)) fail("MEMORY_OR_DISK_BUDGET_EXCEEDED");
  const policy = p as unknown as WriterFencePolicy;
  if (policy.version === 2) validateClosureTrustV2(policy);
  else if (policy.closureTrust !== undefined) fail("V1_CANNOT_CONTAIN_V2_CLOSURE_TRUST");
  return policy;
}
function fresh(value: unknown, p: WriterFencePolicy, now: number): number {
  const t = time(value);
  if (t > now || now - t > p.deadlines.maximumEvidenceAgeMs) fail("STALE_OR_FUTURE_OBSERVATION");
  return t;
}
function approvedWindowTime(value: unknown, p: WriterFencePolicy, now: number): number {
  const boundary = time(value);
  if (boundary < time(p.deadlines.windowStart) || boundary >= time(p.deadlines.windowEnd) || boundary > now) fail("BOUNDARY_OUTSIDE_APPROVED_WINDOW");
  return boundary;
}
function observation(input: unknown, kind: ObservationKind, p: WriterFencePolicy, now: number): CutoverObservation {
  const v = keys(input, ["version", "kind", "issuerId", "keyId", "evidenceMode", "binding", "observedAt", "expiresAt", "provenance", "body", "signatureBase64"]);
  const issuer = p.collectors.find(c => c.keyId === v.keyId && c.issuerId === v.issuerId && c.kinds.includes(kind));
  if (!issuer || v.version !== p.version || v.kind !== kind || v.evidenceMode !== p.evidenceMode || !equal(v.binding, p.binding)) fail("UNTRUSTED_OR_INCOHERENT_OBSERVATION");
  const observed = fresh(v.observedAt, p, now), expires = time(v.expiresAt);
  if (expires <= now || expires - observed > p.deadlines.maximumEvidenceAgeMs) fail("EXPIRED_OBSERVATION");
  const provenance = keys(v.provenance, ["hostId", "bootId", "collectorSha256", "runId", "sequence", "challengeId"]);
  if (provenance.hostId !== p.hostId || provenance.bootId !== p.bootId || provenance.challengeId !== p.challengeId
    || provenance.collectorSha256 !== issuer.collectorSha256 || !id(provenance.runId) || count(provenance.sequence) <= 0n) fail("INVALID_OBSERVATION_PROVENANCE");
  object(v.body);
  if (!signatureValid(migrationCutoverObservationPayload(v as unknown as CutoverObservation), v.signatureBase64, issuer.publicKeyBase64)) fail("INVALID_OBSERVATION_SIGNATURE");
  return v as unknown as CutoverObservation;
}
function tableParity(value: unknown, catalog: string[], sourceTables?: unknown): void {
  const entries = array(value).map(v => keys(v, ["table", "sourceRows", "preservedRows", "quarantinedRows", "sourceSha256", "retainedSha256"]));
  if (!sameStrings(entries.map(t => t.table), catalog)) fail("UNKNOWN_OR_MISSING_TABLE");
  const sources = sourceTables === undefined ? null : array(sourceTables).map(object);
  for (const entry of entries) {
    if (count(entry.sourceRows) !== count(entry.preservedRows) + count(entry.quarantinedRows)
      || !sha(entry.sourceSha256) || entry.sourceSha256 !== entry.retainedSha256) fail("TABLE_PARITY_FAILED");
    const source = sources?.find(s => s.table === entry.table);
    if (sources && (!source || source.rows !== entry.sourceRows || source.sha256 !== entry.sourceSha256)) fail("SNAPSHOT_PARITY_MISMATCH");
  }
}
function verifyPreparation(bundleInput: unknown, p: WriterFencePolicy, now: number): { bundle: WriterFenceBundle; planSha256: string; validUntil: number } {
  const bundle = keys(copy(bundleInput), p.version === 2 ? ["version", "activation", "observations", "closure"] : ["version", "activation", "observations"]);
  const activation = keys(bundle.activation, ["delivery", "fomo", "history", "ownerMerge"]);
  if (bundle.version !== p.version || Object.values(activation).some(v => v !== false)) fail("ACTIVATION_MUST_REMAIN_DISABLED");
  if (now < time(p.deadlines.windowStart) || now >= time(p.deadlines.windowEnd)) fail("OUTSIDE_PREPARATION_WINDOW");
  const observations = keys(bundle.observations, PREPARATION_OBSERVATIONS);
  const reports = Object.fromEntries(PREPARATION_OBSERVATIONS.map(kind => [kind, observation(observations[kind], kind, p, now)])) as Record<typeof PREPARATION_OBSERVATIONS[number], CutoverObservation>;
  const fence = keys(reports.fence.body, ["fenceId", "enforcedAt", "validUntil", "deniedGenerations", "barriers"]);
  if (fence.fenceId !== p.challengeId || !sameStrings(fence.deniedGenerations, [p.binding.sourceGeneration])
    || time(fence.validUntil) <= now || time(fence.validUntil) > time(p.deadlines.windowEnd)) fail("INVALID_WRITER_FENCE");
  const enforced = approvedWindowTime(fence.enforcedAt, p, now);
  if (enforced > time(reports.fence.observedAt)) fail("INVALID_FENCE_TIMELINE");
  const barriers = array(fence.barriers).map(v => keys(v, ["writerId", "admission", "input", "rejection"]));
  if (!sameStrings(barriers.map(b => b.writerId), p.writers.map(w => w.id))) fail("INCOMPLETE_WRITER_BARRIERS");
  const attemptIds: unknown[] = [];
  for (const barrier of barriers) {
    const rejection = keys(barrier.rejection, ["attemptId", "generation", "result"]);
    if (barrier.admission !== "denied" || barrier.input !== "blocked" || !id(rejection.attemptId)
      || rejection.generation !== p.binding.sourceGeneration || rejection.result !== "generation-rejected") fail("WRITER_BARRIER_NOT_PROVEN");
    attemptIds.push(rejection.attemptId);
  }
  if (new Set(attemptIds).size !== attemptIds.length) fail("DUPLICATE_FENCE_PROBE");
  const snapshot = keys(reports.snapshot.body, ["mode", "fenceId", "snapshotId", "snapshotSha256", "watermark", "startedAt", "completedAt", "catalogSha256", "tables"]);
  if (snapshot.mode !== "full-fenced-snapshot" || snapshot.fenceId !== p.challengeId || snapshot.snapshotId !== p.binding.snapshot.id
    || snapshot.snapshotSha256 !== p.binding.snapshot.sha256 || snapshot.watermark !== p.binding.watermark
    || snapshot.catalogSha256 !== migrationCutoverDigest(p.catalog)) fail("FULL_FENCED_SNAPSHOT_REQUIRED");
  const started = approvedWindowTime(snapshot.startedAt, p, now), completed = approvedWindowTime(snapshot.completedAt, p, now);
  if (!(enforced <= started && started <= completed && completed <= time(reports.snapshot.observedAt))) fail("SNAPSHOT_OUTSIDE_FENCE");
  const tables = array(snapshot.tables).map(v => keys(v, ["table", "rows", "sha256"]));
  if (!sameStrings(tables.map(t => t.table), p.catalog) || tables.some(t => !sha(t.sha256))) fail("UNKNOWN_OR_MISSING_TABLE");
  tables.forEach(t => count(t.rows));
  const census = keys(reports.census.body, ["fenceId", "snapshotSha256", "startedAt", "completedAt", "methods", "groups", "writers", "scannedPaths", "files", "processes", "fileHolders"]);
  const censusStart = fresh(census.startedAt, p, now), censusEnd = fresh(census.completedAt, p, now);
  if (!(completed <= censusStart && censusStart <= censusEnd && censusEnd <= time(reports.census.observedAt))
    || census.fenceId !== p.challengeId || census.snapshotSha256 !== p.binding.snapshot.sha256 || !sameStrings(census.methods, CENSUS_METHODS)) fail("CURRENT_EXHAUSTIVE_CENSUS_REQUIRED");
  const groups = array(census.groups).map(v => keys(v, ["kind", "writerIds"]));
  if (!sameStrings(groups.map(g => g.kind), WRITER_KINDS)) fail("INCOMPLETE_CENSUS_CATEGORIES");
  for (const group of groups) if (!sameStrings(group.writerIds, p.writers.filter(w => w.kind === group.kind).map(w => w.id))) fail("UNKNOWN_OR_MISSING_WRITER");
  if (!equal(census.writers, p.writers)) fail("UNKNOWN_OR_MISSING_WRITER");
  const paths = [p.binding.source.canonicalPath, p.binding.source.canonicalPath + "-wal", p.binding.source.canonicalPath + "-shm"];
  if (!sameStrings(census.scannedPaths, paths)) fail("INCOMPLETE_FILE_CENSUS");
  const files = array(census.files).map(v => keys(v, ["canonicalPath", "device", "inode"]));
  if (!sameStrings(files.map(f => f.canonicalPath), paths)) fail("INCOMPLETE_FILE_CENSUS");
  for (const file of files) {
    if (file.device === null && file.inode === null && file.canonicalPath !== p.binding.source.canonicalPath) continue;
    count(file.device); if (count(file.inode) <= 0n) fail("INVALID_FILE_IDENTITY");
  }
  const database = files.find(f => f.canonicalPath === p.binding.source.canonicalPath)!;
  if (database.device !== p.binding.source.device || database.inode !== p.binding.source.inode) fail("SOURCE_FILE_IDENTITY_CHANGED");
  const processes = array(census.processes), holders = array(census.fileHolders);
  for (const value of [...processes, ...holders]) {
    const writer = object(value).writerId;
    if (!p.writers.some(w => w.id === writer)) fail("UNKNOWN_LIVE_WRITER");
  }
  if (processes.length || holders.length) fail("LIVE_PROCESS_OR_SOURCE_FILE_HOLDER");
  const parity = keys(reports.parity.body, ["snapshotSha256", "watermark", "tables"]);
  if (parity.snapshotSha256 !== p.binding.snapshot.sha256 || parity.watermark !== p.binding.watermark) fail("INCOHERENT_PARITY");
  tableParity(parity.tables, p.catalog, tables);
  const target = keys(reports.target.body, ["current", "compatible", "probeSha256"]);
  if (!equal(target.current, p.binding.target) || !equal(target.compatible, p.binding.rollbackTarget) || !sha(target.probeSha256)) fail("EXACT_POSTGRES_TARGET_NOT_PROVEN");
  const guards = keys(reports.guards.body, ["baseline", "retained", "probeSha256"]);
  if (!equal(guards.baseline, p.guards) || !equal(guards.retained, p.guards) || !sha(guards.probeSha256)) fail("PROVIDER_OR_DELIVERY_GUARDS_NOT_PRESERVED");
  const capacity = keys(reports.capacity.body, ["budgetSha256", "measurementId", "traceSha256", "startedAt", "completedAt", "peakRamBytes", "peakDiskBytes", "peakWalBytes", "peakTempBytes", "connectionPeak"]);
  if (capacity.budgetSha256 !== migrationCutoverDigest(p.budgets) || !id(capacity.measurementId) || !sha(capacity.traceSha256)
    || !(approvedWindowTime(capacity.startedAt, p, now) <= approvedWindowTime(capacity.completedAt, p, now)) || time(capacity.completedAt) > time(reports.capacity.observedAt)
    || !integer(capacity.connectionPeak, 1, p.budgets.maximumConnections - p.budgets.reservedConnections)
    || ["peakRamBytes", "peakDiskBytes", "peakWalBytes", "peakTempBytes"].some(field => capacity[field] !== p.budgets[field as keyof CutoverBudgets])) fail("MEASURED_BUDGET_NOT_PROVEN");
  const rehearsal = keys(reports.rehearsal.body, Object.hasOwn(reports.rehearsal.body, "compatibleRelease") ? ["before", "after", "compatibleRelease"] : ["before", "after"]);
  const before = keys(rehearsal.before, ["target", "snapshotSha256", "paritySha256", "guardsSha256", "receiptSha256", "testedAt"]);
  const after = keys(rehearsal.after, ["target", "writeReceiptSha256", "retainedMutationsSha256", "recoveredMutationsSha256", "guardsSha256", "receiptSha256", "startedAt", "firstWriteAt", "completedAt"]);
  if (before.target !== "source-only" || before.snapshotSha256 !== p.binding.snapshot.sha256
    || before.paritySha256 !== migrationCutoverDigest(reports.parity.body) || before.guardsSha256 !== migrationCutoverDigest(p.guards) || !sha(before.receiptSha256)
    || approvedWindowTime(before.testedAt, p, now) < completed || time(before.testedAt) > time(after.startedAt) || time(before.testedAt) > time(reports.rehearsal.observedAt) || !equal(after.target, p.binding.rollbackTarget)
    || !sha(after.writeReceiptSha256) || !sha(after.retainedMutationsSha256) || after.retainedMutationsSha256 !== after.recoveredMutationsSha256
    || after.guardsSha256 !== migrationCutoverDigest(p.guards) || !sha(after.receiptSha256)
    || !(approvedWindowTime(after.startedAt, p, now) < approvedWindowTime(after.firstWriteAt, p, now) && time(after.firstWriteAt) < approvedWindowTime(after.completedAt, p, now))
    || time(after.completedAt) > time(reports.rehearsal.observedAt)) fail("BOTH_ROLLBACK_REHEARSALS_REQUIRED");
  const compatibleProof = rehearsal.compatibleRelease === undefined ? null : verifyCompatibleReleaseProof(rehearsal.compatibleRelease, p, reports.rehearsal, now, completed);
  if (p.version === 2) verifyPreparationClosureV2(bundle as unknown as WriterFenceBundle, p, now, "before-first-pg-write");
  return { bundle: bundle as unknown as WriterFenceBundle, planSha256: migrationCutoverPlanDigest(p, bundle as unknown as WriterFenceBundle),
    validUntil: Math.min(time(p.deadlines.windowEnd), time(fence.validUntil),
      ...(compatibleProof === null ? [] : [time(compatibleProof.attestation.expiresAt), time(compatibleProof.attestation.observedAt) + p.deadlines.maximumEvidenceAgeMs]),
      censusStart + p.deadlines.maximumEvidenceAgeMs, censusEnd + p.deadlines.maximumEvidenceAgeMs,
      ...Object.values(reports).flatMap(report => [time(report.expiresAt), time(report.observedAt) + p.deadlines.maximumEvidenceAgeMs])) };
}

/** Saved evidence only. A successful result is never a capability to write or activate. */
export function evaluateMigrationWriterFence(bundle: unknown, expected: unknown, now: string): WriterFenceEvaluation {
  const result: WriterFenceEvaluation = { preparationReady: false, writeAuthorized: false, activationEnabled: false, evidenceMode: null, planSha256: null, blockers: [] };
  try {
    const policy = validatePolicy(expected);
    result.evidenceMode = policy.evidenceMode;
    result.planSha256 = verifyPreparation(bundle, policy, time(now)).planSha256;
    if (policy.version !== 2) fail("V1_AUDIT_ONLY_NO_CUTOVER_ADVANCE");
    result.preparationReady = true;
  } catch (error) { result.blockers.push(error instanceof CutoverProtocolError ? error.code : "INVALID_INPUT"); }
  return result;
}

export interface CutoverCommand {
  version?: 1 | 2;
  operationId: string; action: CutoverAction; expectedRevision: number; planSha256: string; deadline: string; writeId: string | null;
  recovery: CutoverObservation | null;
  authorization: { issuerId: string; keyId: string; issuedAt: string; expiresAt: string; signatureBase64: string };
}
export function migrationCutoverAuthorizationPayload(input: CutoverCommand): string {
  const command = copy(input), { signatureBase64: _signature, ...authorization } = command.authorization;
  return `address-radar/migration-cutover/authorization/v${command.version ?? 1}\n` + migrationCutoverCanonicalJson({ ...command, authorization });
}
export interface FirstPostgresWriteReceipt {
  writeId: string; receiptSha256: string; providerGuardSha256: string; deliveryGuardSha256: string;
}
export interface CutoverTransitionReceipt {
  operationId: string; revision: number; phase: CutoverPhase; planSha256: string; recordedAt: string;
  activationEnabled: false; writeAuthorized: false;
}
export interface DurableCutoverState {
  version: 1 | 2; revision: number; phase: CutoverPhase; binding: CutoverBinding; policySha256: string; planSha256: string;
  activationEnabled: false;
  preparation: WriterFenceBundle;
  snapshotTables: Array<{ table: string; rows: string; sha256: string }>;
  firstPostgresWrite: (FirstPostgresWriteReceipt & { recordedAt: string }) | null;
  journal: Array<{ operationId: string; requestSha256: string; command: CutoverCommand; receipt: CutoverTransitionReceipt }>;
}
export interface FirstPostgresWriteMarkerV2 {
  version: 2; sourceKey: string; policySha256: string; planSha256: string; bindingSha256: string;
  cohortId: string; generation: string; writeId: string; receiptSha256: string;
  providerGuardSha256: string; deliveryGuardSha256: string; recordedAt: string;
}
export interface CutoverTransaction {
  loadFirstWriteMarker?(): Promise<FirstPostgresWriteMarkerV2 | null>;
  saveFirstWriteMarker?(marker: FirstPostgresWriteMarkerV2): Promise<void>;
  readonly postgres: PostgresTransaction;
  load(): Promise<DurableCutoverState | null>;
  save(expectedRevision: number, state: DurableCutoverState): Promise<void>;
}
export interface CutoverTransactionScope {
  protocolVersion?: 1 | 2;
  postgresRollbackCatalog?: readonly string[] | undefined;
  sourceKey: string; target: CutoverPostgresTarget; deadline: string; maximumLockMs: number; maximumSqlStatements: number; signal: AbortSignal | undefined;
}
/** run must acknowledge a durable commit, serialize by sourceKey, and roll back callback failures. */
export interface CutoverTransitionStore {
  run<T>(scope: CutoverTransactionScope, operation: (transaction: CutoverTransaction) => Promise<T>): Promise<T>;
}
export class CutoverCommitUnknownError extends CutoverProtocolError {
  constructor(readonly operationId: string) { super("COMMIT_UNKNOWN_RECONCILE_UNDER_SOURCE_LOCK"); this.name = "CutoverCommitUnknownError"; }
}
function recordedCommand(input: unknown, policy: WriterFencePolicy, recordedAt: number): CutoverCommand {
  const c = keys(input, policy.version === 2 ? ["version", "operationId", "action", "expectedRevision", "planSha256", "deadline", "writeId", "recovery", "authorization"] : ["operationId", "action", "expectedRevision", "planSha256", "deadline", "writeId", "recovery", "authorization"]);
  if ((policy.version === 2 && c.version !== 2) || !id(c.operationId) || !actions.includes(c.action as CutoverAction) || !integer(c.expectedRevision, 0, policy.budgets.maximumTransitions)
    || !sha(c.planSha256) || (c.action === "first-postgres-write" ? !id(c.writeId) : c.writeId !== null)
    || (c.action === "rollback" ? c.recovery === null : c.recovery !== null)
    || time(c.deadline) <= recordedAt || time(c.deadline) - recordedAt > policy.deadlines.maximumOperationMs) fail("CORRUPT_SIGNED_COMMAND_CHAIN");
  const a = keys(c.authorization, ["issuerId", "keyId", "issuedAt", "expiresAt", "signatureBase64"]);
  const reviewer = policy.reviewers.find(r => r.issuerId === a.issuerId && r.keyId === a.keyId && r.actions.includes(c.action as CutoverAction));
  if (!reviewer || fresh(a.issuedAt, policy, recordedAt) > recordedAt || time(a.expiresAt) <= recordedAt || time(a.expiresAt) > time(c.deadline)
    || (policy.version === 2 && !closureReviewerMatchesV2(reviewer.publicKeyBase64, policy))
    || !signatureValid(migrationCutoverAuthorizationPayload(c as unknown as CutoverCommand), a.signatureBase64, reviewer.publicKeyBase64)) fail("PERSISTED_SCOPED_AUTHORIZATION_INVALID");
  return c as unknown as CutoverCommand;
}

function durableState(input: unknown, policy: WriterFencePolicy): DurableCutoverState {
  const v = keys(copy(input), ["version", "revision", "phase", "binding", "policySha256", "planSha256", "activationEnabled", "preparation", "snapshotTables", "firstPostgresWrite", "journal"]);
  const phases: CutoverPhase[] = ["prepared", "postgres-selected", "postgres-written", "source-rollback-selected", "postgres-rollback-selected", "aborted"];
  if (v.version !== policy.version || !integer(v.revision, 1, policy.budgets.maximumTransitions) || !phases.includes(v.phase as CutoverPhase)
    || v.activationEnabled !== false || !equal(v.binding, policy.binding) || v.policySha256 !== migrationCutoverDigest(policy, policy.version) || !sha(v.planSha256)) fail("STALE_GENERATION_OR_CORRUPT_DURABLE_STATE");
  const snapshotTables = array(v.snapshotTables).map(t => keys(t, ["table", "rows", "sha256"]));
  if (!sameStrings(snapshotTables.map(t => t.table), policy.catalog) || snapshotTables.some(t => !sha(t.sha256))) fail("CORRUPT_SNAPSHOT_TABLES");
  snapshotTables.forEach(t => count(t.rows));
  const journal = array(v.journal);
  if (journal.length !== v.revision || new Set(journal.map(j => object(j).operationId)).size !== journal.length) fail("CORRUPT_TRANSITION_JOURNAL");
  let previousPhase: CutoverPhase | null = null;
  let firstWriteSeen = false;
  let previousTime = -Infinity;
  journal.forEach((entry, i) => {
    const j = keys(entry, ["operationId", "requestSha256", "command", "receipt"]);
    const r = keys(j.receipt, ["operationId", "revision", "phase", "planSha256", "recordedAt", "activationEnabled", "writeAuthorized"]);
    const recorded = time(r.recordedAt);
    const command = recordedCommand(j.command, policy, recorded);
    if (recorded < previousTime || command.operationId !== j.operationId || command.expectedRevision !== i
      || command.planSha256 !== v.planSha256 || migrationCutoverDigest(command, policy.version) !== j.requestSha256) fail("CORRUPT_SIGNED_COMMAND_CHAIN");
    previousTime = recorded;
    let expectedPhase: CutoverPhase;
    if (i === 0) {
      if (command.action !== "prepare") fail("CORRUPT_SIGNED_COMMAND_CHAIN");
      const preparation = verifyPreparation(v.preparation, policy, recorded);
      if (preparation.planSha256 !== v.planSha256 || time(command.authorization.expiresAt) > preparation.validUntil
        || !equal(object(preparation.bundle.observations.snapshot.body).tables, snapshotTables)) fail("CORRUPT_SIGNED_PREPARATION");
      expectedPhase = "prepared";
    } else if (command.action === "select-postgres" && previousPhase === "prepared") expectedPhase = "postgres-selected";
    else if (command.action === "first-postgres-write" && previousPhase === "postgres-selected") {
      if (v.firstPostgresWrite === null || object(v.firstPostgresWrite).writeId !== command.writeId) fail("CORRUPT_FIRST_WRITE_MARKER");
      firstWriteSeen = true;
      expectedPhase = "postgres-written";
    } else if (command.action === "abort" && ["prepared", "postgres-selected"].includes(previousPhase as string)) expectedPhase = "aborted";
    else if (command.action === "rollback" && ["prepared", "postgres-selected", "postgres-written"].includes(previousPhase as string)) {
      const prior = { ...(v as unknown as DurableCutoverState), revision: i, phase: previousPhase!,
        firstPostgresWrite: firstWriteSeen ? v.firstPostgresWrite as DurableCutoverState["firstPostgresWrite"] : null };
      expectedPhase = recoveryValid(command.recovery, prior, command, policy, recorded);
    } else fail("CORRUPT_SIGNED_COMMAND_CHAIN");
    if (command.action === "select-postgres" || command.action === "first-postgres-write") {
      const preparation = verifyPreparation(v.preparation, policy, recorded);
      if (time(command.authorization.expiresAt) > preparation.validUntil) fail("CORRUPT_SIGNED_PREPARATION");
    }
    if (policy.version === 2 && command.action !== "abort") verifyPreparationClosureV2(v.preparation as WriterFenceBundle, policy, command.action === "rollback" ? closureCommittedTimeV2(v as unknown as DurableCutoverState) : recorded, firstWriteSeen ? "after-first-pg-write" : "before-first-pg-write");
    if (r.phase !== expectedPhase) fail("CORRUPT_SIGNED_COMMAND_CHAIN");
    previousPhase = expectedPhase;
    if (!id(j.operationId) || !sha(j.requestSha256) || r.operationId !== j.operationId || r.revision !== i + 1
      || !phases.includes(r.phase as CutoverPhase) || r.planSha256 !== v.planSha256 || r.activationEnabled !== false || r.writeAuthorized !== false) fail("CORRUPT_TRANSITION_JOURNAL");
  });
  const last = object(object(journal.at(-1)).receipt);
  if (last.phase !== v.phase) fail("CORRUPT_TRANSITION_JOURNAL");
  if (v.firstPostgresWrite !== null) {
    const first = keys(v.firstPostgresWrite, ["writeId", "receiptSha256", "providerGuardSha256", "deliveryGuardSha256", "recordedAt"]);
    if (!id(first.writeId) || ![first.receiptSha256, first.providerGuardSha256, first.deliveryGuardSha256].every(sha)) fail("CORRUPT_FIRST_WRITE_MARKER");
    time(first.recordedAt);
  }
  if (["postgres-written", "postgres-rollback-selected"].includes(v.phase as string) !== (v.firstPostgresWrite !== null)) fail("CORRUPT_FIRST_WRITE_MARKER");
  return v as unknown as DurableCutoverState;
}
function recoveryValid(report: unknown, state: DurableCutoverState, command: CutoverCommand, policy: WriterFencePolicy, now: number): CutoverPhase {
  const signed = observation(report, "rollback", policy, now);
  const r = keys(signed.body, ["operationId", "stateRevision", "planSha256", "target", "snapshotSha256", "watermark", "firstWriteReceiptSha256", "tables", "guards", "providerGuardSha256", "deliveryGuardSha256", "retainedMutationsSha256", "recoveredMutationsSha256"]);
  if (r.operationId !== command.operationId || r.stateRevision !== state.revision || r.planSha256 !== state.planSha256
    || r.snapshotSha256 !== policy.binding.snapshot.sha256 || !equal(r.guards, policy.guards)) fail("ROLLBACK_SCOPE_OR_GUARDS_MISMATCH");
  tableParity(r.tables, policy.catalog, state.firstPostgresWrite === null ? state.snapshotTables : undefined);
  if (state.firstPostgresWrite === null) {
    if (r.target !== "source-only" || r.watermark !== policy.binding.watermark || r.firstWriteReceiptSha256 !== null
      || r.providerGuardSha256 !== migrationCutoverDigest(policy.guards.filter(g => g.kind === "provider"))
      || r.deliveryGuardSha256 !== migrationCutoverDigest(policy.guards.filter(g => g.kind === "delivery"))
      || r.retainedMutationsSha256 !== null || r.recoveredMutationsSha256 !== null) fail("BEFORE_WRITE_SOURCE_PARITY_REQUIRED");
    return "source-rollback-selected";
  }
  if (time(signed.observedAt) < time(state.firstPostgresWrite.recordedAt) || !equal(r.target, policy.binding.rollbackTarget) || r.firstWriteReceiptSha256 !== state.firstPostgresWrite.receiptSha256
    || count(r.watermark) < count(policy.binding.watermark)
    || r.providerGuardSha256 !== state.firstPostgresWrite.providerGuardSha256 || r.deliveryGuardSha256 !== state.firstPostgresWrite.deliveryGuardSha256
    || !sha(r.retainedMutationsSha256) || r.retainedMutationsSha256 !== r.recoveredMutationsSha256) fail("AFTER_WRITE_EXACT_POSTGRES_RECOVERY_REQUIRED");
  return "postgres-rollback-selected";
}

export function createMigrationCutoverCoordinator(options: { expected: WriterFencePolicy; store: CutoverTransitionStore; clock: () => string }) {
  const policy = validatePolicy(options.expected), policySha256 = migrationCutoverDigest(policy, policy.version);
  // Lock identity excludes generation: two generations must never coordinate the same source independently.
  const sourceKey = migrationCutoverDigest({ hostId: policy.hostId, canonicalPath: policy.binding.source.canonicalPath });
  let highWaterTime = -Infinity;
  const now = () => {
    const value = time(options.clock());
    if (value < highWaterTime) fail("CLOCK_MOVED_BACKWARDS");
    highWaterTime = value;
    return value;
  };
  const commandValid = (input: unknown, current: number): CutoverCommand => {
    const c = keys(copy(input), policy.version === 2 ? ["version", "operationId", "action", "expectedRevision", "planSha256", "deadline", "writeId", "recovery", "authorization"] : ["operationId", "action", "expectedRevision", "planSha256", "deadline", "writeId", "recovery", "authorization"]);
    if ((policy.version === 2 && c.version !== 2) || !id(c.operationId) || !actions.includes(c.action as CutoverAction) || !integer(c.expectedRevision, 0, policy.budgets.maximumTransitions)
      || !sha(c.planSha256) || (c.action === "first-postgres-write" ? !id(c.writeId) : c.writeId !== null)
      || (c.action === "rollback" ? c.recovery === null : c.recovery !== null)) fail("INVALID_COMMAND");
    const deadline = time(c.deadline);
    if (deadline <= current || deadline - current > policy.deadlines.maximumOperationMs) fail("INVALID_OPERATION_DEADLINE");
    const auth = keys(c.authorization, ["issuerId", "keyId", "issuedAt", "expiresAt", "signatureBase64"]);
    const reviewer = policy.reviewers.find(r => r.issuerId === auth.issuerId && r.keyId === auth.keyId && r.actions.includes(c.action as CutoverAction));
    if (!reviewer || fresh(auth.issuedAt, policy, current) > current || time(auth.expiresAt) <= current || time(auth.expiresAt) > deadline
      || (policy.version === 2 && !closureReviewerMatchesV2(reviewer.publicKeyBase64, policy))
      || !signatureValid(migrationCutoverAuthorizationPayload(c as unknown as CutoverCommand), auth.signatureBase64, reviewer.publicKeyBase64)) fail("EXPLICIT_SCOPED_AUTHORIZATION_REQUIRED");
    return c as unknown as CutoverCommand;
  };
  const check = (command: CutoverCommand, signal?: AbortSignal) => {
    if (signal?.aborted) fail("OPERATION_ABORTED");
    if (now() >= Math.min(time(command.deadline), time(command.authorization.expiresAt))) fail("OPERATION_DEADLINE_EXCEEDED");
  };
  const scope = (command: CutoverCommand, signal?: AbortSignal): CutoverTransactionScope => ({ protocolVersion: policy.version, sourceKey, target: copy(policy.binding.target),
    deadline: command.authorization.expiresAt, maximumLockMs: policy.deadlines.maximumLockMs,
    maximumSqlStatements: policy.budgets.maximumSqlStatements, signal });
  return Object.freeze({
    async execute(input: CutoverCommand, bundle: WriterFenceBundle | null, execution: {
      signal?: AbortSignal;
      write?: (transaction: PostgresTransaction, writeId: string) => Promise<FirstPostgresWriteReceipt>;
    } = {}): Promise<CutoverTransitionReceipt> {
      const command = commandValid(input, now()), requestSha256 = migrationCutoverDigest(command, policy.version);
      if (policy.version !== 2 && command.action !== "abort") fail("V1_AUDIT_ONLY_NO_CUTOVER_ADVANCE");
      check(command, execution.signal);
      if ((command.action === "first-postgres-write") !== (typeof execution.write === "function")) fail("FIRST_WRITE_CALLBACK_REQUIRED_ONLY_FOR_FIRST_WRITE");
      let receipt: CutoverTransitionReceipt;
      try {
        receipt = await options.store.run(scope(command, execution.signal), async tx => {
          check(command, execution.signal);
          const stored = await tx.load(), state = stored === null ? null : durableState(stored, policy);
          const nativeMarker = policy.version === 2 ? await loadAndVerifyNativeMarkerV2(tx, state, policy, sourceKey) : null;
          const prior = state?.journal.find(j => j.operationId === command.operationId);
          if (prior) {
            if (prior.requestSha256 !== requestSha256) fail("IDEMPOTENCY_KEY_REUSED");
            if (policy.version === 2 && state) verifyPreparationClosureV2(state.preparation, policy, closureCommittedTimeV2(state), nativeMarker === null ? "before-first-pg-write" : "after-first-pg-write");
            return copy(prior.receipt);
          }
          if ((state?.revision ?? 0) !== command.expectedRevision) fail("STALE_REVISION");
          if (state && state.planSha256 !== command.planSha256) fail("PLAN_MISMATCH");
          if (state && ["aborted", "source-rollback-selected", "postgres-rollback-selected"].includes(state.phase)) fail("TERMINAL_TRANSITION");
          if ((state?.revision ?? 0) >= policy.budgets.maximumTransitions) fail("TRANSITION_BUDGET_EXCEEDED");
          let next: DurableCutoverState;
          if (command.action === "prepare") {
            if (state) fail("ALREADY_PREPARED");
            const prepared = verifyPreparation(bundle, policy, now());
            if (prepared.planSha256 !== command.planSha256) fail("PLAN_MISMATCH");
            if (time(command.authorization.expiresAt) > prepared.validUntil) fail("AUTHORIZATION_OUTLIVES_EVIDENCE");
            next = { version: policy.version, revision: 0, phase: "prepared", binding: copy(policy.binding), policySha256,
              planSha256: command.planSha256, activationEnabled: false,
              preparation: copy(prepared.bundle), snapshotTables: copy(prepared.bundle.observations.snapshot.body.tables) as DurableCutoverState["snapshotTables"], firstPostgresWrite: null, journal: [] };
          } else {
            if (!state) fail("PREPARATION_REQUIRED");
            next = copy(state);
            if (command.action === "select-postgres" || command.action === "first-postgres-write") {
              const prepared = verifyPreparation(bundle, policy, now());
              if (prepared.planSha256 !== state.planSha256) fail("PLAN_MISMATCH");
              if (time(command.authorization.expiresAt) > prepared.validUntil) fail("AUTHORIZATION_OUTLIVES_EVIDENCE");
              if (command.action === "select-postgres") {
                if (state.phase !== "prepared") fail("INVALID_TRANSITION");
                next.phase = "postgres-selected";
              } else {
                if (state.phase !== "postgres-selected" || state.firstPostgresWrite !== null) fail("INVALID_TRANSITION");
                if (committedRollbackReadiness(state, policy).strategy !== "compatible-postgres-release") fail("POSTGRES_WRITER_ROLLBACK_READINESS_NOT_PROVEN");
                if (state.preparation.closure?.rollback.payload.route !== "compatible-postgres-release") fail("FIRST_WRITE_COMPATIBLE_ROLLBACK_REQUIRED");
                check(command, execution.signal);
                const write = keys(copy(await execution.write!(tx.postgres, command.writeId!)), ["writeId", "receiptSha256", "providerGuardSha256", "deliveryGuardSha256"]);
                if (write.writeId !== command.writeId || ![write.receiptSha256, write.providerGuardSha256, write.deliveryGuardSha256].every(sha)) fail("INVALID_FIRST_WRITE_RECEIPT");
                check(command, execution.signal);
                next.firstPostgresWrite = { ...(write as unknown as FirstPostgresWriteReceipt), recordedAt: new Date(now()).toISOString() };
                next.phase = "postgres-written";
                if (typeof tx.saveFirstWriteMarker !== "function") fail("NATIVE_FIRST_WRITE_MARKER_ADAPTER_REQUIRED");
                await tx.saveFirstWriteMarker(nativeMarkerForStateV2(next, sourceKey));
                const writtenMarker = await loadAndVerifyNativeMarkerV2(tx, next, policy, sourceKey);
                if (writtenMarker === null) fail("NATIVE_FIRST_WRITE_MARKER_REQUIRED");
                verifyPreparationClosureV2(next.preparation, policy, now(), "after-first-pg-write");
              }
            } else if (command.action === "abort") {
              if (state.firstPostgresWrite !== null) fail("CANNOT_ABORT_AFTER_POSTGRES_WRITE");
              next.phase = "aborted";
            } else {
              verifyPreparationClosureV2(state.preparation, policy, closureCommittedTimeV2(state), nativeMarker === null ? "before-first-pg-write" : "after-first-pg-write");
              next.phase = recoveryValid(command.recovery, state, command, policy, now());
            }
          }
          next.revision += 1;
          const committed: CutoverTransitionReceipt = { operationId: command.operationId, revision: next.revision,
            phase: next.phase, planSha256: next.planSha256, recordedAt: new Date(now()).toISOString(), activationEnabled: false, writeAuthorized: false };
          next.journal.push({ operationId: command.operationId, requestSha256, command: copy(command), receipt: committed });
          check(command, execution.signal);
          await tx.save(command.expectedRevision, next);
          check(command, execution.signal);
          return committed;
        });
      } catch (error) {
        if (error instanceof PostgresCommitUncertainError || error instanceof CutoverCommitUnknownError
          || (error instanceof AggregateError && error.errors.some(e => e instanceof PostgresCommitUncertainError))) throw new CutoverCommitUnknownError(command.operationId);
        throw error;
      }
      // A late acknowledgement is ambiguous to the caller; never claim cancellation rolled it back.
      try { check(command, execution.signal); } catch { throw new CutoverCommitUnknownError(command.operationId); }
      return copy(receipt);
    },
    /** Readonly native phase proof, including the pre-prepare empty ledger case.
     * Absence is valid only after the native adapter queried BOTH durable tables.
     * This is not write authorization and does not bypass signed closure checks.
     */
    async inspectPersistedPhase(inspectionDeadline: string, signal?: AbortSignal): Promise<Readonly<{
      version: 1; sourceKey: string; policySha256: string;
      phase: "before-first-pg-write" | "after-first-pg-write";
      ledgerPresent: boolean; revision: number; stateSha256: string | null;
      nativeMarkerSha256: string | null; writeAuthorized: false; activationEnabled: false;
    }>> {
      const current = now(), deadline = time(inspectionDeadline);
      if (policy.version !== 2) fail("V2_NATIVE_PHASE_REQUIRED");
      if (deadline <= current || deadline - current > policy.deadlines.maximumOperationMs || signal?.aborted)
        fail("INVALID_PHASE_INSPECTION_DEADLINE");
      const checkInspection = () => {
        if (signal?.aborted) fail("OPERATION_ABORTED");
        if (now() >= deadline) fail("PHASE_INSPECTION_DEADLINE_EXCEEDED");
      };
      return options.store.run({ protocolVersion: 2, sourceKey, target: copy(policy.binding.target),
        deadline: inspectionDeadline, maximumLockMs: policy.deadlines.maximumLockMs,
        maximumSqlStatements: Math.min(policy.budgets.maximumSqlStatements, MAXIMUM_CUTOVER_STARTUP_SQL_STATEMENTS),
        signal }, async tx => {
        checkInspection();
        const stored = await tx.load();
        checkInspection();
        const state = stored === null ? null : durableState(stored, policy);
        const marker = await loadAndVerifyNativeMarkerV2(tx, state, policy, sourceKey);
        checkInspection();
        const phase = marker === null ? "before-first-pg-write" : "after-first-pg-write";
        if (state) verifyPreparationClosureV2(state.preparation, policy, closureCommittedTimeV2(state), phase);
        checkInspection();
        return Object.freeze({ version: 1 as const, sourceKey, policySha256, phase,
          ledgerPresent: state !== null, revision: state?.revision ?? 0,
          stateSha256: state === null ? null : migrationCutoverDigest(state, 2),
          nativeMarkerSha256: marker === null ? null : migrationCutoverDigest(marker, 2),
          writeAuthorized: false as const, activationEnabled: false as const });
      });
    },
    async reconcile(input: CutoverCommand, recoveryDeadline: string, signal?: AbortSignal): Promise<
      { outcome: "committed"; receipt: CutoverTransitionReceipt } | { outcome: "not-committed"; retryWithSameOperationId: true }
    > {
      // Reconciliation is read-only and must also work after the original authorization expires.
      const command = copy(input), requestSha256 = migrationCutoverDigest(command, policy.version), current = now();
      if (!id(command.operationId) || time(recoveryDeadline) <= current || time(recoveryDeadline) - current > policy.deadlines.maximumOperationMs || signal?.aborted) fail("INVALID_RECOVERY_DEADLINE");
      return options.store.run({ protocolVersion: policy.version, sourceKey, target: copy(policy.binding.target), deadline: recoveryDeadline, maximumLockMs: policy.deadlines.maximumLockMs,
        maximumSqlStatements: policy.budgets.maximumSqlStatements, signal }, async tx => {
        const stored = await tx.load();
        if (signal?.aborted || now() >= time(recoveryDeadline)) fail("RECOVERY_DEADLINE_EXCEEDED");
        const state = stored === null ? null : durableState(stored, policy);
        if (policy.version === 2) {
          const marker = await loadAndVerifyNativeMarkerV2(tx, state, policy, sourceKey);
          if (state) verifyPreparationClosureV2(state.preparation, policy, closureCommittedTimeV2(state), marker === null ? "before-first-pg-write" : "after-first-pg-write");
        }
        const prior = state?.journal.find(j => j.operationId === command.operationId);
        if (!prior) return { outcome: "not-committed", retryWithSameOperationId: true } as const;
        if (prior.requestSha256 !== requestSha256) fail("IDEMPOTENCY_KEY_REUSED");
        return { outcome: "committed", receipt: copy(prior.receipt) } as const;
      });
    },
  });
}

/** No connection, DDL or transaction is started by constructing this adapter. */
export function createMigrationRuntimeCutoverTransitionStore(options: {
  runtime: Pick<ReturnType<typeof createPostgresMigrationRuntime>, "run">;
  statementTimeoutMs: number; lockTimeoutMs: number;
  target: CutoverPostgresTarget; clock: () => string;
}): CutoverTransitionStore {
  if (!integer(options.statementTimeoutMs, 1, 60_000) || !integer(options.lockTimeoutMs, 1, 5000)
    || options.lockTimeoutMs > options.statementTimeoutMs) fail("UNBOUNDED_TRANSACTION_TIMEOUTS");
  if (typeof options.runtime?.run !== "function" || typeof options.clock !== "function") fail("VERIFIED_MIGRATION_RUNTIME_REQUIRED");
  const run = options.runtime.run.bind(options.runtime);
  const target = copy(targetValid(copy(options.target))), schema = `"${target.schema}"`;
  return Object.freeze({
    async run<T>(scope: CutoverTransactionScope, operation: (transaction: CutoverTransaction) => Promise<T>): Promise<T> {
      const ledger = `${schema}.${scope.protocolVersion === 2 ? "migration_cutover_transitions_v2" : "migration_cutover_transitions"}`;
      if (!equal(scope.target, target)) fail("TRANSACTION_TARGET_IDENTITY_MISMATCH");
      if (!sha(scope.sourceKey) || !integer(scope.maximumLockMs, 1, 5000) || !integer(scope.maximumSqlStatements, 8, MAXIMUM_CUTOVER_WRITE_SQL_STATEMENTS)) fail("INVALID_TRANSACTION_SCOPE");
      const remaining = () => {
        if (scope.signal?.aborted) fail("OPERATION_ABORTED");
        const milliseconds = time(scope.deadline) - time(options.clock());
        if (!integer(milliseconds, 1, 60_000)) fail("OPERATION_DEADLINE_EXCEEDED");
        return milliseconds;
      };
      remaining();
      // The verified operator runtime owns approval, role probe and the sole physical commit.
      return run(async native => {
        let statements = 0;
        const postgres: PostgresTransaction = Object.freeze({ async query(sql: string, values: readonly unknown[] = []) {
          remaining();
          if (++statements > scope.maximumSqlStatements) fail("SQL_STATEMENT_BUDGET_EXCEEDED");
          const result = await native.query(sql, values);
          remaining();
          return result;
        } });
        await postgres.query("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$1,true), set_config('synchronous_commit','on',true)",
          [String(Math.min(options.statementTimeoutMs, remaining())), String(Math.min(options.lockTimeoutMs, scope.maximumLockMs, remaining()))]);
        const lock = (await postgres.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked", [scope.sourceKey])).rows[0];
        if (lock?.locked !== true) fail("SOURCE_ADVISORY_LOCK_BUSY");
        const probe = (await postgres.query(`SELECT current_database() AS database,host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
          (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,i.schema_name,i.generation_id,l.fingerprint
          FROM ${schema}.business_schema_identity i CROSS JOIN ${schema}.business_schema_ledger l
          WHERE i.singleton=true ORDER BY l.version DESC LIMIT 1`)).rows[0];
        if (!probe || probe.database !== target.database || probe.schema_name !== target.schema
          || probe.generation_id !== target.generation || probe.fingerprint !== target.schemaSha256
          || probe.server_address !== target.serverAddress || probe.server_port !== target.serverPort || probe.system_identifier !== target.systemIdentifier) fail("TRANSACTION_TARGET_IDENTITY_MISMATCH");
        const kind = (await postgres.query("SELECT relkind,relpersistence FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($1)", [ledger])).rows[0];
        if (scope.postgresRollbackCatalog !== undefined) {
          const catalog = (await postgres.query("SELECT c.relname AS table_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname", [target.schema])).rows;
          if (!sameStrings(catalog.map(row => row.table_name), scope.postgresRollbackCatalog)) fail("LIVE_POSTGRES_ROLLBACK_CATALOG_MISMATCH");
        }
        if (kind?.relkind !== "r" || kind.relpersistence !== "p") fail("DURABLE_TRANSITION_LEDGER_REQUIRED");
        const markerStore = nativeMarkerAdapterV2(schema, scope.sourceKey, postgres.query.bind(postgres), false);
        const result = await operation({ postgres, ...markerStore,
          async load() {
            const rows = (await postgres.query(`SELECT revision,state FROM ${ledger} WHERE source_key=$1 FOR UPDATE`, [scope.sourceKey])).rows;
            if (rows.length > 1) fail("CORRUPT_DURABLE_STATE");
            const row = rows[0];
            if (!row) return null;
            const state = copy(object(row.state));
            if (String(state.revision) !== String(row.revision)) fail("CORRUPT_DURABLE_STATE");
            return state as unknown as DurableCutoverState;
          },
          async save(expectedRevision, state) {
            if (!integer(expectedRevision, 0, 63) || state.revision !== expectedRevision + 1) fail("INVALID_REVISION");
            const result = await postgres.query(`INSERT INTO ${ledger} AS existing(source_key,revision,state) VALUES($1,$2,$3::jsonb)
              ON CONFLICT(source_key) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state
              WHERE existing.revision=$4 RETURNING revision`, [scope.sourceKey, state.revision, migrationCutoverCanonicalJson(state), expectedRevision]);
            if (result.rowCount !== 1) fail("STALE_REVISION");
          },
        });
        remaining();
        return result;
      });
    },
  });
}

const committedBackendSelection: unique symbol = Symbol("committed-postgres-backend-selection");
export interface CommittedPostgresCutoverCapability {
  readonly [committedBackendSelection]: true;
  readonly backend: "postgres";
  readonly protocolVersion: 2;
  readonly closureSha256: string;
  readonly phase: "postgres-selected" | "postgres-written" | "postgres-rollback-selected";
  readonly revision: number;
  readonly sourceKey: string;
  readonly planSha256: string;
  readonly target: Readonly<CutoverPostgresTarget>;
  readonly cohortId: string;
  readonly verifiedAt: string;
  readonly validUntil: string;
  readonly evidenceMode: EvidenceMode;
  readonly firstPostgresWrite: Readonly<FirstPostgresWriteReceipt & { recordedAt: string }> | null;
  readonly mutableJournalVerified: false;
  readonly rollbackReadiness: PostgresRollbackReadiness;
  readonly writerStartupBlockers: readonly string[];
  readonly activationEnabled: false;
  readonly writeAuthorized: false;
}

/** Read-only persisted authorization verification. This selects a backend, never business write authority. */
export async function verifyCommittedPostgresCutover(options: {
  expected: WriterFencePolicy;
  runtime: { target: CutoverPostgresTarget; cohortId: string };
  store: CutoverTransitionStore;
  clock: () => string;
  deadline: string;
  signal?: AbortSignal;
}): Promise<CommittedPostgresCutoverCapability> {
  const policy = validatePolicy(options.expected), runtime = keys(copy(options.runtime), ["target", "cohortId"]);
  if (policy.version !== 2) fail("V1_AUDIT_ONLY_NO_POSTGRES_CAPABILITY");
  targetValid(runtime.target);
  if (!id(runtime.cohortId) || (!equal(runtime.target, policy.binding.target) && !equal(runtime.target, policy.binding.rollbackTarget)) || runtime.cohortId !== policy.binding.cohortId) fail("RUNTIME_CUTOVER_IDENTITY_MISMATCH");
  const current = time(options.clock()), deadline = time(options.deadline);
  const check = () => {
    if (options.signal?.aborted) fail("OPERATION_ABORTED");
    const clock = time(options.clock());
    if (clock < current) fail("CLOCK_MOVED_BACKWARDS");
    if (clock >= deadline) fail("OPERATION_DEADLINE_EXCEEDED");
    return clock;
  };
  if (deadline <= current || deadline - current > policy.deadlines.maximumOperationMs) fail("INVALID_OPERATION_DEADLINE");
  check();
  const sourceKey = migrationCutoverDigest({ hostId: policy.hostId, canonicalPath: policy.binding.source.canonicalPath });
  const selection = await options.store.run({ protocolVersion: 2, sourceKey, target: copy(runtime.target as unknown as CutoverPostgresTarget),
    postgresRollbackCatalog: policy.postgresRollbackCatalog?.map(entry => entry.table), deadline: options.deadline,
    maximumLockMs: policy.deadlines.maximumLockMs, maximumSqlStatements: Math.min(policy.budgets.maximumSqlStatements, MAXIMUM_CUTOVER_STARTUP_SQL_STATEMENTS), signal: options.signal }, async tx => {
    const stored = await tx.load();
    const now = check();
    if (stored === null) fail("COMMITTED_POSTGRES_SELECTION_REQUIRED");
    const state = durableState(stored, policy);
    const marker = await loadAndVerifyNativeMarkerV2(tx, state, policy, sourceKey);
    const closureSha256 = verifyPreparationClosureV2(state.preparation, policy, closureCommittedTimeV2(state), marker === null ? "before-first-pg-write" : "after-first-pg-write");
    if (state.phase !== "postgres-selected" && state.phase !== "postgres-written" && state.phase !== "postgres-rollback-selected") fail("COMMITTED_POSTGRES_SELECTION_REQUIRED");
    const requiredTarget = state.phase === "postgres-rollback-selected" ? policy.binding.rollbackTarget : policy.binding.target;
    if (!equal(runtime.target, requiredTarget)) fail("RUNTIME_CUTOVER_IDENTITY_MISMATCH");
    const rollbackReadiness = committedRollbackReadiness(state, policy);
    if (state.phase === "postgres-rollback-selected" && rollbackReadiness.strategy !== "compatible-postgres-release") fail("POSTGRES_WRITER_ROLLBACK_READINESS_NOT_PROVEN");
    if (state.journal.some(j => time(j.receipt.recordedAt) > now)) fail("FUTURE_COMMITTED_STATE");
    return { phase: state.phase, revision: state.revision, planSha256: state.planSha256, closureSha256, firstPostgresWrite: copy(state.firstPostgresWrite), rollbackReadiness };
  });
  const verifiedAt = new Date(check()).toISOString();
  return Object.freeze({ [committedBackendSelection]: true as const, backend: "postgres" as const,
    protocolVersion: 2 as const, closureSha256: selection.closureSha256, phase: selection.phase, revision: selection.revision, sourceKey, planSha256: selection.planSha256,
    target: Object.freeze(copy(runtime.target as unknown as CutoverPostgresTarget)), cohortId: policy.binding.cohortId,
    verifiedAt, validUntil: options.deadline, evidenceMode: policy.evidenceMode,
    firstPostgresWrite: selection.firstPostgresWrite === null ? null : Object.freeze(selection.firstPostgresWrite), mutableJournalVerified: false as const,
    rollbackReadiness: selection.rollbackReadiness,
    writerStartupBlockers: Object.freeze(selection.rollbackReadiness.strategy === "compatible-postgres-release" ? [] : [selection.rollbackReadiness.reason]), activationEnabled: false as const, writeAuthorized: false as const });
}

/** Startup-only reader over an already verified top-level runtime; no pool, DDL or business SQL. */
export function createReadOnlyCutoverStartupStore(options: {
  runtime: { run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> };
  target: CutoverPostgresTarget;
  clock: () => string;
}): CutoverTransitionStore {
  const target = copy(targetValid(copy(options.target))), schema = `"${target.schema}"`;
  const ledger = `${schema}.migration_cutover_transitions_v2`;
  const run = options.runtime.run.bind(options.runtime);
  return Object.freeze({
    async run<T>(scope: CutoverTransactionScope, operation: (transaction: CutoverTransaction) => Promise<T>): Promise<T> {
      if (!equal(scope.target, target)) fail("TRANSACTION_TARGET_IDENTITY_MISMATCH");
      if (!sha(scope.sourceKey) || !integer(scope.maximumLockMs, 1, 5000) || !integer(scope.maximumSqlStatements, 8, MAXIMUM_CUTOVER_STARTUP_SQL_STATEMENTS)) fail("INVALID_TRANSACTION_SCOPE");
      const started = time(options.clock());
      const check = () => {
        if (scope.signal?.aborted) fail("OPERATION_ABORTED");
        const current = time(options.clock()), remaining = time(scope.deadline) - current;
        if (current < started) fail("CLOCK_MOVED_BACKWARDS");
        if (!integer(remaining, 1, 60_000)) fail("OPERATION_DEADLINE_EXCEEDED");
      };
      check();
      // The root calls this before composition. Existing runtime connection/statement limits remain intact.
      return run(async native => {
        let statements = 0;
        const query = async (sql: string, values: readonly unknown[] = []) => {
          check();
          if (++statements > scope.maximumSqlStatements) fail("SQL_STATEMENT_BUDGET_EXCEEDED");
          const result = await native.query(sql, values);
          check();
          return result;
        };
        // Never read a selection written but not committed by an ambient writer transaction.
        const transaction = (await query("SELECT pg_current_xact_id_if_assigned() IS NULL AS no_prior_writes")).rows[0];
        if (transaction?.no_prior_writes !== true) fail("STARTUP_REQUIRES_TOP_LEVEL_RUNTIME_TRANSACTION");
        // Ordinary SELECT only: read-only console roles must never acquire row or advisory locks.
        // A narrow function EXECUTE grant is required; never substitute pg_monitor or a configured cluster ID.
        const identity = (await query(`SELECT current_database() AS database,host(inet_server_addr()) AS server_address,
          inet_server_port() AS server_port,(SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,
          i.schema_name,i.generation_id,l.fingerprint
          FROM ${schema}.business_schema_identity i CROSS JOIN ${schema}.business_schema_ledger l
          WHERE i.singleton=true ORDER BY l.version DESC LIMIT 1`)).rows[0];
        if (!identity || identity.database !== target.database || identity.schema_name !== target.schema
          || identity.generation_id !== target.generation || identity.fingerprint !== target.schemaSha256
          || identity.server_address !== target.serverAddress || identity.server_port !== target.serverPort || identity.system_identifier !== target.systemIdentifier) fail("TRANSACTION_TARGET_IDENTITY_MISMATCH");
        const kind = (await query("SELECT relkind,relpersistence FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($1)", [ledger])).rows[0];
        if (scope.postgresRollbackCatalog !== undefined) {
          const catalog = (await query("SELECT c.relname AS table_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname", [target.schema])).rows;
          if (!sameStrings(catalog.map(row => row.table_name), scope.postgresRollbackCatalog)) fail("LIVE_POSTGRES_ROLLBACK_CATALOG_MISMATCH");
        }
        if (kind?.relkind !== "r" || kind.relpersistence !== "p") fail("DURABLE_TRANSITION_LEDGER_REQUIRED");
        const markerStore = nativeMarkerAdapterV2(schema, scope.sourceKey, query, true);
        const result = await operation({ ...markerStore,
          postgres: Object.freeze({ async query() { return fail("READ_ONLY_STARTUP_ADAPTER"); } }),
          async load() {
            const rows = (await query(`SELECT revision,state FROM ${ledger} WHERE source_key=$1`, [scope.sourceKey])).rows;
            if (rows.length > 1) fail("CORRUPT_DURABLE_STATE");
            const row = rows[0];
            if (!row) return null;
            const state = copy(object(row.state));
            if (String(state.revision) !== String(row.revision)) fail("CORRUPT_DURABLE_STATE");
            return state as unknown as DurableCutoverState;
          },
          async save() { return fail("READ_ONLY_STARTUP_ADAPTER"); },
        });
        check();
        return result;
      });
    },
  });
}


export type PostgresRollbackOperation = "insert" | "update" | "delete";
export interface PostgresRollbackCatalogEntry { table: string; operations: PostgresRollbackOperation[] }
export const POSTGRES_COMPATIBILITY_GUARD_CHECKS = [
  "disabled-profile", "suspended-profile", "owner-conflict", "provider-cooldown",
  "delivery-disabled", "immutable-provenance", "global-head-collision",
] as const;
export interface CompatiblePostgresReleaseProof {
  version: 1 | 2;
  binding: CutoverBinding;
  strategy: "compatible-postgres-release";
  recoveryMode: "retain-live-postgres-data";
  backend: "postgres";
  candidate: CutoverPostgresTarget;
  compatible: CutoverPostgresTarget;
  candidateArtifactSha256: string;
  compatibleArtifactSha256: string;
  catalogSha256: string;
  schemaProbeSha256: string;
  mutationTraceSha256: string;
  parentTransactionRollbackReceiptSha256: string;
  commitUnknownReconciliationReceiptSha256: string;
  providerGuardSha256: string;
  deliveryGuardSha256: string;
  startedAt: string; firstWriteAt: string; completedAt: string;
  tableChecks: Array<{
    table: string; retainedRows: string; recoveredRows: string; retainedSha256: string; recoveredSha256: string;
    cases: Array<{ operation: PostgresRollbackOperation; committedReceiptSha256: string;
      compatibleReadReceiptSha256: string; compatibleWriteReceiptSha256: string }>;
  }>;
  guardChecks: Array<{ check: typeof POSTGRES_COMPATIBILITY_GUARD_CHECKS[number]; receiptSha256: string }>;
  attestation: { issuerId: string; keyId: string; observedAt: string; expiresAt: string;
    provenance: CutoverObservation["provenance"]; signatureBase64: string };
}
export type PostgresRollbackReadiness = Readonly<{
  strategy: "blocked"; reason: string;
}> | Readonly<{
  strategy: "compatible-postgres-release"; recoveryMode: "retain-live-postgres-data";
  target: Readonly<CutoverPostgresTarget>; catalogSha256: string; proofSha256: string;
  mutableJournalVerified: false;
}>;

export function migrationCompatiblePostgresRollbackPayload(input: CompatiblePostgresReleaseProof): string {
  const proof = copy(input), { signatureBase64: _signature, ...attestation } = proof.attestation;
  return `address-radar/migration-cutover/compatible-postgres-release/v${proof.version}\n`
    + migrationCutoverCanonicalJson({ ...proof, attestation });
}
function validatePostgresRollbackCatalog(value: unknown): PostgresRollbackCatalogEntry[] {
  const entries = array(value).map(entry => keys(entry, ["table", "operations"]));
  if (!entries.length || entries.length > 10_000 || !sameStrings(entries.map(entry => entry.table), entries.map(entry => entry.table))) fail("INVALID_POSTGRES_ROLLBACK_CATALOG");
  for (const entry of entries) {
    if (typeof entry.table !== "string" || !sqlIdentifier.test(entry.table)) fail("INVALID_POSTGRES_ROLLBACK_CATALOG");
    const operations = array(entry.operations);
    if (!sameStrings(operations, operations) || operations.some(operation => !["insert", "update", "delete"].includes(operation as string))) fail("INVALID_POSTGRES_ROLLBACK_CATALOG");
  }
  // Empty operations mean an externally reviewed immutable table, never an inferred exemption.
  if (!entries.some(entry => array(entry.operations).length)) fail("NO_MUTABLE_POSTGRES_ROLLBACK_TABLES");
  return entries as unknown as PostgresRollbackCatalogEntry[];
}
function verifyCompatibleReleaseProof(input: unknown, policy: WriterFencePolicy, report: CutoverObservation,
  now: number, snapshotCompleted: number): CompatiblePostgresReleaseProof {
  if (!policy.postgresRollbackCatalog || !policy.postgresRollbackVerifier) fail("POSTGRES_ROLLBACK_CATALOG_AND_VERIFIER_NOT_PINNED");
  const proof = keys(input, ["version", "binding", "strategy", "recoveryMode", "backend", "candidate", "compatible", "candidateArtifactSha256", "compatibleArtifactSha256",
    "catalogSha256", "schemaProbeSha256", "mutationTraceSha256", "parentTransactionRollbackReceiptSha256", "commitUnknownReconciliationReceiptSha256",
    "providerGuardSha256", "deliveryGuardSha256", "startedAt", "firstWriteAt", "completedAt", "tableChecks", "guardChecks", "attestation"]);
  const candidate = targetValid(proof.candidate), compatible = targetValid(proof.compatible);
  if (proof.version !== policy.version || !equal(proof.binding, policy.binding) || proof.strategy !== "compatible-postgres-release" || proof.recoveryMode !== "retain-live-postgres-data" || proof.backend !== "postgres"
    || !equal(candidate, policy.binding.target) || !equal(compatible, policy.binding.rollbackTarget)
    || candidate.schemaSha256 !== compatible.schemaSha256 || candidate.releaseSha256 === compatible.releaseSha256
    || proof.candidateArtifactSha256 !== candidate.releaseSha256 || proof.compatibleArtifactSha256 !== compatible.releaseSha256
    || proof.catalogSha256 !== migrationCutoverDigest(policy.postgresRollbackCatalog)) fail("EXACT_SAME_DATA_POSTGRES_RELEASE_NOT_PROVEN");
  for (const field of ["schemaProbeSha256", "mutationTraceSha256", "parentTransactionRollbackReceiptSha256", "commitUnknownReconciliationReceiptSha256"]) {
    if (!sha(proof[field])) fail("COMPATIBLE_POSTGRES_REHEARSAL_RECEIPTS_REQUIRED");
  }
  if (proof.providerGuardSha256 !== migrationCutoverDigest(policy.guards.filter(guard => guard.kind === "provider"))
    || proof.deliveryGuardSha256 !== migrationCutoverDigest(policy.guards.filter(guard => guard.kind === "delivery"))) fail("COMPATIBLE_POSTGRES_GUARDS_NOT_PRESERVED");
  const started = approvedWindowTime(proof.startedAt, policy, now), first = approvedWindowTime(proof.firstWriteAt, policy, now), completed = approvedWindowTime(proof.completedAt, policy, now);
  if (!(snapshotCompleted <= started && started < first && first < completed) || completed > time(report.observedAt)) fail("COMPATIBLE_POSTGRES_REHEARSAL_ORDER_INVALID");
  const checks = array(proof.tableChecks).map(value => keys(value, ["table", "retainedRows", "recoveredRows", "retainedSha256", "recoveredSha256", "cases"]));
  if (!sameStrings(checks.map(check => check.table), policy.postgresRollbackCatalog.map(entry => entry.table))) fail("INCOMPLETE_POSTGRES_ROLLBACK_COVERAGE");
  for (const check of checks) {
    if (count(check.retainedRows) !== count(check.recoveredRows) || !sha(check.retainedSha256) || check.retainedSha256 !== check.recoveredSha256) fail("COMPATIBLE_POSTGRES_MUTATIONS_NOT_RETAINED");
    const cases = array(check.cases).map(value => keys(value, ["operation", "committedReceiptSha256", "compatibleReadReceiptSha256", "compatibleWriteReceiptSha256"]));
    const expected = policy.postgresRollbackCatalog.find(entry => entry.table === check.table)!;
    if (!sameStrings(cases.map(value => value.operation), expected.operations)) fail("INCOMPLETE_POSTGRES_ROLLBACK_OPERATION_COVERAGE");
    for (const test of cases) if (![test.committedReceiptSha256, test.compatibleReadReceiptSha256, test.compatibleWriteReceiptSha256].every(sha)) fail("COMPATIBLE_POSTGRES_REHEARSAL_RECEIPTS_REQUIRED");
  }
  const guards = array(proof.guardChecks).map(value => keys(value, ["check", "receiptSha256"]));
  if (!sameStrings(guards.map(guard => guard.check), POSTGRES_COMPATIBILITY_GUARD_CHECKS) || guards.some(guard => !sha(guard.receiptSha256))) fail("COMPATIBLE_POSTGRES_GUARD_BEHAVIOR_NOT_PROVEN");
  const attestation = keys(proof.attestation, ["issuerId", "keyId", "observedAt", "expiresAt", "provenance", "signatureBase64"]);
  const pinned = policy.postgresRollbackVerifier;
  const verifier = policy.collectors.find(collector => collector.issuerId === pinned.issuerId && collector.keyId === pinned.keyId && collector.kinds.includes("rehearsal"));
  const outer = policy.collectors.find(collector => collector.issuerId === report.issuerId && collector.keyId === report.keyId);
  if (!verifier || !outer || verifier.publicKeyBase64 === outer.publicKeyBase64 || attestation.issuerId !== pinned.issuerId || attestation.keyId !== pinned.keyId) fail("INDEPENDENT_COMPATIBILITY_VERIFIER_REQUIRED");
  const provenance = keys(attestation.provenance, ["hostId", "bootId", "collectorSha256", "runId", "sequence", "challengeId"]);
  if (provenance.hostId !== policy.hostId || provenance.bootId !== policy.bootId || provenance.challengeId !== policy.challengeId
    || provenance.collectorSha256 !== verifier.collectorSha256 || !id(provenance.runId) || provenance.runId === report.provenance.runId || count(provenance.sequence) <= 0n) fail("COMPATIBILITY_VERIFIER_PROVENANCE_INVALID");
  if (fresh(attestation.observedAt, policy, now) < completed || time(attestation.observedAt) > time(report.observedAt)
    || time(attestation.expiresAt) <= now || time(attestation.expiresAt) > time(policy.deadlines.windowEnd)
    || time(attestation.expiresAt) - time(attestation.observedAt) > policy.deadlines.maximumEvidenceAgeMs
    || !signatureValid(migrationCompatiblePostgresRollbackPayload(proof as unknown as CompatiblePostgresReleaseProof), attestation.signatureBase64, verifier.publicKeyBase64)) fail("COMPATIBILITY_ATTESTATION_INVALID");
  return proof as unknown as CompatiblePostgresReleaseProof;
}
function committedRollbackReadiness(state: DurableCutoverState, policy: WriterFencePolicy): PostgresRollbackReadiness {
  if (!policy.postgresRollbackCatalog || !policy.postgresRollbackVerifier) return Object.freeze({ strategy: "blocked", reason: "POSTGRES_ROLLBACK_CATALOG_AND_VERIFIER_NOT_PINNED" });
  const report = state.preparation.observations.rehearsal;
  if (!Object.hasOwn(report.body, "compatibleRelease")) return Object.freeze({ strategy: "blocked", reason: "COMPATIBLE_POSTGRES_RELEASE_REHEARSAL_MISSING" });
  const preparedAt = time(state.journal[0]!.receipt.recordedAt);
  const proof = verifyCompatibleReleaseProof(report.body.compatibleRelease, policy, report, preparedAt, time(state.preparation.observations.snapshot.body.completedAt));
  return Object.freeze({ strategy: "compatible-postgres-release", recoveryMode: "retain-live-postgres-data",
    target: Object.freeze(copy(policy.binding.rollbackTarget)), catalogSha256: proof.catalogSha256,
    proofSha256: migrationCutoverDigest(proof), mutableJournalVerified: false });
}
const committedWriterStartup: unique symbol = Symbol("committed-postgres-writer-startup");
export interface CommittedPostgresWriterStartupCapability extends CommittedPostgresCutoverCapability {
  readonly [committedWriterStartup]: true;
  readonly phase: "postgres-written" | "postgres-rollback-selected";
  readonly firstPostgresWrite: Readonly<FirstPostgresWriteReceipt & { recordedAt: string }>;
  readonly rollbackReadiness: Extract<PostgresRollbackReadiness, { strategy: "compatible-postgres-release" }>;
}
/** A verified rollback route is a startup gate, not business activation or SQL authorization. */
export async function verifyCommittedPostgresWriterStartup(options: Parameters<typeof verifyCommittedPostgresCutover>[0]): Promise<CommittedPostgresWriterStartupCapability> {
  const selection = await verifyCommittedPostgresCutover(options);
  if ((selection.phase !== "postgres-written" && selection.phase !== "postgres-rollback-selected") || selection.firstPostgresWrite === null) fail("POSTGRES_WRITER_FIRST_COMMITTED_WRITE_REQUIRED");
  if (selection.rollbackReadiness.strategy !== "compatible-postgres-release" || selection.writerStartupBlockers.length) fail("POSTGRES_WRITER_ROLLBACK_READINESS_NOT_PROVEN");
  return Object.freeze({ ...selection, [committedWriterStartup]: true as const, phase: selection.phase,
    firstPostgresWrite: selection.firstPostgresWrite, rollbackReadiness: selection.rollbackReadiness });
}


/** Deprecated fail-closed entry: a raw pool cannot bypass operator approval and owner-role verification. */
export function createPostgresCutoverTransitionStore(_options: {
  pool: PostgresPool; statementTimeoutMs: number; lockTimeoutMs: number;
  target: CutoverPostgresTarget; clock: () => string;
}): CutoverTransitionStore {
  return fail("RAW_POOL_CUTOVER_STORE_DISABLED_USE_VERIFIED_MIGRATION_RUNTIME");
}

// Additional externally signed closure evidence; never grants a production write capability.
export {
  canonicalFenceClosureEvidence,
  fenceClosureEvidenceSha256,
  fenceClosureSigningMessage,
  verifyWriterFenceSnapshotRollbackClosure,
} from "./migration-writer-fence-closure.js";
export type {
  FenceClosureAuthorization,
  FenceClosureBinding,
  FenceClosureCensus,
  FenceClosureInput,
  FenceClosureRollback,
  FenceClosureScope,
  FenceClosureSigned,
  FenceClosureSnapshot,
  FenceClosureTrust,
} from "./migration-writer-fence-closure.js";

/** Additive protocol ledger: never changes the immutable legacy schema module. */
export const MIGRATION_CUTOVER_TRANSITIONS_V2_DDL = `CREATE TABLE migration_cutover_transitions_v2 (
 source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 64),
 state jsonb NOT NULL CHECK (COALESCE((
  jsonb_typeof(state)='object'
  AND state ?& ARRAY['version','revision','phase','binding','policySha256','planSha256','activationEnabled','preparation','snapshotTables','firstPostgresWrite','journal']
  AND (state - ARRAY['version','revision','phase','binding','policySha256','planSha256','activationEnabled','preparation','snapshotTables','firstPostgresWrite','journal'])='{}'::jsonb
  AND state->'version'='2'::jsonb AND state->>'revision'=revision::text
  AND state->'activationEnabled'='false'::jsonb
  AND state->>'phase' IN ('prepared','postgres-selected','postgres-written','source-rollback-selected','postgres-rollback-selected','aborted')
  AND jsonb_typeof(state->'journal')='array' AND jsonb_array_length(state->'journal')=revision
  AND jsonb_typeof(state->'snapshotTables')='array'
  AND jsonb_typeof(state->'preparation')='object' AND state->'preparation'->'version'='2'::jsonb
  AND state->'preparation' ?& ARRAY['version','activation','observations','closure']
  AND ((state->'preparation') - ARRAY['version','activation','observations','closure'])='{}'::jsonb
  AND jsonb_typeof(state->'preparation'->'closure')='object'
  AND state->'preparation'->'closure' ?& ARRAY['authorization','census','snapshot','rollback']
  AND ((state->'preparation'->'closure') - ARRAY['authorization','census','snapshot','rollback'])='{}'::jsonb
  AND ((state->'firstPostgresWrite'='null'::jsonb)=(state->>'phase' NOT IN ('postgres-written','postgres-rollback-selected')))
 ), false))
)`;
export const MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL = `CREATE TABLE migration_cutover_first_write_markers (
 source_key text PRIMARY KEY REFERENCES migration_cutover_transitions_v2(source_key),
 marker_sha256 text NOT NULL CHECK (marker_sha256 ~ '^[a-f0-9]{64}$'),
 marker jsonb NOT NULL CHECK (COALESCE((
  jsonb_typeof(marker)='object' AND marker->'version'='2'::jsonb
  AND marker ?& ARRAY['version','sourceKey','policySha256','planSha256','bindingSha256','cohortId','generation','writeId','receiptSha256','providerGuardSha256','deliveryGuardSha256','recordedAt']
  AND (marker - ARRAY['version','sourceKey','policySha256','planSha256','bindingSha256','cohortId','generation','writeId','receiptSha256','providerGuardSha256','deliveryGuardSha256','recordedAt'])='{}'::jsonb
  AND marker->>'sourceKey'=source_key
 ), false))
)`;
export function migrationCutoverProtocolV2Ddl(schema: string): readonly [string,string] {
 migrationCutoverTransitionsDdl(schema);
 const q=`"${schema}"`;
 return Object.freeze([
  MIGRATION_CUTOVER_TRANSITIONS_V2_DDL.replace("CREATE TABLE migration_cutover_transitions_v2",`CREATE TABLE ${q}.migration_cutover_transitions_v2`),
  MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL.replace("CREATE TABLE migration_cutover_first_write_markers",`CREATE TABLE ${q}.migration_cutover_first_write_markers`).replace("REFERENCES migration_cutover_transitions_v2",`REFERENCES ${q}.migration_cutover_transitions_v2`),
 ]);
}
function closureReviewerMatchesV2(key:string,p:WriterFencePolicy):boolean {
 return p.closureTrust!==undefined && createPublicKey(p.closureTrust.authorizationPublicKeyPem).export({type:"spki",format:"der"}).toString("base64")===key;
}
function closureBindingFromPolicyV2(p:WriterFencePolicy):ClosureTrustV2["expectedBinding"] {
 const b=p.binding;
 return {sourcePath:b.source.canonicalPath,sourceDevice:b.source.device,sourceInode:b.source.inode,generation:b.generation,watermark:b.watermark,cluster:b.target.systemIdentifier,schemaSha256:b.target.schemaSha256,release:b.target.releaseSha256,artifactSha256:b.target.releaseSha256,cohortSha256:migrationCutoverDigest({cohortId:b.cohortId},2),providerGuardSha256:migrationCutoverDigest(p.guards.filter(g=>g.kind==="provider")),deliveryGuardSha256:migrationCutoverDigest(p.guards.filter(g=>g.kind==="delivery"))};
}
function validateClosureTrustV2(p:WriterFencePolicy):void {
 const t=keys(p.closureTrust,["authorizationPublicKeyPem","observerPublicKeyPem","snapshotPublicKeyPem","independentCompatibilityPublicKeyPem","expectedBinding","expectedScopesSha256","expectedTableNames","expectedRollbackRelease","expectedRollbackArtifactSha256","maximumEvidenceAgeMs","maximumMaintenanceWindowMs"]);
 if(!p.postgresRollbackVerifier||!p.postgresRollbackCatalog||!sha(t.expectedScopesSha256)||!equal(t.expectedBinding,closureBindingFromPolicyV2(p))||!sameStrings(t.expectedTableNames,p.catalog)||t.expectedRollbackRelease!==p.binding.rollbackTarget.releaseSha256||t.expectedRollbackArtifactSha256!==p.binding.rollbackTarget.releaseSha256||t.maximumEvidenceAgeMs!==p.deadlines.maximumEvidenceAgeMs||t.maximumMaintenanceWindowMs!==time(p.deadlines.windowEnd)-time(p.deadlines.windowStart))fail("V2_PINNED_CLOSURE_POLICY_REQUIRED");
 const key=(pem:unknown):string=>{if(typeof pem!=="string")fail("INVALID_TRUST_KEY");const k=createPublicKey(pem);if(k.asymmetricKeyType!=="ed25519")fail("INVALID_TRUST_KEY");return k.export({type:"spki",format:"der"}).toString("base64");};
 const authorization=key(t.authorizationPublicKeyPem),observer=key(t.observerPublicKeyPem),snapshot=key(t.snapshotPublicKeyPem),compatibility=key(t.independentCompatibilityPublicKeyPem);
 if(!p.reviewers.some(r=>r.publicKeyBase64===authorization&&["prepare","select-postgres","first-postgres-write","rollback","abort"].every(a=>r.actions.includes(a as CutoverAction)))||!p.collectors.some(c=>c.publicKeyBase64===observer&&c.kinds.includes("census")&&c.kinds.includes("fence"))||!p.collectors.some(c=>c.publicKeyBase64===snapshot&&c.kinds.includes("snapshot"))||!p.collectors.some(c=>c.issuerId===p.postgresRollbackVerifier?.issuerId&&c.keyId===p.postgresRollbackVerifier.keyId&&c.publicKeyBase64===compatibility&&c.kinds.includes("rehearsal"))||compatibility===authorization||compatibility===observer)fail("V2_CLOSURE_TRUST_ROLE_MISMATCH");
}
function verifyPreparationClosureV2(bundle:WriterFenceBundle,p:WriterFencePolicy,now:number,phase:ClosureInputV2["phase"]):string {
 if(p.version!==2||bundle.version!==2||!p.closureTrust)fail("V2_SIGNED_CLOSURE_REQUIRED");
 const closure=keys(bundle.closure,["authorization","census","snapshot","rollback"]) as unknown as WriterFenceClosureV2;
 const a=closure.authorization.payload,c=closure.census.payload,s=closure.snapshot.payload,r=closure.rollback.payload;
 if(a.windowStart!==p.deadlines.windowStart||a.windowEnd!==p.deadlines.windowEnd||a.maximumSqlStatements!==p.budgets.maximumSqlStatements||a.maximumTransactionMs!==p.deadlines.maximumOperationMs||!sameStrings(a.scopes.map(v=>v.id),p.writers.map(v=>v.id)))fail("CLOSURE_SIGNED_POLICY_SCOPE_MISMATCH");
 const kinds={service:"services",timer:"timers",bridge:"externalInputs",cron:"usercron",operator:"operators",deploy:"deploy","external-input":"externalInputs"} as const;
 for(const scope of a.scopes){const writer=p.writers.find(w=>w.id===scope.id);if(!writer||writer.kind!==kinds[scope.kind])fail("CLOSURE_WRITER_KIND_MISMATCH");}
 const reports=bundle.observations;
 const tables=array(reports.snapshot.body.tables).map(v=>{const t=keys(v,["table","rows","sha256"]);return{name:t.table,rowCount:t.rows,sha256:t.sha256};});
 if(!equal(s.tables,tables)||c.fencedAt!==reports.fence.body.enforcedAt||c.observedAt!==reports.census.observedAt||s.startedAt!==reports.snapshot.body.startedAt||s.completedAt!==reports.snapshot.body.completedAt||r.parityReceiptSha256!==migrationCutoverDigest(reports.parity.body)||s.parityReceiptSha256!==r.parityReceiptSha256)fail("CLOSURE_PREPARATION_EVIDENCE_MISMATCH");
 if(r.route==="compatible-postgres-release"){const proof=reports.rehearsal.body.compatibleRelease;if(proof===undefined||r.compatibilityTestReceiptSha256!==migrationCutoverDigest(proof,2))fail("CLOSURE_COMPATIBILITY_PROOF_NOT_BOUND");}
 verifyClosureV2({...closure,phase},p.closureTrust,new Date(now));
 return migrationCutoverDigest(closure,2);
}
function closureCommittedTimeV2(state:DurableCutoverState):number {
 if(state.firstPostgresWrite!==null)return time(state.firstPostgresWrite.recordedAt);
 const entry=state.journal.find(j=>j.command.action==="select-postgres")??state.journal[0];if(!entry)fail("CORRUPT_TRANSITION_JOURNAL");return time(entry.receipt.recordedAt);
}
function nativeMarkerForStateV2(state:DurableCutoverState,sourceKey:string):FirstPostgresWriteMarkerV2 {
 const w=state.firstPostgresWrite;if(state.version!==2||w===null)fail("NATIVE_FIRST_WRITE_MARKER_REQUIRED");
 return {version:2,sourceKey,policySha256:state.policySha256,planSha256:state.planSha256,bindingSha256:migrationCutoverDigest(state.binding,2),cohortId:state.binding.cohortId,generation:state.binding.generation,writeId:w.writeId,receiptSha256:w.receiptSha256,providerGuardSha256:w.providerGuardSha256,deliveryGuardSha256:w.deliveryGuardSha256,recordedAt:w.recordedAt};
}
async function loadAndVerifyNativeMarkerV2(tx:CutoverTransaction,state:DurableCutoverState|null,p:WriterFencePolicy,sourceKey:string):Promise<FirstPostgresWriteMarkerV2|null> {
 if(typeof tx.loadFirstWriteMarker!=="function")fail("NATIVE_FIRST_WRITE_MARKER_ADAPTER_REQUIRED");
 const marker=await tx.loadFirstWriteMarker();
 if(state===null||state.firstPostgresWrite===null){if(marker!==null)fail("ORPHAN_OR_PREMATURE_NATIVE_FIRST_WRITE_MARKER");return null;}
 if(p.version!==2||marker===null||!equal(marker,nativeMarkerForStateV2(state,sourceKey)))fail("NATIVE_FIRST_WRITE_MARKER_MISMATCH");return marker;
}
function nativeMarkerAdapterV2(schema:string,sourceKey:string,query:PostgresTransaction["query"],readOnly:boolean):Pick<CutoverTransaction,"loadFirstWriteMarker"|"saveFirstWriteMarker"> {
 const table=`${schema}.migration_cutover_first_write_markers`;let probed=false;
 const probe=async()=>{if(probed)return;const r=(await query("SELECT relkind,relpersistence FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($1)",[table])).rows[0];if(r?.relkind!=="r"||r.relpersistence!=="p")fail("DURABLE_NATIVE_FIRST_WRITE_MARKER_TABLE_REQUIRED");probed=true;};
 return {
  async loadFirstWriteMarker(){await probe();const rows=(await query(`SELECT marker_sha256,marker FROM ${table} WHERE source_key=$1`,[sourceKey])).rows;if(rows.length>1)fail("CORRUPT_NATIVE_FIRST_WRITE_MARKER");const r=rows[0];if(!r)return null;const m=keys(copy(r.marker),["version","sourceKey","policySha256","planSha256","bindingSha256","cohortId","generation","writeId","receiptSha256","providerGuardSha256","deliveryGuardSha256","recordedAt"]);if(m.version!==2||m.sourceKey!==sourceKey||!sha(r.marker_sha256)||r.marker_sha256!==migrationCutoverDigest(m,2))fail("CORRUPT_NATIVE_FIRST_WRITE_MARKER");return m as unknown as FirstPostgresWriteMarkerV2;},
  async saveFirstWriteMarker(m){if(readOnly)fail("READ_ONLY_STARTUP_ADAPTER");await probe();if(m.sourceKey!==sourceKey||m.version!==2)fail("INVALID_NATIVE_FIRST_WRITE_MARKER");const r=await query(`INSERT INTO ${table}(source_key,marker_sha256,marker) VALUES($1,$2,$3::jsonb) ON CONFLICT(source_key) DO NOTHING RETURNING source_key`,[sourceKey,migrationCutoverDigest(m,2),migrationCutoverCanonicalJson(m)]);if(r.rowCount!==1)fail("NATIVE_FIRST_WRITE_MARKER_ALREADY_EXISTS");},
 };
}
