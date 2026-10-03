import { describe, expect, it, vi } from "vitest";
import {
  createSyntheticPreservationAcceptanceBundle, packPreservedSqliteValue,
  unpackPreservedSqliteValue, validatePreservationAcceptanceBundle, verifyPostgresPreservationRoundTrip,
} from "../src/postgres-preservation-acceptance.js";
import type { PostgresAcceptanceRuntime } from "../src/postgres-acceptance-driver.js";

describe("preservation staging codec and safety gate", () => {
  it("retains int64 boundaries without converting them to JavaScript numbers", () => {
    for (const value of ["9223372036854775807", "-9223372036854775808", "9007199254740993", "0"]) {
      const packed = packPreservedSqliteValue({ storage: "integer", value });
      expect(unpackPreservedSqliteValue({ storage_type: "integer", integer_value: packed.integerValue }))
        .toEqual({ storage: "integer", value });
    }
    for (const value of ["9223372036854775808", "-9223372036854775809", "01", "-0", "1.5"]) {
      expect(() => packPreservedSqliteValue({ storage: "integer", value })).toThrow("invalid_preserved_integer");
    }
  });

  it("checks float bytes including subnormal, maximum finite and negative zero", () => {
    for (const value of ["-0", Number.MIN_VALUE.toString(), Number.MAX_VALUE.toString(), "0.125"]) {
      packPreservedSqliteValue({ storage: "real", value });
      const bytes = Buffer.alloc(8); bytes.writeDoubleBE(Number(value));
      expect(unpackPreservedSqliteValue({ storage_type: "real", real_bits: bytes.toString("hex") }))
        .toEqual({ storage: "real", value });
    }
    for (const value of ["NaN", "Infinity", "0.12500", ""]) {
      expect(() => packPreservedSqliteValue({ storage: "real", value })).toThrow("invalid_preserved_real");
    }
  });

  it("retains NUL, Unicode and isolated surrogates as original observed text", () => {
    const value = "private\u0000text\uD83D\uDE80\uD800";
    const packed = packPreservedSqliteValue({ storage: "text", value });
    expect(unpackPreservedSqliteValue({ storage_type: "text", byte_value: packed.byteValue }))
      .toEqual({ storage: "text", value });
    expect(() => unpackPreservedSqliteValue({ storage_type: "text", byte_value: Buffer.from([0]) }))
      .toThrow("invalid_preserved_text_bytes");
  });

  it("retains blobs and NULL without substituting either for text", () => {
    const value = Buffer.from([0, 255, 128, 1]).toString("base64");
    const packed = packPreservedSqliteValue({ storage: "blob", value });
    expect(unpackPreservedSqliteValue({ storage_type: "blob", byte_value: packed.byteValue })).toEqual({ storage: "blob", value });
    expect(packPreservedSqliteValue({ storage: "null" }).byteValue).toBeNull();
    expect(unpackPreservedSqliteValue({ storage_type: "null" })).toEqual({ storage: "null" });
    expect(() => packPreservedSqliteValue({ storage: "blob", value: "not-base64" })).toThrow("invalid_preserved_blob");
  });

  it("validates the synthetic bundle without approving migration or eligibility", () => {
    const bundle = createSyntheticPreservationAcceptanceBundle();
    expect(() => validatePreservationAcceptanceBundle(bundle)).not.toThrow();
    expect(bundle.productionMigrationReady).toBe(false);
    expect(bundle.newEligibilityGranted).toBe(false);
    expect(bundle.newPurchaseSamplesCreated).toBe(0);
  });

  it("rejects incomplete dependency or safety scopes", () => {
    const bundle = createSyntheticPreservationAcceptanceBundle();
    expect(() => validatePreservationAcceptanceBundle({ ...bundle, declaredDependenciesComplete: false }))
      .toThrow("preservation_bundle_not_ready_for_isolated_acceptance");
    expect(() => validatePreservationAcceptanceBundle({ ...bundle, globalDeliveryAndBudgetGuardsComplete: false }))
      .toThrow("preservation_bundle_not_ready_for_isolated_acceptance");
  });

  it("rejects modified source values and unknown dependency edges", () => {
    const bundle = createSyntheticPreservationAcceptanceBundle();
    const row = bundle.rows[0]!;
    expect(() => validatePreservationAcceptanceBundle({
      ...bundle, rows: [{ ...row, values: { ...row.values, injected_column: { storage: "text", value: "altered" } } }, ...bundle.rows.slice(1)],
    })).toThrow("preservation_row_fingerprint_mismatch");
    expect(() => validatePreservationAcceptanceBundle({
      ...bundle, edges: [{ from: row.rowId, to: "missing", relation: "foreign_key" }],
    })).toThrow("invalid_preservation_edge");
  });

  it("rejects invalid bundles before opening a database transaction or probing", async () => {
    const probe = vi.fn();
    const run = vi.fn();
    const runtime = { probe, run } as unknown as PostgresAcceptanceRuntime;
    await expect(verifyPostgresPreservationRoundTrip(runtime, {
      ...createSyntheticPreservationAcceptanceBundle(), declaredDependenciesComplete: false,
    })).rejects.toThrow("preservation_bundle_not_ready_for_isolated_acceptance");
    expect(probe).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
});
