import { describe, expect, it, vi } from "vitest";
import { PostgresCommitUncertainError } from "../../../packages/database/src/postgres-unit-of-work.js";
import type { PostgresBusinessRuntime } from "../../../packages/database/src/postgres-business-driver.js";
import { createPostgresServiceFactAdapters, PostgresProviderBudgetError } from "../src/postgres-service-fact-adapters.js";

function setup(afterCommit?: () => void) {
  let now = 100000;
  const row = { provider_id: "provider", cooldown_until: "0", window_started_at: 90000,
    window_ms: 60000, maximum_requests: 60, requests_used: 0, maximum_concurrency: 1, active_leases: 0 };
  const queries: string[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("service-provider-budget-lock")) return { rows: [{ ...row }], rowCount: 1 };
    if (sql.includes("service-provider-budget-debit")) { row.requests_used = Number(values[3]); return { rows: [{ provider_id: row.provider_id }], rowCount: 1 }; }
    if (sql.includes("service-provider-cooldown")) { row.cooldown_until = String(BigInt(row.cooldown_until) > BigInt(String(values[2])) ? row.cooldown_until : values[2]); return { rows: [{ cooldown_until: row.cooldown_until }], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  });
  const fetchImpl = vi.fn(async () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
  const runtime = { run: async (op: any) => { const value = await op({ query }); afterCommit?.(); return value; },
    probe: async () => ({ generation: "generation", service: "wallet-monitor" }) } as unknown as PostgresBusinessRuntime;
  const create = (mode: "enabled" | "omitted" | "disabled" = "enabled") => createPostgresServiceFactAdapters({ runtime, generationId: "generation", maximumProfiles: 1,
    now: () => now, sources: { leaseMs: 60000, maximumProfileAgeMs: 60000, maximumFactAgeMs: 60000,
      maximumSafetyAgeMs: 10000, providerTimeoutMs: 5000, maximumResponseBytes: 65536,
      maximumFactPayloadBytes: 65536, fetchImpl,
      ...(mode === "enabled" ? { evmProviderPacingEnabled: true } : mode === "disabled" ? { evmProviderPacingEnabled: false } : {}) } });
  const request = (ports: Awaited<ReturnType<typeof create>>, signal?: AbortSignal) => ports.fetch("https://provider.invalid/SECRET", {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), ...(signal ? { signal } : {}) });
  return { row, queries, create, request, fetchImpl, setNow: (value: number) => { now = value; } };
}

describe("quota-derived durable EVM pacing", () => {
  it("releases the committed lease without fetching when cancellation arrives during commit", async () => {
    const abort = new AbortController();
    const state = setup(() => abort.abort(new Error("commit cancellation")));
    await expect(state.request(await state.create(), abort.signal)).rejects.toThrow("commit cancellation");
    expect(state.fetchImpl).not.toHaveBeenCalled();
    expect(state.queries.filter(sql => sql.includes("INSERT INTO wallet_service_provider_leases"))).toHaveLength(1);
    expect(state.queries.filter(sql => sql.includes("service-provider-release"))).toHaveLength(1);
  });
  it("does not retry or fetch after an uncertain acquisition commit", async () => {
    const uncertain = new PostgresCommitUncertainError(new Error("connection lost during commit"));
    const state = setup(() => { throw uncertain; });
    await expect(state.request(await state.create())).rejects.toBe(uncertain);
    expect(state.fetchImpl).not.toHaveBeenCalled();
    expect(state.queries.filter(sql => sql.includes("service-provider-budget-lock"))).toHaveLength(1);
    expect(state.queries.filter(sql => sql.includes("INSERT INTO wallet_service_provider_leases"))).toHaveLength(1);
    expect(state.queries.some(sql => sql.includes("service-provider-release"))).toBe(false);
  });
  it.each(["omitted", "disabled"] as const)("preserves the g path when opt-in is %s", async mode => {
    const state = setup(), ports = await state.create(mode);
    await state.request(ports); await state.request(ports);
    expect(state.fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.row.requests_used).toBe(2); expect(state.row.maximum_requests).toBe(60);
    expect(state.row.cooldown_until).toBe("0");
    expect(state.queries.some(sql => sql.includes("service-provider-cooldown"))).toBe(false);
  });
  it("reserves a shared 1000ms gap without changing the minute quota", async () => {
    const state = setup(); await state.request(await state.create());
    expect(state.row.cooldown_until).toBe("101000");
    expect(state.row.requests_used).toBe(1);
    expect(state.row.maximum_requests).toBe(60);
  });
  it("waits outside the transaction and rechecks shared state across workers", async () => {
    vi.useFakeTimers();
    try {
      const state = setup(); await state.request(await state.create());
      const second = state.request(await state.create());
      await vi.advanceTimersByTimeAsync(999);
      expect(state.fetchImpl).toHaveBeenCalledTimes(1);
      state.setNow(101000); await vi.advanceTimersByTimeAsync(1); await second;
      expect(state.fetchImpl).toHaveBeenCalledTimes(2);
      expect(state.row.cooldown_until).toBe("102000");
      expect(state.row.requests_used).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it("does not shorten a real long provider cooldown or debit a request", async () => {
    const state = setup(); state.row.cooldown_until = "160000";
    await expect(state.request(await state.create())).rejects.toBeInstanceOf(PostgresProviderBudgetError);
    expect(state.fetchImpl).not.toHaveBeenCalled(); expect(state.row.requests_used).toBe(0);
    expect(state.row.cooldown_until).toBe("160000");
  });
  it("aborts a pacing wait before another debit, lease or network request", async () => {
    const state = setup(); await state.request(await state.create());
    const abort = new AbortController(); const waiting = state.request(await state.create(), abort.signal);
    const rejected = expect(waiting).rejects.toThrow(); abort.abort(new Error("cancelled")); await rejected;
    expect(state.fetchImpl).toHaveBeenCalledTimes(1); expect(state.row.requests_used).toBe(1);
    expect(state.queries.filter(sql => sql.includes("INSERT INTO wallet_service_provider_leases"))).toHaveLength(1);
  });
});
