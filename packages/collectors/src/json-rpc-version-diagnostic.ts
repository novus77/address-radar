import { types as utilTypes } from "node:util";

/** Observe only the serialized body actually passed to fetch; never expose signatures, endpoints or raw errors. */
export function logJsonRpcTransactionVersionFailure(requestBody: string,error: unknown): void {
  try {
    if (typeof requestBody !== "string" || requestBody.length > 4096 || !error || typeof error !== "object" || utilTypes.isProxy(error)) return;
    const codeDescriptor = Object.getOwnPropertyDescriptor(error,"code");
    const messageDescriptor = Object.getOwnPropertyDescriptor(error,"message");
    if (!codeDescriptor || !("value" in codeDescriptor) || codeDescriptor.value !== -32015
      || messageDescriptor !== undefined && !("value" in messageDescriptor)) return;
    const request = JSON.parse(requestBody) as unknown;
    if (!request || typeof request !== "object" || Array.isArray(request)) return;
    const method = Object.getOwnPropertyDescriptor(request,"method")?.value as unknown;
    if (method !== "getTransaction" && method !== "getBlock") return;
    const params = Object.getOwnPropertyDescriptor(request,"params")?.value as unknown;
    const options = Array.isArray(params) ? Object.getOwnPropertyDescriptor(params,"1")?.value as unknown : undefined;
    const version = options && typeof options === "object" && !Array.isArray(options)
      ? Object.getOwnPropertyDescriptor(options,"maxSupportedTransactionVersion") : undefined;
    const rawVersion = version && "value" in version ? version.value as unknown : undefined;
    const validVersion = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion >= 0;
    const requestedVersionState = version === undefined ? "absent" : validVersion ? "safe_integer" : "invalid";
    const requestedMaxSupportedTransactionVersion = validVersion ? rawVersion : null;
    const message = messageDescriptor?.value as unknown;
    // Exact known Solana response shape only. Both version numbers must agree; malformed shapes are not evidence.
    const matched = typeof message === "string" && message.length <= 512 && !/[\r\n]/.test(message)
      ? /^Transaction version \((0|[1-9][0-9]{0,15})\) is not supported by the requesting client\. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": (0|[1-9][0-9]{0,15})$/.exec(message)
      : null;
    const parsed = matched && matched[1] === matched[2] ? Number(matched[1]) : null;
    const requiredVersionPresent = parsed !== null && Number.isSafeInteger(parsed);
    const requiredMaxSupportedTransactionVersion = requiredVersionPresent ? parsed : null;
    console.error(JSON.stringify({ event: "json_rpc_transaction_version_failure",method,code: -32015,
      requestedVersionState,requestedMaxSupportedTransactionVersion,requiredVersionPresent,requiredMaxSupportedTransactionVersion }));
  } catch { /* Diagnostics never change transport, provider budgets, retries or proof semantics. */ }
}
