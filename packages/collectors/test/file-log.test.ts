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
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":1}\n{"id":2');
    const reader = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });

    expect(await reader.read()).toEqual({ values: [{ id: 1 }], malformedLines: 0 });
    await appendFile(path, '}\nnot-json\n');
    const restarted = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    expect(await restarted.read()).toEqual({ values: [{ id: 2 }], malformedLines: 1 });
  });

  it("persists an initial end cursor so restart does not skip events written while stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":"old"}\n');
    const first = createJsonLineFileReader(path, { cursorPath });
    expect(await first.read()).toEqual({ values: [], malformedLines: 0 });

    await appendFile(path, '{"id":"new"}\n');
    const restarted = createJsonLineFileReader(path, { cursorPath });
    expect(await restarted.read()).toEqual({ values: [{ id: "new" }], malformedLines: 0 });
  });

  it("resets a persisted cursor when the journal is truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":1}\n{"id":2}\n');
    const first = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    await first.read();
    await writeFile(path, '{"id":3}\n');

    const restarted = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    expect(await restarted.read()).toEqual({ values: [{ id: 3 }], malformedLines: 0 });
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
      cursor: "page-2",
    }))).toMatchObject({ lookupId: "milestone:m1", purpose: "milestone_backfill", eventIds: ["event-1"] });
    expect(parseFomoLookupResult("{}")) .toBeNull();
    expect(parseFomoLookupResult(JSON.stringify({
      version: 2,
      lookupId: "milestone:bad",
      chainId: "solana",
      tokenAddress: "Mint",
      completedAt: 2_000,
      holderCount: 1,
      queriedTraderCount: 1,
      observationCount: 1,
      purpose: "milestone_backfill",
    }))).toBeNull();
  });
});
