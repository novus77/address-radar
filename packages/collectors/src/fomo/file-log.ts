import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonLineBatch {
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly leaseId: string;
  readonly values: readonly unknown[];
  readonly malformedLines: number;
  readonly records: readonly JsonLineRecord[];
}

export interface JsonLineRecord {
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly hash: string;
  readonly raw?: string;
  readonly error?: string;
  readonly value?: unknown;
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

const parsedCursor = (text: string): number | null => {
  try {
    const value = JSON.parse(text) as Partial<FileCursor>;
    return value.version === 1 && Number.isSafeInteger(value.byteOffset) && value.byteOffset! >= 0 ? value.byteOffset! : null;
  } catch { return null; }
};

async function persistCursor(path: string, byteOffset: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, byteOffset })}\n`, "utf8");
  await rename(temporaryPath, path);
}

const leaseId = (byteOffset: number, nextByteOffset: number, bytes: Buffer): string => createHash("sha256")
  .update(`${byteOffset}:${nextByteOffset}:`)
  .update(bytes)
  .digest("base64url");

export function createJsonLineFileReader(path: string, options: { readonly cursorPath: string; readonly startAtEnd?: boolean }) {
  let mutationTail: Promise<void> = Promise.resolve();

  const loadCursor = async (initialSize: number): Promise<number> => {
    const current = parsedCursor(await readText(options.cursorPath));
    if (current !== null) return current;
    const initial = options.startAtEnd === false ? 0 : initialSize;
    await persistCursor(options.cursorPath, initial);
    return initial;
  };

  return Object.freeze({
    async read(): Promise<JsonLineBatch | null> {
      const buffer = await readFile(path);
      let start = await loadCursor(buffer.length);
      if (buffer.length < start) {
        start = 0;
        await persistCursor(options.cursorPath, start);
      }
      const finalNewline = buffer.lastIndexOf(10);
      if (finalNewline < start) return null;
      const next = finalNewline + 1;
      const bytes = buffer.subarray(start, next);
      const values: unknown[] = [];
      let malformedLines = 0;
      const records: JsonLineRecord[] = [];
      let relativeOffset = 0;
      for (const lineBytes of bytes.toString("utf8").split("\n")) {
        const lineLength = Buffer.byteLength(lineBytes, "utf8");
        const lineOffset = start + relativeOffset;
        relativeOffset += lineLength + 1;
        if (!lineBytes.trim()) continue;
        const hash = createHash("sha256").update(lineBytes).digest("hex");
        try {
          const value = JSON.parse(lineBytes) as unknown;
          values.push(value);
          records.push(Object.freeze({ byteOffset: lineOffset, nextByteOffset: lineOffset + lineLength + 1, hash, value }));
        } catch (error) {
          malformedLines += 1;
          records.push(Object.freeze({ byteOffset: lineOffset, nextByteOffset: lineOffset + lineLength + 1, hash, raw: lineBytes.slice(0, 4_096), error: error instanceof Error ? error.message : String(error) }));
        }
      }
      return Object.freeze({
        byteOffset: start,
        nextByteOffset: next,
        leaseId: leaseId(start, next, bytes),
        values: Object.freeze(values),
        malformedLines,
        records: Object.freeze(records),
      });
    },

    ack(batch: JsonLineBatch): Promise<boolean> {
      let committed = false;
      const operation = mutationTail.then(async () => {
        const current = parsedCursor(await readText(options.cursorPath));
        if (current === null || current !== batch.byteOffset || batch.nextByteOffset <= batch.byteOffset) return;
        const buffer = await readFile(path);
        if (batch.nextByteOffset > buffer.length || buffer[batch.nextByteOffset - 1] !== 0x0a) return;
        const bytes = buffer.subarray(batch.byteOffset, batch.nextByteOffset);
        if (leaseId(batch.byteOffset, batch.nextByteOffset, bytes) !== batch.leaseId) return;
        await persistCursor(options.cursorPath, batch.nextByteOffset);
        committed = true;
      });
      mutationTail = operation.then(() => undefined, () => undefined);
      return operation.then(() => committed);
    },

    async cursor(): Promise<number> { return loadCursor(0); },
  });
}
