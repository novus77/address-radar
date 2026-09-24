import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FomoTokenLookupConsumer,
  FomoTokenLookupProducer,
  FomoTokenLookupResultConsumer,
  FomoTokenLookupResultProducer,
} from "@address-radar/collectors";

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
});
