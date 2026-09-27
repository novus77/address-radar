import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("historical wallet materialization", () => {
  it("idempotently admits an accepted unknown wallet as a monitored candidate", () => {
    const directory = mkdtempSync(join(tmpdir(), "historical-wallet-materialization-"));
    directories.push(directory);
    const path = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    const database = openAddressRadarDatabase(path);

    const input = { traderId: "wallet:base:0xabc", chain: "base", address: "0xAbC", observedAt: 100, strategyVersion: "candidate-history-v3" } as const;
    repository.admitHistoricalWalletCandidate(input);
    repository.admitHistoricalWalletCandidate({ ...input, observedAt: 200 });

    expect(database.prepare("SELECT lifecycle, manual, locked FROM trader_entities WHERE entity_id = ?").get(input.traderId)).toEqual({ lifecycle: "candidate", manual: 0, locked: 0 });
    expect(database.prepare("SELECT chain_family AS chainFamily, address, source FROM entity_wallet_identities WHERE entity_id = ?").all(input.traderId)).toEqual([{ chainFamily: "evm", address: "0xabc", source: "historical_milestone" }]);
    expect(database.prepare("SELECT policy FROM trader_monitoring_policy WHERE trader_id = ?").get(input.traderId)).toEqual({ policy: "periodic" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM trader_sources WHERE entity_id = ? AND source_key = 'milestone'").get(input.traderId)).toEqual({ count: 1 });
    database.close();
    repository.close();
  });
});
