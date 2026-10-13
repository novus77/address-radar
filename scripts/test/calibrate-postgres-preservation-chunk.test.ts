import { describe, it, expect } from "vitest";
import { preservationRowWindows, largestPreservationChunk } from "../calibrate-postgres-preservation-chunk.js";
describe("bounded actual source calibration protocol, no PG", () => {
  it("pins the independently measured largest immutable chunk", () => { expect(largestPreservationChunk.bytes).toBe(16775058); expect(largestPreservationChunk.sha256).toHaveLength(64); });
  it("accounts every row once with explicit row and byte windows", () => {
    expect(preservationRowWindows([Buffer.alloc(2),Buffer.alloc(2),Buffer.alloc(8),Buffer.alloc(1)],2,4)).toEqual([{start:0,end:2,bytes:4},{start:2,end:3,bytes:8},{start:3,end:4,bytes:1}]);
    expect(preservationRowWindows([])).toEqual([]);
  });
  it.each([0,4097,NaN])("rejects unbounded row quotas %s", value => { expect(()=>preservationRowWindows([],value)).toThrow(); });
  it("rejects unbounded wire quotas", () => { expect(()=>preservationRowWindows([],64,16*1024**2)).toThrow(); });
});
