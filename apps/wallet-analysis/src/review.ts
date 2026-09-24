import { createHash } from "node:crypto";
import type { AddressRadarRepository } from "@address-radar/database";
import type { WalletAnalysisStore } from "./store.js";

export function createWalletAnalysisReviewService(input: { readonly store: WalletAnalysisStore; readonly repository: AddressRadarRepository }) {
  return Object.freeze({
    accept(request: { readonly analysisId: string; readonly accountId: string; readonly handle: string; readonly entityId: string; readonly reviewedAt: number }) {
      const job = input.store.job(request.analysisId);
      if (!job || job.status !== "review_required") throw new Error("Wallet analysis is not pending review");
      input.repository.upsertFomoAccount({ accountId: request.accountId, handle: request.handle, firstSeenAt: request.reviewedAt, lastSeenAt: request.reviewedAt });
      const owner = input.repository.walletOwner(job.chainFamily, job.address);
      input.repository.saveWalletMappingObservation({ observationId: stableId(request.analysisId, request.accountId, job.chainFamily, job.address), importId: `wallet-analysis:${request.analysisId}`, batchId: null, handle: request.handle, accountId: request.accountId, chainFamily: job.chainFamily, address: job.address, provider: "wallet_analysis_review", observedAt: request.reviewedAt, importedAt: request.reviewedAt });
      if (owner && owner !== request.accountId) {
        input.repository.createIdentityConflict({ conflictId: stableId("conflict", request.analysisId, owner), handle: request.handle, accountId: request.accountId, chainFamily: job.chainFamily, address: job.address, conflictingAccountId: owner, status: "pending", payload: { analysisId: request.analysisId, source: "wallet_analysis_review" }, createdAt: request.reviewedAt, resolvedAt: null, resolution: null });
        return Object.freeze({ status: "conflict" as const, conflictingAccountId: owner });
      }
      input.repository.ensureTraderEntity({ entityId: request.entityId, lifecycle: "candidate", manual: true, locked: false, createdAt: request.reviewedAt, updatedAt: request.reviewedAt });
      input.repository.linkAccountToEntity({ accountId: request.accountId, entityId: request.entityId, confidence: "confirmed", source: "wallet_analysis_review", observedAt: request.reviewedAt });
      input.repository.attachWallet({ accountId: request.accountId, chainFamily: job.chainFamily, address: job.address, confidence: "confirmed", source: "wallet_analysis_review", observedAt: request.reviewedAt });
      const entityId = input.repository.completeIdentityAdmission(request.accountId, request.reviewedAt);
      if (!entityId) throw new Error("Unable to complete wallet analysis admission");
      input.store.review(request.analysisId, "accepted", request.reviewedAt);
      input.repository.recordOperatorAudit({ auditId: `wallet-analysis-accept:${request.analysisId}`, action: "wallet_analysis.accept", actor: "developer", payload: { analysisId: request.analysisId, accountId: request.accountId, entityId }, occurredAt: request.reviewedAt });
      return Object.freeze({ status: "accepted" as const, entityId });
    },
    reject(request: { readonly analysisId: string; readonly reviewedAt: number }) {
      input.store.review(request.analysisId, "rejected", request.reviewedAt);
      input.repository.recordOperatorAudit({ auditId: `wallet-analysis-reject:${request.analysisId}`, action: "wallet_analysis.reject", actor: "developer", payload: { analysisId: request.analysisId }, occurredAt: request.reviewedAt });
      return Object.freeze({ status: "rejected" as const });
    },
  });
}

const stableId = (...parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");
