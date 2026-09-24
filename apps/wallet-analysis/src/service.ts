export async function runWalletAnalysisService(input: { readonly signal: AbortSignal; readonly intervalMs: number; readonly runOnce: () => Promise<{ readonly processed: boolean }> }): Promise<void> {
  while (!input.signal.aborted) {
    const result = await input.runOnce();
    if (input.signal.aborted) break;
    if (!result.processed) await sleep(input.intervalMs, input.signal).catch(error => { if (!input.signal.aborted) throw error; });
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); }, { once: true }); }); }
