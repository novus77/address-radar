import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  FomoTokenLookupConsumer,
  FomoTokenLookupProducer,
  FomoTokenLookupResultConsumer,
  FomoTokenLookupResultProducer,
} from "@address-radar/collectors";
import { atomicWrite, fileLockCoordinationPath, FileLockTimeoutError, withExclusiveFileLock } from "../src/fomo/durable-file.js";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("durable file coordination", () => {
  it("never overlaps two lock instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const operation = async (wait: boolean) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (wait) {
        enteredFirst();
        await firstRelease;
      }
      active -= 1;
    };

    const first = withExclusiveFileLock(lockPath, () => operation(true), { timeoutMs: 500, retryDelayMs: 2 });
    await firstEntered;
    const second = withExclusiveFileLock(lockPath, () => operation(false), { timeoutMs: 500, retryDelayMs: 2 });
    await delay(20);
    expect(maximumActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });

  it("releases normally after an operation longer than its acquisition timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");

    await expect(withExclusiveFileLock(lockPath, async () => {
      await delay(40);
      return 42;
    }, { timeoutMs: 5, staleMs: 1 })).resolves.toBe(42);
    await expect(withExclusiveFileLock(lockPath, async () => 43, { timeoutMs: 50 })).resolves.toBe(43);
  });

  it("maps bounded contention to a typed timeout error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");
    let releaseOwner!: () => void;
    let enteredOwner!: () => void;
    const ownerRelease = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const ownerEntered = new Promise<void>((resolve) => { enteredOwner = resolve; });
    const owner = withExclusiveFileLock(lockPath, async () => {
      enteredOwner();
      await ownerRelease;
    }, { timeoutMs: 500 });
    await ownerEntered;

    const startedAt = Date.now();
    await expect(withExclusiveFileLock(lockPath, async () => undefined, { timeoutMs: 25, retryDelayMs: 2 })).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(250);
    releaseOwner();
    await owner;
  });

  it("rolls back and releases after callback failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");

    await expect(withExclusiveFileLock(lockPath, async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    await expect(withExclusiveFileLock(lockPath, async () => 42)).resolves.toBe(42);
  });

  it("acquires after a prior connection closes without commit or rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");
    const abandoned = new DatabaseSync(fileLockCoordinationPath(lockPath));
    abandoned.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    abandoned.close();

    await expect(withExclusiveFileLock(lockPath, async () => 42)).resolves.toBe(42);
  });

  it("ignores legacy lock and guard artifacts without deleting them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");
    await writeFile(lockPath, "unknown legacy contents");
    await mkdir(lockPath + ".guard");

    await expect(withExclusiveFileLock(lockPath, async () => 42, { timeoutMs: 50 })).resolves.toBe(42);
    expect(await readFile(lockPath, "utf8")).toBe("unknown legacy contents");
    expect(await readdir(lockPath + ".guard")).toEqual([]);
  });

  it("unconditionally releases after the acquisition deadline has expired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
    const lockPath = join(directory, "resource.lock");

    await withExclusiveFileLock(lockPath, async () => { await delay(30); }, { timeoutMs: 5 });
    await expect(withExclusiveFileLock(lockPath, async () => "released", { timeoutMs: 20 })).resolves.toBe("released");
  });

  it("removes its unique temporary file when atomic rename fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atomic-write-"));
    const target = join(directory, "cursor.json");
    await mkdir(target);

    await expect(atomicWrite(target, "value")).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.startsWith("cursor.json.") && name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("Fomo lookup queue", () => {
  it("deduplicates normalized requests across producer restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    const first = new FomoTokenLookupProducer({ filePath, bucketMs: 60_000 });
    expect((await first.enqueue({ chainId: " BSC ", tokenAddress: " 0xAbC ", requestedAt: 60_001 })).enqueued).toBe(true);
    const restarted = new FomoTokenLookupProducer({ filePath, bucketMs: 60_000 });
    expect((await restarted.enqueue({ chainId: "bsc", tokenAddress: "0xabc", requestedAt: 119_999 })).enqueued).toBe(false);
    expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("deduplicates concurrent producers across instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    const input = { chainId: "base", tokenAddress: "0xAbC", requestedAt: 1 };
    const [first, second] = await Promise.all([
      new FomoTokenLookupProducer({ filePath }).enqueue(input),
      new FomoTokenLookupProducer({ filePath }).enqueue(input),
    ]);

    expect([first.enqueued, second.enqueued].sort()).toEqual([false, true]);
    expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("does not let a legacy producer lock artifact block enqueue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    await writeFile(filePath + ".lock", "unknown legacy contents");
    const producer = new FomoTokenLookupProducer({ filePath, lockTimeoutMs: 50 });

    await expect(producer.enqueue({ chainId: "base", tokenAddress: "0x1", requestedAt: 1 })).resolves.toMatchObject({ enqueued: true });
    expect(await readFile(filePath + ".lock", "utf8")).toBe("unknown legacy contents");
  });

  it("persists retry attempts and advances after the bounded retry count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    const cursorPath = join(directory, "cursor.json");
    const producer = new FomoTokenLookupProducer({ filePath });
    await producer.enqueue({ chainId: "base", tokenAddress: "0x1", requestedAt: 1 });
    await producer.enqueue({ chainId: "base", tokenAddress: "0x2", requestedAt: 600_001 });
    const firstConsumer = new FomoTokenLookupConsumer({ filePath, cursorPath, maxAttempts: 2 });
    const firstLease = (await firstConsumer.next())!;
    expect((await firstConsumer.fail(firstLease)).attempts).toBe(1);

    const restarted = new FomoTokenLookupConsumer({ filePath, cursorPath, maxAttempts: 2 });
    const retriedLease = (await restarted.next())!;
    expect(retriedLease.request.lookupId).toBe(firstLease.request.lookupId);
    expect(await restarted.fail(retriedLease)).toEqual({ discarded: true, attempts: 2 });
    expect((await restarted.next())?.request.tokenAddress).toBe("0x2");
  });

  it("claims a queue lease across consumer instances and prevents stale commit regression", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    const cursorPath = join(directory, "cursor.json");
    await new FomoTokenLookupProducer({ filePath }).enqueue({ chainId: "base", tokenAddress: "0x1", requestedAt: 1 });
    let now = 0;
    const first = new FomoTokenLookupConsumer({ filePath, cursorPath, claimTtlMs: 50, now: () => now });
    const second = new FomoTokenLookupConsumer({ filePath, cursorPath, claimTtlMs: 50, now: () => now });
    const firstLease = (await first.next())!;
    expect(await second.next()).toBeNull();

    now = 100;
    const recoveredLease = (await second.next())!;
    expect(recoveredLease.request.lookupId).toBe(firstLease.request.lookupId);
    await second.complete(recoveredLease);
    await first.complete(firstLease);
    expect(await new FomoTokenLookupConsumer({ filePath, cursorPath }).next()).toBeNull();
  });

  it("resets safely when the request queue is replaced by a shorter generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    const cursorPath = join(directory, "cursor.json");
    await new FomoTokenLookupProducer({ filePath }).enqueue({ chainId: "base", tokenAddress: "0x111111111111111111", requestedAt: 1 });
    const first = new FomoTokenLookupConsumer({ filePath, cursorPath });
    const oldLease = (await first.next())!;
    await first.complete(oldLease);

    const replacement = join(directory, "replacement.jsonl");
    await new FomoTokenLookupProducer({ filePath: replacement }).enqueue({ chainId: "base", tokenAddress: "0x2", requestedAt: 2 });
    await rename(replacement, filePath);

    const restarted = new FomoTokenLookupConsumer({ filePath, cursorPath });
    expect((await restarted.next())?.request.tokenAddress).toBe("0x2");
  });

  it("replays from zero when a legacy line-only cursor has no generation evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    const cursorPath = join(directory, "cursor.json");
    const replacement = join(directory, "replacement.jsonl");
    const producer = new FomoTokenLookupProducer({ filePath: replacement });
    await producer.enqueue({ chainId: "base", tokenAddress: "0xfirst", requestedAt: 1 });
    await producer.enqueue({ chainId: "base", tokenAddress: "0xsecond", requestedAt: 600_001 });
    await writeFile(cursorPath, `${JSON.stringify({ version: 1, lineNumber: 1, attempts: 0 })}\n`);
    await rename(replacement, filePath);

    const restarted = new FomoTokenLookupConsumer({ filePath, cursorPath });
    expect((await restarted.next())?.request.tokenAddress).toBe("0xfirst");
  });

  it("preserves milestone pagination fields and rejects contradictory requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const producer = new FomoTokenLookupProducer({ filePath: join(directory, "lookups.jsonl") });
    const result = await producer.enqueue({ chainId: "solana", tokenAddress: " MintCase ", requestedAt: 10, purpose: "milestone_backfill", milestoneId: "m1", beforeAt: 9, cursor: "page-2" });
    expect(result.request).toMatchObject({ lookupId: "milestone:m1:page-2", tokenAddress: "MintCase", beforeAt: 9, cursor: "page-2" });
    await expect(producer.enqueue({ chainId: "solana", tokenAddress: "Mint", requestedAt: 10, purpose: "milestone_backfill" })).rejects.toThrow("milestoneId");
  });
});

