import { randomUUID } from "node:crypto";

import { atomicWrite, durableAppend, durableRemove, readText, withExclusiveFileLock, type FileLockOptions } from "./durable-file.js";

export interface FomoTokenLookupRequest {
  readonly version: 1 | 2;
  readonly lookupId: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly requestedAt: number;
  readonly purpose?: "milestone_backfill";
  readonly milestoneId?: string;
  readonly beforeAt?: number;
  readonly cursor?: string;
}

export interface FomoTokenLookupLease {
  readonly lineNumber: number;
  readonly request: FomoTokenLookupRequest;
}

export interface FomoTokenLookupResult {
  readonly version: 1 | 2;
  readonly lookupId: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly completedAt: number;
  readonly holderCount: number;
  readonly queriedTraderCount: number;
  readonly observationCount: number;
  readonly eventIds?: readonly string[];
  readonly purpose?: "milestone_backfill";
  readonly milestoneId?: string;
  readonly beforeAt?: number;
  readonly cursor?: string;
}

interface LookupCursor { version: 1; lineNumber: number; attempts: number }
interface LookupClaim { readonly version: 1; readonly ownerId: string; readonly expiresAt: number; readonly lease: FomoTokenLookupLease }

const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function normalizedToken(chainId: string, tokenAddress: string) {
  const chain = chainId.trim().toLowerCase();
  const address = tokenAddress.trim();
  if (!chain || !address) throw new Error("Fomo token lookup requires chainId and tokenAddress");
  return { chainId: chain, tokenAddress: chain === "solana" ? address : address.toLowerCase() };
}

function validMilestone(input: { readonly purpose?: unknown; readonly milestoneId?: unknown; readonly beforeAt?: unknown; readonly cursor?: unknown }): void {
  if (input.purpose === "milestone_backfill") {
    if (typeof input.milestoneId !== "string" || !input.milestoneId.trim()) throw new Error("milestoneId is required for milestone_backfill");
    if (!validInteger(input.beforeAt)) throw new Error("beforeAt is required for milestone_backfill");
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor.trim())) throw new Error("cursor must not be empty");
    return;
  }
  if (input.purpose !== undefined || input.milestoneId !== undefined || input.beforeAt !== undefined || input.cursor !== undefined) throw new Error("Milestone fields require purpose milestone_backfill");
}

function parseRequest(line: string): FomoTokenLookupRequest | null {
  try {
    const value = JSON.parse(line) as Partial<FomoTokenLookupRequest>;
    if ((value.version !== 1 && value.version !== 2) || typeof value.lookupId !== "string" || !value.lookupId || typeof value.chainId !== "string" || typeof value.tokenAddress !== "string" || !validInteger(value.requestedAt)) return null;
    if (value.version === 2) {
      validMilestone(value);
      if (value.purpose !== "milestone_backfill") return null;
    } else if (value.purpose !== undefined || value.milestoneId !== undefined || value.beforeAt !== undefined || value.cursor !== undefined) return null;
    return Object.freeze(value as FomoTokenLookupRequest);
  } catch { return null; }
}

const parseCursor = (text: string): LookupCursor => {
  try {
    const value = JSON.parse(text) as Partial<LookupCursor>;
    if (value.version === 1 && validInteger(value.lineNumber) && validInteger(value.attempts)) return value as LookupCursor;
  } catch { /* Replay from the beginning. */ }
  return { version: 1, lineNumber: 0, attempts: 0 };
};

const parseClaim = (text: string): LookupClaim | null => {
  try {
    const value = JSON.parse(text) as Partial<LookupClaim>;
    return value.version === 1 && typeof value.ownerId === "string" && validInteger(value.expiresAt) && value.lease !== undefined ? value as LookupClaim : null;
  } catch { return null; }
};

const cursorValue = (cursor: LookupCursor): string => `${JSON.stringify(cursor)}\n`;

