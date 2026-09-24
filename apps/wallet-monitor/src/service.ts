export async function runWalletMonitorService(input: { readonly signal: AbortSignal; readonly intervalMs: number; readonly pollOnce: () => Promise<unknown>; readonly onError?: (error: Error) => void }): Promise<void> {
  while (!input.signal.aborted) {
    try { await input.pollOnce(); } catch (error) { input.onError?.(error instanceof Error ? error : new Error(String(error))); }
    if (input.signal.aborted) break;
    await sleep(input.intervalMs, input.signal).catch(error => { if (!input.signal.aborted) throw error; });
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); }, { once: true }); });
}
