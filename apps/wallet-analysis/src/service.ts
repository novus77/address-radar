export async function runWalletAnalysisService(input: { readonly signal: AbortSignal; readonly intervalMs: number; readonly runOnce: () => Promise<{ readonly processed: boolean }> }): Promise<void> {
  let contentionAttempts = 0;
  while (!input.signal.aborted) {
    let processed: boolean;
    try {
      processed = (await input.runOnce()).processed;
      contentionAttempts = 0;
    } catch (error) {
      if (input.signal.aborted) break;
      if (!isSqliteContention(error)) throw error;
      contentionAttempts += 1;
      const delayMs = Math.min(30_000, Math.max(1_000, input.intervalMs) * 2 ** Math.min(contentionAttempts - 1, 5));
      console.warn("wallet_analysis_sqlite_contention", { attempt: contentionAttempts, retryAfterMs: delayMs });
      await sleep(delayMs, input.signal).catch(cause => { if (!input.signal.aborted) throw cause; });
      continue;
    }
    if (input.signal.aborted) break;
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

function isSqliteContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  const code = error.errcode;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}
