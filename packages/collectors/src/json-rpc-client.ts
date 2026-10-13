import type { FetchLike, JsonRpcClient } from "./types.js";
import { logJsonRpcTransactionVersionFailure } from "./json-rpc-version-diagnostic.js";

export type JsonRpcLimitCategory = "range_limit" | "rate_limit" | "ambiguous_limit";

/** Closed transport categories only; never return provider text, endpoints or payloads. */
export function classifyJsonRpcLimit(input: {
  readonly method?: string;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly httpStatus?: number;
}): JsonRpcLimitCategory | null {
  if (input.httpStatus === 429) return "rate_limit";
  if (input.httpStatus !== undefined && !(input.httpStatus >= 200 && input.httpStatus < 300)) return null;
  const message = typeof input.message === "string" ? input.message : "";
  if (/rate[ -]?limit|request rate|too many requests/i.test(message)) return "rate_limit";
  if (input.code !== -32005) return null;
  if (input.method === "eth_getLogs" && knownLogRangeLimit(message)) return "range_limit";
  return "ambiguous_limit";
}

export class JsonRpcRateLimitError extends Error {
  declare readonly code?: number;
  constructor(readonly endpoint: string, readonly retryAfterMs?: number,
    readonly reasonCode: "rpc_http_rate_limited" | "rpc_json_rate_limited" | "rpc_json_limit_ambiguous" = "rpc_http_rate_limited",
    code?: unknown) {
    super("JSON-RPC endpoint rate limited");
    this.name = "JsonRpcRateLimitError";
    if (typeof code === "number" && Number.isSafeInteger(code)) {
      Object.defineProperty(this, "code", { value: code, enumerable: true });
    }
    // Keep the existing programmatic endpoint API, but exclude credentials from error serialization.
    Object.defineProperty(this, "endpoint", { enumerable: false });
  }
}

export class JsonRpcResponseError extends Error {
  constructor(message: string, readonly code?: number,
    readonly reasonCode: "rpc_response_error" | "rpc_range_limit" = "rpc_response_error") {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

export class JsonRpcAbortError extends Error {
  constructor() {
    super("JSON-RPC request aborted by caller");
    this.name = "JsonRpcAbortError";
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(readonly endpoint: string, readonly timeoutMs: number) {
    super(`JSON-RPC request timed out after ${timeoutMs}ms: ${endpoint}`);
    this.name = "JsonRpcTimeoutError";
  }
}

export function createJsonRpcClient(input: {
  readonly endpoint: string;
  readonly fallbackEndpoint?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}): JsonRpcClient {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  let requestId = 0;

  return {
    async request<T>(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw new JsonRpcAbortError();
      const endpoints = [input.endpoint, input.fallbackEndpoint].filter((value): value is string => Boolean(value));
      const id = ++requestId;
      let lastError: unknown;
      for (const endpoint of endpoints) {
        if (signal?.aborted) throw new JsonRpcAbortError();
        try {
          return await requestEndpoint<T>(endpoint, method, params, id, fetchImpl, timeoutMs, signal);
        } catch (error) {
          if (error instanceof JsonRpcAbortError) throw error;
          if (error instanceof JsonRpcResponseError) throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("JSON-RPC request failed");
    },
  };
}

async function requestEndpoint<T>(
  endpoint: string,
  method: string,
  params: readonly unknown[],
  id: number,
  fetchImpl: FetchLike,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw new JsonRpcRateLimitError(
        endpoint,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      const error = new Error(`JSON-RPC HTTP ${response.status}: ${endpoint}`);
      if (response.status >= 400 && response.status < 500) throw new JsonRpcResponseError(error.message);
      throw error;
    }
    let payload: {
      readonly jsonrpc?: unknown;
      readonly id?: unknown;
      readonly result?: T;
      readonly error?: { readonly code?: number; readonly message?: string };
    };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      throw new JsonRpcResponseError("Malformed JSON-RPC response");
    }
    if (payload.jsonrpc !== "2.0" || payload.id !== id) {
      throw new JsonRpcResponseError("Malformed JSON-RPC response");
    }
    if (payload.error) {
      logJsonRpcTransactionVersionFailure(requestBody,payload.error);
      const category = classifyJsonRpcLimit({ method, code: payload.error.code,
        message: payload.error.message, httpStatus: response.status });
      if (category === "range_limit") {
        throw new JsonRpcResponseError("JSON-RPC log range limit exceeded", -32005, "rpc_range_limit");
      }
      if (category === "rate_limit" || category === "ambiguous_limit") {
        throw new JsonRpcRateLimitError(endpoint, undefined,
          category === "rate_limit" ? "rpc_json_rate_limited" : "rpc_json_limit_ambiguous", payload.error.code);
      }
      throw new JsonRpcResponseError(payload.error.message ?? "JSON-RPC response error", payload.error.code);
    }
    if (!("result" in payload)) throw new JsonRpcResponseError("Malformed JSON-RPC response");
    return payload.result as T;
  } catch (error) {
    if (externalSignal?.aborted) throw new JsonRpcAbortError();
    if (timedOut) throw new JsonRpcTimeoutError(endpoint, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function knownLogRangeLimit(message: string): boolean {
  if (message.length > 256 || /[\r\n]/.test(message)) return false;
  // Match complete reviewed response shapes only. Generic "limit exceeded" is not a range proof.
  return [
    /^too many (?:results|logs)[.!]?$/i,
    /^query returned more than [0-9][0-9,]{0,15} results[.!]?$/i,
    /^block (?:range|span)(?: is)? too (?:large|wide)[.!]?$/i,
    /^exceed maximum block range: [0-9]{1,12}[.!]?$/i,
    /^eth_getLogs is limited to a [0-9][0-9,]{0,15} blocks range[.!]?$/i,
  ].some(pattern => pattern.test(message));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}
