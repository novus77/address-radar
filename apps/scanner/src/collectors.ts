import { createJsonLineFileReader, createJsonRpcClient, normalizeFomoHistoryLine, normalizeOnchainWalletRecord, type JsonRpcClient, type OnchainWalletRecord } from "@address-radar/collectors";
import type { AddressRadarRepository } from "@address-radar/database";
import type { MonitoringRegistry } from "@address-radar/identity";
import type { ScannerConfig } from "./config.js";
import type { ScannerCollector, ScannerObservation } from "./runtime.js";

export function createConfiguredCollectors(input: { readonly config: ScannerConfig; readonly repository: AddressRadarRepository; readonly monitoringRegistry?: MonitoringRegistry; readonly rpcClient?: JsonRpcClient; readonly now?: () => number }): readonly ScannerCollector[] {
  const now = input.now ?? Date.now;
  const collectors: ScannerCollector[] = input.config.fomoFilePaths.map((path, index) => {
    const reader = createJsonLineFileReader(path, { cursorPath: `${path}.scanner.cursor`, startAtEnd: input.config.fileStartAtEnd });
    return { name: `fomo-file-${index}`, async collect() {
      const batch = await reader.read();
      if (!batch) return { observations: [], status: "ready" as const, queueOldestAt: null, registryVersion: input.monitoringRegistry?.version() ?? 0 };
      const observations = batch.values.flatMap(value => { const event = normalizeFomoHistoryLine(JSON.stringify(value), { collectedAt: now() }); return event ? [{ event } satisfies ScannerObservation] : []; });
      await reader.ack(batch);
      return { observations, status: batch.malformedLines ? "degraded" as const : "ready" as const, queueOldestAt: observations[0]?.event?.occurredAt ?? null, registryVersion: input.monitoringRegistry?.version() ?? 0 };
    } };
  });
  const makeOnchain = (name: string, records: () => Promise<readonly OnchainWalletRecord[]>): ScannerCollector => ({ name, async collect() {
    const registry = input.monitoringRegistry!;
    const identities = [...registry.wallets("evm"), ...registry.wallets("solana")];
    const byAddress = new Map(identities.map(identity => [identity.address.toLowerCase(), identity]));
    const observations = (await records()).flatMap(record => {
      const identity = record.walletAddress ? byAddress.get(record.walletAddress.toLowerCase()) : undefined;
      if (!identity) return [];
      const event = normalizeOnchainWalletRecord(record, { accountId: identity.accountId, entityId: identity.entityId, collectedAt: now() });
      return event ? [{ event } satisfies ScannerObservation] : [];
    });
    return { observations, status: "ready" as const, queueOldestAt: observations[0]?.event?.occurredAt ?? null, registryVersion: registry.version() };
  } });
  if (input.config.onchainFilePath && input.monitoringRegistry) {
    const path = input.config.onchainFilePath;
    const reader = createJsonLineFileReader(path, { cursorPath: `${path}.scanner.cursor`, startAtEnd: input.config.fileStartAtEnd });
    collectors.push(makeOnchain("onchain-file", async () => { const batch = await reader.read(); if (!batch) return []; await reader.ack(batch); return batch.values as OnchainWalletRecord[]; }));
  }
  if (input.config.onchainRpcEndpoint && input.monitoringRegistry) {
    const rpc = input.rpcClient ?? createJsonRpcClient({ endpoint: input.config.onchainRpcEndpoint });
    collectors.push(makeOnchain("onchain-rpc", () => rpc.request<readonly OnchainWalletRecord[]>(input.config.onchainRpcMethod, [])));
  }
  return Object.freeze(collectors);
}
