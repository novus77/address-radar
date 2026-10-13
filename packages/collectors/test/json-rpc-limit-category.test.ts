import { describe, expect, it, vi } from "vitest";
import { createJsonRpcClient, JsonRpcRateLimitError, JsonRpcResponseError } from "../src/json-rpc-client.js";
import { createConfiguredWalletRpcClient } from "../../../apps/wallet-monitor/src/rpc.js";
import { classifyJsonRpcLimit, type JsonRpcLimitCategory } from "../src/index.js";

const endpoint = "https://rpc.invalid/SECRET?api-key=SECRET";
function fixture(message: unknown, code: unknown = -32005, options: { method?: string; status?: number; fallback?: boolean } = {}) {
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    return Response.json({ jsonrpc: "2.0", id, error: { code, message } },
      { status: options.status ?? 200, headers: { "Retry-After": "60" } });
  });
  const client = createJsonRpcClient({ endpoint, fetch,
    ...(options.fallback ? { fallbackEndpoint: "https://fallback.invalid/SECRET" } : {}) });
  return { fetch, request: () => client.request(options.method ?? "eth_getLogs", []) };
}

describe("fixed JSON-RPC limit categories", () => {
  it.each(["SECRET", { secret: "SECRET" }, ["SECRET"], null, true, NaN, Infinity, -Infinity,
    1.5, Number.MAX_SAFE_INTEGER + 1])("omits invalid response codes from rate error serialization: %j", async code => {
    const error = await fixture("rate limit exceeded", code).request().catch(value => value);
    if (!(error instanceof JsonRpcRateLimitError)) throw error;
    expect(error.reasonCode).toBe("rpc_json_rate_limited");
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("code");
  });

  it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "SECRET",
    { toJSON() { return "SECRET"; } }])("also validates codes at the public error constructor boundary: %j", code => {
    const error = new JsonRpcRateLimitError(endpoint, undefined, "rpc_json_rate_limited", code);
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });

  it.each([-32005, -32000, 0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "retains only numeric safe-integer diagnostic codes: %s", code => {
      const error = new JsonRpcRateLimitError(endpoint, undefined, "rpc_json_rate_limited", code);
      expect(JSON.parse(JSON.stringify(error)).code).toBe(code);
    });

  it.each([
    "too many results", "Too many logs.", "query returned more than 10000 results",
    "Query returned more than 10,000 results.", "block range too wide", "block range is too large.",
    "block span too large", "exceed maximum block range: 5000",
    "eth_getLogs is limited to a 10,000 blocks range",
  ])("preserves a typed range limit for the exact reviewed pattern %s", async message => {
    const f = fixture(message, -32005, { fallback: true });
    await expect(f.request()).rejects.toMatchObject({ name: "JsonRpcResponseError", code: -32005,
      reasonCode: "rpc_range_limit", message: "JSON-RPC log range limit exceeded" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "limit exceeded", "request limit exceeded", "response too large", "too many requests",
    "range limit", "too many results per second", "block range too wide; rate limit exceeded",
    "too many results https://SECRET.invalid", "block range too wide\nSECRET",
    "block range too wide for account SECRET", "query returned more than 100 results; SECRET",
    "", null, {},
  ])("keeps generic, ambiguous or rate responses out of the range category: %s", async message => {
    const f = fixture(message);
    const error = await f.request().catch(value => value);
    expect(error).toBeInstanceOf(JsonRpcRateLimitError);
    if (!(error instanceof JsonRpcRateLimitError)) throw error;
    expect(error).toMatchObject({ code: -32005 });
    expect(error.reasonCode).not.toBe("rpc_range_limit");
    expect(error.message).not.toContain("SECRET");
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });

  it.each(["rate limit exceeded", "Rate-limit exceeded", "request rate exceeded", "too many requests"])(
    "retains fixed JSON rate attribution for %s", async message => {
      await expect(fixture(message).request()).rejects.toMatchObject({ name: "JsonRpcRateLimitError",
        code: -32005, reasonCode: "rpc_json_rate_limited" });
    });

  it("keeps an ambiguous -32005 as rate limiting with a fixed ambiguity category", async () => {
    await expect(fixture("limit exceeded SECRET").request()).rejects.toMatchObject({
      name: "JsonRpcRateLimitError", code: -32005, reasonCode: "rpc_json_limit_ambiguous" });
  });

  it("keeps HTTP429 authoritative even if its body resembles a range error", async () => {
    const f = fixture("too many results", -32005, { status: 429 });
    const error = await f.request().catch(value => value);
    if (!(error instanceof JsonRpcRateLimitError)) throw error;
    expect(error).toMatchObject({ name: "JsonRpcRateLimitError", reasonCode: "rpc_http_rate_limited", retryAfterMs: 60000 });
    expect(error.endpoint).toBe(endpoint);
    expect(error.message).not.toContain("SECRET");
    expect(JSON.stringify(error)).not.toContain("SECRET");
  });

  it("does not reclassify another method based only on the range-like message", async () => {
    await expect(fixture("too many results", -32005, { method: "eth_blockNumber" }).request()).rejects
      .toMatchObject({ name: "JsonRpcRateLimitError", reasonCode: "rpc_json_limit_ambiguous" });
  });

  it("does not reclassify another JSON-RPC code", async () => {
    await expect(fixture("block range too wide", -32602).request()).rejects.toMatchObject({
      name: "JsonRpcResponseError", code: -32602, reasonCode: "rpc_response_error" });
  });

  it("does not turn numeric rate-limit messages into an uncategorized response", async () => {
    await expect(fixture("rate limit exceeded", -32000).request()).rejects.toMatchObject({
      name: "JsonRpcRateLimitError", code: -32000, reasonCode: "rpc_json_rate_limited" });
  });

  it("preserves typed range attribution through the real wallet RPC wrapper without fallback", async () => {
    const f = fixture("block range too wide");
    const rpc = createConfiguredWalletRpcClient({ endpoints: { bsc: { primary: endpoint, fallback: "https://fallback.invalid" } }, fetch: f.fetch });
    await expect(rpc.request("bsc", "eth_getLogs", [], new AbortController().signal)).rejects
      .toBeInstanceOf(JsonRpcResponseError);
    await expect(rpc.request("bsc", "eth_getLogs", [], new AbortController().signal)).rejects
      .toMatchObject({ code: -32005, reasonCode: "rpc_range_limit" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("shared closed-set JSON-RPC classification export", () => {
  it.each([
    [{ httpStatus: 429, method: "eth_getLogs", code: -32005, message: "too many results" }, "rate_limit"],
    [{ httpStatus: 200, method: "eth_getLogs", code: -32005, message: "too many results" }, "range_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "block range too wide" }, "range_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "limit exceeded" }, "ambiguous_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "too many requests" }, "rate_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "block range too wide; rate limit" }, "rate_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "block range too wide\n" }, "ambiguous_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "block range too wide\r\n" }, "ambiguous_limit"],
    [{ method: "eth_getLogs", code: -32005, message: "too many results SECRET" }, "ambiguous_limit"],
    [{ method: "eth_getLogs", code: -32005, message: {} }, "ambiguous_limit"],
    [{ code: -32005, message: "too many results" }, "ambiguous_limit"],
    [{ method: "eth_call", code: -32005, message: "too many results" }, "ambiguous_limit"],
    [{ method: "eth_getLogs", code: "-32005", message: "too many results" }, null],
    [{ method: "eth_getLogs", code: -32602, message: "too many results" }, null],
    [{ method: "eth_getLogs", code: -32000, message: "rate limit exceeded" }, "rate_limit"],
    [{ httpStatus: 503, method: "eth_getLogs", code: -32005, message: "too many results" }, null],
    [{ httpStatus: 403, message: "rate limit" }, null],
    [{ httpStatus: NaN, code: -32005 }, null],
    [{}, null],
  ] satisfies Array<[Parameters<typeof classifyJsonRpcLimit>[0], JsonRpcLimitCategory | null]>)(
    "returns only the agreed category for %j", (input, expected) => {
      expect(classifyJsonRpcLimit(input)).toBe(expected);
    });
});
