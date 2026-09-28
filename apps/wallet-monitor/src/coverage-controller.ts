import type { MonitoredWallet } from "@address-radar/identity";
import type { WalletChainCoverage, WalletCoverageStatus } from "@address-radar/database";

import type { WalletCollector, WalletCollectorResult } from "./contracts.js";

export interface WalletCoverageWriter {
  checkpoint(source: string, partitionKey: string): string | null;
  recordCoverage(input: WalletChainCoverage): void;
}

export function recordCollectorCoverage(input: {
  readonly collector: Pick<WalletCollector, "name" | "chainFamily">;
  readonly wallets: readonly MonitoredWallet[];
  readonly result: WalletCollectorResult;
  readonly store: WalletCoverageWriter;
  readonly collectedAt: number;
}): void {
  const chain = collectorChain(input.collector);
  if (chain === null) return;

  const successes = new Map(
    input.result.partitions
      .filter((partition) => partition.partitionKey !== "schedule")
      .map((partition) => [partition.partitionKey, partition] as const),
  );
  const failures = new Map((input.result.failures ?? []).map((failure) => [failure.partitionKey, failure.error] as const));
  const diagnostics = new Map<string, Array<{ readonly reason: string; readonly sourceReference: string }>>();
  for (const diagnostic of input.result.diagnostics ?? []) {
    if (diagnostic.partitionKey === "schedule") continue;
    const values = diagnostics.get(diagnostic.partitionKey) ?? [];
    values.push({ reason: diagnostic.reason, sourceReference: diagnostic.sourceReference });
    diagnostics.set(diagnostic.partitionKey, values);
  }

  const sharedPartitionKey = `chain:${chain}`;
  const sharedSuccess = successes.get(sharedPartitionKey);
  const sharedFailure = failures.get(sharedPartitionKey);

  for (const wallet of input.wallets) {
    const partitionKey = input.collector.chainFamily === "solana"
      ? `wallet:${wallet.address}`
      : input.collector.name.startsWith("blockscout_wallet_")
        ? `${chain}:${wallet.address.toLowerCase()}`
        : sharedPartitionKey;
    const success = successes.get(partitionKey) ?? sharedSuccess;
    const failure = failures.get(partitionKey) ?? sharedFailure;
    if (!success && !failure) continue;

    const cursor = success?.nextCheckpoint ?? input.store.checkpoint(input.collector.name, partitionKey);
    const status = failure === undefined
      ? successfulStatus(input.collector.name, cursor)
      : failureStatus(failure);
    input.store.recordCoverage({
      identityId: wallet.accountId,
      chain,
      provider: input.collector.name,
      status,
      cursor,
      coverageStartAt: null,
      coverageEndAt: null,
      lastSuccessAt: success ? input.collectedAt : null,
      diagnostic: coverageDiagnostic({
        collector: input.collector,
        status,
        ...(failure === undefined ? {} : { failure }),
        diagnostics: diagnostics.get(partitionKey) ?? diagnostics.get(sharedPartitionKey) ?? [],
      }),
      updatedAt: input.collectedAt,
    });
  }
}

export function recordCollectorFailure(input: {
  readonly collector: Pick<WalletCollector, "name" | "chainFamily">;
  readonly wallets: readonly MonitoredWallet[];
  readonly error: string;
  readonly store: WalletCoverageWriter;
  readonly failedAt: number;
}): void {
  const chain = collectorChain(input.collector);
  if (chain === null) return;
  for (const wallet of input.wallets) {
    input.store.recordCoverage({
      identityId: wallet.accountId,
      chain,
      provider: input.collector.name,
      status: failureStatus(input.error),
      cursor: null,
      coverageStartAt: null,
      coverageEndAt: null,
      lastSuccessAt: null,
      diagnostic: {
        code: failureCode(input.error),
        error: input.error,
        scope: "provider",
      },
      updatedAt: input.failedAt,
    });
  }
}

function collectorChain(collector: Pick<WalletCollector, "name" | "chainFamily">): string | null {
  if (collector.chainFamily === "solana") return "solana";
  if (collector.name.startsWith("evm:")) return collector.name.slice("evm:".length);
  if (collector.name.startsWith("blockscout_wallet_")) return collector.name.slice("blockscout_wallet_".length);
  return null;
}

function successfulStatus(provider: string, cursor: string | null): WalletCoverageStatus {
  if (!provider.startsWith("blockscout_wallet_")) return "healthy";
  const checkpoint = parseCheckpoint(cursor);
  return checkpoint?.backfillComplete === true ? "complete" : "running";
}

function failureStatus(error: string): WalletCoverageStatus {
  return failureCode(error) === "provider_route_incompatible" ? "blocked" : "degraded";
}

function failureCode(error: string): string {
  if (/status\s+(404|405)|not[ _-]?found|unsupported route/i.test(error)) return "provider_route_incompatible";
  if (/status\s+429|rate[ _-]?limit/i.test(error)) return "provider_rate_limited";
  return "provider_error";
}

function coverageDiagnostic(input: {
  readonly collector: Pick<WalletCollector, "name" | "chainFamily">;
  readonly status: WalletCoverageStatus;
  readonly failure?: string;
  readonly diagnostics: readonly { readonly reason: string; readonly sourceReference: string }[];
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code: input.failure ? failureCode(input.failure) : "collector_progress",
    mode: input.collector.name.startsWith("blockscout_wallet_")
      ? "indexed_history"
      : input.collector.chainFamily === "solana"
        ? "signature_polling"
        : "live_block_monitoring",
    historicalCoverage: input.status === "complete" ? "complete" : "not_proven",
    ...(input.failure ? { error: input.failure } : {}),
    ...(input.diagnostics.length > 0 ? { observations: input.diagnostics } : {}),
  });
}

function parseCheckpoint(value: string | null): { readonly backfillComplete?: boolean } | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(value) as unknown;
    return decoded !== null && typeof decoded === "object"
      ? decoded as { readonly backfillComplete?: boolean }
      : null;
  } catch {
    return null;
  }
}
