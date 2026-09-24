import type { TraderEvent } from "@address-radar/domain";

import type { TradeEventRepository } from "./types.js";

export function createTradeEventIngestor(repository: TradeEventRepository) {
  return Object.freeze({
    async ingest(events: readonly TraderEvent[]): Promise<{ readonly inserted: number; readonly duplicates: number }> {
      let inserted = 0;
      let duplicates = 0;
      for (const event of events) {
        if (repository.insertTraderEvent(event).inserted) inserted += 1;
        else duplicates += 1;
      }
      return Object.freeze({ inserted, duplicates });
    },
  });
}
