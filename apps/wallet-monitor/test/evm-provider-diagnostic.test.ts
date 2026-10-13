import { describe, expect, it, vi } from "vitest";
import { diagnoseEvmTransferBlock } from "../src/evm-provider-diagnostic.js";

describe("one-block budget-port EVM diagnostic", () => {
  it.each([
    [{ result: [] }, "empty_success", undefined, 0],
    [{ result: [{}] }, "nonempty_success", undefined, 1],
    [{ error: { code: -32005, message: "limit exceeded SECRET" } }, "ambiguous_limit", -32005, undefined],
    [{ error: { code: -32005, message: "query returned more than 10000 results" } }, "range_limit", -32005, undefined],
    [{ error: { code: -32601, message: "SECRET" } }, "method_unavailable", -32601, undefined],
    [{ error: { code: "SECRET", message: "rate limit exceeded" } }, "rate_limit", undefined, undefined],
  ])("returns only a closed diagnostic for %j", async (reply, category, code, resultCount) => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.params).toEqual([{ fromBlock: "0x7890e04", toBlock: "0x7890e04",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }));
    });
    const result = await diagnoseEvmTransferBlock({ budgetedFetch: fetch, endpoint: "https://provider.invalid/SECRET",
      blockNumber: 126422532, signal: new AbortController().signal });
    expect(result).toEqual({ category, method: "eth_getLogs", ...(code === undefined ? {} : { code }),
      ...(resultCount === undefined ? {} : { resultCount }) });
    expect(fetch).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("does not retry a durable budget refusal or make a raw fallback request", async () => {
    const fetch = vi.fn(async () => { throw Object.assign(new Error("SECRET"), { name: "PostgresProviderBudgetError" }); });
    expect(await diagnoseEvmTransferBlock({ budgetedFetch: fetch, endpoint: "https://provider.invalid/SECRET",
      blockNumber: 1, signal: new AbortController().signal })).toEqual({ category: "provider_budget_unavailable", method: "eth_getLogs" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("does not call the port after cancellation", async () => {
    const abort = new AbortController(); abort.abort(); const fetch = vi.fn();
    expect(await diagnoseEvmTransferBlock({ budgetedFetch: fetch, endpoint: "https://provider.invalid/SECRET",
      blockNumber: 1, signal: abort.signal })).toEqual({ category: "aborted_or_timed_out", method: "eth_getLogs" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
