import { isRetryableContention } from "./retryable-contention.js";

export async function runWalletAnalysisService(input: {
  readonly signal: AbortSignal;
  readonly intervalMs: number;
  readonly runOnce: () => Promise<{ readonly processed: boolean; readonly contention?: boolean }>;
}): Promise<void> {
  let contentionAttempts = 0;
  while (!input.signal.aborted) {
    let processed = false;
    let contention = false;
    try {
      const result = await input.runOnce();
      processed = result.processed;
      contention = result.contention === true;
    } catch (error) {
      if (input.signal.aborted) break;
      if (!isRetryableContention(error)) throw error;
      contention = true;
    }
    if (input.signal.aborted) break;
    if (contention) {
      contentionAttempts += 1;
      const delayMs = Math.min(30_000, Math.max(1_000, input.intervalMs) * 2 ** Math.min(contentionAttempts - 1, 5));
      console.warn("wallet_analysis_sqlite_contention", { attempt: contentionAttempts, retryAfterMs: delayMs });
      await sleep(delayMs, input.signal).catch(cause => { if (!input.signal.aborted) throw cause; });
      continue;
    }
    contentionAttempts = 0;
    if (!processed) await sleep(input.intervalMs, input.signal).catch(error => { if (!input.signal.aborted) throw error; });
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason ?? new Error("Aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
