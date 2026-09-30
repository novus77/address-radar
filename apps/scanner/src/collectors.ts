import { createJsonLineFileReader, createJsonRpcClient, parseFomoHistoryLine, normalizeOnchainWalletRecord, validateOnchainWalletRecord, type JsonLineRecord, type JsonRpcClient, type OnchainWalletRecord } from "@address-radar/collectors";
import type { AddressRadarRepository } from "@address-radar/database";
import { normalizeDiscoveryChain, type DiscoveryChain } from "@address-radar/domain";
import type { MonitoringRegistry } from "@address-radar/identity";
import type { ScannerConfig } from "./config.js";
import type { ScannerCollector, ScannerObservation } from "./runtime.js";

export function createProjectionReplayCollector(input: {
  readonly repository: AddressRadarRepository;
  readonly strategyVersion: string;
  readonly now?: () => number;
  readonly lookbackMs: number;
  readonly batchSize: number;
  readonly realtimeWindowMs?: number;
  readonly realtimeBatchSize?: number;
}): ScannerCollector {
  if (!Number.isSafeInteger(input.lookbackMs) || input.lookbackMs < 1) throw new Error("lookbackMs must be a positive safe integer");
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1) throw new Error("batchSize must be a positive safe integer");
  const realtimeWindowMs = input.realtimeWindowMs ?? 60 * 60_000;
  const realtimeBatchSize = Math.min(input.batchSize, input.realtimeBatchSize ?? 25);
  if (!Number.isSafeInteger(realtimeWindowMs) || realtimeWindowMs < 1) throw new Error("realtimeWindowMs must be a positive safe integer");
  if (!Number.isSafeInteger(realtimeBatchSize) || realtimeBatchSize < 1) throw new Error("realtimeBatchSize must be a positive safe integer");
  const now = input.now ?? Date.now;
  return Object.freeze({
    name: "projection-replay",
    async collect() {
      const collectedAt = now();
      const realtime = input.repository.eventsMissingProjection({
        projectionType: "address_signal_evidence_v1",
        sourceRevision: input.strategyVersion,
        since: Math.max(0, collectedAt - realtimeWindowMs),
        limit: realtimeBatchSize,
        order: "newest",
      });
      const selected = new Map(realtime.map(event => [event.eventId, event]));
      const remaining = input.batchSize - selected.size;
      if (remaining > 0) {
        const historical = input.repository.eventsMissingProjection({
          projectionType: "address_signal_evidence_v1",
          sourceRevision: input.strategyVersion,
          since: Math.max(0, collectedAt - input.lookbackMs),
          limit: input.batchSize + selected.size,
          order: "oldest",
        });
        for (const event of historical) {
          if (selected.has(event.eventId)) continue;
          selected.set(event.eventId, event);
          if (selected.size === input.batchSize) break;
        }
      }
      const events = [...selected.values()];
      return Object.freeze({
        observations: Object.freeze(events.map(event => Object.freeze({ event }))),
        status: "ready" as const,
        queueOldestAt: events.length ? Math.min(...events.map(event => event.occurredAt)) : null,
      });
    },
  });
}

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
  const chains = input.config.allowedChains.flatMap(value => {
    try { return [normalizeDiscoveryChain(value)]; }
    catch { return []; }
  }) as DiscoveryChain[];
  const fomoHealthTargets = chains.map(chain => ({ source: "fomo_token_page" as const, chain, stream: "fomo_live" as const }));
  const onchainHealthTargets = chains.map(chain => ({ source: chain === "solana" ? "rpc_solana" as const : "rpc_evm" as const, chain, stream: "wallet_observation" as const }));
  const deadLetter = (path: string, record: JsonLineRecord, error: string): void => {
    input.repository.recordCollectorDeadLetter({ deadLetterId: `jsonl:${path}:${record.byteOffset}:${record.hash}`, sourcePath: path, byteOffset: record.byteOffset, contentHash: record.hash, error, rawPayload: record.raw ?? "", recordedAt: now() });
  };
  const collectors: ScannerCollector[] = input.config.fomoFilePaths.map((path, index) => {
    const reader = createJsonLineFileReader(path, { cursorPath: `${path}.scanner.cursor`, startAtEnd: input.config.fileStartAtEnd });
    return { name: `fomo-file-${index}`, healthTargets: fomoHealthTargets, async collect() {
      const batch = await reader.read();
      if (!batch) return { observations: [], status: "ready" as const, queueOldestAt: null, registryVersion: input.monitoringRegistry?.version() ?? 0 };
      for (const malformed of batch.records.filter(record => record.error)) {
        deadLetter(path, malformed, malformed.error!);
      }
      const observations = batch.records.flatMap(record => {
        if (!Object.hasOwn(record, "value")) return [];
        const parsed = parseFomoHistoryLine(JSON.stringify(record.value), { collectedAt: now() });
        if (!parsed) { deadLetter(path, record, "fomo_schema_invalid"); return []; }
        const existing = input.repository.accountByHandle(parsed.handle);
        const accountId = existing?.accountId ?? parsed.event.accountId;
        const entityId = input.repository.entityForAccount(accountId) ?? `fomo:${accountId}`;
        input.repository.upsertFomoAccount({ accountId, handle: parsed.handle, firstSeenAt: parsed.event.occurredAt, lastSeenAt: parsed.event.occurredAt });
        input.repository.ensureTraderEntity({ entityId, lifecycle: "suspended", manual: false, locked: false, createdAt: parsed.event.occurredAt, updatedAt: parsed.event.occurredAt });
        input.repository.linkAccountToEntity({ entityId, accountId, confidence: "high", source: "fomo_token_history", observedAt: parsed.event.occurredAt });
        const event = Object.freeze({ ...parsed.event, accountId, entityId });
        return [{ event, ...lifecycleEvidence(record.value) } satisfies ScannerObservation];
      });
      return { observations, status: "ready" as const, queueOldestAt: observations[0]?.event?.occurredAt ?? null, registryVersion: input.monitoringRegistry?.version() ?? 0, commit: async () => { if (!(await reader.ack(batch))) throw new Error(`Unable to acknowledge ${path}`); } };
    } };
  });
  const makeOnchain = (name: string, load: () => Promise<{ readonly records: readonly OnchainWalletRecord[]; readonly commit?: () => Promise<void>; readonly lineRecords?: readonly JsonLineRecord[]; readonly sourcePath?: string }>): ScannerCollector => ({ name, healthTargets: onchainHealthTargets, async collect() {
    const registry = input.monitoringRegistry!;
    const identities = [...registry.wallets("evm"), ...registry.wallets("solana")];
    const byAddress = new Map(identities.map(identity => [identity.address.toLowerCase(), identity]));
    const loaded = await load();
    const observations = loaded.records.flatMap((record, index) => {
      const lineRecord = loaded.lineRecords?.[index];
      const schemaError = validateOnchainWalletRecord(record);
      if (schemaError) { if (lineRecord && loaded.sourcePath) deadLetter(loaded.sourcePath, lineRecord, schemaError); return []; }
      const identity = record.walletAddress ? byAddress.get(record.walletAddress.toLowerCase()) : undefined;
      if (!identity) return [];
      const event = normalizeOnchainWalletRecord(record, { accountId: identity.accountId, entityId: identity.entityId, collectedAt: now() });
      if (!event) { if (lineRecord && loaded.sourcePath) deadLetter(loaded.sourcePath, lineRecord, "onchain_schema_invalid"); return []; }
      return [{ event } satisfies ScannerObservation];
    });
    return { observations, status: "ready" as const, queueOldestAt: observations[0]?.event?.occurredAt ?? null, registryVersion: registry.version(), ...(loaded.commit ? { commit: loaded.commit } : {}) };
  } });
  if (input.config.onchainFilePath && input.monitoringRegistry) {
    const path = input.config.onchainFilePath;
    const reader = createJsonLineFileReader(path, { cursorPath: `${path}.scanner.cursor`, startAtEnd: input.config.fileStartAtEnd });
    collectors.push(makeOnchain("onchain-file", async () => { const batch = await reader.read(); if (!batch) return { records: [] }; for (const malformed of batch.records.filter(record => record.error)) deadLetter(path, malformed, malformed.error!); const lineRecords = batch.records.filter(record => Object.hasOwn(record, "value")); return { records: lineRecords.map(record => record.value as OnchainWalletRecord), lineRecords, sourcePath: path, commit: async () => { if (!(await reader.ack(batch))) throw new Error(`Unable to acknowledge ${path}`); } }; }));
  }
  if (input.config.onchainRpcEndpoint && input.monitoringRegistry) {
    const rpc = input.rpcClient ?? createJsonRpcClient({ endpoint: input.config.onchainRpcEndpoint, ...(input.config.onchainRpcFallbackEndpoint ? { fallbackEndpoint: input.config.onchainRpcFallbackEndpoint } : {}) });
    collectors.push(makeOnchain("onchain-rpc", async () => ({ records: await rpc.request<readonly OnchainWalletRecord[]>(input.config.onchainRpcMethod, []) })));
  }
  return Object.freeze(collectors);
}
