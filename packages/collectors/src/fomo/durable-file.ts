import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface FileLockOwnerIdentity {
  readonly pid: number;
  readonly hostname: string;
  readonly processStartIdentity: string;
}

export type FileLockOwnerStatus = "alive" | "dead" | "reused" | "unknown";

export interface FileLockOwnerIdentityProvider {
  current(): Promise<FileLockOwnerIdentity>;
  status(owner: FileLockOwnerIdentity): Promise<FileLockOwnerStatus>;
}

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly retryDelayMs?: number;
  readonly ownerIdentityProvider?: FileLockOwnerIdentityProvider;
}

interface LockMetadata extends FileLockOwnerIdentity {
  readonly version: 1;
  readonly token: string;
  readonly createdAt: number;
  readonly heartbeatAt: number;
}

interface LockSnapshot {
  readonly metadata: LockMetadata | null;
  readonly contents: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mtimeMs: number;
}

const portableProcessStartIdentity = `portable:${Math.round(Date.now() - process.uptime() * 1_000)}`;

export async function readText(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function durableAppend(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.appendFile(value, "utf8");
    await handle.datasync();
  } finally { await handle.close(); }
  await syncDirectory(directory);
}

export async function atomicWrite(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(value, "utf8");
    await handle.datasync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle) {
      try { await handle.close(); }
      catch (closeError) { cleanupErrors.push(closeError); }
    }
    try { await unlink(temporaryPath); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `Atomic write failed and cleanup was incomplete: ${path}`);
    throw error;
  }
}

export async function durableRemove(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sameInode = (left: { readonly dev: number | bigint; readonly ino: number | bigint }, right: { readonly dev: number | bigint; readonly ino: number | bigint }): boolean => left.dev === right.dev && left.ino === right.ino;

function combinedFailure(message: string, failures: unknown[]): unknown {
  return failures.length === 1 ? failures[0] : new AggregateError(failures, message);
}

function parseLockMetadata(contents: string): LockMetadata | null {
  try {
    const value = JSON.parse(contents) as Partial<LockMetadata>;
    if (value.version === 1 && typeof value.token === "string" && value.token.length > 0 && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.hostname === "string" && value.hostname.length > 0 && typeof value.processStartIdentity === "string" && value.processStartIdentity.length > 0 && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.heartbeatAt)) return value as LockMetadata;
  } catch { /* Invalid owner identity fails closed. */ }
  return null;
}

async function snapshotLock(path: string): Promise<LockSnapshot> {
  const before = await stat(path);
  const contents = await readFile(path, "utf8");
  const after = await stat(path);
  if (!sameInode(before, after)) throw Object.assign(new Error(`Lock changed while inspecting: ${path}`), { code: "EAGAIN" });
  return { metadata: parseLockMetadata(contents), contents, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs };
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return sameInode(left, right) && left.contents === right.contents && left.metadata?.token === right.metadata?.token;
}

function pidLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

async function linuxProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = contents.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fieldsAfterCommand = contents.slice(closeParen + 1).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    return startTime ? `linux:${startTime}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const defaultOwnerIdentityProvider: FileLockOwnerIdentityProvider = {
  async current() {
    return {
      pid: process.pid,
      hostname: hostname(),
      processStartIdentity: await linuxProcessStartIdentity(process.pid) ?? portableProcessStartIdentity,
    };
  },
  async status(owner) {
    if (owner.hostname !== hostname()) return "unknown";
    const liveness = pidLiveness(owner.pid);
    if (liveness !== "alive") return liveness;
    if (owner.processStartIdentity.startsWith("linux:")) {
      const currentIdentity = await linuxProcessStartIdentity(owner.pid);
      if (currentIdentity === null) return pidLiveness(owner.pid) === "dead" ? "dead" : "unknown";
      return currentIdentity === owner.processStartIdentity ? "alive" : "reused";
    }
    if (owner.pid !== process.pid) return "unknown";
    return owner.processStartIdentity === portableProcessStartIdentity ? "alive" : "reused";
  },
};

async function acquirePathGuard(path: string, deadline: number, retryDelayMs: number): Promise<void> {
  const guardPath = `${path}.guard`;
  for (;;) {
    try {
      await mkdir(guardPath);
      try { await syncDirectory(dirname(guardPath)); }
      catch (error) {
        const failures: unknown[] = [error];
        try { await rmdir(guardPath); } catch (cleanupError) { failures.push(cleanupError); }
        throw combinedFailure(`Lock guard acquisition cleanup failed: ${path}`, failures);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock guard: ${path}`);
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }
}

