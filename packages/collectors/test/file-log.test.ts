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

    const first = await reader.read();
    expect(first).toMatchObject({ values: [{ id: 1 }], malformedLines: 0, byteOffset: 0 });
    expect(await reader.ack(first!)).toBe(true);
    await appendFile(path, '}\nnot-json\n');
    const restarted = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    expect(await restarted.read()).toMatchObject({ values: [{ id: 2 }], malformedLines: 1 });
  });

  it("persists an initial end cursor so restart does not skip events written while stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":"old"}\n');
    const first = createJsonLineFileReader(path, { cursorPath });
    expect(await first.read()).toBeNull();

    await appendFile(path, '{"id":"new"}\n');
    const restarted = createJsonLineFileReader(path, { cursorPath });
    expect(await restarted.read()).toMatchObject({ values: [{ id: "new" }], malformedLines: 0 });
  });

  it("resets a persisted cursor when the journal is truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":1}\n{"id":2}\n');
    const first = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    const initial = await first.read();
    await first.ack(initial!);
    await writeFile(path, '{"id":3}\n');

    const restarted = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    expect(await restarted.read()).toMatchObject({ values: [{ id: 3 }], malformedLines: 0 });
  });

  it("replays an unacknowledged batch after downstream failure and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":1}\n{"id":2}\n');
    const first = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    const failedBatch = await first.read();
    expect(failedBatch?.values).toEqual([{ id: 1 }, { id: 2 }]);

    const restarted = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    const replayed = await restarted.read();
    expect(replayed).toEqual(failedBatch);
    expect(await restarted.ack(replayed!)).toBe(true);
    expect(await createJsonLineFileReader(path, { cursorPath, startAtEnd: false }).read()).toBeNull();
  });

  it("rejects stale and out-of-order acknowledgements without corrupting the cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "collector-log-"));
    const path = join(directory, "events.jsonl");
    const cursorPath = join(directory, "events.cursor.json");
    await writeFile(path, '{"id":1}\n');
    const reader = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    const first = (await reader.read())!;
    expect(await reader.ack(first)).toBe(true);
    await appendFile(path, '{"id":2}\n');
    const second = (await reader.read())!;

    expect(await reader.ack(first)).toBe(false);
    expect(await reader.ack({ ...second, byteOffset: second.nextByteOffset, nextByteOffset: second.nextByteOffset + 100 })).toBe(false);
    const restarted = createJsonLineFileReader(path, { cursorPath, startAtEnd: false });
    expect((await restarted.read())?.values).toEqual([{ id: 2 }]);
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
