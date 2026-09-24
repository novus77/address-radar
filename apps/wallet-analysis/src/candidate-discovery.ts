import { createHash } from "node:crypto";
import type { AddressRadarRepository } from "@address-radar/database";
import { createCandidateAdmissionService } from "@address-radar/identity";
import { CANDIDATE_MILESTONES, strongestSatisfiedTier, type CandidateEvidenceType } from "@address-radar/scoring";

export interface CandidateDiscoveryResult {
  readonly accountId: string;
  readonly discoveryType: CandidateEvidenceType;
  readonly maximumOpportunity: number;
  readonly weightedEntryMarketCapUsd: number;
}

export function createCandidateDiscoveryService(input: { readonly repository: AddressRadarRepository }) {
  const admission = createCandidateAdmissionService(input);
  return Object.freeze({
    observe(event: { readonly chain: string; readonly tokenAddress: string; readonly marketCapUsd: number; readonly reachedAt: number; readonly provenance: { readonly source: string; readonly sourceEventIds: readonly string[] } }): readonly CandidateDiscoveryResult[] {
      const results: CandidateDiscoveryResult[] = [];
      for (const milestone of CANDIDATE_MILESTONES) {
        if (event.marketCapUsd < milestone.marketCapUsd) continue;
        const milestoneId = `${event.chain}:${event.tokenAddress}:${milestone.marketCapUsd}`;
        input.repository.recordTokenMilestone({ milestoneId, chain: event.chain, tokenAddress: event.tokenAddress, marketCapUsd: milestone.marketCapUsd, reachedAt: event.reachedAt, payload: JSON.stringify({ observedMarketCapUsd: event.marketCapUsd, provenance: event.provenance, processor: "wallet_analysis" }) });
        const buys = input.repository.eventsForToken(event.chain, event.tokenAddress).filter(item => item.side === "buy" && item.occurredAt <= event.reachedAt && item.amountUsd !== null && item.amountUsd > 0 && item.marketCapUsd !== null && item.marketCapUsd > 0);
        const byAccount = new Map<string, typeof buys>();
        for (const buy of buys) byAccount.set(buy.accountId, [...(byAccount.get(buy.accountId) ?? []), buy]);
        for (const [accountId, accountBuys] of byAccount) {
          const amount = accountBuys.reduce((sum, buy) => sum + buy.amountUsd!, 0);
          if (amount < 100) continue;
          const weightedEntryMarketCapUsd = accountBuys.reduce((sum, buy) => sum + buy.marketCapUsd! * buy.amountUsd!, 0) / amount;
          const maximumOpportunity = milestone.marketCapUsd / weightedEntryMarketCapUsd;
          const tier = strongestSatisfiedTier(milestone.marketCapUsd, maximumOpportunity);
          if (!tier) continue;
          const discovery = Object.freeze({ accountId, discoveryType: tier.type, maximumOpportunity, weightedEntryMarketCapUsd });
          const trades = accountBuys.map(buy => ({ eventId: buy.eventId, source: buy.source })).sort((left, right) => left.eventId.localeCompare(right.eventId));
          const provenanceKey = JSON.stringify({ milestone: event.provenance, trades });
          const discoveryId = createHash("sha256").update(`${milestoneId}\0${accountId}\0${tier.type}\0${provenanceKey}`).digest("hex");
          input.repository.saveCandidateDiscovery({ discoveryId, accountId, discoveryType: tier.type, payload: JSON.stringify({ chain: event.chain, tokenAddress: event.tokenAddress, tierRank: tier.rank, maximumOpportunity, processor: "wallet_analysis", evidence: { milestone: event.provenance, trades } }), discoveredAt: event.reachedAt });
          admission.evaluate({ accountId, observedAt: event.reachedAt });
          results.push(discovery);
        }
      }
      return Object.freeze(results);
    },
  });
}
