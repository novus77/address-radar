import { createHash } from "node:crypto";

import type { CandidateHistoryStore } from "@address-radar/database";
import { evaluateCandidateAdmission, strongestSatisfiedTier } from "@address-radar/scoring";

export interface HistoricalTradeEvidenceRow {
  readonly eventId: string;
  readonly economicKey: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly traderAddress: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number;
  readonly marketCapUsd: number;
  readonly occurredAt: number;
  readonly source: string;
  readonly capturableMultiple?: number | null;
  readonly realizedMultiple?: number | null;
}

const finitePositive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const normalizeAddress = (chain: string, value: string): string => chain === "solana" ? value.trim() : value.trim().toLowerCase();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

interface EconomicTrade {
  readonly row: HistoricalTradeEvidenceRow;
  readonly sourceEventIds: Set<string>;
}

export function createHistoricalEvidenceService(input: {
  readonly store: CandidateHistoryStore;
  readonly resolveTraderId: (chain: string, traderAddress: string) => string | null;
  readonly strategyVersion: string;
}) {
  return Object.freeze({
    ingest(rows: readonly HistoricalTradeEvidenceRow[], evaluatedAt: number) {
      const economicTrades = new Map<string, EconomicTrade>();
      let duplicateEvents = 0;
      for (const raw of rows) {
        const chain = raw.chain.trim().toLowerCase();
        const tokenAddress = normalizeAddress(chain, raw.tokenAddress);
        const traderAddress = normalizeAddress(chain, raw.traderAddress);
        if (!chain || !tokenAddress || !traderAddress || !raw.eventId || !raw.economicKey) continue;
        const row = Object.freeze({ ...raw, chain, tokenAddress, traderAddress });
        const key = `${chain}\0${raw.economicKey}`;
        const existing = economicTrades.get(key);
        if (existing) {
          existing.sourceEventIds.add(raw.eventId);
          duplicateEvents += 1;
        } else {
          economicTrades.set(key, { row, sourceEventIds: new Set([raw.eventId]) });
        }
      }

      const groups = new Map<string, EconomicTrade[]>();
      for (const trade of economicTrades.values()) {
        const key = `${trade.row.chain}\0${trade.row.tokenAddress}\0${trade.row.traderAddress}`;
        groups.set(key, [...(groups.get(key) ?? []), trade]);
      }

      let acceptedEvidence = 0;
      const affectedTraders = new Set<string>();
      const unresolvedTraderIds = new Set<string>();
      for (const trades of groups.values()) {
        const first = trades[0]!.row;
        const tokenId = `${first.chain}:${first.tokenAddress}`;
        const traderId = input.resolveTraderId(first.chain, first.traderAddress) ?? `wallet:${first.chain}:${first.traderAddress}`;
        if (traderId.startsWith("wallet:")) unresolvedTraderIds.add(traderId);
        let strongest: { readonly tier: NonNullable<ReturnType<typeof strongestSatisfiedTier>>; readonly milestoneId: string; readonly evidenceAt: number; readonly amount: number; readonly weightedEntry: number; readonly theoretical: number; readonly capturable: number | null; readonly realized: number | null; readonly sourceEventIds: readonly string[] } | null = null;
        for (const milestone of input.store.milestoneCrossings(tokenId)) {
          const crossedAt = milestone.crossedAt;
          if (milestone.precision === "unavailable" || crossedAt === null) continue;
          const eligible = trades.filter(trade => trade.row.side === "buy" && trade.row.occurredAt <= crossedAt && finitePositive(trade.row.amountUsd) && finitePositive(trade.row.marketCapUsd));
          const amount = eligible.reduce((sum, trade) => sum + trade.row.amountUsd, 0);
          if (amount < 50) continue;
          const weightedEntry = eligible.reduce((sum, trade) => sum + trade.row.amountUsd * trade.row.marketCapUsd, 0) / amount;
          const theoretical = milestone.marketCapUsd / weightedEntry;
          const tier = strongestSatisfiedTier(milestone.marketCapUsd, theoretical);
          if (!tier || (strongest && strongest.tier.rank >= tier.rank)) continue;
          const values = (field: "capturableMultiple" | "realizedMultiple") => eligible.map(trade => trade.row[field]).filter(finitePositive);
          const capturable = values("capturableMultiple");
          const realized = values("realizedMultiple");
          strongest = Object.freeze({ tier, milestoneId: milestone.milestoneId, evidenceAt: crossedAt, amount, weightedEntry, theoretical, capturable: capturable.length ? Math.max(...capturable) : null, realized: realized.length ? Math.max(...realized) : null, sourceEventIds: Object.freeze([...new Set(eligible.flatMap(trade => [...trade.sourceEventIds]))].sort()) });
        }
        if (!strongest) continue;
        const evidenceId = hash(`${traderId}\0${tokenId}\0${strongest.milestoneId}\0${strongest.tier.type}\0${strongest.sourceEventIds.join(",")}`);
        input.store.saveEvidence({ evidenceId, traderId, tokenId, milestoneId: strongest.milestoneId, evidenceType: strongest.tier.type, admissionClass: strongest.tier.admissionClass, cumulativeBuyUsd: strongest.amount, weightedEntryMarketCapUsd: strongest.weightedEntry, theoreticalOpportunity: strongest.theoretical, capturableMultiple: strongest.capturable, realizedMultiple: strongest.realized, evidenceAt: strongest.evidenceAt, sourceEventIds: strongest.sourceEventIds, strategyVersion: input.strategyVersion });
        affectedTraders.add(traderId);
        acceptedEvidence += 1;
      }

      for (const traderId of affectedTraders) {
        const evidence = input.store.evidenceForTrader(traderId);
        const snapshot = evaluateCandidateAdmission(evidence.map(item => ({ tokenKey: item.tokenId, evidenceType: item.evidenceType as Parameters<typeof evaluateCandidateAdmission>[0][number]["evidenceType"], evidenceAt: item.evidenceAt })), evaluatedAt);
        input.store.saveAdmissionSnapshot({ snapshotId: hash(`${traderId}\0${evaluatedAt}\0${evidence.map(item => item.evidenceId).join(",")}`), traderId, ...snapshot, strategyVersion: input.strategyVersion, evaluatedAt });
      }
      return Object.freeze({ acceptedEvidence, duplicateEvents, unresolvedTraderIds: Object.freeze([...unresolvedTraderIds].sort()) });
    },
  });
}
