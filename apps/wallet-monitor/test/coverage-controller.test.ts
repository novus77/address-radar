import { describe, expect, it } from "vitest";
import type { MonitoredWallet } from "@address-radar/identity";
import type { WalletChainCoverage } from "@address-radar/database";

import { recordCollectorCoverage, recordCollectorFailure } from "../src/coverage-controller.js";

const wallet: MonitoredWallet = {
  address: "0xABCDEF",
  accountId: "account-1",
  entityId: "entity-1",
  lifecycle: "active",
};

function capture() {
  const records: WalletChainCoverage[] = [];
  return {
    records,
    store: {
      checkpoint: () => null,
      recordCoverage: (input: WalletChainCoverage) => records.push(input),
    },
  };
}

describe("wallet coverage controller", () => {
  it("records indexed history as running until backfill completes", () => {
    const target = capture();
    recordCollectorCoverage({
      collector: { name: "blockscout_wallet_base", chainFamily: "evm" },
      wallets: [wallet],
      result: {
        partitions: [{
          partitionKey: "base:0xabcdef",
          nextCheckpoint: JSON.stringify({ backfillComplete: false }),
          events: [],
        }],
      },
      store: target.store,
      collectedAt: 100,
    });

    expect(target.records).toHaveLength(1);
    expect(target.records[0]).toMatchObject({
      identityId: "account-1",
      chain: "base",
      provider: "blockscout_wallet_base",
      status: "running",
      lastSuccessAt: 100,
    });
  });

  it("records completed indexed history explicitly", () => {
    const target = capture();
    recordCollectorCoverage({
      collector: { name: "blockscout_wallet_base", chainFamily: "evm" },
      wallets: [wallet],
      result: {
        partitions: [{
          partitionKey: "base:0xabcdef",
          nextCheckpoint: JSON.stringify({ backfillComplete: true }),
          events: [],
        }],
      },
      store: target.store,
      collectedAt: 200,
    });

    expect(target.records[0]).toMatchObject({ status: "complete" });
    expect(target.records[0]?.diagnostic).toMatchObject({ historicalCoverage: "complete" });
  });

  it("classifies an incompatible indexed route as blocked", () => {
    const target = capture();
    recordCollectorCoverage({
      collector: { name: "blockscout_wallet_bsc", chainFamily: "evm" },
      wallets: [wallet],
      result: {
        partitions: [],
        failures: [{ partitionKey: "bsc:0xabcdef", error: "Blockscout wallet request failed with status 404" }],
      },
      store: target.store,
      collectedAt: 300,
    });

    expect(target.records[0]).toMatchObject({ status: "blocked" });
    expect(target.records[0]?.diagnostic).toMatchObject({ code: "provider_route_incompatible" });
  });

  it("does not claim historical coverage for a healthy live RPC collector", () => {
    const target = capture();
    recordCollectorCoverage({
      collector: { name: "evm:eth", chainFamily: "evm" },
      wallets: [wallet],
      result: {
        partitions: [{ partitionKey: "chain:eth", nextCheckpoint: "{\"blockNumber\":10}", events: [] }],
      },
      store: target.store,
      collectedAt: 400,
    });

    expect(target.records[0]).toMatchObject({ status: "healthy" });
    expect(target.records[0]?.diagnostic).toMatchObject({
      mode: "live_block_monitoring",
      historicalCoverage: "not_proven",
    });
  });

  it("records collector-level failures for every affected wallet", () => {
    const target = capture();
    recordCollectorFailure({
      collector: { name: "solana", chainFamily: "solana" },
      wallets: [{ ...wallet, address: "sol-wallet" }],
      error: "RPC rate limit exceeded",
      store: target.store,
      failedAt: 500,
    });

    expect(target.records[0]).toMatchObject({
      chain: "solana",
      status: "degraded",
      diagnostic: { code: "provider_rate_limited", scope: "provider" },
    });
  });
});
