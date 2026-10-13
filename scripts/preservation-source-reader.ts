import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { once } from "node:events";

export const immutablePreservationDirectory = "/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle";

/** Only the externally pinned private fixture helper gets OS file-reading privileges. */
export async function createPacedPreservationSourceReader(helper: string, expectedSha256: string, deadlineAtMs: number) {
  const info = await lstat(helper);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) ||
      createHash("sha256").update(await readFile(helper)).digest("hex") !== expectedSha256) throw new Error("source_reader_helper_pin");
  const child = spawn("/usr/bin/python3", ["-u", helper, String(deadlineAtMs)], { stdio: ["pipe", "pipe", "pipe"] });
  const finished = new Promise<void>(resolve => child.once("close", () => resolve()));
  let failure: string | undefined;
  child.stdin.on("error", () => { failure ??= "source_reader_pipe"; });
  child.stderr.on("data", (bytes: Buffer) => {
    const reason = bytes.toString("utf8").trim();
    failure = /^source_reader_[a-z_]+$/.test(reason) ? reason : "source_reader_failed";
  });
  child.on("error", () => { failure = "source_reader_spawn"; });
  const framing = createBoundedPreservationFraming(child.stdout[Symbol.asyncIterator](), async () => { await finished; throw new Error(failure ?? "source_reader_eof"); });
  let busy = false;
  const metrics = { bytes: 0, files: 0, releasedRanges: 0, unsupportedAdviceRanges: 0, freshHash: true, cachedWitnessUsed: false };
  return {
    metrics,
    async read(directory: string, file: string, maximum: number): Promise<Buffer> {
      if (busy || directory !== immutablePreservationDirectory ||
          !(file === "manifest.json" || /^table-[0-9]{4}-chunk-[0-9]{6}\.json$/.test(file)) ||
          !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 ** 2) throw new Error("source_reader_scope");
      busy = true;
      try {
        if (!child.stdin.write(JSON.stringify({ file, maximum: Math.min(maximum, 16 * 1024 ** 2) }) + "\n")) await once(child.stdin, "drain");
        const header = await framing.line();
        if (!Number.isSafeInteger(header.size) || Number(header.size) < 0 || Number(header.size) > maximum) throw new Error("source_reader_size");
        const bytes = await framing.body(Number(header.size));
        const receipt = await framing.line();
        if (receipt.bytes !== bytes.length || receipt.freshHash !== true || receipt.cachedWitnessUsed !== false ||
            receipt.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("source_reader_digest");
        const advice = receipt.advice as Record<string, number>;
        metrics.bytes += bytes.length; metrics.files++; metrics.releasedRanges += advice.released!;
        metrics.unsupportedAdviceRanges += advice.unsupported!;
        return bytes;
      } finally { busy = false; }
    },
    async close() {
      child.stdin.end();
      if (child.exitCode !== null) return;
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000); timer.unref();
      try { await finished; } finally { clearTimeout(timer); }
    },
  };
}

/** One bounded input segment, one reusable header scratch, one completely filled body.
 * Caller serializes whole request/receipt exchanges; no input is pulled speculatively. */
export function createBoundedPreservationFraming(iterator: AsyncIterator<Buffer>, onEof: () => Promise<never> = async () => { throw new Error("source_reader_eof"); }) {
  const empty = Buffer.alloc(0), header = Buffer.allocUnsafe(4096);
  let pending: Buffer = empty, offset = 0;
  const metrics = { inputPulls: 0, headerScans: 0, pendingBytes: 0, maximumPendingBytes: 0 };
  function consumed() {
    if (offset === pending.length) { pending = empty; offset = 0; }
    metrics.pendingBytes = pending.length - offset;
  }
  async function available() {
    if (offset < pending.length) return;
    const next = await iterator.next(); metrics.inputPulls++;
    if (next.done) return await onEof();
    if (!Buffer.isBuffer(next.value) || next.value.length < 1 || next.value.length > 1024 ** 2) throw new Error("source_reader_wire_chunk_limit");
    pending = next.value; offset = 0; metrics.pendingBytes = pending.length;
    metrics.maximumPendingBytes = Math.max(metrics.maximumPendingBytes, metrics.pendingBytes);
  }
  return {
    metrics,
    async line(): Promise<Record<string, unknown>> {
      let written = 0;
      while (true) {
        await available();
        const newline = pending.indexOf(10, offset);
        const count = (newline < 0 ? pending.length : newline) - offset;
        metrics.headerScans++;
        if (written + count >= header.length) throw new Error("source_reader_header_limit");
        pending.copy(header, written, offset, offset + count); written += count;
        offset += count + (newline < 0 ? 0 : 1); consumed();
        if (newline >= 0) {
          const value: unknown = JSON.parse(header.subarray(0, written).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source_reader_header_kind");
          return value as Record<string, unknown>;
        }
      }
    },
    async body(size: number): Promise<Buffer> {
      if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 ** 2) throw new Error("source_reader_size");
      // Every byte is overwritten before this buffer can escape. EOF/error returns no body.
      const bytes = Buffer.allocUnsafe(size); let written = 0;
      while (written < size) {
        await available(); const count = Math.min(size - written, pending.length - offset);
        pending.copy(bytes, written, offset, offset + count); written += count; offset += count; consumed();
      }
      return bytes;
    },
  };
}
