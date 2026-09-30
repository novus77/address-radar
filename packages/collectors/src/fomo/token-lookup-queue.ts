import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

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
  readonly lookupRevision?: number;
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
  readonly verificationStatus?: "confirmed" | "not_found" | "mismatch" | "deferred";
  readonly exactAddressMatch?: boolean;
  readonly historyAvailable?: boolean;
  readonly providerTokenId?: string;
  readonly providerUrl?: string;
  readonly errorCode?: string;
  readonly eventIds?: readonly string[];
  readonly purpose?: "milestone_backfill";
  readonly milestoneId?: string;
  readonly beforeAt?: number;
  readonly cursor?: string;
}

interface LookupCursor {
  readonly version: 1;
  lineNumber: number;
  attempts: number;
  byteOffset?: number;
  generation?: string;
  prefixHash?: string;
}

interface LookupClaim {
  readonly version: 1;
  readonly ownerId: string;
  readonly expiresAt: number;
  readonly generation: string;
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly leaseId: string;
  readonly lease: FomoTokenLookupLease;
}

interface QueueSnapshot { readonly buffer: Buffer; readonly generation: string }

const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("base64url");
const generationOf = (value: { readonly dev: number | bigint; readonly ino: number | bigint }): string => `${value.dev}:${value.ino}`;
const leaseHash = (generation: string, byteOffset: number, nextByteOffset: number, bytes: Uint8Array): string => createHash("sha256").update(`${generation}:${byteOffset}:${nextByteOffset}:`).update(bytes).digest("base64url");

function normalizedToken(chainId: string, tokenAddress: string) {
  const chain = chainId.trim().toLowerCase();
  const address = tokenAddress.trim();
  if (!chain || !address) throw new Error("Fomo token lookup requires chainId and tokenAddress");
  return { chainId: chain, tokenAddress: chain === "solana" ? address : address.toLowerCase() };
}

function validMilestone(input: { readonly purpose?: unknown; readonly milestoneId?: unknown; readonly beforeAt?: unknown; readonly cursor?: unknown; readonly lookupRevision?: unknown }): void {
  if (input.purpose === "milestone_backfill") {
    if (typeof input.milestoneId !== "string" || !input.milestoneId.trim()) throw new Error("milestoneId is required for milestone_backfill");
    if (!validInteger(input.beforeAt)) throw new Error("beforeAt is required for milestone_backfill");
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor.trim())) throw new Error("cursor must not be empty");
    if (input.lookupRevision !== undefined && !validInteger(input.lookupRevision)) throw new Error("lookupRevision must be a non-negative integer");
    return;
  }
  if (input.purpose !== undefined || input.milestoneId !== undefined || input.beforeAt !== undefined || input.cursor !== undefined || input.lookupRevision !== undefined) throw new Error("Milestone fields require purpose milestone_backfill");
}

function parseRequest(line: string): FomoTokenLookupRequest | null {
  try {
    const value = JSON.parse(line) as Partial<FomoTokenLookupRequest>;
    if ((value.version !== 1 && value.version !== 2) || typeof value.lookupId !== "string" || !value.lookupId || typeof value.chainId !== "string" || typeof value.tokenAddress !== "string" || !validInteger(value.requestedAt)) return null;
    if (value.version === 2) {
      validMilestone(value);
      if (value.purpose !== "milestone_backfill") return null;
    } else if (value.purpose !== undefined || value.milestoneId !== undefined || value.beforeAt !== undefined || value.cursor !== undefined || value.lookupRevision !== undefined) return null;
    return Object.freeze(value as FomoTokenLookupRequest);
  } catch { return null; }
}

const parseCursor = (text: string): LookupCursor | null => {
  try {
    const value = JSON.parse(text) as Partial<LookupCursor>;
    if (value.version === 1 && validInteger(value.lineNumber) && validInteger(value.attempts) && (value.byteOffset === undefined || validInteger(value.byteOffset))) return value as LookupCursor;
  } catch { /* Replay from the beginning. */ }
  return null;
};

