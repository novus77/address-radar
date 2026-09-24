import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

interface LookupCursor {
  version: 1;
  lineNumber: number;
  attempts: number;
}

const readText = async (path: string): Promise<string> => {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

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
    return value as FomoTokenLookupRequest;
  } catch { return null; }
}

export class FomoTokenLookupProducer {
  readonly #filePath: string;
  readonly #bucketMs: number;
  #knownLookupIds: Promise<Set<string>> | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string; readonly bucketMs?: number }) {
    this.#filePath = options.filePath;
    this.#bucketMs = options.bucketMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#bucketMs) || this.#bucketMs < 1) throw new Error("bucketMs must be positive");
  }

  enqueue(input: { readonly chainId: string; readonly tokenAddress: string; readonly requestedAt: number; readonly purpose?: "milestone_backfill"; readonly milestoneId?: string; readonly beforeAt?: number; readonly cursor?: string }) {
    const operation = this.#writeTail.then(async () => {
      if (!validInteger(input.requestedAt)) throw new Error("requestedAt must be a non-negative integer");
      validMilestone(input);
      const token = normalizedToken(input.chainId, input.tokenAddress);
      const cursor = input.cursor?.trim();
      const milestoneId = input.milestoneId?.trim();
      const bucket = Math.floor(input.requestedAt / this.#bucketMs);
      const lookupId = input.purpose === "milestone_backfill" ? `milestone:${milestoneId!}${cursor ? `:${cursor}` : ""}` : `${token.chainId}:${token.tokenAddress}:${bucket}`;
      const request: FomoTokenLookupRequest = {
        version: input.purpose ? 2 : 1,
        lookupId,
        ...token,
        requestedAt: input.requestedAt,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(milestoneId ? { milestoneId } : {}),
        ...(input.beforeAt !== undefined ? { beforeAt: input.beforeAt } : {}),
        ...(cursor ? { cursor } : {}),
      };
      const known = await this.#loadKnownLookupIds();
      if (known.has(lookupId)) return Object.freeze({ enqueued: false, request });
      await mkdir(dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, `${JSON.stringify(request)}\n`, "utf8");
      known.add(lookupId);
      return Object.freeze({ enqueued: true, request });
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #loadKnownLookupIds(): Promise<Set<string>> {
    this.#knownLookupIds ??= readText(this.#filePath).then((text) => {
      const ids = new Set<string>();
      for (const line of text.split("\n")) {
        const request = line.trim() ? parseRequest(line) : null;
        if (request) ids.add(request.lookupId);
      }
      return ids;
    });
    return this.#knownLookupIds;
  }
}

export class FomoTokenLookupConsumer {
  readonly #filePath: string;
  readonly #cursorPath: string;
  readonly #maxAttempts: number;
  #cursor: Promise<LookupCursor> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { readonly filePath: string; readonly cursorPath: string; readonly maxAttempts?: number }) {
    this.#filePath = options.filePath;
    this.#cursorPath = options.cursorPath;
    this.#maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) throw new Error("maxAttempts must be positive");
  }

  async next(): Promise<FomoTokenLookupLease | null> {
    const cursor = await this.#loadCursor();
    const lines = (await readText(this.#filePath)).split("\n");
    while (cursor.lineNumber < lines.length) {
      const line = lines[cursor.lineNumber];
      if (!line?.trim()) return null;
      const request = parseRequest(line);
      if (request) return Object.freeze({ lineNumber: cursor.lineNumber, request });
      cursor.lineNumber += 1;
      cursor.attempts = 0;
      await this.#persistCursor(cursor);
    }
    return null;
  }

  complete(lease: FomoTokenLookupLease): Promise<void> {
    return this.#mutateCursor(lease, (cursor) => { cursor.lineNumber += 1; cursor.attempts = 0; });
  }

  async fail(lease: FomoTokenLookupLease): Promise<{ readonly discarded: boolean; readonly attempts: number }> {
    let result = { discarded: false, attempts: 0 };
    await this.#mutateCursor(lease, (cursor) => {
      cursor.attempts += 1;
      result = { discarded: cursor.attempts >= this.#maxAttempts, attempts: cursor.attempts };
      if (result.discarded) { cursor.lineNumber += 1; cursor.attempts = 0; }
    });
    return Object.freeze(result);
  }

  #mutateCursor(lease: FomoTokenLookupLease, mutation: (cursor: LookupCursor) => void): Promise<void> {
    const operation = this.#mutationTail.then(async () => {
      const cursor = await this.#loadCursor();
      if (cursor.lineNumber !== lease.lineNumber) return;
      mutation(cursor);
      await this.#persistCursor(cursor);
    });
    this.#mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #loadCursor(): Promise<LookupCursor> {
    this.#cursor ??= readText(this.#cursorPath).then((text) => {
      try {
        const value = JSON.parse(text) as Partial<LookupCursor>;
        if (value.version === 1 && validInteger(value.lineNumber) && validInteger(value.attempts)) return value as LookupCursor;
      } catch { /* Replay from the start when the cursor is absent or damaged. */ }
      return { version: 1, lineNumber: 0, attempts: 0 };
    });
    return this.#cursor;
  }

  async #persistCursor(cursor: LookupCursor): Promise<void> {
    await mkdir(dirname(this.#cursorPath), { recursive: true });
    const temporaryPath = `${this.#cursorPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(cursor)}\n`, "utf8");
    await rename(temporaryPath, this.#cursorPath);
  }
}
