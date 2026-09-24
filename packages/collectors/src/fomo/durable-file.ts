import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly staleMs?: number;
}

export class FileLockTimeoutError extends Error {
  readonly code = "FILE_LOCK_TIMEOUT";
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out acquiring SQLite lock for ${lockPath} after ${timeoutMs}ms`);
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export function fileLockCoordinationPath(lockPath: string): string {
  return `${lockPath}.coord.sqlite`;
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

function combinedFailure(message: string, failures: unknown[]): unknown {
  return failures.length === 1 ? failures[0] : new AggregateError(failures, message);
}

function isSqliteBusy(error: unknown): boolean {
  const value = error as { readonly errcode?: unknown; readonly errstr?: unknown; readonly message?: unknown };
  return value.errcode === 5 || value.errcode === 6 || typeof value.errstr === "string" && /busy|locked/i.test(value.errstr) || typeof value.message === "string" && /busy|locked/i.test(value.message);
}

function closeAfterAcquisitionFailure(database: DatabaseSync, failure: unknown): never {
  const failures = [failure];
  try { database.exec("ROLLBACK"); }
  catch (rollbackError) {
    if (!/no transaction is active/i.test(String((rollbackError as Error).message))) failures.push(rollbackError);
  }
  try { database.close(); }
  catch (closeError) { failures.push(closeError); }
  throw combinedFailure("SQLite lock acquisition cleanup failed", failures);
}

async function beginImmediate(lockPath: string, timeoutMs: number, retryDelayMs: number): Promise<DatabaseSync> {
  const databasePath = fileLockCoordinationPath(lockPath);
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(databasePath), { recursive: true });

  for (;;) {
    const database = new DatabaseSync(databasePath);
    const remainingMs = Math.max(0, deadline - Date.now());
    const busyTimeoutMs = Math.max(0, Math.min(retryDelayMs, remainingMs));
    try {
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      database.exec("BEGIN IMMEDIATE");
      database.exec("CREATE TABLE IF NOT EXISTS coordination_lock (id INTEGER PRIMARY KEY CHECK (id = 1))");
      await syncDirectory(dirname(databasePath));
      return database;
    } catch (error) {
      if (!isSqliteBusy(error)) closeAfterAcquisitionFailure(database, error);
      try { database.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], `SQLite lock contention cleanup failed: ${lockPath}`); }
      if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export async function withExclusiveFileLock<T>(lockPath: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const retryDelayMs = options.retryDelayMs ?? 10;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || options.staleMs !== undefined && (!Number.isSafeInteger(options.staleMs) || options.staleMs < 1)) throw new Error("Invalid file lock options");
  const database = await beginImmediate(lockPath, timeoutMs, retryDelayMs);

  let result: T | undefined;
  let operationFailure: unknown;
  try { result = await operation(); }
  catch (error) { operationFailure = error; }

  const failures: unknown[] = [];
  if (operationFailure === undefined) {
    try { database.exec("COMMIT"); }
    catch (commitError) {
      failures.push(commitError);
      try { database.exec("ROLLBACK"); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
  } else {
    failures.push(operationFailure);
    try { database.exec("ROLLBACK"); }
    catch (rollbackError) { failures.push(rollbackError); }
  }
  try { database.close(); }
  catch (closeError) { failures.push(closeError); }

  if (failures.length > 0) throw combinedFailure(`SQLite locked operation or release failed: ${lockPath}`, failures);
  return result as T;
}
