import { createJsonLineFileReader, createJsonRpcClient, normalizeFomoHistoryLine, normalizeOnchainWalletRecord, type JsonRpcClient, type OnchainWalletRecord } from "@address-radar/collectors";
import type { AddressRadarRepository } from "@address-radar/database";
import type { MonitoringRegistry } from "@address-radar/identity";
import type { ScannerConfig } from "./config.js";
import type { ScannerCollector, ScannerObservation } from "./runtime.js";

const timestamp = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const lifecycleEvidence = (value: unknown): Pick<ScannerObservation, "createdAt" | "launchedAt"> => {
  if (typeof value !== "object" || value === null) return {};
  const root = value as Record<string, unknown>;
  const wrapped = typeof root.value === "object" && root.value !== null ? root.value as Record<string, unknown> : root;
  const payload = typeof wrapped.payload === "object" && wrapped.payload !== null ? wrapped.payload as Record<string, unknown> : wrapped;
  const asset = typeof payload.asset === "object" && payload.asset !== null ? payload.asset as Record<string, unknown> : {};
  const createdAt = timestamp(asset.createdAt ?? payload.tokenCreatedAt);
  const launchedAt = timestamp(asset.launchedAt ?? asset.migratedAt ?? payload.launchedAt ?? payload.migrationAt);
  return { ...(createdAt !== undefined ? { createdAt } : {}), ...(launchedAt !== undefined ? { launchedAt } : {}) };
};

export function createConfiguredCollectors(input: { readonly config: ScannerConfig; readonly repository: AddressRadarRepository; readonly monitoringRegistry?: MonitoringRegistry; readonly rpcClient?: JsonRpcClient; readonly now?: () => number }): readonly ScannerCollector[] {
  const now = input.now ?? Date.now;
  const collectors: ScannerCollector[] = input.config.fomoFilePaths.map((path, index) => {
    const reader = createJsonLineFileReader(path, { cursorPath: `${path}.scanner.cursor`, startAtEnd: input.config.fileStartAtEnd });
    return { name: `fomo-file-${index}`, async collect() {
      const batch = await reader.read();
      if (!batch) return { observations: [], status: "ready" as const, queueOldestAt: null, registryVersion: input.monitoringRegistry?.version() ?? 0 };
      for (const malformed of batch.records.filter(record => record.error)) {
        input.repository.recordCollectorDeadLetter({ deadLetterId: `jsonl:${path}:${malformed.byteOffset}:${malformed.hash}`, sourcePath: path, byteOffset: malformed.byteOffset, contentHash: malformed.hash, error: malformed.error!, rawPayload: malformed.raw ?? "", recordedAt: now() });
      }
      const observations = batch.values.flatMap(value => { const event = normalizeFomoHistoryLine(JSON.stringify(value), { collectedAt: now() }); return event ? [{ event, ...lifecycleEvidence(value) } satisfies ScannerObservation] : []; });
      return { observations, status: "ready" as const, queueOldestAt: observations[0]?.event?.occurredAt ?? null, registryVersion: input.monitoringRegistry?.version() ?? 0, commit: async () => { if (!(await reader.ack(batch))) throw new Error(`Unable to acknowledge ${path}`); } };
    } };
  });
  const makeOnchain = (name: string, load: () => Promise<{ readonly records: readonly OnchainWalletRecord[]; readonly commit?: () => Promise<void> }>): ScannerCollector => ({ name, async collect() {
    const registry = input.monitoringRegistry!;
    const identities = [...registry.wallets("evm"), ...registry.wallets("solana")];
    const byAddress = new Map(identities.map(identity => [identity.address.toLowerCase(), identity]));
    const loaded = await load();
    const observations = loaded.records.flatMap(record => {
      const identity = record.walletAddress ? byAddress.get(record.walletAddress.toLowerCase()) : undefined;
      if (!identity) return [];
      const event = normalizeOnchainWalletRecord(record, { accountId: identity.accountId, entityId: identity.entityId, collectedAt: now() });
      return event ? [{ event } satisfies ScannerObservation] : [];
    });
    return { observations, status: "ready" as const, queueOldestAt: observations[0]?.event?.occurredAt ?? null, registryVersion: registry.version(), ...(loaded.commit ? { commit: loaded.commit } : {}) };
  } });
  if (input.config.onchainFilePath && input.monitoringRegistry) {
    const path = input.config.onchainFilePath;
    const reader = createJsonLineFileReader(path, { cursorPath: `${path}.scanner.cursor`, startAtEnd: input.config.fileStartAtEnd });
    collectors.push(makeOnchain("onchain-file", async () => { const batch = await reader.read(); if (!batch) return { records: [] }; for (const malformed of batch.records.filter(record => record.error)) input.repository.recordCollectorDeadLetter({ deadLetterId: `jsonl:${path}:${malformed.byteOffset}:${malformed.hash}`, sourcePath: path, byteOffset: malformed.byteOffset, contentHash: malformed.hash, error: malformed.error!, rawPayload: malformed.raw ?? "", recordedAt: now() }); return { records: batch.values as OnchainWalletRecord[], commit: async () => { if (!(await reader.ack(batch))) throw new Error(`Unable to acknowledge ${path}`); } }; }));
  }
  if (input.config.onchainRpcEndpoint && input.monitoringRegistry) {
    const rpc = input.rpcClient ?? createJsonRpcClient({ endpoint: input.config.onchainRpcEndpoint });
    collectors.push(makeOnchain("onchain-rpc", async () => ({ records: await rpc.request<readonly OnchainWalletRecord[]>(input.config.onchainRpcMethod, []) })));
  }
  return Object.freeze(collectors);
}
