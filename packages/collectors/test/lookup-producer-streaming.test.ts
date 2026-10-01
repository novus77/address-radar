import { mkdtemp,readFile,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe,expect,it } from "vitest";
import { FomoTokenLookupProducer } from "@address-radar/collectors";
import { fileLockCoordinationPath,FileLockTimeoutError } from "../src/fomo/durable-file.js";

describe("streaming lookup deduplication", () => {
  it("handles split UTF-8 and long lines without changing deduplication", async () => {
    const directory=await mkdtemp(join(tmpdir(),"lookup-stream-"));
    const filePath=join(directory,"lookups.ndjson");
    const row={ version:1,lookupId:"base:0xabc:0",chainId:"base",tokenAddress:"0xabc",requestedAt:1,padding:"界".repeat(30000) };
    const original=JSON.stringify(row)+"\n";
    await writeFile(filePath,original);
    const producer=new FomoTokenLookupProducer({ filePath });
    expect((await producer.enqueue({ chainId:"base",tokenAddress:"0xABC",requestedAt:1 })).enqueued).toBe(false);
    expect(await readFile(filePath,"utf8")).toBe(original);
    expect((await producer.enqueue({ chainId:"solana",tokenAddress:"Mint",requestedAt:1 })).enqueued).toBe(true);
  });
  it("does not lose a request after a genuine coordination lock timeout", async () => {
    const directory=await mkdtemp(join(tmpdir(),"lookup-timeout-"));
    const filePath=join(directory,"lookups.ndjson");
    const owner=new DatabaseSync(fileLockCoordinationPath(filePath+".lock"));
    owner.exec("BEGIN IMMEDIATE");
    const producer=new FomoTokenLookupProducer({ filePath,lockTimeoutMs:20 });
    const request={ chainId:"base",tokenAddress:"0xabc",requestedAt:1 };
    try { await expect(producer.enqueue(request)).rejects.toBeInstanceOf(FileLockTimeoutError); }
    finally { owner.close(); }
    expect((await producer.enqueue(request)).enqueued).toBe(true);
    expect((await producer.enqueue(request)).enqueued).toBe(false);
    expect((await readFile(filePath,"utf8")).trim().split("\n")).toHaveLength(1);
  });
});
