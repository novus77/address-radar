import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { createWalletMonitorRuntime, openWalletMonitorStore } from "../src/index.js";
import type { WalletCollector } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("Solana partition failures persist degraded partial and total health", async () => {
  const directory = mkdtempSync(join(tmpdir(), "address-radar-health-"));
  directories.push(directory);
  const store = openWalletMonitorStore(join(directory, "monitor.sqlite"));
  const registry = {
    version: () => 1,
    wallets: () => [
      { address: "wallet-1", accountId: "account-1", entityId: "entity-1", lifecycle: "active" as const },
      { address: "wallet-2", accountId: "account-2", entityId: "entity-2", lifecycle: "active" as const },
    ],
    acknowledge: () => undefined,
    close: () => undefined,
  };
  let allFail = false;
  const collector: WalletCollector = {
    name: "solana",
    chainFamily: "solana",
    async collect() {
      return allFail
        ? { partitions: [], failures: [{ partitionKey: "wallet:wallet-1", error: "rpc down" }, { partitionKey: "wallet:wallet-2", error: "rpc down" }] }
        : { partitions: [{ partitionKey: "wallet:wallet-1", nextCheckpoint: "one", events: [] }], failures: [{ partitionKey: "wallet:wallet-2", error: "rate limited" }] };
    },
  };
  const runtime = createWalletMonitorRuntime({ registry, store, collectors: [collector], consumer: "test", now: () => allFail ? 2_000 : 1_000 });

  await runtime.pollOnce();
  assert.deepEqual(store.providerStatus("solana"), {
    source: "solana",
    status: "degraded",
    successfulPartitions: 1,
    failedPartitions: 1,
    lastError: "wallet:wallet-2: rate limited",
    updatedAt: 1_000,
  });

  allFail = true;
  await runtime.pollOnce();
  assert.deepEqual(store.providerStatus("solana"), {
    source: "solana",
    status: "degraded",
    successfulPartitions: 0,
    failedPartitions: 2,
    lastError: "wallet:wallet-1: rpc down; wallet:wallet-2: rpc down",
    updatedAt: 2_000,
  });
  store.close();
});
