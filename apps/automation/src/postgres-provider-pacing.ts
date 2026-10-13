const methods = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call"]);

export function pacedEvmRequest(body: unknown, maximumBytes: number): boolean {
  if (typeof body !== "string" || Buffer.byteLength(body) > maximumBytes) return false;
  try {
    const value: unknown = JSON.parse(body);
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).method === "string"
      && methods.has((value as { method: string }).method));
  } catch { return false; }
}

export function providerPacingUntil(at: number, windowMs: number, requests: number): string {
  if (![at, windowMs, requests].every(Number.isSafeInteger) || at < 0 || windowMs < 1 || requests < 1) {
    throw new Error("Invalid provider pacing budget");
  }
  const until = BigInt(at) + (BigInt(windowMs) + BigInt(requests) - 1n) / BigInt(requests);
  if (until > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Provider pacing clock exceeds budget");
  return until.toString();
}

/** No transaction or provider lease is held during the abortable wait. */
export async function acquirePacedProvider<T>(operation: () => Promise<T>, input: {
  paced: boolean; signal: AbortSignal; now: () => number; maximumWaitMs: number;
  budgetRetryAt: (error: unknown) => number | null;
}): Promise<T> {
  for (;;) {
    input.signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      const retryAt = input.paced ? input.budgetRetryAt(error) : null;
      const now = input.now(), delay = retryAt === null ? NaN : retryAt - now;
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(retryAt) || !Number.isSafeInteger(delay)
        || delay < 1 || delay >= input.maximumWaitMs) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); reject(input.signal.reason); };
        const timer = setTimeout(() => { input.signal.removeEventListener("abort", abort); resolve(); }, delay);
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
      });
    }
  }
}
