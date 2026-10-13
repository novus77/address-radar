import { describe, expect, it, vi } from "vitest";
import { PreservationImportYield, withPreservationImportAdmission } from "../preservation-import-boundary.js";

const now = 1_791_111_111_000;
const config = { stage: "import", deadlineAtMs: now + 900_000, maximumTransactionMs: 60_000 };

describe("import-only transaction admission", () => {
  it("returns only the actual operation result when a complete transaction fits", async () => {
    const operation = vi.fn(async () => ({ acknowledged: true }));
    expect(await withPreservationImportAdmission(config, operation, () => now)).toEqual({ acknowledged: true });
    expect(operation).toHaveBeenCalledOnce();
  });
  it.each([70_000, 69_999, 0, -1])("does not begin work with %s milliseconds remaining", async remaining => {
    const operation = vi.fn(async () => ({ acknowledged: true }));
    await expect(withPreservationImportAdmission({ ...config, deadlineAtMs: now + remaining }, operation, () => now))
      .rejects.toBeInstanceOf(PreservationImportYield);
    expect(operation).not.toHaveBeenCalled();
  });
  it("admits work immediately outside the cleanup reserve", async () => {
    expect(await withPreservationImportAdmission({ ...config, deadlineAtMs: now + 70_001 }, async () => 7, () => now)).toBe(7);
  });
  it("never converts a query or uncertain COMMIT failure into a planned yield", async () => {
    const failure = new Error("fixture_commit_unknown");
    await expect(withPreservationImportAdmission(config, async () => { throw failure; }, () => now)).rejects.toBe(failure);
  });
  it("does not change existing resume/parity admission semantics", async () => {
    for (const stage of ["resume", "parity", "interrupt"]) {
      expect(await withPreservationImportAdmission({ ...config, stage, deadlineAtMs: now }, async () => stage, () => now)).toBe(stage);
    }
  });
  it.each([NaN, Infinity, -1, 0.5])("rejects invalid clock %s before work", async clock => {
    const operation = vi.fn(async () => 1);
    await expect(withPreservationImportAdmission(config, operation, () => clock)).rejects.toThrow("INVALID_BOUNDARY");
    expect(operation).not.toHaveBeenCalled();
  });
  it.each([0, 60_001, NaN])("rejects invalid transaction bound %s", async maximumTransactionMs => {
    await expect(withPreservationImportAdmission({ ...config, maximumTransactionMs }, async () => 1, () => now))
      .rejects.toThrow("INVALID_BOUNDARY");
  });
});
