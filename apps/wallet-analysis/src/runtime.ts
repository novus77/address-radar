import { analyzeWalletPositions, type ChainFamily, type WalletAnalysisPosition } from "@address-radar/domain";
import type { WalletAnalysisStore } from "./store.js";

export const WALLET_HISTORY_WINDOW_MS = 60 * 24 * 60 * 60_000;
export const WALLET_HISTORY_TOKEN_LIMIT = 300;

export interface WalletHistoryProvider {
  collect(input: {
    readonly analysisId: string;
    readonly address: string;
    readonly from: number;
    readonly to: number;
    readonly limit: number;
    readonly cursor: string | null;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly positions: readonly WalletAnalysisPosition[];
    readonly nextCursor: string | null;
    readonly done: boolean;
    readonly provenance: string;
  }>;
}

export function createWalletAnalysisRuntime(input: {
  readonly store: WalletAnalysisStore;
  readonly providers: Readonly<Partial<Record<ChainFamily, WalletHistoryProvider>>>;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  return Object.freeze({
    async runOnce(signal: AbortSignal = new AbortController().signal) {
      const job = input.store.next();
      if (!job) return Object.freeze({ processed: false, analysisId: null, status: null });
      const provider = input.providers[job.chainFamily];
      if (!provider) {
        const error = `wallet_history_provider_unavailable:${job.chainFamily}`;
        input.store.fail(job.analysisId, error, now());
        return Object.freeze({ analysisId: job.analysisId, processed: false, status: "collecting" as const, error });
      }
      try {
        const existing = input.store.positions(job.analysisId).length;
        const remaining = Math.max(0, Math.min(job.maxTokens, job.requestedSamples) - existing);
        if (remaining === 0) {
          const metrics = analyzeWalletPositions({ requestedSamples: job.requestedSamples, positions: input.store.positions(job.analysisId) });
          const status = input.store.complete(job.analysisId, metrics, now());
          return Object.freeze({ analysisId: job.analysisId, processed: true, status, saved: 0, metrics });
        }
        const page = await provider.collect({ analysisId: job.analysisId, address: job.address, from: job.from, to: job.to, limit: job.maxTokens, cursor: job.checkpoint, signal });
        if (!page.done && page.nextCursor === null) throw new Error("Incomplete wallet history page requires nextCursor");
        const bounded = page.positions.filter(position => position.enteredAt >= job.from && position.enteredAt <= job.to);
        const saved = input.store.savePage(job.analysisId, bounded, page.done ? null : page.nextCursor, page.provenance, now());
        if (!page.done) return Object.freeze({ analysisId: job.analysisId, processed: true, status: "collecting" as const, saved });
        const metrics = analyzeWalletPositions({ requestedSamples: job.requestedSamples, positions: input.store.positions(job.analysisId) });
        const status = input.store.complete(job.analysisId, metrics, now());
        return Object.freeze({ analysisId: job.analysisId, processed: true, status, saved, metrics });
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        input.store.fail(job.analysisId, error, now());
        return Object.freeze({ analysisId: job.analysisId, processed: false, status: "collecting" as const, error });
      }
    },
  });
}
