import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FomoTokenLookupResult } from "./token-lookup-queue.js";

interface ResultCursor { readonly version: 1; readonly byteOffset: number }

export interface FomoTokenLookupResultLease {
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly result: FomoTokenLookupResult;
}

const readText = async (path: string): Promise<string> => {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseFomoLookupResult(line: string): FomoTokenLookupResult | null {
  try {
    const value = JSON.parse(line) as Partial<FomoTokenLookupResult>;
    if ((value.version !== 1 && value.version !== 2) || typeof value.lookupId !== "string" || !value.lookupId.trim() || typeof value.chainId !== "string" || !value.chainId.trim() || typeof value.tokenAddress !== "string" || !value.tokenAddress.trim() || !validInteger(value.completedAt) || !validInteger(value.holderCount) || !validInteger(value.queriedTraderCount) || !validInteger(value.observationCount)) return null;
    if (value.eventIds !== undefined && (!Array.isArray(value.eventIds) || value.eventIds.some((id) => typeof id !== "string" || !id.trim()))) return null;
    if (value.version === 2) {
      if (value.purpose !== "milestone_backfill" || typeof value.milestoneId !== "string" || !value.milestoneId.trim() || !validInteger(value.beforeAt)) return null;
      if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor.trim())) return null;
    } else if (value.purpose !== undefined || value.milestoneId !== undefined || value.beforeAt !== undefined || value.cursor !== undefined) return null;
    return Object.freeze(value as FomoTokenLookupResult);
  } catch { return null; }
}

export class FomoTokenLookupResultProducer {
  readonly #filePath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string }) { this.#filePath = options.filePath; }

  append(result: FomoTokenLookupResult): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      if (!parseFomoLookupResult(JSON.stringify(result))) throw new Error("Invalid Fomo token lookup result");
      await mkdir(dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, `${JSON.stringify(result)}\n`, "utf8");
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }
}

export class FomoTokenLookupResultConsumer {
  readonly #filePath: string;
  readonly #cursorPath: string;
  #cursor: Promise<ResultCursor> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string; readonly cursorPath: string }) {
    this.#filePath = options.filePath;
    this.#cursorPath = options.cursorPath;
  }

  async next(): Promise<FomoTokenLookupResultLease | null> {
    const cursor = await this.#loadCursor();
    let size: number;
    try { size = (await stat(this.#filePath)).size; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (cursor.byteOffset >= size) return null;
    const handle = await open(this.#filePath, "r");
    try {
      const buffer = Buffer.alloc(size - cursor.byteOffset);
      await handle.read(buffer, 0, buffer.length, cursor.byteOffset);
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) return null;
      const nextByteOffset = cursor.byteOffset + newlineIndex + 1;
      const result = parseFomoLookupResult(buffer.subarray(0, newlineIndex).toString("utf8"));
      if (!result) {
        const next = { version: 1 as const, byteOffset: nextByteOffset };
        await this.#persistCursor(next);
        this.#cursor = Promise.resolve(next);
        return this.next();
      }
      return Object.freeze({ byteOffset: cursor.byteOffset, nextByteOffset, result });
    } finally { await handle.close(); }
  }

  complete(lease: FomoTokenLookupResultLease): Promise<void> {
    const operation = this.#mutationTail.then(async () => {
      const cursor = await this.#loadCursor();
      if (cursor.byteOffset !== lease.byteOffset) return;
      const next = { version: 1 as const, byteOffset: lease.nextByteOffset };
      await this.#persistCursor(next);
      this.#cursor = Promise.resolve(next);
    });
    this.#mutationTail = operation.catch(() => undefined);
    return operation;
  }

  #loadCursor(): Promise<ResultCursor> {
    this.#cursor ??= readText(this.#cursorPath).then((text) => {
      try {
        const value = JSON.parse(text) as Partial<ResultCursor>;
        if (value.version === 1 && validInteger(value.byteOffset)) return value as ResultCursor;
      } catch { /* Replay when the cursor is absent or damaged. */ }
      return { version: 1, byteOffset: 0 };
    });
    return this.#cursor;
  }

  async #persistCursor(cursor: ResultCursor): Promise<void> {
    await mkdir(dirname(this.#cursorPath), { recursive: true });
    const temporaryPath = `${this.#cursorPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(cursor)}\n`, "utf8");
    await rename(temporaryPath, this.#cursorPath);
  }
}
