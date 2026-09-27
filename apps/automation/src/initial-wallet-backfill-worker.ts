import type { WalletAnalysisStore } from "@address-radar/wallet-analysis";

import type { AutomationHandler } from "./scheduler.js";

type InitialWalletBackfillPayload = {
  readonly traderId: string;
  readonly accountId?: string;
  readonly chainFamily: "evm" | "solana";
  readonly address: string;
  readonly windowDays: number;
  readonly maximumTokens: number;
};

function parsePayload(payload: string): InitialWalletBackfillPayload {
  const value = JSON.parse(payload) as Partial<InitialWalletBackfillPayload>;
  if (!value.traderId?.trim()) throw new Error("traderId is required");
  if (value.chainFamily !== "evm" && value.chainFamily !== "solana") {
    throw new Error("chainFamily must be evm or solana");
  }
  if (!value.address?.trim()) throw new Error("address is required");
  if (value.windowDays !== 60) throw new Error("windowDays must be 60");
  if (!Number.isSafeInteger(value.maximumTokens) || value.maximumTokens! < 1) {
    throw new Error("maximumTokens must be a positive safe integer");
  }
  return value as InitialWalletBackfillPayload;
}

export function createInitialWalletBackfillWorker(input: {
  readonly store: WalletAnalysisStore;
  readonly now?: () => number;
}): AutomationHandler {
  const now = input.now ?? Date.now;
  return Object.freeze<AutomationHandler>({
    jobType: "initial_wallet_backfill",
    async execute(job) {
      const payload = parsePayload(job.payload);
      input.store.enqueue({
        analysisId: job.idempotencyKey,
        chainFamily: payload.chainFamily,
        address: payload.address,
        requestedSamples: Math.min(300, payload.maximumTokens),
        createdAt: now(),
      });
      return Object.freeze({
        status: "completed" as const,
        cursor: job.idempotencyKey,
      });
    },
  });
}
