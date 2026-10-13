import { classifyJsonRpcLimit, type JsonRpcLimitCategory } from "@address-radar/collectors";

export interface WalletRpcDiagnostic {
  readonly rpcOrigin: "http" | "json_rpc" | "provider_budget" | "local_cooldown";
  readonly rpcCategory?: JsonRpcLimitCategory;
  readonly rpcMethod?: string;
  readonly rpcCode?: number;
}

const methods = new Set(["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call"]);

/** Project again at the log boundary; never serialize an error or provider text. */
export function sanitizeWalletRpcDiagnostic(value: unknown): WalletRpcDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const origin = input.rpcOrigin;
  if (origin !== "http" && origin !== "json_rpc" && origin !== "provider_budget" && origin !== "local_cooldown") return undefined;
  const result: { rpcOrigin: WalletRpcDiagnostic["rpcOrigin"]; rpcCategory?: JsonRpcLimitCategory;
    rpcMethod?: string; rpcCode?: number } = { rpcOrigin: origin };
  if (input.rpcCategory === "range_limit" || input.rpcCategory === "rate_limit" || input.rpcCategory === "ambiguous_limit") {
    result.rpcCategory = input.rpcCategory;
  }
  if (typeof input.rpcMethod === "string" && methods.has(input.rpcMethod)) result.rpcMethod = input.rpcMethod;
  if (typeof input.rpcCode === "number" && Number.isSafeInteger(input.rpcCode)) result.rpcCode = input.rpcCode;
  return result;
}

export function walletRpcDiagnostic(error: unknown, method?: string): WalletRpcDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const reason = record.reasonCode;
  let origin: WalletRpcDiagnostic["rpcOrigin"] | undefined;
  let category: JsonRpcLimitCategory | null = null;
  if (record.name === "PostgresProviderBudgetError") origin = "provider_budget";
  else if (record.name === "WalletRpcRateLimitError" || record.name === "JsonRpcRateLimitError") {
    if (reason === "rpc_http_rate_limited") { origin = "http"; category = "rate_limit"; }
    else if (reason === "rpc_json_rate_limited") { origin = "json_rpc"; category = "rate_limit"; }
    else if (reason === "rpc_json_limit_ambiguous") { origin = "json_rpc"; category = "ambiguous_limit"; }
    else origin = "local_cooldown";
  } else {
    const status = typeof record.status === "number" ? record.status : typeof record.statusCode === "number" ? record.statusCode : undefined;
    category = classifyJsonRpcLimit({ ...(method === undefined ? {} : { method }), code: record.code,
      message: error instanceof Error ? error.message : undefined, ...(status === undefined ? {} : { httpStatus: status }) });
    if (category !== "rate_limit" && method === "eth_getLogs" && record.code === -32005 && reason === "rpc_range_limit") category = "range_limit";
    if (category) origin = status === 429 ? "http" : "json_rpc";
  }
  return origin === undefined ? undefined : sanitizeWalletRpcDiagnostic({ rpcOrigin: origin,
    rpcCategory: category, rpcMethod: method, rpcCode: record.code });
}
