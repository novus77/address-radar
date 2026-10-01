import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openAddressRadarRepository } from "@address-radar/database";
import { openWalletMonitorStore } from "../src/store.js";
import { deriveExecutionBasis } from "../src/execution-basis.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "radar-execution-provenance-"));
  directories.push(directory);
  return join(directory, "radar.db");
}
function identity(path: string) {
  const repository = openAddressRadarRepository(path);
  repository.upsertFomoAccount({ accountId: "account", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId: "entity", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId: "account", entityId: "entity", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.close();
}
const basis = deriveExecutionBasis({ successful: true, swapConfirmed: true,
  tokenDeltas: [{ asset: "TokenCase", quantity: 100 }],
  quoteDeltas: [{ asset: "verified-usdc", symbol: "USDC", quantity: -60, verifiedStablecoin: true }],
});
const observation = {
  source: "solana", eventId: "sig:1", chainFamily: "solana" as const, chain: "solana",
  walletAddress: "WalletCase", tokenAddress: "TokenCase", accountId: "account", entityId: "entity",
  side: "buy" as const, amountUsd: 60, priceUsd: 0.6, marketCapUsd: null,
  occurredAt: 100, collectedAt: 200, sourceReference: "solana:sig", executionBasis: basis,
};

describe("execution provenance persistence", () => {
  it("preserves estimates through restart and delayed identity projection", () => {
    const path = setup();
    let store = openWalletMonitorStore(path);
    store.persist("solana", "wallet", [observation], "cursor", 200);
    store.close();
    identity(path);
    store = openWalletMonitorStore(path);
    expect(store.observations()[0]).toMatchObject({ executionBasis: basis });
    store.persist("solana", "wallet", [], "cursor", 300);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT provenance FROM source_observations").get() as { provenance: string };
    expect(JSON.parse(row.provenance).executionBasis).toEqual(basis);
    db.close();
  });
  it("does not duplicate source events when the same observation is replayed", () => {
    const path = setup();
    identity(path);
    const store = openWalletMonitorStore(path);
    store.persist("solana", "wallet", [observation], "cursor", 200);
    store.persist("solana", "wallet", [observation], "cursor", 300);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT count(*) n FROM source_observations").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) n FROM wallet_monitor_execution_bases").get()).toEqual({ n: 1 });
    db.close();
  });
  it("adds late basis enrichment without creating a second trade", () => {
    const path = setup();
    identity(path);
    const store = openWalletMonitorStore(path);
    const { executionBasis: _basis, ...legacy } = observation;
    store.persist("solana", "wallet", [legacy], "cursor", 200);
    store.persist("solana", "wallet", [observation], "cursor", 300);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT count(*) n FROM trader_events").get()).toEqual({ n: 1 });
    const row = db.prepare("SELECT provenance_json FROM source_observation_enrichments ORDER BY revision DESC LIMIT 1").get() as { provenance_json: string };
    expect(JSON.parse(row.provenance_json).executionBasis).toEqual(basis);
    db.close();
  });
});
