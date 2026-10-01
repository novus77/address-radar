import type { DatabaseSync } from "node:sqlite";
import { listUnscheduledConsumerHistoryTokens, type SourceLedgerStore } from "@address-radar/database";
import { normalizeDiscoveryChain } from "@address-radar/domain";

export function reconcileConsumerHistoryRecovery(input: {
  readonly database: DatabaseSync;
  readonly ledger: SourceLedgerStore;
  readonly now?: () => number;
  readonly limit?: number;
}) {
  const at = (input.now ?? Date.now)();
  const rows = listUnscheduledConsumerHistoryTokens(input.database, at, input.limit ?? 25);
  let enqueued = 0;
  for (const { tokenId } of rows) {
    const chain = normalizeDiscoveryChain(tokenId.slice(0, tokenId.indexOf(":")));
    const jobType = chain === "robinhood" ? "fomo_token_history" : "market_history";
    const result = input.ledger.enqueueRecoveryJob({
      jobId: `recovery:${jobType}:${tokenId}`, jobType, chain, subjectKey: tokenId,
      priority: 25, cursor: null, nextAttemptAt: at, createdAt: at,
    });
    if (result.inserted) enqueued += 1;
  }
  // Existing jobs own their lease, retry policy and terminal diagnosis.
  return Object.freeze({ examined: rows.length, enqueued });
}
