import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly retryDelayMs?: number;
}

interface LockMetadata {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
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

function parseLockMetadata(contents: string): LockMetadata | null {
  try {
    const value = JSON.parse(contents) as Partial<LockMetadata>;
    if (value.version === 1 && typeof value.token === "string" && value.token.length > 0 && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.hostname === "string" && value.hostname.length > 0 && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.heartbeatAt)) return value as LockMetadata;
  } catch { /* Invalid locks are recoverable only after their mtime expires. */ }
  return null;
}

const sameInode = (left: { readonly dev: number | bigint; readonly ino: number | bigint }, right: { readonly dev: number | bigint; readonly ino: number | bigint }): boolean => left.dev === right.dev && left.ino === right.ino;

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

function localPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function restoreMovedLock(stalePath: string, path: string): Promise<void> {
  try {
    await link(stalePath, path);
    await durableRemove(stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function recoverStaleLock(path: string, staleMs: number): Promise<boolean> {
  let candidate: LockSnapshot;
  try { candidate = await snapshotLock(path); }
  catch (error) {
    if (["ENOENT", "EAGAIN"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  if (Date.now() - candidate.mtimeMs < staleMs) return false;
  if (candidate.metadata?.hostname === hostname() && localPidIsAlive(candidate.metadata.pid)) return false;

  let verified: LockSnapshot;
  try { verified = await snapshotLock(path); }
  catch (error) {
    if (["ENOENT", "EAGAIN"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  if (!sameSnapshot(candidate, verified) || Date.now() - verified.mtimeMs < staleMs) return false;
  if (verified.metadata?.hostname === hostname() && localPidIsAlive(verified.metadata.pid)) return false;

  const stalePath = `${path}.stale.${randomUUID()}`;
  try { await rename(path, stalePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    const moved = await snapshotLock(stalePath);
    if (!sameSnapshot(verified, moved)) {
      await restoreMovedLock(stalePath, path);
      throw new Error(`Lock changed during stale recovery: ${path}`);
    }
    await durableRemove(stalePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

function combinedFailure(message: string, failures: unknown[]): unknown {
  return failures.length === 1 ? failures[0] : new AggregateError(failures, message);
}

export async function withExclusiveFileLock<T>(path: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 10;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(staleMs) || staleMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) throw new Error("Invalid file lock options");
  const token = randomUUID();
  const startedAt = Date.now();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  let handle: FileHandle;

  for (;;) {
    try {
      handle = await open(path, "wx");
      const createdAt = Date.now();
      const metadata: LockMetadata = { version: 1, token, pid: process.pid, hostname: hostname(), createdAt, heartbeatAt: createdAt };
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.datasync();
        await syncDirectory(directory);
      } catch (error) {
        const failures: unknown[] = [error];
        try { await handle.close(); } catch (closeError) { failures.push(closeError); }
        try { await durableRemove(path); } catch (removeError) { failures.push(removeError); }
        throw combinedFailure(`Lock acquisition cleanup failed: ${path}`, failures);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await recoverStaleLock(path, staleMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out acquiring lock: ${path}`);
      await delay(Math.min(retryDelayMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    }
  }

  let heartbeatFailure: unknown;
  let heartbeatTail = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatTail = heartbeatTail.then(async () => {
      try {
        const now = new Date();
        await handle.utimes(now, now);
        await handle.datasync();
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
  try { await releaseOwnedLock(path, token, handle); }
  catch (error) { releaseFailure = error; }
  let closeFailure: unknown;
  try { await handle.close(); }
  catch (error) { closeFailure = error; }

  const failures = [operationFailure, heartbeatFailure, releaseFailure, closeFailure].filter((failure) => failure !== undefined);
  if (failures.length > 0) throw combinedFailure(`Locked operation or release failed: ${path}`, failures);
  return result as T;
}
