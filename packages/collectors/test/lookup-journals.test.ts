import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FomoTokenLookupConsumer,
  FomoTokenLookupProducer,
  FomoTokenLookupResultConsumer,
  FomoTokenLookupResultProducer,
} from "@address-radar/collectors";
import { atomicWrite, withExclusiveFileLock } from "../src/fomo/durable-file.js";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("durable file coordination", () => {
  it("keeps a live long-running owner beyond staleMs and serializes reacquisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-lock-"));
    const lockPath = join(directory, "resource.lock");
    let active = 0;
    let maximumActive = 0;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const operation = async (holdMs: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (holdMs > 0) entered();
      await delay(holdMs);
      active -= 1;
    };

    const first = withExclusiveFileLock(lockPath, () => operation(80), { staleMs: 15, timeoutMs: 300, retryDelayMs: 2 });
    await firstEntered;
    const metadata = JSON.parse(await readFile(lockPath, "utf8"));
    expect(metadata).toMatchObject({ version: 1, pid: process.pid, hostname: hostname() });
    const second = withExclusiveFileLock(lockPath, () => operation(0), { staleMs: 15, timeoutMs: 300, retryDelayMs: 2 });

    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });

  it("does not remove a replacement lock during release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-lock-"));
    const lockPath = join(directory, "resource.lock");
    const displacedPath = join(directory, "displaced.lock");

    await expect(withExclusiveFileLock(lockPath, async () => {
      await rename(lockPath, displacedPath);
      await writeFile(lockPath, `${JSON.stringify({ version: 1, token: "replacement", pid: process.pid, hostname: hostname(), createdAt: Date.now() })}\n`);
      return 42;
    })).resolves.toBe(42);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: "replacement" });
  });

  it("surfaces release failure when the owned lock metadata is corrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-lock-"));
    const lockPath = join(directory, "resource.lock");

    await expect(withExclusiveFileLock(lockPath, async () => {
      await writeFile(lockPath, "corrupted");
      return 42;
    })).rejects.toThrow("Owned lock metadata changed");
    await rm(lockPath, { force: true });
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

  it("recovers a stale producer lock without waiting indefinitely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lookup-queue-"));
    const filePath = join(directory, "lookups.jsonl");
    await writeFile(`${filePath}.lock`, JSON.stringify({ token: "dead" }));
    const blocked = new FomoTokenLookupProducer({ filePath, lockTimeoutMs: 20, staleLockMs: 10_000 });
    await expect(blocked.enqueue({ chainId: "base", tokenAddress: "0x1", requestedAt: 1 })).rejects.toThrow("Timed out acquiring lock");
    await utimes(`${filePath}.lock`, new Date(0), new Date(0));
    const producer = new FomoTokenLookupProducer({ filePath, lockTimeoutMs: 200, staleLockMs: 10 });

    await expect(producer.enqueue({ chainId: "base", tokenAddress: "0x1", requestedAt: 1 })).resolves.toMatchObject({ enqueued: true });
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
