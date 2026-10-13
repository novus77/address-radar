import { describe, expect, it, vi } from "vitest";
import { readPostgresGenerationProgress } from "../src/postgres-progress.js";

const row = { stage: "purchase", status: "recorded", reason_code: null, count: "9007199254740993",
  last_progress_at: "10000", new_records_1h: "1" };
function transaction(rows: Record<string, unknown>[] = [row]) {
  return { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows, rowCount: rows.length })) };
}
describe("PostgreSQL generation-scoped progress", () => {
  it("preserves bigint counts and reports unknown coverage and delta without implying qualification", async () => {
    const tx = transaction();
    const result = await readPostgresGenerationProgress(tx, { generationId: "generation-2", asOf: 10000 });
    expect(result.stages[0]).toEqual({ stage: "purchase", status: "recorded", reasonCode: null,
      count: row.count, lastProgressAt: 10000, newRecords1h: "1" });
    expect(result).toMatchObject({ backend: "postgresql", gatewayDeliveryEnabled: false, coverageVerified: false, runnableDelta15m: null });
    expect(tx.query.mock.calls[0]?.[1]).toEqual(["generation-2", 10000, 0]);
    const sql = tx.query.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("wallet_capture_generation_bindings");
    expect(sql).toContain("e.execution_fingerprint=s.execution_fingerprint");
    expect(sql).toContain("forward_opportunity_heads");
    expect(sql).toContain("forward_trader_capability_heads");
    expect(sql).toContain("LIMIT 201");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE)\b/);
    expect(sql).not.toContain("automation_jobs");
  });
  it("retains reasons and distinguishes leased, missing data and opportunity observation", async () => {
    const result = await readPostgresGenerationProgress(transaction([
      { ...row, stage: "ability_work", status: "leased", reason_code: "source_missing" },
      { ...row, stage: "opportunity", status: "observing", reason_code: "window_open" },
    ]), { generationId: "generation-2", asOf: 10000 });
    expect(result.stages.map(item => [item.status, item.reasonCode])).toEqual([["leased", "source_missing"], ["observing", "window_open"]]);
  });
  it.each([
    { count: 10 }, { count: "01" }, { new_records_1h: "9007199254740994" },
    { last_progress_at: "10001" }, { last_progress_at: "9007199254740993" },
    { stage: "legacy_admission" }, { reason_code: [] }, { status: "" },
  ])("refuses malformed or misleading counts %j", async patch => {
    await expect(readPostgresGenerationProgress(transaction([{ ...row, ...patch }]),
      { generationId: "generation-2", asOf: 10000 })).rejects.toThrow();
  });
  it("fails closed instead of truncating excessive reasons or double counting duplicate groups", async () => {
    await expect(readPostgresGenerationProgress(transaction([row, row]), { generationId: "generation-2", asOf: 10000 })).rejects.toThrow("Duplicate");
    await expect(readPostgresGenerationProgress(transaction(Array.from({ length: 201 }, () => row)),
      { generationId: "generation-2", asOf: 10000 })).rejects.toThrow("budget");
  });
  it("does not query on invalid scope", async () => {
    const tx = transaction();
    await expect(readPostgresGenerationProgress(tx, { generationId: "bad'", asOf: 10000 })).rejects.toThrow();
    expect(tx.query).not.toHaveBeenCalled();
  });
});
