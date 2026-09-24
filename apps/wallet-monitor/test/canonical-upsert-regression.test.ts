import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { openWalletMonitorStore } from "../src/store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("same event id in a replacement canonical block is restored exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "wallet-monitor-upsert-"));
  directories.push(directory);
  const path = join(directory, "radar.sqlite");
  const store = openWalletMonitorStore(path);
  store.persist("evm:eth", "chain:eth", [observation("old", "0xold")], "old", 1, [{ blockNumber: 10, blockHash: "0xold" }]);
  store.persist("evm:eth", "chain:eth", [observation("replacement", "0xnew")], "new", 2, [{ blockNumber: 10, blockHash: "0xnew" }]);
  store.close();

  const database = new DatabaseSync(path);
  const rows = database.prepare("SELECT source_reference AS sourceReference, source_block_hash AS blockHash, orphaned_at AS orphanedAt FROM wallet_monitor_observations WHERE source = ? AND event_id = ?").all("evm:eth", "same-event");
  expect(rows).toEqual([{ sourceReference: "replacement", blockHash: "0xnew", orphanedAt: null }]);
  database.close();
});

function observation(sourceReference: string, sourceBlockHash: string) {
  return { eventId: "same-event", chainFamily: "evm" as const, chain: "eth", walletAddress: "0xwallet", tokenAddress: "0xtoken", accountId: "account", entityId: "entity", side: "buy" as const, amountUsd: 1, priceUsd: 1, marketCapUsd: 1, occurredAt: 1, collectedAt: 1, source: "onchain" as const, sourceReference, sourceBlockNumber: 10, sourceBlockHash };
}