describe("Fomo lookup result journal", () => {
  it("leases, acknowledges, and resumes from an atomic persistent cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-results-"));
    const filePath = join(directory, "results.jsonl");
    const cursorPath = join(directory, "cursor.json");
    const producer = new FomoTokenLookupResultProducer({ filePath });
    await producer.append({ version: 2, lookupId: "milestone:m1:page-2", chainId: "solana", tokenAddress: "Mint", completedAt: 20, holderCount: 1, queriedTraderCount: 1, observationCount: 1, eventIds: ["event-1"], purpose: "milestone_backfill", milestoneId: "m1", beforeAt: 10, cursor: "page-2" });
    const first = new FomoTokenLookupResultConsumer({ filePath, cursorPath });
    const lease = (await first.next())!;
    expect(lease.result).toMatchObject({ cursor: "page-2", eventIds: ["event-1"] });
    await first.complete(lease);

    const restarted = new FomoTokenLookupResultConsumer({ filePath, cursorPath });
    expect(await restarted.next()).toBeNull();
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({ version: 1, byteOffset: lease.nextByteOffset });
  });

  it("claims result leases across instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-results-"));
    const filePath = join(directory, "results.jsonl");
    const cursorPath = join(directory, "cursor.json");
    await new FomoTokenLookupResultProducer({ filePath }).append({ version: 1, lookupId: "one", chainId: "base", tokenAddress: "0x1", completedAt: 1, holderCount: 1, queriedTraderCount: 1, observationCount: 0 });
    const first = new FomoTokenLookupResultConsumer({ filePath, cursorPath });
    const second = new FomoTokenLookupResultConsumer({ filePath, cursorPath });
    const lease = await first.next();

    expect(lease).not.toBeNull();
    expect(await second.next()).toBeNull();
    await first.complete(lease!);
    expect(await second.next()).toBeNull();
  });

  it("resets safely when the result journal is replaced by a shorter generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-results-"));
    const filePath = join(directory, "results.jsonl");
    const cursorPath = join(directory, "cursor.json");
    const producer = new FomoTokenLookupResultProducer({ filePath });
    await producer.append({ version: 1, lookupId: "long-old-lookup-id", chainId: "base", tokenAddress: "0x111111", completedAt: 1, holderCount: 1, queriedTraderCount: 1, observationCount: 0 });
    const first = new FomoTokenLookupResultConsumer({ filePath, cursorPath });
    const oldLease = (await first.next())!;
    await first.complete(oldLease);

    const replacement = join(directory, "replacement.jsonl");
    await new FomoTokenLookupResultProducer({ filePath: replacement }).append({ version: 1, lookupId: "new", chainId: "base", tokenAddress: "0x2", completedAt: 2, holderCount: 1, queriedTraderCount: 1, observationCount: 0 });
    await rename(replacement, filePath);

    const restarted = new FomoTokenLookupResultConsumer({ filePath, cursorPath });
    expect((await restarted.next())?.result.lookupId).toBe("new");
  });
});
