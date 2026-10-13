import { describe, expect, it } from "vitest";
import { validatePreservationResidentCalibration, preservationPreparationPins } from "../postgres-preservation-fixture-authority.js";
const fixture = () => ({ status: "calibrated", manifestSha256: preservationPreparationPins.manifestSha256,
  sha256: "1328e4403d467c4aa7f7ef4cee43a85ea59347263caf0250b4f76be36fb6f8b3",
  proofSha256: "1328e4403d467c4aa7f7ef4cee43a85ea59347263caf0250b4f76be36fb6f8b3",
  file: "table-0044-chunk-000000.json", bytes: 16775058, rows: 2842,
  measuredPeakRssBytes: 146104320, maximumRssBytes: 256 * 1024 ** 2, rollbackObserved: true,
  nativeMetrics: { physicalSqlStatements: 162, acknowledgedRollbacks: 1 } });
describe("prior externally trusted calibration shape, resident allowance only", () => {
  it("retains the measured bound without granting source validation or production authority", () => {
    expect(validatePreservationResidentCalibration(fixture())).toEqual({ manifestSha256: preservationPreparationPins.manifestSha256,
      chunkSha256: fixture().sha256, chunkBytes: 16775058, measuredPeakRssBytes: 146104320, maximumRssBytes: 256*1024**2, rollbackObserved: true });
  });
  it.each(["manifest", "chunk", "bytes", "rollback", "rss", "native"])("rejects changed %s", field => {
    const value = fixture();
    if (field === "manifest") Object.assign(value, { manifestSha256: "0".repeat(64) });
    if (field === "chunk") value.proofSha256 = "0".repeat(64);
    if (field === "bytes") value.bytes--;
    if (field === "rollback") value.rollbackObserved = false;
    if (field === "rss") value.maximumRssBytes++;
    if (field === "native") value.nativeMetrics.acknowledgedRollbacks = 0;
    expect(() => validatePreservationResidentCalibration(value)).toThrow("calibration_receipt");
  });
});
