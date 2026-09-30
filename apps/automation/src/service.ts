export async function runAutomationService(input: {
  readonly signal: AbortSignal;
  readonly intervalMs: number;
  readonly pollOnce: () => Promise<unknown>;
  readonly onError?: (error: Error) => void;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      await input.pollOnce();
    } catch (error) {
      input.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    if (input.signal.aborted) break;
    await sleep(input.intervalMs, input.signal).catch((error: unknown) => {
      if (!input.signal.aborted) throw error;
    });
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
