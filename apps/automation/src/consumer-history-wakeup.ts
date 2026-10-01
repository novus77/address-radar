import type { DatabaseSync } from "node:sqlite";
import {
  consumerHistoryFingerprint, listConsumerHistoryWakeupNeeds, recordConsumerHistoryDispatch,
  recordConsumerHistoryObservation, withAddressRadarWriteTransaction, type AutomationJobStore,
} from "@address-radar/database";
import { enqueueTraderAbilityEvaluation } from "./trader-ability-worker.js";

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
      const active = input.database.prepare(`SELECT 1 FROM automation_jobs WHERE job_type='ability_evaluation'
        AND subject_key=? AND status IN ('pending','running','retry_scheduled','waiting_source','blocked_source') LIMIT 1`)
        .get(row.consumerId);
      if (active) { deferred += 1; return; }
      enqueueTraderAbilityEvaluation(input.jobs,row.consumerId,at,at,`consumer-history:${row.tokenId}:${fingerprint}`);
      recordConsumerHistoryDispatch(input.database,row.consumerId,row.tokenId,fingerprint,at);
      dispatched += 1;
    });
  }
  return Object.freeze({ examined: rows.length, dispatched, deferred });
}
