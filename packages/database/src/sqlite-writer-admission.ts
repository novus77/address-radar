import { assertProductionSourceRegistered, serializeSqliteBoundary } from './sqlite-writer-boundary-lock.js';
import { createHash } from "node:crypto";
import { type Stats, constants as fsConstants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as sqliteConstants, type DatabaseSync } from "node:sqlite";

export const SQLITE_ADMISSION_CONTROL = "/etc/address-radar/sqlite-writer-admission";
const hashPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[A-Za-z0-9_.:@/-]{1,256}$/;
const kinds = new Set(["services", "timers", "operators", "deploy", "usercron", "externalInputs"]);
const services = new Set(["scanner", "automation", "wallet-monitor", "wallet-analysis", "historical-backfill", "console"]);
export interface SqliteAdmissionPolicy {
  version: 1; deploymentId: string; challengeId: string; notBefore: number; notAfter: number;
  sources: Array<{ path: string; device: string; inode: string; generation: string }>;
  writers: Array<{ id: string; kind: string; service: string | null; sourcePath: string; launchSha256: string; probeLaunchSha256: string }>;
  unresolvedScopes: string[];
}
export interface SqliteAdmissionState {
  version: 1; deploymentId: string; policySha256: string; challengeId: string; revision: string;
  admission: "open" | "closed"; notBefore: number; notAfter: number;
}
export interface SqliteAdmissionRequest {
  path: string; device: string; inode: string; writerId: string; launchSha256: string; generation: string; probe: boolean;
}
export class SqliteAdmissionRejected extends Error {
  constructor(readonly reason: string) { super(`SQLite writer admission rejected: ${reason}`); }
}
function requireAdmission(value: unknown, reason: string): asserts value {
  if (!value) throw new SqliteAdmissionRejected(reason);
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  requireAdmission(value !== null && typeof value === "object" && !Array.isArray(value), "policy-invalid");
  const object = value as Record<string, unknown>;
  requireAdmission(Object.keys(object).sort().join("\0") === keys.sort().join("\0"), "policy-invalid");
  return object;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function pathValid(value: unknown): value is string {
  return typeof value === "string" && /^\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(value)
    && resolve(value) === value;
}
export function parseSqliteAdmissionPolicy(input: unknown): SqliteAdmissionPolicy {
  const p = exact(input, ["version", "deploymentId", "challengeId", "notBefore", "notAfter", "sources", "writers", "unresolvedScopes"]);
  requireAdmission(p.version === 1 && tokenPattern.test(String(p.deploymentId)) && tokenPattern.test(String(p.challengeId)), "policy-invalid");
  requireAdmission(Number.isSafeInteger(p.notBefore) && Number.isSafeInteger(p.notAfter)
    && Number(p.notBefore) >= 0 && Number(p.notAfter) > Number(p.notBefore)
    && Number(p.notAfter) - Number(p.notBefore) <= 7200000, "window-invalid");
  requireAdmission(Array.isArray(p.unresolvedScopes) && p.unresolvedScopes.length === 0, "scope-unresolved");
  requireAdmission(Array.isArray(p.sources) && p.sources.length > 0 && p.sources.length <= 8, "source-unresolved");
  const paths = new Set<string>();
  for (const item of p.sources) {
    const source = exact(item, ["path", "device", "inode", "generation"]);
    requireAdmission(pathValid(source.path) && !paths.has(source.path)
      && /^[1-9][0-9]*$/.test(String(source.device)) && /^[1-9][0-9]*$/.test(String(source.inode))
      && typeof source.generation === "string" && tokenPattern.test(source.generation), "source-unresolved");
    paths.add(source.path);
  }
  requireAdmission(Array.isArray(p.writers) && p.writers.length > 0 && p.writers.length <= 256, "writer-unresolved");
  const ids = new Set<string>();
  for (const item of p.writers) {
    const writer = exact(item, ["id", "kind", "service", "sourcePath", "launchSha256", "probeLaunchSha256"]);
    requireAdmission(typeof writer.id === "string" && tokenPattern.test(writer.id) && !ids.has(writer.id)
      && kinds.has(String(writer.kind)) && paths.has(String(writer.sourcePath))
      && (writer.service === null || services.has(String(writer.service)))
      && typeof writer.launchSha256 === "string" && hashPattern.test(writer.launchSha256)
      && typeof writer.probeLaunchSha256 === "string" && hashPattern.test(writer.probeLaunchSha256), "writer-unresolved");
    ids.add(writer.id);
  }
  return p as unknown as SqliteAdmissionPolicy;
}
export function evaluateSqliteAdmission(policy: SqliteAdmissionPolicy, input: unknown,
  request: SqliteAdmissionRequest, policySha256: string, now: number): void {
  parseSqliteAdmissionPolicy(policy);
  const state = exact(input, ["version", "deploymentId", "policySha256", "challengeId", "revision", "admission", "notBefore", "notAfter"]);
  requireAdmission(state.version === 1 && state.deploymentId === policy.deploymentId && state.policySha256 === policySha256
    && state.challengeId === policy.challengeId && /^[1-9][0-9]*$/.test(String(state.revision))
    && ["open", "closed"].includes(String(state.admission))
    && state.notBefore === policy.notBefore && state.notAfter === policy.notAfter, "state-invalid");
  requireAdmission(Number.isSafeInteger(now) && now >= policy.notBefore && now < policy.notAfter, "window-invalid");
  const source = policy.sources.find(value => value.path === request.path);
  requireAdmission(source && source.device === request.device && source.inode === request.inode, "source-identity-changed");
  const writer = policy.writers.find(value => value.id === request.writerId && value.sourcePath === source.path);
  requireAdmission(writer && request.launchSha256 === (request.probe ? writer.probeLaunchSha256 : writer.launchSha256), "writer-unregistered");
  requireAdmission(request.generation === source.generation, "generation-unregistered");
  requireAdmission(state.admission === "open", "generation-rejected");
}

function protectedInfo(path: string, directory: boolean): Stats {
  const info = lstatSync(path);
  requireAdmission(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile())
    && info.uid === 0 && (info.mode & 0o022) === 0
    && (directory || (info.nlink === 1 && info.size <= 65536)), "control-unprotected");
  return info;
}
export function readSqliteAdmissionProtectedBytes(path: string): Buffer {
  const ancestors: Array<{ path: string; dev: number; ino: number }> = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const info = protectedInfo(parent, true);
    ancestors.push({ path: parent, dev: Number(info.dev), ino: Number(info.ino) });
    if (parent === "/") break;
  }
  const before = protectedInfo(path, false);
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    requireAdmission(opened.dev === before.dev && opened.ino === before.ino, "control-replaced");
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const amount = readSync(fd, buffer, size, buffer.length - size, null);
      if (amount === 0) break;
      size += amount;
    }
    requireAdmission(size <= 65536, "control-bound");
    const after = fstatSync(fd), live = protectedInfo(path, false);
    requireAdmission(after.dev === before.dev && after.ino === before.ino && live.dev === before.dev && live.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "control-replaced");
    for (const ancestor of ancestors) {
      const current = protectedInfo(ancestor.path, true);
      requireAdmission(Number(current.dev) === ancestor.dev && Number(current.ino) === ancestor.ino, "control-replaced");
    }
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
export function readSqliteAdmissionProtectedRecord(path: string): { value: unknown; sha256: string } {
  const raw = readSqliteAdmissionProtectedBytes(path), value = JSON.parse(raw.toString("utf8")) as unknown;
  requireAdmission(canonical(value) === raw.toString("utf8"), "control-noncanonical");
  return { value, sha256: digest(raw) };
}
const readProtected = readSqliteAdmissionProtectedRecord;
export const measureSqliteAdmissionCodeSha256 = (path: string): string => protectedCodeSha256(path);
function protectedConfiguration(): { policy: SqliteAdmissionPolicy; policySha256: string; state: unknown } | null {
  try { protectedInfo(SQLITE_ADMISSION_CONTROL, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // Only installation of activation.json enables enforcement. Staging never changes old admission.
  let activation: { value: unknown; sha256: string };
  try { activation = readProtected(`${SQLITE_ADMISSION_CONTROL}/activation.json`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const marker = exact(activation.value, ["version", "deploymentId", "policySha256"]);
  requireAdmission(marker.version === 1 && typeof marker.policySha256 === "string" && hashPattern.test(marker.policySha256), "activation-invalid");
  const loaded = readProtected(`${SQLITE_ADMISSION_CONTROL}/policy.json`);
  const policy = parseSqliteAdmissionPolicy(loaded.value);
  requireAdmission(loaded.sha256 === marker.policySha256 && policy.deploymentId === marker.deploymentId, "policy-pin-changed");
  return { policy, policySha256: loaded.sha256, state: readProtected(`${SQLITE_ADMISSION_CONTROL}/state.json`).value };
}
let registeredService: string | null = null;
export function registerSqliteWriterService(service: string): void {
  requireAdmission(services.has(service) && (registeredService === null || registeredService === service), "service-unregistered");
  registeredService = service;
}
const measuredCode = new Map<string, { identity: string; sha256: string }>();
function protectedCodeSha256(path: string): string {
  const parents: Array<{ path: string; dev: number; ino: number }> = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const info = protectedInfo(parent, true);
    parents.push({ path: parent, dev: Number(info.dev), ino: Number(info.ino) });
    if (parent === "/") break;
  }
  const before = lstatSync(path);
  requireAdmission(before.isFile() && !before.isSymbolicLink() && before.uid === 0
    && before.nlink === 1 && (before.mode & 0o022) === 0 && before.size <= 268435456, "code-unprotected");
  const codeIdentity = canonical([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  const cached = measuredCode.get(path);
  if (cached?.identity === codeIdentity) return cached.sha256;
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    requireAdmission(opened.dev === before.dev && opened.ino === before.ino, "code-replaced");
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    const deadline = performance.now() + 2000;
    let count = 0;
    while (true) {
      requireAdmission(performance.now() < deadline, "code-read-bound");
      const amount = readSync(fd, buffer, 0, buffer.length, null);
      if (!amount) break;
      count += amount;
      requireAdmission(count <= 268435456, "code-read-bound");
      hash.update(buffer.subarray(0, amount));
    }
    const after = fstatSync(fd), live = lstatSync(path);
    requireAdmission(after.dev === before.dev && after.ino === before.ino && live.dev === before.dev && live.ino === before.ino
      && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, "code-replaced");
    for (const parent of parents) {
      const current = protectedInfo(parent.path, true);
      requireAdmission(Number(current.dev) === parent.dev && Number(current.ino) === parent.ino, "code-replaced");
    }
    const sha256 = hash.digest("hex");
    measuredCode.set(path, { identity: codeIdentity, sha256 });
    return sha256;
  } finally { closeSync(fd); }
}
export function sqliteWriterLaunchBinding(execPath: string, entryPath: string, gatePath: string,
  argv: readonly string[], readCode: (path: string) => string): string {
  const code = [execPath, entryPath, gatePath].map(path => ({ path, sha256: readCode(path) }));
  requireAdmission(code.every(value => hashPattern.test(value.sha256)), "code-pin-invalid");
  return digest(canonical({ execPath, argv, code }));
}
export function sqliteWriterLaunchSha256(): string {
  requireAdmission(typeof process.argv[1] === "string", "entry-unregistered");
  return sqliteWriterLaunchBinding(realpathSync(process.execPath), realpathSync(process.argv[1]),
    realpathSync(fileURLToPath(import.meta.url)), process.argv, protectedCodeSha256);
}
function assertSqliteWriterAdmissionWithoutBoundary(databasePath: string, expectedPolicySha256?: string): void {
  const config = protectedConfiguration();
  requireAdmission(!expectedPolicySha256 || config?.policySha256 === expectedPolicySha256, "activation-or-policy-changed");
  if (!config) return;
  if (databasePath === ":memory:" || databasePath === "") return;
  const absolute = resolve(databasePath);
  let info: Stats;
  try { info = statSync(absolute); }
  catch (error) {
    requireAdmission(!config.policy.sources.some(source => source.path === absolute), "source-identity-changed");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const actualPath = realpathSync(absolute);
  const source = config.policy.sources.find(value => value.path === absolute || value.path === actualPath
    || (value.device === String(info.dev) && value.inode === String(info.ino)));
  if (!source) return;
  requireAdmission(info.isFile() && !lstatSync(absolute).isSymbolicLink() && actualPath === source.path, "source-identity-changed");
  const launchSha256 = sqliteWriterLaunchSha256();
  const writers = config.policy.writers.filter(value => value.sourcePath === source.path && value.launchSha256 === launchSha256
    && (registeredService === null ? value.service === null : value.service === registeredService));
  requireAdmission(writers.length === 1, "writer-unregistered");
  evaluateSqliteAdmission(config.policy, config.state, { path: source.path, device: String(info.dev), inode: String(info.ino),
    writerId: writers[0]!.id, launchSha256, generation: source.generation, probe: false }, config.policySha256, Date.now());
}
export function probeSqliteWriterAdmission(writerId: string, generation: string, sourcePath: string): Record<string, unknown> {
  const config = protectedConfiguration();
  requireAdmission(config, "enforcement-not-activated");
  const info = statSync(sourcePath);
  const request = { path: sourcePath, device: String(info.dev), inode: String(info.ino), writerId,
    launchSha256: sqliteWriterLaunchSha256(), generation, probe: true };
  try { evaluateSqliteAdmission(config.policy, config.state, request, config.policySha256, Date.now()); }
  catch (error) {
    if (error instanceof SqliteAdmissionRejected && error.reason === "generation-rejected") {
      return { result: error.reason, writerId, generation, challengeId: config.policy.challengeId,
        policySha256: config.policySha256, stateSha256: digest(canonical(config.state)),
        observedAt: new Date().toISOString(), boundary: "shared-sqlite-admission-only", fenceEstablished: false };
    }
    throw error;
  }
  return { result: "admitted", writerId, generation, fenceEstablished: false };
}

const guarded = new WeakMap<object, DatabaseSync>();
function guardSqliteDatabaseWithoutBoundary(database: DatabaseSync, check: () => void): DatabaseSync {
  const existing = guarded.get(database);
  if (existing) return existing;
  requireAdmission(typeof database.setAuthorizer === "function", "sqlite-authorizer-unavailable");
  database.setAuthorizer((action, arg1) => {
    if (action === sqliteConstants.SQLITE_ATTACH || action === sqliteConstants.SQLITE_DETACH) return sqliteConstants.SQLITE_DENY;
    if (action === sqliteConstants.SQLITE_TRANSACTION && arg1 === "ROLLBACK") return sqliteConstants.SQLITE_OK;
    try { check(); return sqliteConstants.SQLITE_OK; } catch { return sqliteConstants.SQLITE_DENY; }
  });
  const guardStatement = (statement: object): object => new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        check();
        const result = Reflect.apply(value, target, args) as unknown;
        if (property !== "iterate") return result;
        const iterator = result as Iterator<unknown> & Iterable<unknown>;
        return { next: () => { check(); return iterator.next(); },
          return: () => iterator.return ? iterator.return() : { done: true, value: undefined },
          [Symbol.iterator]() { return this; } };
      };
    },
    set() { throw new SqliteAdmissionRejected("statement-mutation-forbidden"); },
  });
  const proxy = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (["setAuthorizer", "enableLoadExtension", "loadExtension", "applyChangeset", "createSession"].includes(String(property))) {
        return () => { throw new SqliteAdmissionRejected("sqlite-bypass-forbidden"); };
      }
      return (...args: unknown[]) => {
        const rollback = property === "exec" && args.length === 1 && typeof args[0] === "string" && /^\s*ROLLBACK\s*;?\s*$/i.test(args[0]);
        if (property !== "close" && property !== Symbol.dispose && !rollback) check();
        const result = Reflect.apply(value, target, args) as unknown;
        return property === "prepare" ? guardStatement(result as object) : result;
      };
    },
    set() { throw new SqliteAdmissionRejected("database-mutation-forbidden"); },
  });
  guarded.set(database, proxy);
  guarded.set(proxy, proxy);
  return proxy;
}
export function sqliteAdmissionLease(check: () => void, remainingMs: number, clock = () => performance.now()): () => void {
  requireAdmission(Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= 7200000, "window-invalid");
  const started = clock(), deadline = started + remainingMs;
  return () => {
    const before = clock();
    requireAdmission(before >= started && before < deadline, "window-invalid");
    check();
    const after = clock();
    requireAdmission(after >= before && after < deadline, "window-invalid");
  };
}
export function installSqliteAdmissionGuard(database: DatabaseSync, managed: boolean, check: () => void): DatabaseSync {
  return managed ? guardSqliteDatabase(database, check) : database;
}
function enforceSqliteDatabaseAdmissionWithoutBoundary(database: DatabaseSync, expectedPath?: string): DatabaseSync {
  const config = protectedConfiguration();
  // Staging or a genuinely absent activation marker must preserve legacy object and behavior.
  if (!config) return database;
  const location = database.location();
  if (expectedPath !== undefined) assertSqliteWriterAdmission(expectedPath);
  if (!location) return database;
  assertSqliteWriterAdmission(location);
  const actualPath = realpathSync(location), info = statSync(location);
  const managed = config.policy.sources.some(source => source.path === actualPath
    || (source.device === String(info.dev) && source.inode === String(info.ino)));
  if (!managed) return database;
  const check = sqliteAdmissionLease(() => assertSqliteWriterAdmission(location, config.policySha256),
    config.policy.notAfter - Date.now());
  return installSqliteAdmissionGuard(database, true, check);
}

export function guardSqliteDatabase(...args: Parameters<typeof guardSqliteDatabaseWithoutBoundary>): ReturnType<typeof guardSqliteDatabaseWithoutBoundary> {
  return serializeSqliteBoundary(guardSqliteDatabaseWithoutBoundary(...args));
}

export function assertSqliteWriterAdmission(...args: Parameters<typeof assertSqliteWriterAdmissionWithoutBoundary>): ReturnType<typeof assertSqliteWriterAdmissionWithoutBoundary> {
  assertProductionSourceRegistered();
  return assertSqliteWriterAdmissionWithoutBoundary(...args);
}

export function enforceSqliteDatabaseAdmission(...args: Parameters<typeof enforceSqliteDatabaseAdmissionWithoutBoundary>): ReturnType<typeof enforceSqliteDatabaseAdmissionWithoutBoundary> {
  assertProductionSourceRegistered();
  return enforceSqliteDatabaseAdmissionWithoutBoundary(...args);
}
