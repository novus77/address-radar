import type { FetchLike } from "@address-radar/collectors";

export interface SolanaTokenSupplyProvider {
  resolveMany(tokenAddresses: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, number>>;
}

interface SupplyResult {
  readonly value?: {
    readonly amount?: string;
    readonly decimals?: number;
    readonly uiAmountString?: string;
  };
}

export function createSolanaTokenSupplyProvider(input: {
  readonly endpoint: string;
  readonly fallbackEndpoint?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly batchSize?: number;
}): SolanaTokenSupplyProvider {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const endpoints = [input.endpoint, input.fallbackEndpoint].filter((value): value is string => Boolean(value));
  const officialPublicRpc = endpoints.every(endpoint => new URL(endpoint).hostname === "api.mainnet-beta.solana.com");
  const batchSize = input.batchSize ?? (officialPublicRpc ? 1 : 50);
  const minimumIntervalMs = officialPublicRpc ? 125 : 0;

  return Object.freeze({
    async resolveMany(tokenAddresses: readonly string[], signal: AbortSignal) {
      const addresses = [...new Set(tokenAddresses.map((value: string) => value.trim()).filter(Boolean))];
      const supplies = new Map<string, number>();
      for (let offset = 0; offset < addresses.length; offset += batchSize) {
        if (offset > 0 && minimumIntervalMs > 0) await delay(minimumIntervalMs, signal);
        const batch = addresses.slice(offset, offset + batchSize);
        const resolved = await requestBatch(endpoints, batch, fetchImpl, timeoutMs, signal);
        for (const [address, supply] of resolved) supplies.set(address, supply);
      }
      return supplies;
    },
  });
}

async function requestBatch(
  endpoints: readonly string[],
  addresses: readonly string[],
  fetchImpl: FetchLike,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, number>> {
  let lastError: unknown;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requests = addresses.map((address, index) => ({ jsonrpc: "2.0", id: index + 1, method: "getTokenSupply", params: [address] }));
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requests.length === 1 ? requests[0] : requests),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
      const rawPayload = await response.json() as { readonly id?: number; readonly result?: SupplyResult; readonly error?: unknown } | readonly { readonly id?: number; readonly result?: SupplyResult; readonly error?: unknown }[];
      const payload = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
      const resolved = new Map<string, number>();
      for (const item of payload) {
        if (!Number.isSafeInteger(item.id) || item.error) continue;
        const address = addresses[(item.id ?? 0) - 1];
        if (!address) continue;
        const value = item.result?.value;
        const supply = value?.uiAmountString != null
          ? Number(value.uiAmountString)
          : Number(value?.amount) / 10 ** Number(value?.decimals ?? 0);
        if (Number.isFinite(supply) && supply > 0) resolved.set(address, supply);
      }
      return resolved;
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Solana supply request aborted");
      lastError = error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Solana supply RPC unavailable");
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Solana supply request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
