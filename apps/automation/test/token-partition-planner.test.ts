import { describe, expect, it } from "vitest";

import {
  partitionHistoricalTokens,
  selectHistoricalTokenMiningRound,
  type HistoricalTokenSeed,
} from "../src/token-partition-planner.js";

const WEEK = 7 * 24 * 60 * 60_000;
const ANCHOR = Date.parse("2026-08-09T16:00:00.000Z");

describe("historical token partition planner", () => {
  it("keeps five chains, canonicalizes aliases, deduplicates, and caps batches at 50", () => {
    const tokens: HistoricalTokenSeed[] = [
      token("solana", "SoLCase", ANCHOR + 1),
      token("sol", "SoLCase", ANCHOR + 2),
      token("ethereum", "0xABC", ANCHOR + 3),
      token("eth", "0xabc", ANCHOR + 4),
      token("bnb", "0xBSC", ANCHOR + 5),
      token("base", "0xBASE", ANCHOR + 6),
      token("robinhood", "0xR", ANCHOR + 7),
      token("monad", "0xNO", ANCHOR + 8),
      ...Array.from({ length: 51 }, (_, index) =>
        token("bsc", `0x${index.toString(16).padStart(40, "0")}`, ANCHOR + 10)),
    ];

    const partitions = partitionHistoricalTokens(tokens, { anchorAt: ANCHOR });

    expect(new Set(partitions.map((partition) => partition.chain))).toEqual(
      new Set(["solana", "eth", "bsc", "base", "robinhood"]),
    );
    expect(partitions.every((partition) => partition.tokens.length <= 50)).toBe(true);
    expect(partitions.every((partition) => partition.weekEnd - partition.weekStart === WEEK)).toBe(true);
    expect(partitions.flatMap((partition) => partition.tokens)
      .filter((item) => item.tokenId === "solana:SoLCase")).toHaveLength(1);
    expect(partitions.flatMap((partition) => partition.tokens)
      .filter((item) => item.tokenId === "eth:0xabc")).toHaveLength(1);
    expect(partitions.filter((partition) => partition.chain === "bsc").length).toBe(2);
  });

  it("reserves every active chain then favors the most recent fourteen days", () => {
    const now = ANCHOR + 8 * WEEK;
    const tokens: HistoricalTokenSeed[] = [];
    for (const chain of ["solana", "bsc", "eth", "base", "robinhood"] as const) {
      tokens.push(token(chain, `${chain}-old`, ANCHOR + 1));
      tokens.push(token(chain, `${chain}-recent`, now - 24 * 60 * 60_000));
    }
    for (let index = 0; index < 8; index += 1) {
      tokens.push(token("solana", `recent-${index}`, now - index * WEEK));
    }
    const partitions = partitionHistoricalTokens(tokens, { anchorAt: ANCHOR });

    const selected = selectHistoricalTokenMiningRound(partitions, {
      capacity: 10,
      now,
    });

    expect(new Set(selected.map((partition) => partition.chain))).toEqual(
      new Set(["solana", "bsc", "eth", "base", "robinhood"]),
    );
    const remainingAfterChainReservations = selected.slice(5);
    const recent = remainingAfterChainReservations.filter(
      (partition) => partition.weekEnd > now - 14 * 24 * 60 * 60_000,
    );
    expect(recent.length).toBeGreaterThanOrEqual(4);
  });
});

function token(chain: string, address: string, reachedAt: number): HistoricalTokenSeed {
  return {
    chain,
    tokenAddress: address,
    firstReached1mAt: reachedAt,
    peakMarketCapUsd: 1_500_000,
  };
}
