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
  const directory = mkdtempSync(join(tmpdir(), "radar-execution-revision-"));
  directories.push(directory);
  const path = join(directory, "radar.db");
  const repository = openAddressRadarRepository(path);
  repository.upsertFomoAccount({ accountId: "account", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId: "entity", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId: "account", entityId: "entity", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.close();
  return path;
}
function observation(amount: number, collectedAt: number) {
  return { source: "solana", eventId: "sig:1", chainFamily: "solana" as const, chain: "solana",
    walletAddress: "WalletCase", tokenAddress: "TokenCase", accountId: "account", entityId: "entity",
    side: "buy" as const, amountUsd: amount, priceUsd: amount / 100, marketCapUsd: null,
    occurredAt: 100, collectedAt, sourceReference: "solana:sig",
    executionBasis: deriveExecutionBasis({ successful: true, swapConfirmed: true,
      tokenDeltas: [{ asset: "TokenCase", quantity: 100 }],
      quoteDeltas: [{ asset: "verified-usdc", symbol: "USDC", quantity: -amount, verifiedStablecoin: true }] }),
  };
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return {
    wallet: db.prepare("SELECT amount_usd,price_usd,entity_id FROM wallet_monitor_observations").get(),
    event: db.prepare("SELECT amount_usd,price_usd,entity_id FROM trader_events").get(),
    raw: db.prepare("SELECT amount_usd FROM raw_trader_observations").get(),
    canonical: db.prepare("SELECT amount_usd FROM canonical_trader_events").get(),
  }; } finally { db.close(); }
}

describe("audited wallet execution revision loop", () => {
  it("propagates a corrected real execution through derived event and canonical views", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 200);
    store.persist("solana", "WalletCase", [observation(90, 300)], "cursor", 300);
    store.close();
    expect(rows(path)).toMatchObject({ wallet: { amount_usd: 90, price_usd: 0.9 },
      event: { amount_usd: 90, price_usd: 0.9 }, raw: { amount_usd: 90 }, canonical: { amount_usd: 90 } });
  });

  it("does not let an older execution replay downgrade stored values", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(90, 300)], "cursor", 300);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 400);
    store.close();
    expect(rows(path)).toMatchObject({ wallet: { amount_usd: 90, price_usd: 0.9 },
      event: { amount_usd: 90, price_usd: 0.9 } });
  });

  it("preserves the original wallet identity on a conflicting replay", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 200);
    store.persist("solana", "WalletCase", [{ ...observation(90, 300), entityId: "different-owner" }], "cursor", 300);
    store.close();
    expect(rows(path)).toMatchObject({ wallet: { entity_id: "entity", amount_usd: 60 },
      event: { entity_id: "entity", amount_usd: 60 } });
  });
});

describe("execution revision safety and durable handoff", () => {
  it("preserves the original ledger payload and queues durable consumer requests", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 200);
    store.persist("solana", "WalletCase", [observation(90, 300)], "cursor", 300);
    store.persist("solana", "WalletCase", [observation(90, 400)], "cursor", 400);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='execution_revision_requests'").get()).toBeDefined();
      expect(db.prepare("SELECT revision FROM trader_execution_heads WHERE event_id='sig:1'").get()).toEqual({ revision: 2 });
      const requests = db.prepare("SELECT consumer_type,desired_revision,applied_revision FROM execution_revision_requests ORDER BY consumer_type").all();
      expect(requests).toHaveLength(5);
      expect(requests.every(r => r.desired_revision === 2 && r.applied_revision === 0)).toBe(true);
      const original = db.prepare("SELECT payload FROM source_observations ORDER BY collected_at LIMIT 1").get() as { payload: string };
      expect(JSON.parse(original.payload).amountUsd).toBe(60);
      expect(db.prepare("SELECT COUNT(*) n FROM trader_execution_revisions WHERE event_id='sig:1'").get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });

  it("does not replace a valid execution basis with an unavailable basis", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 200);
    store.persist("solana", "WalletCase", [{ ...observation(60, 300), executionBasis: deriveExecutionBasis({
      successful: null, swapConfirmed: false, tokenDeltas: [], quoteDeltas: [],
    }) }], "cursor", 300);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const value = db.prepare("SELECT basis_json FROM wallet_monitor_execution_bases").get() as { basis_json: string };
      expect(JSON.parse(value.basis_json).status).toBe("estimated");
    } finally { db.close(); }
  });

  it("does not accept an execution basis for a different token", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 200);
    const other = deriveExecutionBasis({ successful: true, swapConfirmed: true,
      tokenDeltas: [{ asset: "DifferentToken", quantity: 100 }],
      quoteDeltas: [{ asset: "verified-usdc", symbol: "USDC", quantity: -90, verifiedStablecoin: true }] });
    store.persist("solana", "WalletCase", [{ ...observation(90, 300), executionBasis: other }], "cursor", 300);
    store.close();
    expect(rows(path)).toMatchObject({ wallet: { amount_usd: 60 }, event: { amount_usd: 60 } });
  });

  it("quarantines a revision conflicting with an already linked Fomo counterpart", () => {
    const path = setup(); const repository = openAddressRadarRepository(path);
    repository.insertTraderEvent({ eventId: "fomo:1", accountId: "account", entityId: "entity",
      chain: "solana", tokenAddress: "TokenCase", side: "buy", amountUsd: 60, priceUsd: 0.6,
      marketCapUsd: null, tokenAgeMs: null, occurredAt: 100, collectedAt: 150, source: "fomo_stream" });
    repository.close();
    const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(60, 200)], "cursor", 200);
    store.persist("solana", "WalletCase", [observation(90, 300)], "cursor", 300);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT amount_usd FROM trader_events WHERE event_id='sig:1'").get()).toEqual({ amount_usd: 60 });
      expect(db.prepare("SELECT amount_usd FROM canonical_trader_events").get()).toEqual({ amount_usd: 60 });
      expect(db.prepare("SELECT projected_at FROM wallet_monitor_observations").get()).toEqual({ projected_at: null });
      expect(db.prepare("SELECT projection_state FROM trader_execution_heads WHERE event_id='sig:1'").get()).toEqual({ projection_state: "review_required" });
    } finally { db.close(); }
  });

  it("does not regress execution price history through a duplicate repository replay", () => {
    const path = setup(); const store = openWalletMonitorStore(path);
    store.persist("solana", "WalletCase", [observation(90, 300)], "cursor", 300);
    store.close();
    const repository = openAddressRadarRepository(path);
    repository.insertTraderEvent({ eventId: "sig:1", accountId: "account", entityId: "entity",
      chain: "solana", tokenAddress: "TokenCase", side: "buy", amountUsd: 60, priceUsd: 0.6,
      marketCapUsd: null, tokenAgeMs: null, occurredAt: 100, collectedAt: 200, source: "onchain_wallet" });
    repository.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT price_usd FROM market_observations WHERE source='trader_event:onchain_wallet'").get()).toEqual({ price_usd: 0.9 });
    } finally { db.close(); }
  });
});
