import { createHash } from "node:crypto";

import {
  normalizeManualResolutionHandle,
  normalizeManualWalletMapping,
  type ManualWalletMapping,
} from "@address-radar/domain";
import type { AddressRadarRepository, IdentityResolutionBatchRecord } from "@address-radar/database";

const TWELVE_HOURS_MS = 12 * 60 * 60_000;

const csvCell = (value: string | number): string => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const stableId = (...parts: readonly string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex");

const exportedItems = (batch: IdentityResolutionBatchRecord) => batch.items.map(item => ({
  handle: item.handle,
  accountId: item.accountId,
  priority: item.priority,
  reasons: item.reasons,
  firstSeenAt: item.firstSeenAt,
  lastSeenAt: item.lastSeenAt,
}));

export const createManualResolutionService = (input: {
  readonly repository: AddressRadarRepository;
  readonly now?: () => number;
}) => ({
  createBatch(options: { readonly batchId: string; readonly maxSize?: number }) {
    const batch = input.repository.createIdentityResolutionBatch({ batchId: options.batchId, createdAt: input.now?.() ?? Date.now(), maxSize: options.maxSize ?? 25, cooldownMs: TWELVE_HOURS_MS });
    const items = exportedItems(batch);
    const header = "handle,accountId,priority,reasons,firstSeenAt,lastSeenAt";
    const csv = [header, ...items.map(item => [item.handle, item.accountId, item.priority, item.reasons.join("|"), item.firstSeenAt, item.lastSeenAt].map(csvCell).join(","))].join("\n");
    input.repository.recordOperatorAudit({ auditId: `identity-batch:${batch.batchId}`, action: "identity.batch_export", actor: "developer", payload: { batchId: batch.batchId, handles: items.map(item => item.handle) }, occurredAt: batch.createdAt });
    return Object.freeze({ batch, json: JSON.stringify(items, null, 2), csv: `${csv}\n` });
  },

  importMappings(request: {
    readonly importId: string;
    readonly batchId: string;
    readonly importedAt: number;
    readonly items: readonly { readonly handle: string; readonly observedAt: number; readonly source: "fomolens_manual"; readonly wallets: readonly ManualWalletMapping[] }[];
  }) {
    const batch = input.repository.identityResolutionBatch(request.batchId);
    if (!batch) throw new Error("Identity resolution batch not found");
    const batchItems = new Map(batch.items.map(item => [item.handle, item]));
    let resolved = 0;
    let conflicts = 0;
    let observations = 0;

    for (const item of request.items) {
      const handle = normalizeManualResolutionHandle(item.handle);
      const queued = batchItems.get(handle);
      if (!queued) throw new Error(`Handle ${handle} is not part of batch ${request.batchId}`);
      const wallets = item.wallets.map(normalizeManualWalletMapping);
      let itemConflicts = 0;
      for (const wallet of wallets) {
        const owner = input.repository.walletOwner(wallet.family, wallet.address);
        input.repository.saveWalletMappingObservation({ observationId: stableId(request.importId, handle, wallet.family, wallet.address), importId: request.importId, batchId: request.batchId, handle, accountId: queued.accountId, chainFamily: wallet.family, address: wallet.address, provider: item.source, observedAt: item.observedAt, importedAt: request.importedAt });
        observations += 1;
        if (owner && owner !== queued.accountId) {
          input.repository.createIdentityConflict({ conflictId: stableId("conflict", handle, wallet.family, wallet.address, owner), handle, accountId: queued.accountId, chainFamily: wallet.family, address: wallet.address, conflictingAccountId: owner, status: "pending", payload: { importId: request.importId, batchId: request.batchId, observedAt: item.observedAt }, createdAt: request.importedAt, resolvedAt: null, resolution: null });
          conflicts += 1;
          itemConflicts += 1;
          continue;
        }
        input.repository.attachWallet({ accountId: queued.accountId, chainFamily: wallet.family, address: wallet.address, confidence: "high", source: item.source, observedAt: item.observedAt });
      }
      if (itemConflicts > 0) input.repository.markIdentityResolution(handle, "conflict", request.importedAt);
      else if (wallets.length === 0) input.repository.markIdentityResolution(handle, "not_found", request.importedAt);
      else {
        input.repository.completeIdentityResolution(handle, queued.accountId, request.importedAt);
        resolved += 1;
      }
    }
    const complete = request.items.length === batch.items.length && conflicts === 0;
    input.repository.markIdentityResolutionBatch(request.batchId, complete ? "imported" : "partially_imported", request.importedAt);
    input.repository.recordOperatorAudit({ auditId: `identity-import:${request.importId}`, action: "identity.batch_import", actor: "developer", payload: { importId: request.importId, batchId: request.batchId, resolved, conflicts, observations }, occurredAt: request.importedAt });
    return Object.freeze({ resolved, conflicts, observations });
  },

  importDirectMappings(request: {
    readonly importId: string;
    readonly importedAt: number;
    readonly items: readonly { readonly handle: string; readonly observedAt: number; readonly source: "fomolens_manual"; readonly wallets: readonly ManualWalletMapping[] }[];
  }) {
    const queue = new Map(input.repository.identityResolutionQueue(500).map(item => [item.handle, item]));
    let resolved = 0;
    let conflicts = 0;
    let observations = 0;

    for (const item of request.items) {
      const handle = normalizeManualResolutionHandle(item.handle);
      let queued = queue.get(handle);
      if (!queued) {
        const account = input.repository.accountByHandle(handle);
        if (!account) throw new Error(`Unknown Fomo handle ${handle}`);
        input.repository.enqueueIdentityResolution({ handle, accountId: account.accountId, priority: 70, reason: "manual_resolution", observedAt: request.importedAt });
        queued = input.repository.identityResolutionQueue(500).find(candidate => candidate.handle === handle);
      }
      if (!queued) throw new Error(`Unable to prepare identity resolution for ${handle}`);
      const wallets = item.wallets.map(normalizeManualWalletMapping);
      if (wallets.length === 0) throw new Error(`Handle ${handle} requires at least one wallet`);
      let itemConflicts = 0;

      for (const wallet of wallets) {
        const owner = input.repository.walletOwner(wallet.family, wallet.address);
        input.repository.saveWalletMappingObservation({ observationId: stableId(request.importId, handle, wallet.family, wallet.address), importId: request.importId, batchId: null, handle, accountId: queued.accountId, chainFamily: wallet.family, address: wallet.address, provider: item.source, observedAt: item.observedAt, importedAt: request.importedAt });
        observations += 1;
        if (owner && owner !== queued.accountId) {
          input.repository.createIdentityConflict({ conflictId: stableId("conflict", handle, wallet.family, wallet.address, owner), handle, accountId: queued.accountId, chainFamily: wallet.family, address: wallet.address, conflictingAccountId: owner, status: "pending", payload: { importId: request.importId, observedAt: item.observedAt }, createdAt: request.importedAt, resolvedAt: null, resolution: null });
          conflicts += 1;
          itemConflicts += 1;
          continue;
        }
        input.repository.attachWallet({ accountId: queued.accountId, chainFamily: wallet.family, address: wallet.address, confidence: "high", source: item.source, observedAt: item.observedAt });
      }

      if (itemConflicts > 0) input.repository.markIdentityResolution(handle, "conflict", request.importedAt);
      else {
        input.repository.completeIdentityResolution(handle, queued.accountId, request.importedAt);
        resolved += 1;
      }
    }

    input.repository.recordOperatorAudit({ auditId: `identity-direct-import:${request.importId}`, action: "identity.direct_import", actor: "developer", payload: { importId: request.importId, handles: request.items.map(item => item.handle), resolved, conflicts, observations }, occurredAt: request.importedAt });
    return Object.freeze({ resolved, conflicts, observations });
  },
});
