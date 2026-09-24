import type { FetchLike, JsonRpcClient } from "./types.js";

export class JsonRpcRateLimitError extends Error {
  constructor(readonly endpoint: string) {
    super(`JSON-RPC endpoint rate limited: ${endpoint}`);
    this.name = "JsonRpcRateLimitError";
  }
}

export class JsonRpcResponseError extends Error {
  constructor(message: string, readonly code?: number) {
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
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
    if (response.status === 429) throw new JsonRpcRateLimitError(endpoint);
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
      if (payload.error.code === -32005 || /rate limit/i.test(payload.error.message ?? "")) {
        throw new JsonRpcRateLimitError(endpoint);
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
