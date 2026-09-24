import type { AddressRadarRepository } from "@address-radar/database";
import type { WalletAnalysisStore } from "./store.js";

export function createWalletAnalysisReviewService(input: {
  readonly store: WalletAnalysisStore;
  readonly repository: AddressRadarRepository;
}) {
  return Object.freeze({
    accept(request: {
      readonly analysisId: string;
      readonly entityId: string;
      readonly reviewedAt: number;
      readonly accountId?: string;
      readonly handle?: string;
    }) {
      if (Boolean(request.accountId) !== Boolean(request.handle)) {
        throw new Error("accountId and handle must be supplied together");
      }
      return input.repository.reviewWalletAnalysisDecision({
        decision: "accept",
        analysisId: request.analysisId,
        entityId: request.entityId,
        reviewedAt: request.reviewedAt,
        ...(request.accountId && request.handle
          ? { account: { accountId: request.accountId, handle: request.handle } }
          : {}),
      });
    },
    reject(request: { readonly analysisId: string; readonly reviewedAt: number }) {
      return input.repository.reviewWalletAnalysisDecision({
        decision: "reject",
        analysisId: request.analysisId,
        reviewedAt: request.reviewedAt,
      });
    },
  });
}
