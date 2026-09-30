import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FomoTokenLookupProducer } from "../src/fomo/token-lookup-queue.js";

describe("milestone lookup revision", () => {
  it("deduplicates the same revision but permits a bounded retry identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "milestone-revision-"));
    try {
      const filePath = join(directory, "requests.ndjson");
      const producer = new FomoTokenLookupProducer({ filePath });
      const request = { chainId: "base", tokenAddress: "0xabc", requestedAt: 1_000, purpose: "milestone_backfill", milestoneId: "m", beforeAt: 900 } as const;
      const original = await producer.enqueue({ ...request, lookupRevision: 0 });
      expect((await producer.enqueue({ ...request, lookupRevision: 0 })).enqueued).toBe(false);
      const retry = await producer.enqueue({ ...request, lookupRevision: 1 });
      expect(retry.enqueued).toBe(true);
      expect(retry.request.lookupId).not.toBe(original.request.lookupId);
      expect((await readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(2);
      expect(retry.request.cursor).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
