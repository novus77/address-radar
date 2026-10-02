import type { DatabaseSync } from "node:sqlite";
import {
  consumerHistoryFingerprint, listConsumerHistoryWakeupNeeds, recordConsumerHistoryDispatch,
  recordConsumerHistoryObservation, withAddressRadarWriteTransaction, type AutomationJobStore,
} from "@address-radar/database";
import { enqueueTraderAbilityEvaluation } from "./trader-ability-worker.js";
import { DEFAULT_QUEUE_TYPE_POLICIES } from "./queue-policy.js";

export function reconcileConsumerHistoryWakeups(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly now?: () => number;
  readonly limit?: number;
}) {
  const at = (input.now ?? Date.now)();
  const rows = listConsumerHistoryWakeupNeeds(input.database,at,input.limit ?? 25);
  let dispatched = 0;
  let deferred = 0;
  for (const row of rows) {
    const fingerprint = consumerHistoryFingerprint(input.database,row.tokenId,row.fromAt,row.toAt);
    withAddressRadarWriteTransaction(input.database, () => {
      recordConsumerHistoryObservation(input.database,row.consumerId,row.tokenId,fingerprint,at);
      if (fingerprint === null || fingerprint === row.dispatchedFingerprint) return;
      const active = input.jobs.activeJobForSubject("ability_evaluation", row.consumerId);
      const highWaterMark = DEFAULT_QUEUE_TYPE_POLICIES.ability_evaluation!.highWaterMark;
      if (active || input.jobs.activeCount("ability_evaluation") >= highWaterMark) {
        deferred += 1;
        return;
      }
      enqueueTraderAbilityEvaluation(input.jobs,row.consumerId,at,at,`consumer-history:${row.tokenId}:${fingerprint}`);
      recordConsumerHistoryDispatch(input.database,row.consumerId,row.tokenId,fingerprint,at);
      dispatched += 1;
    });
  }
  return Object.freeze({ examined: rows.length, dispatched, deferred });
}
