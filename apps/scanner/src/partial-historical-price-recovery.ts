import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DefiLlamaPriceError, type HistoricalTokenPriceResult } from "@address-radar/collectors";
import { createTokenFactStore, withAddressRadarWriteTransaction } from "@address-radar/database";

interface PriceRetentionInput {
  readonly database: DatabaseSync;
  readonly tokenId: string;
  readonly now: () => number;
}

function persistPriceProgress(partial: HistoricalTokenPriceResult, input: PriceRetentionInput,
  kind: "page-price" | "partial-price", message: string, status: number | null): void {
  if (!partial.prices.length) return;
  const separator = input.tokenId.indexOf(":");
  const chain = input.tokenId.slice(0, separator);
  const address = input.tokenId.slice(separator + 1);
  if (separator < 1 || !address || !["solana", "eth", "bsc", "base", "robinhood"].includes(chain)) {
    throw new Error("Invalid partial history token identity");
  }
  const at = input.now();
  if (!Number.isSafeInteger(at) || at < 0 || partial.prices.some(point =>
    !Number.isSafeInteger(point.observedAt) || point.observedAt < 0
    || !Number.isFinite(point.priceUsd) || point.priceUsd <= 0)) {
    throw new Error("Invalid partial historical price observation");
  }
  const startAt = Math.min(...partial.prices.map(point => point.observedAt));
  const endAt = Math.max(...partial.prices.map(point => point.observedAt));
  withAddressRadarWriteTransaction(input.database, () => {
    const insert = input.database.prepare(`INSERT OR IGNORE INTO market_observations
      (chain,token_address,observed_at,price_usd,source) VALUES (?,?,?,?,?)`);
    let written = 0;
    for (const point of partial.prices) {
      written += Number(insert.run(chain, chain === "solana" ? address : address.toLowerCase(),
        point.observedAt, point.priceUsd, partial.source).changes);
    }
    // A retry or error fallback must not count an already committed page twice.
    if (written === 0) return;
    const facts = createTokenFactStore(input.database);
    const existing = facts.fact(input.tokenId, "price_history");
    const current = facts.ensure(input.tokenId, "price_history", existing?.strategyVersion ?? "data-flow-v1", at);
    if (!["available", "conflicted", "terminal_unavailable"].includes(current.status)) {
      const sameSource = current.primarySource === partial.source;
      facts.transition({ tokenId: input.tokenId, factType: "price_history", status: "partial",
        precision: "derived", primarySource: partial.source,
        coverageStartAt: Math.min(startAt, sameSource ? current.coverageStartAt ?? startAt : startAt),
        coverageEndAt: Math.max(endAt, sameSource ? current.coverageEndAt ?? endAt : endAt),
        observedAt: Math.max(endAt, sameSource ? current.observedAt ?? endAt : endAt), knownAt: at,
        strategyVersion: current.strategyVersion, updatedAt: at });
    }
    facts.recordAttempt({ attemptId: `${kind}:${partial.source}:${input.tokenId}:${at}:${randomUUID()}`,
      tokenId: input.tokenId, factType: "price_history", provider: partial.source, outcome: "partial",
      startedAt: at, finishedAt: at, factsWritten: written, coverageStartAt: startAt,
      coverageEndAt: endAt, message,
      payload: { retainedPrices: partial.prices.length, confidence: partial.confidence, status } });
  }, { label: "retain-partial-historical-prices" });
}

export function persistHistoricalPricePage(page: HistoricalTokenPriceResult, input: PriceRetentionInput): void {
  persistPriceProgress(page, input, "page-price", "Historical price page committed", null);
}

export async function retainPartialHistoricalPrices<T>(result: Promise<T>, input: PriceRetentionInput): Promise<T> {
  try {
    return await result;
  } catch (error) {
    if (error instanceof DefiLlamaPriceError && error.partialResult?.prices.length) {
      persistPriceProgress(error.partialResult, input, "partial-price", error.message, error.status);
    }
    throw error;
  }
}
