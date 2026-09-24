import { readFile } from "node:fs/promises";

export interface JsonLineReadResult {
  readonly values: readonly unknown[];
  readonly malformedLines: number;
}

export function createJsonLineFileReader(path: string, options: { readonly startAtEnd?: boolean } = {}) {
  let cursor: number | null = null;
  return Object.freeze({
    async read(): Promise<JsonLineReadResult> {
      const buffer = await readFile(path);
      if (cursor === null) cursor = options.startAtEnd === false ? 0 : buffer.length;
      if (buffer.length < cursor) cursor = 0;
      const start = cursor;
      const finalNewline = buffer.lastIndexOf(10);
      if (finalNewline < start) return Object.freeze({ values: Object.freeze([]), malformedLines: 0 });
      const chunk = buffer.subarray(start, finalNewline + 1).toString("utf8");
      cursor = finalNewline + 1;
      const values: unknown[] = [];
      let malformedLines = 0;
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try { values.push(JSON.parse(line)); } catch { malformedLines += 1; }
      }
      return Object.freeze({ values: Object.freeze(values), malformedLines });
    },
    cursor(): number | null { return cursor; },
  });
}
