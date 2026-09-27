import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { atomicWrite, durableAppend, durableRemove, readText, withExclusiveFileLock, type FileLockOptions } from "./durable-file.js";
import type { FomoTokenLookupResult } from "./token-lookup-queue.js";

interface ResultCursor {
  readonly version: 1;
  readonly byteOffset: number;
  readonly generation?: string;
  readonly prefixHash?: string;
}

export interface FomoTokenLookupResultLease {
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly generation: string;
  readonly leaseId: string;
  readonly result: FomoTokenLookupResult;
}

interface ResultClaim { readonly version: 1; readonly ownerId: string; readonly expiresAt: number; readonly lease: FomoTokenLookupResultLease }

const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("base64url");
const generationOf = (value: { readonly dev: number | bigint; readonly ino: number | bigint }): string => `${value.dev}:${value.ino}`;
const leaseHash = (generation: string, byteOffset: number, nextByteOffset: number, bytes: Uint8Array): string => createHash("sha256").update(`${generation}:${byteOffset}:${nextByteOffset}:`).update(bytes).digest("base64url");

export function parseFomoLookupResult(line: string): FomoTokenLookupResult | null {
  try {
    const value = JSON.parse(line) as Partial<FomoTokenLookupResult>;
    if ((value.version !== 1 && value.version !== 2) || typeof value.lookupId !== "string" || !value.lookupId.trim() || typeof value.chainId !== "string" || !value.chainId.trim() || typeof value.tokenAddress !== "string" || !value.tokenAddress.trim() || !validInteger(value.completedAt) || !validInteger(value.holderCount) || !validInteger(value.queriedTraderCount) || !validInteger(value.observationCount)) return null;
    if (value.verificationStatus !== undefined && !new Set(["confirmed", "not_found", "mismatch", "deferred"]).has(value.verificationStatus)) return null;
    if (value.exactAddressMatch !== undefined && typeof value.exactAddressMatch !== "boolean") return null;
    if (value.historyAvailable !== undefined && typeof value.historyAvailable !== "boolean") return null;
    for (const field of [value.providerTokenId, value.providerUrl, value.errorCode]) if (field !== undefined && typeof field !== "string") return null;
    if (value.eventIds !== undefined && (!Array.isArray(value.eventIds) || value.eventIds.some((id) => typeof id !== "string" || !id.trim()))) return null;
    if (value.version === 2) {
      if (value.purpose !== "milestone_backfill" || typeof value.milestoneId !== "string" || !value.milestoneId.trim() || !validInteger(value.beforeAt)) return null;
      if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor.trim())) return null;
    } else if (value.purpose !== undefined || value.milestoneId !== undefined || value.beforeAt !== undefined || value.cursor !== undefined) return null;
    return Object.freeze(value as FomoTokenLookupResult);
  } catch { return null; }
}

const parseCursor = (text: string): ResultCursor | null => {
  try {
    const value = JSON.parse(text) as Partial<ResultCursor>;
    return value.version === 1 && validInteger(value.byteOffset) ? value as ResultCursor : null;
  } catch { return null; }
};

const parseClaim = (text: string): ResultClaim | null => {
  try {
    const value = JSON.parse(text) as Partial<ResultClaim>;
    return value.version === 1 && typeof value.ownerId === "string" && validInteger(value.expiresAt) && value.lease !== undefined ? value as ResultClaim : null;
  } catch { return null; }
};

export class FomoTokenLookupResultProducer {
  readonly #filePath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string }) { this.#filePath = options.filePath; }

  append(result: FomoTokenLookupResult): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      if (!parseFomoLookupResult(JSON.stringify(result))) throw new Error("Invalid Fomo token lookup result");
      await durableAppend(this.#filePath, `${JSON.stringify(result)}\n`);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }
}

export class FomoTokenLookupResultConsumer {
  readonly #filePath: string;
  readonly #cursorPath: string;
  readonly #claimPath: string;
  readonly #ownerId = randomUUID();
  readonly #claimTtlMs: number;
  readonly #now: () => number;
  readonly #lockOptions: FileLockOptions;