export class FomoTokenLookupProducer {
  readonly #filePath: string;
  readonly #bucketMs: number;
  readonly #lockOptions: FileLockOptions;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string; readonly bucketMs?: number; readonly lockTimeoutMs?: number; readonly staleLockMs?: number }) {
    this.#filePath = options.filePath;
    this.#bucketMs = options.bucketMs ?? 5 * 60_000;
    this.#lockOptions = { ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}), ...(options.staleLockMs !== undefined ? { staleMs: options.staleLockMs } : {}) };
    if (!Number.isSafeInteger(this.#bucketMs) || this.#bucketMs < 1) throw new Error("bucketMs must be positive");
  }

  enqueue(input: { readonly chainId: string; readonly tokenAddress: string; readonly requestedAt: number; readonly purpose?: "milestone_backfill"; readonly milestoneId?: string; readonly beforeAt?: number; readonly cursor?: string }) {
    const operation = this.#writeTail.then(() => withExclusiveFileLock(`${this.#filePath}.lock`, async () => {
      if (!validInteger(input.requestedAt)) throw new Error("requestedAt must be a non-negative integer");
      validMilestone(input);
      const token = normalizedToken(input.chainId, input.tokenAddress);
      const cursor = input.cursor?.trim();
      const milestoneId = input.milestoneId?.trim();
      const bucket = Math.floor(input.requestedAt / this.#bucketMs);
      const lookupId = input.purpose === "milestone_backfill" ? `milestone:${milestoneId!}${cursor ? `:${cursor}` : ""}` : `${token.chainId}:${token.tokenAddress}:${bucket}`;
      const request: FomoTokenLookupRequest = Object.freeze({
        version: input.purpose ? 2 : 1,
        lookupId,
        ...token,
        requestedAt: input.requestedAt,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(milestoneId ? { milestoneId } : {}),
        ...(input.beforeAt !== undefined ? { beforeAt: input.beforeAt } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const known = new Set((await readText(this.#filePath)).split("\n").flatMap((line) => {
        const parsed = line.trim() ? parseRequest(line) : null;
        return parsed ? [parsed.lookupId] : [];
      }));
      if (known.has(lookupId)) return Object.freeze({ enqueued: false, request });
      await durableAppend(this.#filePath, `${JSON.stringify(request)}\n`);
      return Object.freeze({ enqueued: true, request });
    }, this.#lockOptions));
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export class FomoTokenLookupConsumer {
  readonly #filePath: string;
  readonly #cursorPath: string;
  readonly #claimPath: string;
  readonly #ownerId = randomUUID();
  readonly #maxAttempts: number;
  readonly #claimTtlMs: number;
  readonly #now: () => number;
  readonly #lockOptions: FileLockOptions;

  constructor(options: { readonly filePath: string; readonly cursorPath: string; readonly maxAttempts?: number; readonly claimTtlMs?: number; readonly now?: () => number; readonly lockTimeoutMs?: number; readonly staleLockMs?: number }) {
    this.#filePath = options.filePath;
    this.#cursorPath = options.cursorPath;
    this.#claimPath = `${options.cursorPath}.claim`;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#claimTtlMs = options.claimTtlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#lockOptions = { ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}), ...(options.staleLockMs !== undefined ? { staleMs: options.staleLockMs } : {}) };
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || !Number.isSafeInteger(this.#claimTtlMs) || this.#claimTtlMs < 1) throw new Error("Invalid lookup consumer options");
  }

  next(): Promise<FomoTokenLookupLease | null> {
    return this.#locked(async () => {
      const existingClaim = parseClaim(await readText(this.#claimPath));
      if (existingClaim && existingClaim.expiresAt > this.#now()) return existingClaim.ownerId === this.#ownerId ? existingClaim.lease : null;
      if (existingClaim) await durableRemove(this.#claimPath);
      const cursor = parseCursor(await readText(this.#cursorPath));
      const lines = (await readText(this.#filePath)).split("\n");
      while (cursor.lineNumber < lines.length) {
        const line = lines[cursor.lineNumber];
        if (!line?.trim()) return null;
        const request = parseRequest(line);
        if (request) {
          const lease = Object.freeze({ lineNumber: cursor.lineNumber, request });
          const claim: LookupClaim = { version: 1, ownerId: this.#ownerId, expiresAt: this.#now() + this.#claimTtlMs, lease };
          await atomicWrite(this.#claimPath, `${JSON.stringify(claim)}\n`);
          return lease;
        }
        cursor.lineNumber += 1;
        cursor.attempts = 0;
        await atomicWrite(this.#cursorPath, cursorValue(cursor));
      }
      return null;
    });
  }

  complete(lease: FomoTokenLookupLease): Promise<void> {
    return this.#locked(async () => {
      const claim = parseClaim(await readText(this.#claimPath));
      const cursor = parseCursor(await readText(this.#cursorPath));
      if (!this.#owns(claim, lease) || cursor.lineNumber !== lease.lineNumber) return;
      cursor.lineNumber += 1;
      cursor.attempts = 0;
      await atomicWrite(this.#cursorPath, cursorValue(cursor));
      await durableRemove(this.#claimPath);
    });
  }

  fail(lease: FomoTokenLookupLease): Promise<{ readonly discarded: boolean; readonly attempts: number }> {
    return this.#locked(async () => {
      const claim = parseClaim(await readText(this.#claimPath));
      const cursor = parseCursor(await readText(this.#cursorPath));
      if (!this.#owns(claim, lease) || cursor.lineNumber !== lease.lineNumber) return Object.freeze({ discarded: false, attempts: cursor.attempts });
      cursor.attempts += 1;
      const result = { discarded: cursor.attempts >= this.#maxAttempts, attempts: cursor.attempts };
      if (result.discarded) { cursor.lineNumber += 1; cursor.attempts = 0; }
      await atomicWrite(this.#cursorPath, cursorValue(cursor));
      await durableRemove(this.#claimPath);
      return Object.freeze(result);
    });
  }

  #owns(claim: LookupClaim | null, lease: FomoTokenLookupLease): boolean {
    return claim?.ownerId === this.#ownerId && claim.lease.lineNumber === lease.lineNumber && claim.lease.request.lookupId === lease.request.lookupId;
  }

  #locked<T>(operation: () => Promise<T>): Promise<T> {
    return withExclusiveFileLock(`${this.#cursorPath}.lock`, operation, this.#lockOptions);
  }
}
