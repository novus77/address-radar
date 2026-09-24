import type { ChainFamily } from "@address-radar/domain";
import type { MonitoredWallet, MonitoringRegistry } from "@address-radar/identity";
import type { NormalizedWalletObservation, WalletCollector, WalletCollectorEvent } from "./contracts.js";
import type { WalletMonitorStore } from "./store.js";

export function createWalletMonitorRuntime(input: {
  readonly registry: MonitoringRegistry;
  readonly store: WalletMonitorStore;
  readonly collectors: readonly WalletCollector[];
  readonly consumer: string;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let appliedVersion = -1;
  let wallets: Readonly<Record<ChainFamily, readonly MonitoredWallet[]>> = Object.freeze({ evm: Object.freeze([]), solana: Object.freeze([]) });

  const reloadRegistry = () => {
    const version = input.registry.version();
    if (version === appliedVersion) return;
    wallets = Object.freeze({ evm: input.registry.wallets("evm"), solana: input.registry.wallets("solana") });
    input.registry.acknowledge(input.consumer, version, now());
    appliedVersion = version;
  };

  return Object.freeze({
    async pollOnce(signal: AbortSignal = new AbortController().signal) {
      reloadRegistry();
      let accepted = 0;
      let providerFailures = 0;
      const results = await Promise.allSettled(input.collectors.map(async collector => {
        const monitored = wallets[collector.chainFamily];
        const result = await collector.collect({ wallets: monitored, cursor: input.store.cursor(collector.name), signal });
        const normalized = result.events.flatMap(event => normalize(event, collector.name, collector.chainFamily, monitored, now()));
        const cursor = result.events.at(-1)?.cursor ?? input.store.cursor(collector.name);
        accepted += input.store.persist(collector.name, normalized, cursor, now());
      }));
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") continue;
        providerFailures += 1;
        input.store.recordFailure(input.collectors[index]!.name, result.reason instanceof Error ? result.reason.message : String(result.reason), now());
      }
      return Object.freeze({ accepted, providerFailures, registryVersion: appliedVersion });
    },
  });
}

function normalize(event: WalletCollectorEvent, source: string, chainFamily: ChainFamily, wallets: readonly MonitoredWallet[], collectedAt: number): readonly NormalizedWalletObservation[] {
  if (!event.eventId.trim() || !event.cursor.trim() || !event.sourceReference.trim() || !Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) return [];
  const normalizeAddress = (value: string) => chainFamily === "evm" ? value.trim().toLowerCase() : value.trim();
  const walletAddress = normalizeAddress(event.walletAddress);
  const wallet = wallets.find(candidate => normalizeAddress(candidate.address) === walletAddress);
  if (!wallet) return [];
  const tokenAddress = normalizeAddress(event.tokenAddress);
  if (!tokenAddress) return [];
  return [Object.freeze({
    ...event,
    source,
    chainFamily,
    chain: event.chain.trim().toLowerCase(),
    walletAddress,
    tokenAddress,
    accountId: wallet.accountId,
    entityId: wallet.entityId,
    collectedAt,
  })];
}