  constructor(options: { readonly filePath: string; readonly cursorPath: string; readonly claimTtlMs?: number; readonly now?: () => number; readonly lockTimeoutMs?: number; readonly staleLockMs?: number }) {
    this.#filePath = options.filePath;
    this.#cursorPath = options.cursorPath;
    this.#claimPath = `${options.cursorPath}.claim`;
    this.#claimTtlMs = options.claimTtlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#lockOptions = { ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}), ...(options.staleLockMs !== undefined ? { staleMs: options.staleLockMs } : {}) };
    if (!Number.isSafeInteger(this.#claimTtlMs) || this.#claimTtlMs < 1) throw new Error("Invalid result consumer options");
  }

  next(): Promise<FomoTokenLookupResultLease | null> {
    return this.#locked(async () => {
      const existingClaim = parseClaim(await readText(this.#claimPath));
      if (existingClaim && existingClaim.expiresAt > this.#now()) return existingClaim.ownerId === this.#ownerId ? existingClaim.lease : null;
      if (existingClaim) await durableRemove(this.#claimPath);
      let snapshot: { readonly buffer: Buffer; readonly generation: string };
      try { snapshot = await this.snapshot(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let cursor = await this.#resolvedCursor(snapshot);
      while (cursor.byteOffset < snapshot.buffer.length) {
        const remaining = snapshot.buffer.subarray(cursor.byteOffset);
        const newlineIndex = remaining.indexOf(0x0a);
        if (newlineIndex < 0) return null;
        const nextByteOffset = cursor.byteOffset + newlineIndex + 1;
        const bytes = snapshot.buffer.subarray(cursor.byteOffset, nextByteOffset);
        const result = parseFomoLookupResult(bytes.subarray(0, bytes.length - 1).toString("utf8"));
        if (!result) {
          cursor = { version: 1, byteOffset: nextByteOffset, generation: snapshot.generation, prefixHash: hash(snapshot.buffer.subarray(0, nextByteOffset)) };
          await this.#persistCursor(cursor);
          continue;
        }
        const lease: FomoTokenLookupResultLease = Object.freeze({
          byteOffset: cursor.byteOffset,
          nextByteOffset,
          generation: snapshot.generation,
          leaseId: leaseHash(snapshot.generation, cursor.byteOffset, nextByteOffset, bytes),
          result,
        });
        const claim: ResultClaim = { version: 1, ownerId: this.#ownerId, expiresAt: this.#now() + this.#claimTtlMs, lease };
        await atomicWrite(this.#claimPath, `${JSON.stringify(claim)}\n`);
        return lease;
      }
      return null;
    });
  }

  complete(lease: FomoTokenLookupResultLease): Promise<void> {
    return this.#locked(async () => {
      const claim = parseClaim(await readText(this.#claimPath));
      if (claim?.ownerId !== this.#ownerId || claim.lease.leaseId !== lease.leaseId) return;
      const snapshot = await this.snapshot();
      const cursor = await this.#resolvedCursor(snapshot);
      const bytes = snapshot.buffer.subarray(lease.byteOffset, lease.nextByteOffset);
      if (snapshot.generation !== lease.generation || cursor.byteOffset !== lease.byteOffset || lease.nextByteOffset > snapshot.buffer.length || snapshot.buffer[lease.nextByteOffset - 1] !== 0x0a || leaseHash(lease.generation, lease.byteOffset, lease.nextByteOffset, bytes) !== lease.leaseId) {
        await durableRemove(this.#claimPath);
        return;
      }
      await this.#persistCursor({ version: 1, byteOffset: lease.nextByteOffset, generation: snapshot.generation, prefixHash: hash(snapshot.buffer.subarray(0, lease.nextByteOffset)) });
      await durableRemove(this.#claimPath);
    });
  }

  private async snapshot() {
    const [metadata, buffer] = await Promise.all([stat(this.#filePath), readFile(this.#filePath)]);
    return { buffer, generation: generationOf(metadata) };
  }

  async #resolvedCursor(snapshot: { readonly buffer: Buffer; readonly generation: string }): Promise<ResultCursor> {
    const persisted = parseCursor(await readText(this.#cursorPath));
    if (!persisted) return { version: 1, byteOffset: 0, generation: snapshot.generation, prefixHash: hash(new Uint8Array()) };
    const validBoundary = persisted.byteOffset === 0 || persisted.byteOffset <= snapshot.buffer.length && snapshot.buffer[persisted.byteOffset - 1] === 0x0a;
    const validPrefix = persisted.prefixHash === undefined || persisted.prefixHash === hash(snapshot.buffer.subarray(0, persisted.byteOffset));
    if (persisted.generation !== undefined && persisted.generation !== snapshot.generation || !validBoundary || !validPrefix) {
      const reset = { version: 1 as const, byteOffset: 0, generation: snapshot.generation, prefixHash: hash(new Uint8Array()) };
      await this.#persistCursor(reset);
      return reset;
    }
    return { ...persisted, generation: snapshot.generation };
  }

  #persistCursor(cursor: ResultCursor): Promise<void> {
    return atomicWrite(this.#cursorPath, `${JSON.stringify(cursor)}\n`);
  }

  #locked<T>(operation: () => Promise<T>): Promise<T> {
    return withExclusiveFileLock(`${this.#cursorPath}.lock`, operation, this.#lockOptions);
  }
}