const parseClaim = (text: string): LookupClaim | null => {
  try {
    const value = JSON.parse(text) as Partial<LookupClaim>;
    return value.version === 1 && typeof value.ownerId === "string" && validInteger(value.expiresAt) && typeof value.generation === "string" && validInteger(value.byteOffset) && validInteger(value.nextByteOffset) && typeof value.leaseId === "string" && value.lease !== undefined ? value as LookupClaim : null;
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

  enqueue(input: { readonly chainId: string; readonly tokenAddress: string; readonly requestedAt: number; readonly purpose?: "milestone_backfill"; readonly milestoneId?: string; readonly beforeAt?: number; readonly cursor?: string; readonly lookupRevision?: number }) {
    const operation = this.#writeTail.then(() => withExclusiveFileLock(`${this.#filePath}.lock`, async () => {
      if (!validInteger(input.requestedAt)) throw new Error("requestedAt must be a non-negative integer");
      validMilestone(input);
      const token = normalizedToken(input.chainId, input.tokenAddress);
      const cursor = input.cursor?.trim();
      const milestoneId = input.milestoneId?.trim();
      const bucket = Math.floor(input.requestedAt / this.#bucketMs);
      const revision = input.lookupRevision !== undefined ? `:before:${input.beforeAt}:revision:${input.lookupRevision}` : "";
      const lookupId = input.purpose === "milestone_backfill" ? `milestone:${milestoneId!}${revision}${cursor ? `:${cursor}` : ""}` : `${token.chainId}:${token.tokenAddress}:${bucket}`;
      const request: FomoTokenLookupRequest = Object.freeze({
        version: input.purpose ? 2 : 1,
        lookupId,
        ...token,
        requestedAt: input.requestedAt,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(milestoneId ? { milestoneId } : {}),
        ...(input.beforeAt !== undefined ? { beforeAt: input.beforeAt } : {}),
        ...(cursor ? { cursor } : {}),
        ...(input.lookupRevision !== undefined ? { lookupRevision: input.lookupRevision } : {}),
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
      const claimText = await readText(this.#claimPath);
      const existingClaim = parseClaim(claimText);
      if (existingClaim && existingClaim.expiresAt > this.#now()) return existingClaim.ownerId === this.#ownerId ? existingClaim.lease : null;
      if (claimText) await durableRemove(this.#claimPath);
      let snapshot: QueueSnapshot;
      try { snapshot = await this.#snapshot(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let cursor = await this.#resolvedCursor(snapshot);
      while (cursor.byteOffset! < snapshot.buffer.length) {
        const newlineIndex = snapshot.buffer.indexOf(0x0a, cursor.byteOffset!);
        if (newlineIndex < 0) return null;
        const nextByteOffset = newlineIndex + 1;
        const bytes = snapshot.buffer.subarray(cursor.byteOffset!, nextByteOffset);
        const request = parseRequest(bytes.subarray(0, bytes.length - 1).toString("utf8"));
        if (request) {
          const lease = Object.freeze({ lineNumber: cursor.lineNumber, request });
          const claim: LookupClaim = {
            version: 1,
            ownerId: this.#ownerId,
            expiresAt: this.#now() + this.#claimTtlMs,
            generation: snapshot.generation,
            byteOffset: cursor.byteOffset!,
            nextByteOffset,
            leaseId: leaseHash(snapshot.generation, cursor.byteOffset!, nextByteOffset, bytes),
            lease,
          };
          await atomicWrite(this.#claimPath, `${JSON.stringify(claim)}\n`);
          return lease;
        }
        cursor = { version: 1, lineNumber: cursor.lineNumber + 1, attempts: 0, byteOffset: nextByteOffset, generation: snapshot.generation, prefixHash: hash(snapshot.buffer.subarray(0, nextByteOffset)) };
        await this.#persistCursor(cursor);
      }
      return null;
    });
  }

  complete(lease: FomoTokenLookupLease): Promise<void> {
    return this.#locked(async () => {
      const claim = parseClaim(await readText(this.#claimPath));
      if (!this.#owns(claim, lease)) return;
      const state = await this.#verifiedClaimState(claim!);
      if (!state) {
        await durableRemove(this.#claimPath);
        return;
      }
      await this.#persistCursor({ version: 1, lineNumber: lease.lineNumber + 1, attempts: 0, byteOffset: claim!.nextByteOffset, generation: state.snapshot.generation, prefixHash: hash(state.snapshot.buffer.subarray(0, claim!.nextByteOffset)) });
      await durableRemove(this.#claimPath);
    });
  }

  fail(lease: FomoTokenLookupLease): Promise<{ readonly discarded: boolean; readonly attempts: number }> {
    return this.#locked(async () => {
      const claim = parseClaim(await readText(this.#claimPath));
      if (!this.#owns(claim, lease)) {
        const cursor = parseCursor(await readText(this.#cursorPath));
        return Object.freeze({ discarded: false, attempts: cursor?.attempts ?? 0 });
      }
      const state = await this.#verifiedClaimState(claim!);
      if (!state) {
        await durableRemove(this.#claimPath);
        return Object.freeze({ discarded: false, attempts: 0 });
      }
      const attempts = state.cursor.attempts + 1;
      const discarded = attempts >= this.#maxAttempts;
      const byteOffset = discarded ? claim!.nextByteOffset : claim!.byteOffset;
      await this.#persistCursor({
        version: 1,
        lineNumber: discarded ? lease.lineNumber + 1 : lease.lineNumber,
        attempts: discarded ? 0 : attempts,
        byteOffset,
        generation: state.snapshot.generation,
        prefixHash: hash(state.snapshot.buffer.subarray(0, byteOffset)),
      });
      await durableRemove(this.#claimPath);
      return Object.freeze({ discarded, attempts });
    });
  }

  #owns(claim: LookupClaim | null, lease: FomoTokenLookupLease): boolean {
    return claim?.ownerId === this.#ownerId && claim.lease.lineNumber === lease.lineNumber && claim.lease.request.lookupId === lease.request.lookupId;
  }

  async #snapshot(): Promise<QueueSnapshot> {
    const [metadata, buffer] = await Promise.all([stat(this.#filePath), readFile(this.#filePath)]);
    return { buffer, generation: generationOf(metadata) };
  }

  async #resolvedCursor(snapshot: QueueSnapshot): Promise<LookupCursor> {
    const persisted = parseCursor(await readText(this.#cursorPath));
    if (!persisted) return { version: 1, lineNumber: 0, attempts: 0, byteOffset: 0, generation: snapshot.generation, prefixHash: hash(new Uint8Array()) };
    if (persisted.byteOffset === undefined || persisted.generation === undefined || persisted.prefixHash === undefined) {
      const reset: LookupCursor = { version: 1, lineNumber: 0, attempts: 0, byteOffset: 0, generation: snapshot.generation, prefixHash: hash(new Uint8Array()) };
      await this.#persistCursor(reset);
      return reset;
    }
    const validBoundary = persisted.byteOffset === 0 || persisted.byteOffset <= snapshot.buffer.length && snapshot.buffer[persisted.byteOffset - 1] === 0x0a;
    const validPrefix = persisted.prefixHash === hash(snapshot.buffer.subarray(0, persisted.byteOffset));
    if (persisted.generation !== snapshot.generation || !validBoundary || !validPrefix) {
      const reset: LookupCursor = { version: 1, lineNumber: 0, attempts: 0, byteOffset: 0, generation: snapshot.generation, prefixHash: hash(new Uint8Array()) };
      await this.#persistCursor(reset);
      return reset;
    }
    return persisted;
  }

  async #verifiedClaimState(claim: LookupClaim): Promise<{ readonly snapshot: QueueSnapshot; readonly cursor: LookupCursor } | null> {
    let snapshot: QueueSnapshot;
    try { snapshot = await this.#snapshot(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const cursor = await this.#resolvedCursor(snapshot);
    const bytes = snapshot.buffer.subarray(claim.byteOffset, claim.nextByteOffset);
    if (snapshot.generation !== claim.generation || cursor.lineNumber !== claim.lease.lineNumber || cursor.byteOffset !== claim.byteOffset || claim.nextByteOffset > snapshot.buffer.length || snapshot.buffer[claim.nextByteOffset - 1] !== 0x0a || leaseHash(claim.generation, claim.byteOffset, claim.nextByteOffset, bytes) !== claim.leaseId) return null;
    return { snapshot, cursor };
  }

  #persistCursor(cursor: LookupCursor): Promise<void> {
    return atomicWrite(this.#cursorPath, cursorValue(cursor));
  }

  #locked<T>(operation: () => Promise<T>): Promise<T> {
    return withExclusiveFileLock(`${this.#cursorPath}.lock`, operation, this.#lockOptions);
  }
}
