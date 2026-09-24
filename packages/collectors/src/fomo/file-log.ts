import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonLineReadResult {
  readonly values: readonly unknown[];
  readonly malformedLines: number;
}

interface FileCursor {
  readonly version: 1;
  readonly byteOffset: number;
}

const readText = async (path: string): Promise<string> => {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

async function persistCursor(path: string, byteOffset: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, byteOffset })}\n`, "utf8");
  await rename(temporaryPath, path);
}

export function createJsonLineFileReader(path: string, options: { readonly cursorPath: string; readonly startAtEnd?: boolean }) {
  let cursor: Promise<number> | undefined;
  const loadCursor = (initialSize: number): Promise<number> => {
    cursor ??= readText(options.cursorPath).then(async (text) => {
      try {
        const value = JSON.parse(text) as Partial<FileCursor>;
        if (value.version === 1 && Number.isSafeInteger(value.byteOffset) && value.byteOffset! >= 0) return value.byteOffset!;
      } catch {
        // A missing or damaged cursor starts from the configured initial position.
      }
      const initial = options.startAtEnd === false ? 0 : initialSize;
      await persistCursor(options.cursorPath, initial);
      return initial;
    });
    return cursor;
  };

  return Object.freeze({
    async read(): Promise<JsonLineReadResult> {
      const buffer = await readFile(path);
      let start = await loadCursor(buffer.length);
      if (buffer.length < start) {
        start = 0;
        await persistCursor(options.cursorPath, start);
        cursor = Promise.resolve(start);
      }
      const finalNewline = buffer.lastIndexOf(10);
      if (finalNewline < start) return Object.freeze({ values: Object.freeze([]), malformedLines: 0 });
      const next = finalNewline + 1;
      const chunk = buffer.subarray(start, next).toString("utf8");
      const values: unknown[] = [];
      let malformedLines = 0;
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try { values.push(JSON.parse(line)); } catch { malformedLines += 1; }
      }
      await persistCursor(options.cursorPath, next);
      cursor = Promise.resolve(next);
      return Object.freeze({ values: Object.freeze(values), malformedLines });
    },
    async cursor(): Promise<number> { return loadCursor(0); },
  });
}
