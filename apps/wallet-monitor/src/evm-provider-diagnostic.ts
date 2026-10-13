import { classifyJsonRpcLimit, type FetchLike, type JsonRpcLimitCategory } from "@address-radar/collectors";

type Category = JsonRpcLimitCategory | "empty_success" | "nonempty_success" | "method_unavailable"
  | "rpc_response_error" | "invalid_response" | "response_oversize" | "http_error"
  | "provider_budget_unavailable" | "aborted_or_timed_out" | "transport_unavailable";
export interface EvmProviderDiagnostic {
  readonly category: Category; readonly method: "eth_getLogs"; readonly code?: number; readonly resultCount?: number;
}

/** Caller must pass the approved generation's existing budget+lease fetch, never raw fetch. */
export async function diagnoseEvmTransferBlock(input: {
  readonly budgetedFetch: FetchLike; readonly endpoint: string; readonly blockNumber: number; readonly signal: AbortSignal;
}): Promise<EvmProviderDiagnostic> {
  const result = (category: Category): EvmProviderDiagnostic => ({ category, method: "eth_getLogs" });
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5000)]);
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) return result("invalid_response");
    const url = new URL(input.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return result("invalid_response");
    const block = `0x${input.blockNumber.toString(16)}`;
    const response = await input.budgetedFetch(input.endpoint, { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "eth_getLogs", params: [{ fromBlock: block, toBlock: block,
          topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }] }) });
    signal.throwIfAborted();
    if (response.status === 429) return result("rate_limit");
    if (!response.ok || response.redirected) return result("http_error");
    if (!response.body) return result("invalid_response");
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength; if (bytes > 65536) return result("response_oversize"); parts.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    signal.throwIfAborted();
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return result("invalid_response");
    const rpc = value as Record<string, unknown>;
    if (rpc.jsonrpc !== "2.0" || rpc.id !== 1 || ("error" in rpc && "result" in rpc)) return result("invalid_response");
    if (rpc.error && typeof rpc.error === "object" && !Array.isArray(rpc.error)) {
      const error = rpc.error as Record<string, unknown>;
      const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : undefined;
      const category = classifyJsonRpcLimit({ method: "eth_getLogs", code: error.code, message: error.message,
        httpStatus: response.status }) ?? (code === -32601 ? "method_unavailable" : "rpc_response_error");
      return { ...result(category), ...(code === undefined ? {} : { code }) };
    }
    if (!Array.isArray(rpc.result) || rpc.result.some(value => !value || typeof value !== "object" || Array.isArray(value))) return result("invalid_response");
    return { ...result(rpc.result.length === 0 ? "empty_success" : "nonempty_success"), resultCount: rpc.result.length };
  } catch (error) {
    if (signal.aborted) return result("aborted_or_timed_out");
    if (error instanceof Error && error.name === "PostgresProviderBudgetError") return result("provider_budget_unavailable");
    return result(error instanceof SyntaxError ? "invalid_response" : "transport_unavailable");
  }
}
