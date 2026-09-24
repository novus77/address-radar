import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createJsonLineFileReader,
  parseFomoLookupResult,
} from "@address-radar/collectors";

describe("file-log ingestion", () => {
  it("reads only complete lines and resumes from a byte cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    await writeFile(path, '{"id":1}\n{"id":2');
    const reader = createJsonLineFileReader(path, { startAtEnd: false });

    expect(await reader.read()).toEqual({ values: [{ id: 1 }], malformedLines: 0 });
    await appendFile(path, '}\nnot-json\n');
    expect(await reader.read()).toEqual({ values: [{ id: 2 }], malformedLines: 1 });
  });

  it("parses milestone lookup results without losing replay metadata", () => {
    expect(parseFomoLookupResult(JSON.stringify({
      version: 2,
      lookupId: "milestone:m1",
      chainId: "solana",
      tokenAddress: "MintCase",
      completedAt: 2_000,
      holderCount: 3,
      queriedTraderCount: 2,
      observationCount: 1,
      eventIds: ["event-1"],
      purpose: "milestone_backfill",
      milestoneId: "m1",
      beforeAt: 1_000,
    }))).toMatchObject({ lookupId: "milestone:m1", purpose: "milestone_backfill", eventIds: ["event-1"] });
    expect(parseFomoLookupResult("{}")) .toBeNull();
  });
});
