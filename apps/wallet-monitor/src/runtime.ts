import type { MonitoringRegistry, MonitoredWallet } from "@address-radar/identity";

import type { NormalizedWalletObservation, WalletCollector } from "./contracts.js";
import type { WalletMonitorStore } from "./store.js";

export function createWalletMonitorRuntime(input: {
  readonly registry: MonitoringRegistry;
  readonly store: WalletMonitorStore;
  readonly collectors: readonly WalletCollector[];
  readonly consumer: string;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let registryVersion = -1;
  let walletsByFamily: Readonly<Record<"evm" | "solana", readonly MonitoredWallet[]>> = {
    evm: [],
    solana: [],
  };

  const reload = () => {
    const version = input.registry.version();
    if (version === registryVersion) return;
    walletsByFamily = {
      evm: input.registry.wallets("evm"),
      solana: input.registry.wallets("solana"),
    };
    registryVersion = version;
    input.registry.acknowledge(input.consumer, version, now());
  };

  return {
    async pollOnce(signal = new AbortController().signal) {
      reload();
      let accepted = 0;
      let providerFailures = 0;
      const settled = await Promise.allSettled(input.collectors.map(async (collector) => {
        const wallets = walletsByFamily[collector.chainFamily];
        const result = await collector.collect({
          wallets,
          checkpoint: (partitionKey) => input.store.checkpoint(collector.name, partitionKey),
          signal,
        });
        const collectedAt = now();
        for (const partition of result.partitions) {
          const observations = normalize(partition.events, wallets, collector.name, collector.chainFamily, collectedAt);
          accepted += input.store.persist(
            collector.name,
            partition.partitionKey,
            observations,
            partition.nextCheckpoint,
            collectedAt,
          );
        }
        const failures = result.failures ?? [];
        providerFailures += failures.length;
        input.store.recordDiagnostics(collector.name, result.diagnostics ?? [], collectedAt);
        input.store.recordProviderResult(
          collector.name,
          result.partitions.map((partition) => partition.partitionKey).filter((key) => key !== "schedule"),
          failures,
          collectedAt,
        );
      }));
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        if (signal.aborted) throw result.reason;
        providerFailures += 1;
        const collector = input.collectors[index]!;
        input.store.recordFailure(
          collector.name,
          result.reason instanceof Error ? result.reason.message : String(result.reason),
          now(),
        );
      });
      return { accepted, providerFailures, registryVersion };
    },
  };
}

function normalize(
  events: readonly Omit<NormalizedWalletObservation, "source" | "chainFamily" | "accountId" | "entityId" | "collectedAt">[],
  wallets: readonly MonitoredWallet[],
  source: string,
  chainFamily: "evm" | "solana",
  collectedAt: number,
): NormalizedWalletObservation[] {
  const ownership = new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
  return events.flatMap((event) => {
    const wallet = ownership.get(event.walletAddress.toLowerCase());
    if (!wallet) return [];
    return [{
      ...event,
      chain: event.chain.toLowerCase(),
      walletAddress: chainFamily === "evm" ? event.walletAddress.toLowerCase() : event.walletAddress,
      tokenAddress: chainFamily === "evm" ? event.tokenAddress.toLowerCase() : event.tokenAddress,
      source,
      chainFamily,
      accountId: wallet.accountId,
      entityId: wallet.entityId,
      collectedAt,
    }];
  });
}
