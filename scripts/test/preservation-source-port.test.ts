import { describe, expect, it } from "vitest";
import { readFullDataPreservationSourceFile, withFullDataPreservationSourceReader } from "../../packages/database/src/postgres-full-data-import.js";

describe("explicit preservation source I/O scope, not verification authority", () => {
  it("retains directory, filename and byte-budget arguments", async () => {
    const calls: unknown[] = [];
    const result = await withFullDataPreservationSourceReader({ read: async (...args) => {
      calls.push(args); return Buffer.from("opaque");
    } }, () => readFullDataPreservationSourceFile("/private/immutable", "manifest.json", 4096));
    expect(result).toEqual(Buffer.from("opaque"));
    expect(calls).toEqual([["/private/immutable", "manifest.json", 4096]]);
  });

  it("does not leak an injected reader after a rejected operation", async () => {
    await expect(withFullDataPreservationSourceReader({ read: async () => {
      throw new Error("source_reader_pressure");
    } }, () => readFullDataPreservationSourceFile("/private/immutable", "manifest.json", 4096))).rejects.toThrow("source_reader_pressure");
    await expect(readFullDataPreservationSourceFile("/private/absent-preservation-test", "manifest.json", 4096)).rejects.toThrow();
  });

  it("keeps independent asynchronous fixture readers isolated", async () => {
    const run = (name: string) => withFullDataPreservationSourceReader({ read: async () => {
      await new Promise(resolve => setTimeout(resolve, 1)); return Buffer.from(name);
    } }, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return readFullDataPreservationSourceFile("/private/immutable", "manifest.json", 4096);
    });
    expect(await Promise.all([run("one"), run("two")])).toEqual([Buffer.from("one"), Buffer.from("two")]);
  });
});
