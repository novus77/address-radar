import { describe, expect, it } from "vitest";

import {
  createTradeEventIngestor,
  importFomoHistoryEvent,
  normalizeFomoHistoryLine,
  normalizeOnchainWalletRecord,
  parseFomoHistoryEvent,
} from "@address-radar/collectors";

const fomoLine = JSON.stringify({
  kind: "event",
  value: {
    eventType: "fomo.activity.buy",
    eventId: "fomo-1",
    payload: {
      trader: { id: "account-1", handle: "@Alpha" },
      asset: { chain: "BASE", tokenAddress: "0xAbC" },
      action: "buy",
      usdAmount: 25,
      price: 0.5,
      marketCap: 1_000,
      occurredAt: 2_000,
      sourceTradeId: "trade-1",
    },
  },
});

describe("trade event normalization", () => {
  it("normalizes Fomo history into the domain trade contract", () => {
    expect(normalizeFomoHistoryLine(fomoLine, { collectedAt: 2_100 })).toEqual({
      eventId: "fomo-1",
      accountId: "account-1",
      entityId: "fomo:account-1",
      chain: "base",
      tokenAddress: "0xabc",
      side: "buy",
      amountUsd: 25,
      priceUsd: 0.5,
      marketCapUsd: 1_000,
      tokenAgeMs: null,
      occurredAt: 2_000,
      collectedAt: 2_100,
      source: "fomo_token_history",
    });
  });

  it("normalizes on-chain input to the same contract while preserving source provenance", () => {
    expect(normalizeOnchainWalletRecord({
      eventId: "chain-1",
      transactionHash: "0xtx",
      chainFamily: "evm",
      chain: "BASE",
      walletAddress: "0xFfF",
      tokenAddress: "0xAbC",
      side: "buy",
      amountUsd: 30,
      priceUsd: 0.6,
      marketCapUsd: 1_200,
      occurredAt: 3_000,
    }, { accountId: "account-1", entityId: "entity-1", collectedAt: 3_100 })).toEqual({
      eventId: "chain-1",
      accountId: "account-1",
      entityId: "entity-1",
      chain: "base",
      tokenAddress: "0xabc",
      side: "buy",
      amountUsd: 30,
      priceUsd: 0.6,
      marketCapUsd: 1_200,
      tokenAgeMs: null,
      occurredAt: 3_000,
      collectedAt: 3_100,
      source: "onchain_wallet",
    });
  });

  it("keeps Solana token and wallet addresses case-sensitive", () => {
    const event = normalizeOnchainWalletRecord({
      eventId: "sol-1",
      chainFamily: "solana",
      chain: "SOLANA",
      walletAddress: "  WalletCase  ",
      tokenAddress: "  MintCase  ",
      side: "sell",
      occurredAt: 4_000,
    }, { accountId: "account-1", entityId: "entity-1", collectedAt: 4_100 });

    expect(event?.tokenAddress).toBe("MintCase");
    expect(event?.chain).toBe("solana");
  });

  it("trims EVM addresses before lowercasing", () => {
    const event = normalizeOnchainWalletRecord({
      eventId: "evm-whitespace",
      chainFamily: "evm",
      chain: " BASE ",
      walletAddress: "  0xFfF  ",
      tokenAddress: "  0xAbC  ",
      side: "buy",
      occurredAt: 5_000,
    }, { accountId: "account-1", entityId: "entity-1", collectedAt: 5_100 });

    expect(event?.chain).toBe("base");
    expect(event?.tokenAddress).toBe("0xabc");
  });

  it("rejects malformed external events", () => {
    expect(normalizeFomoHistoryLine("not json", { collectedAt: 1 })).toBeNull();
    expect(normalizeOnchainWalletRecord({ eventId: "bad", occurredAt: -1 }, {
      accountId: "account-1",
      entityId: "entity-1",
      collectedAt: 1,
    })).toBeNull();
  });

  it("requires the Fomo event type to match its action exactly", () => {
    const mismatched = fomoLine.replace("fomo.activity.buy", "fomo.activity.sell");
    const suffixed = fomoLine.replace("fomo.activity.buy", "fomo.activity.buy.extra");
    expect(parseFomoHistoryEvent(mismatched)).toBeNull();
    expect(parseFomoHistoryEvent(suffixed)).toBeNull();
  });

  it("normalizes negative Fomo financial values to null", () => {
    const value = JSON.parse(fomoLine) as { value: { payload: { usdAmount: number; price: number; marketCap: number } } };
    value.value.payload.usdAmount = -1;
    value.value.payload.price = -2;
    value.value.payload.marketCap = -3;

    expect(parseFomoHistoryEvent(JSON.stringify(value))).toMatchObject({ amountUsd: null, priceUsd: null, marketCapUsd: null });
  });
});

describe("trade event ingestion", () => {
  it("reports duplicate event ids without applying aggregation decisions", async () => {
    const seen = new Set<string>();
    const ingestor = createTradeEventIngestor({
      insertTraderEvent: event => {
        const inserted = !seen.has(event.eventId);
        seen.add(event.eventId);
        return { inserted };
      },
    });
    const event = normalizeFomoHistoryLine(fomoLine, { collectedAt: 2_100 })!;

    await expect(ingestor.ingest([event, event])).resolves.toEqual({ inserted: 1, duplicates: 1 });
  });

  it("reuses the canonical account for a known handle when the upstream account id changes", () => {
    const event = parseFomoHistoryEvent(fomoLine)!;
    const insertedEvents: unknown[] = [];
    const repository = {
      accountByHandle: () => ({ accountId: "canonical-account", handle: "alpha" }),
      upsertFomoAccount: () => undefined,
      ensureTraderEntity: () => undefined,
      linkAccountToEntity: () => undefined,
      insertTraderEvent: (inserted: unknown) => { insertedEvents.push(inserted); return { inserted: true }; },
    };

    expect(importFomoHistoryEvent(repository, { ...event, accountId: "changed-upstream-id" }, 2_100)).toBe(true);
    expect(insertedEvents).toEqual([expect.objectContaining({ accountId: "canonical-account", entityId: "fomo:canonical-account" })]);
  });

  it("persists account, entity, and identity link before inserting the event", () => {
    const event = parseFomoHistoryEvent(fomoLine)!;
    const calls: string[] = [];
    const repository = {
      accountByHandle: () => null,
      upsertFomoAccount: (value: unknown) => { calls.push("account"); expect(value).toMatchObject({ accountId: "account-1", handle: "alpha" }); },
      ensureTraderEntity: (value: unknown) => { calls.push("entity"); expect(value).toMatchObject({ entityId: "fomo:account-1", lifecycle: "suspended" }); },
      linkAccountToEntity: (value: unknown) => { calls.push("link"); expect(value).toMatchObject({ accountId: "account-1", entityId: "fomo:account-1", source: "fomo_token_history" }); },
      insertTraderEvent: (value: unknown) => { calls.push("event"); expect(value).toMatchObject({ eventId: "fomo-1", source: "fomo_token_history" }); return { inserted: true }; },
    };

    expect(importFomoHistoryEvent(repository, event, 2_100)).toBe(true);
    expect(calls).toEqual(["account", "entity", "link", "event"]);
  });
});
