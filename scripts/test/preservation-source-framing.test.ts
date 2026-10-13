import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBoundedPreservationFraming } from "../preservation-source-reader.js";

async function* wire(parts: readonly Buffer[]) { for (const part of parts) yield part; }
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
describe("bounded source framing allocation and backpressure, no helper or PG", () => {
  it("scans a complete header without per-byte async pulls and preserves opaque body bytes", async () => {
    const body = Buffer.from(Array.from({length: 32768}, (_, i) => i % 256));
    const header = line({ size: body.length, annotation: "x".repeat(2000) });
    const sha256 = createHash("sha256").update(body).digest("hex");
    const framing = createBoundedPreservationFraming(wire([Buffer.concat([header, body, line({ sha256 })])]));
    expect((await framing.line()).size).toBe(body.length);
    expect(await framing.body(body.length)).toEqual(body);
    expect(await framing.line()).toEqual({ sha256 });
    expect(framing.metrics.inputPulls).toBe(1);
    expect(framing.metrics.headerScans).toBe(2);
    expect(framing.metrics.pendingBytes).toBe(0);
  });
  it("handles fragmented headers, binary newline bytes and receipts without read-ahead", async () => {
    const body = Buffer.from([0,10,255,1,10]), bytes=Buffer.concat([line({size:5}),body,line({done:true})]);
    let pulls=0;
    async function* fragmented(){for(let offset=0;offset<bytes.length;offset+=3){pulls++;yield bytes.subarray(offset,offset+3);}}
    const framing=createBoundedPreservationFraming(fragmented());
    expect(await framing.line()).toEqual({size:5});expect(pulls).toBeLessThan(Math.ceil(bytes.length/3));
    expect(await framing.body(5)).toEqual(body);expect(await framing.line()).toEqual({done:true});
    expect(framing.metrics.maximumPendingBytes).toBeLessThanOrEqual(3);
  });
  it("rejects oversized headers without accumulating unbounded text", async () => {
    const framing=createBoundedPreservationFraming(wire([Buffer.alloc(4097,120)]));
    await expect(framing.line()).rejects.toThrow("header_limit");
  });
  it.each([-1,16*1024**2+1,NaN])("rejects unbounded body allocation %s", async size => {
    await expect(createBoundedPreservationFraming(wire([])).body(size)).rejects.toThrow("size");
  });
  it("never returns an incomplete unsafe-allocated buffer", async () => {
    await expect(createBoundedPreservationFraming(wire([Buffer.from([1,2])])).body(5)).rejects.toThrow("eof");
  });
  it("bounds incoming wire segments separately from the whole immutable chunk", async () => {
    await expect(createBoundedPreservationFraming(wire([Buffer.alloc(1024**2+1)])).line()).rejects.toThrow("wire_chunk_limit");
  });
});
