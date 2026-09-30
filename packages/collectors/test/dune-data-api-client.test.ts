import { describe, expect, it, vi } from "vitest";

import {
  DuneApiError,
  DuneCreditLimitError,
  DuneExecutionError,
  DuneTimeoutError,
  createDuneDataApiClient,
} from "@address-radar/collectors";

const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  Response.json(body, { status, ...(headers ? { headers } : {}) });

describe("Dune Data API client", () => {
  it("authenticates, polls a saved query, paginates results, and returns provenance", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const responses = [
      json({ execution_id: "exec-1", state: "QUERY_STATE_PENDING" }),
      json({ execution_id: "exec-1", state: "QUERY_STATE_EXECUTING" }),
      json({ execution_id: "exec-1", state: "QUERY_STATE_COMPLETED" }),
      json({ execution_id: "exec-1", query_id: 42, state: "QUERY_STATE_COMPLETED", next_offset: 2, result: { rows: [{ id: 1 }, { id: 2 }], metadata: { total_row_count: 3 } } }),
      json({ execution_id: "exec-1", query_id: 42, state: "QUERY_STATE_COMPLETED", result: { rows: [{ id: 3 }], metadata: { total_row_count: 3 } } }),
    ];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return responses.shift()!;
    });
    const client = createDuneDataApiClient({ apiKey: "secret", fetch, pollIntervalMs: 1, sleep: async () => {} });

    await expect(client.runSavedQuery<{ readonly id: number }>(42, {
      parameters: { chain: "base", minimum_market_cap: 1_000_000 },
      pageSize: 2,
    })).resolves.toEqual({
      queryId: 42,
      executionId: "exec-1",
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      pageCount: 2,
      totalRowCount: 3,
    });
    expect(requests[0]?.init?.headers).toMatchObject({ "X-Dune-API-Key": "secret", "Content-Type": "application/json" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ query_parameters: { chain: "base", minimum_market_cap: 1_000_000 } });
    expect(requests.map(request => request.url)).toEqual([
      "https://api.dune.com/api/v1/query/42/execute",
      "https://api.dune.com/api/v1/execution/exec-1/status",
      "https://api.dune.com/api/v1/execution/exec-1/status",
      "https://api.dune.com/api/v1/execution/exec-1/results?limit=2&offset=0",
      "https://api.dune.com/api/v1/execution/exec-1/results?limit=2&offset=2",
    ]);
  });

  it("retries retryable HTTP failures with a bounded attempt count", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(json({ execution_id: "exec-2", state: "QUERY_STATE_COMPLETED" }))
      .mockResolvedValueOnce(json({ execution_id: "exec-2", query_id: 7, state: "QUERY_STATE_COMPLETED", result: { rows: [] } }));
    const client = createDuneDataApiClient({ apiKey: "secret", fetch, sleep: async () => {}, maxRequestAttempts: 2 });

    await expect(client.runSavedQuery(7)).resolves.toMatchObject({ executionId: "exec-2", rows: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("resumes one result page from a persisted execution and offset", async () => {
    const requests: string[] = [];
    const responses = [
      json({ execution_id: "exec-resume", state: "QUERY_STATE_COMPLETED" }),
      json({ execution_id: "exec-resume", query_id: 42, state: "QUERY_STATE_COMPLETED", next_offset: 200, result: { rows: [{ id: 101 }], metadata: { total_row_count: 300 } } }),
    ];
    const client = createDuneDataApiClient({ apiKey: "secret", fetch: async input => { requests.push(String(input)); return responses.shift()!; } });

    await expect(client.runSavedQueryPage<{ readonly id: number }>(42, {
      executionId: "exec-resume",
      offset: 100,
      pageSize: 100,
    })).resolves.toEqual({
      queryId: 42,
      executionId: "exec-resume",
      rows: [{ id: 101 }],
      nextOffset: 200,
      totalRowCount: 300,
    });
    expect(requests).toEqual([
      "https://api.dune.com/api/v1/execution/exec-resume/status",
      "https://api.dune.com/api/v1/execution/exec-resume/results?limit=100&offset=100",
    ]);
  });

  it("does not retry terminal authentication errors or expose the API key", async () => {
    const fetch = vi.fn(async () => json({ error: "Invalid API Key" }, 401));
    const client = createDuneDataApiClient({ apiKey: "secret-value", fetch, sleep: async () => {} });

    const rejection = expect(client.runSavedQuery(1)).rejects;
    await rejection.toBeInstanceOf(DuneApiError);
    await rejection.toMatchObject({ status: 401, retryable: false });
    await rejection.not.toThrow(/secret-value/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports billing limits separately", async () => {
    const client = createDuneDataApiClient({ apiKey: "secret", fetch: async () => json({ error: "billing limit" }, 402) });
    await expect(client.runSavedQuery(1)).rejects.toBeInstanceOf(DuneCreditLimitError);
  });

  it("reports terminal query execution failures", async () => {
    const responses = [
      json({ execution_id: "exec-3", state: "QUERY_STATE_PENDING" }),
      json({ execution_id: "exec-3", state: "QUERY_STATE_FAILED", error: { message: "SQL failed" } }),
    ];
    const client = createDuneDataApiClient({ apiKey: "secret", fetch: async () => responses.shift()!, sleep: async () => {} });
    await expect(client.runSavedQuery(1)).rejects.toMatchObject({ name: DuneExecutionError.name, executionId: "exec-3" });
  });

  it("times out bounded polling", async () => {
    let now = 0;
    const responses = [
      json({ execution_id: "exec-4", state: "QUERY_STATE_PENDING" }),
      json({ execution_id: "exec-4", state: "QUERY_STATE_EXECUTING" }),
    ];
    const client = createDuneDataApiClient({
      apiKey: "secret",
      fetch: async () => responses.shift() ?? json({ execution_id: "exec-4", state: "QUERY_STATE_EXECUTING" }),
      timeoutMs: 10,
      pollIntervalMs: 6,
      now: () => now,
      sleep: async (duration) => { now += duration; },
    });
    await expect(client.runSavedQuery(1)).rejects.toBeInstanceOf(DuneTimeoutError);
  });

  it("honors external cancellation before sending a request", async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const client = createDuneDataApiClient({ apiKey: "secret", fetch });

    await expect(client.runSavedQuery(1, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
