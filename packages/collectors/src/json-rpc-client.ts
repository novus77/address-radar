import type { FetchLike, JsonRpcClient } from "./types.js";

export class JsonRpcRateLimitError extends Error {
  constructor(readonly endpoint: string) {
    super(`JSON-RPC provider rate limited: ${endpoint}`);
    this.name = "JsonRpcRateLimitError";
  }
}

export class JsonRpcResponseError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

interface JsonRpcEnvelope {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export function createJsonRpcClient(input: {
  readonly endpoint: string;
  readonly fallbackEndpoint?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}): JsonRpcClient {
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const endpoints = input.fallbackEndpoint
    ? [input.endpoint, input.fallbackEndpoint]
    : [input.endpoint];
  let requestId = 0;

  return Object.freeze({
    async request<T>(method: string, params: readonly unknown[]): Promise<T> {
      if (!method.trim()) throw new Error("JSON-RPC method is required");
      const id = ++requestId;
      let lastError: Error | null = null;
      for (const endpoint of endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            signal: controller.signal,
          });
          if (response.status === 429) {
            lastError = new JsonRpcRateLimitError(endpoint);
            continue;
          }
          if (response.status >= 500) {
            lastError = new JsonRpcResponseError(`JSON-RPC provider returned HTTP ${response.status}`);
            continue;
          }
          if (!response.ok) throw new JsonRpcResponseError(`JSON-RPC provider returned HTTP ${response.status}`);
          let envelope: JsonRpcEnvelope;
          try {
            envelope = await response.json() as JsonRpcEnvelope;
          } catch {
            throw new JsonRpcResponseError("Malformed JSON-RPC response");
          }
          if (
            typeof envelope !== "object" || envelope === null ||
            envelope.jsonrpc !== "2.0" || envelope.id !== id ||
            (!("result" in envelope) && !("error" in envelope))
          ) throw new JsonRpcResponseError("Malformed JSON-RPC response");
          if (envelope.error) {
            const code = typeof envelope.error.code === "number" ? envelope.error.code : undefined;
            const message = typeof envelope.error.message === "string" ? envelope.error.message : "JSON-RPC request failed";
            throw new JsonRpcResponseError(message, code);
          }
          return envelope.result as T;
        } catch (error) {
          if (error instanceof JsonRpcRateLimitError || error instanceof JsonRpcResponseError) {
            lastError = error;
            if (error instanceof JsonRpcResponseError && !error.message.includes("HTTP 5")) throw error;
          } else {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError ?? new Error("JSON-RPC request failed");
    },
  });
}
