import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly retryDelayMs?: number;
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
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(value, "utf8");
    await handle.datasync();
  } finally { await handle.close(); }
  await rename(temporaryPath, path);
  await syncDirectory(directory);
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

export async function withExclusiveFileLock<T>(path: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 10;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(staleMs) || staleMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) throw new Error("Invalid file lock options");
  const token = randomUUID();
  const startedAt = Date.now();
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, token, createdAt: Date.now() })}\n`, "utf8");
        await handle.datasync();
      } finally { await handle.close(); }
      await syncDirectory(dirname(path));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(path);
        if (Date.now() - lockStat.mtimeMs >= staleMs) {
          const stalePath = `${path}.stale.${randomUUID()}`;
          try {
            await rename(path, stalePath);
            await durableRemove(stalePath);
            continue;
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
          }
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out acquiring lock: ${path}`);
      await delay(Math.min(retryDelayMs, timeoutMs));
    }
  }

  try { return await operation(); }
  finally {
    try {
      const current = JSON.parse(await readText(path)) as { readonly token?: unknown };
      if (current.token === token) await durableRemove(path);
    } catch {
      // A stale owner must never remove a replacement lock.
    }
  }
}
