export function createTraceResponseFence(): { capture(): number; invalidate(): number; isCurrent(value: number): boolean };
export function summarizeTracePurchase(row: Record<string, any>, asOf: number): { amountLabel: string; entryLabel: string; opportunityLabel: string };
export function summarizeTraceSignal(signal: Record<string, any>): string;
