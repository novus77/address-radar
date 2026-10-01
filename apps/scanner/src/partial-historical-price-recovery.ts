import type { DatabaseSync } from "node:sqlite";
import { DefiLlamaPriceError } from "@address-radar/collectors";
import { createTokenFactStore, withAddressRadarWriteTransaction } from "@address-radar/database";

export async function retainPartialHistoricalPrices<T>(result: Promise<T>, input: {
  readonly database: DatabaseSync;
  readonly tokenId: string;
  readonly now: () => number;
}): Promise<T> {
  try {
    return await result;
  } catch (error) {
    if (!(error instanceof DefiLlamaPriceError) || !error.partialResult?.prices.length) throw error;
    const partial = error.partialResult;
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
      const facts = createTokenFactStore(input.database);
      const existing = facts.fact(input.tokenId, "price_history");
      const current = facts.ensure(input.tokenId, "price_history", existing?.strategyVersion ?? "data-flow-v1", at);
      // Partial-page progress must not overwrite another range's available or terminal status.
      if (!["available", "conflicted", "terminal_unavailable"].includes(current.status)) {
        facts.transition({ tokenId: input.tokenId, factType: "price_history", status: "partial",
          precision: "derived", primarySource: partial.source, coverageStartAt: startAt,
          coverageEndAt: endAt, observedAt: endAt, knownAt: at,
          strategyVersion: current.strategyVersion, updatedAt: at });
      }
      facts.recordAttempt({ attemptId: `partial-price:${partial.source}:${input.tokenId}:${at}`,
        tokenId: input.tokenId, factType: "price_history", provider: partial.source, outcome: "partial",
        startedAt: at, finishedAt: at, factsWritten: written, coverageStartAt: startAt,
        coverageEndAt: endAt, message: error.message,
        payload: { retainedPrices: partial.prices.length, confidence: partial.confidence, status: error.status } });
    }, { label: "retain-partial-historical-prices" });
    throw error;
  }
}
