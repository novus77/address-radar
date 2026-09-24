export async function runWalletAnalysisService(input: { readonly signal: AbortSignal; readonly intervalMs: number; readonly runOnce: () => Promise<{ readonly processed: boolean }> }): Promise<void> {
  while (!input.signal.aborted) {
    const result = await input.runOnce();
    if (input.signal.aborted) break;
    if (!result.processed) await sleep(input.intervalMs, input.signal).catch(error => { if (!input.signal.aborted) throw error; });
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