async function withPathGuard<T>(path: string, deadline: number, retryDelayMs: number, operation: () => Promise<T>): Promise<T> {
  const guardPath = `${path}.guard`;
  await acquirePathGuard(path, deadline, retryDelayMs);
  let result: T | undefined;
  let operationFailure: unknown;
  try { result = await operation(); }
  catch (error) { operationFailure = error; }
  let releaseFailure: unknown;
  try {
    await rmdir(guardPath);
    await syncDirectory(dirname(guardPath));
  } catch (error) { releaseFailure = error; }
  const failures = [operationFailure, releaseFailure].filter((failure) => failure !== undefined);
  if (failures.length > 0) throw combinedFailure(`Lock guard operation or release failed: ${path}`, failures);
  return result as T;
}

async function installLock(path: string, token: string, owner: FileLockOwnerIdentity): Promise<FileHandle> {
  const handle = await open(path, "wx");
  const createdAt = Date.now();
  const metadata: LockMetadata = { version: 1, token, ...owner, createdAt, heartbeatAt: createdAt };
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.datasync();
    await syncDirectory(dirname(path));
    return handle;
  } catch (error) {
    const failures: unknown[] = [error];
    try { await handle.close(); } catch (closeError) { failures.push(closeError); }
    try { await durableRemove(path); } catch (removeError) { failures.push(removeError); }
    throw combinedFailure(`Lock installation cleanup failed: ${path}`, failures);
  }
}

async function acquireOrRecoverLock(path: string, token: string, owner: FileLockOwnerIdentity, staleMs: number, ownerIdentityProvider: FileLockOwnerIdentityProvider): Promise<FileHandle | null> {
  try { return await installLock(path, token, owner); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let candidate: LockSnapshot;
  try { candidate = await snapshotLock(path); }
  catch (error) {
    if (["ENOENT", "EAGAIN"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  if (Date.now() - candidate.mtimeMs < staleMs || candidate.metadata === null) return null;
  const ownerStatus = await ownerIdentityProvider.status(candidate.metadata);
  if (ownerStatus !== "dead" && ownerStatus !== "reused") return null;

  let verified: LockSnapshot;
  try { verified = await snapshotLock(path); }
  catch (error) {
    if (["ENOENT", "EAGAIN"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  if (!sameSnapshot(candidate, verified) || Date.now() - verified.mtimeMs < staleMs) return null;
  const verifiedStatus = await ownerIdentityProvider.status(verified.metadata!);
  if (verifiedStatus !== "dead" && verifiedStatus !== "reused") return null;

  const stalePath = `${path}.stale.${randomUUID()}`;
  await rename(path, stalePath);
  const moved = await snapshotLock(stalePath);
  if (!sameSnapshot(verified, moved)) throw new Error(`Lock changed during guarded stale recovery: ${path}`);
  await durableRemove(stalePath);
  return installLock(path, token, owner);
}

async function releaseOwnedLock(path: string, token: string, handle: FileHandle): Promise<"released" | "not-owner"> {
  const owned = await handle.stat();
  let current;
  try { current = await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not-owner";
    throw error;
  }
  if (!sameInode(owned, current)) return "not-owner";
  const metadata = parseLockMetadata(await readFile(path, "utf8"));
  if (metadata?.token !== token) throw new Error(`Owned lock metadata changed: ${path}`);
  const verified = await stat(path);
  if (!sameInode(owned, verified)) return "not-owner";
  await durableRemove(path);
  return "released";
}

export async function withExclusiveFileLock<T>(path: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 10;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(staleMs) || staleMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) throw new Error("Invalid file lock options");
  const ownerIdentityProvider = options.ownerIdentityProvider ?? defaultOwnerIdentityProvider;
  const owner = await ownerIdentityProvider.current();
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  let handle: FileHandle | null = null;

  while (handle === null) {
    handle = await withPathGuard(path, deadline, retryDelayMs, () => acquireOrRecoverLock(path, token, owner, staleMs, ownerIdentityProvider));
    if (handle !== null) break;
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock: ${path}`);
    await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
  }

  let heartbeatFailure: unknown;
  let heartbeatTail = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatTail = heartbeatTail.then(async () => {
      try {
        const now = new Date();
        await handle!.utimes(now, now);
        await handle!.datasync();
      } catch (error) { heartbeatFailure ??= error; }
    });
  }, Math.max(1, Math.floor(staleMs / 3)));
  heartbeat.unref();

  let result: T | undefined;
  let operationFailure: unknown;
  try { result = await operation(); }
  catch (error) { operationFailure = error; }
  clearInterval(heartbeat);
  await heartbeatTail;

  let releaseFailure: unknown;
  try {
    const releaseStatus = await withPathGuard(path, deadline, retryDelayMs, () => releaseOwnedLock(path, token, handle!));
    if (releaseStatus === "not-owner") throw new Error(`Lock ownership lost: ${path}`);
  } catch (error) { releaseFailure = error; }
  let closeFailure: unknown;
  try { await handle.close(); }
  catch (error) { closeFailure = error; }

  const failures = [operationFailure, heartbeatFailure, releaseFailure, closeFailure].filter((failure) => failure !== undefined);
  if (failures.length > 0) throw combinedFailure(`Locked operation or release failed: ${path}`, failures);
  return result as T;
}
