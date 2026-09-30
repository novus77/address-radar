import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction, type AutomationJobStore } from "@address-radar/database";
import { enqueueCandidateFactEvaluation } from "./candidate-evidence-worker.js";
import { enqueueTraderAbilityEvaluation } from "./trader-ability-worker.js";

export function createSourceFactRevisionReconciler(input: { readonly database: DatabaseSync; readonly jobs: AutomationJobStore; readonly now?: () => number; readonly batchSize?: number }) {
  input.database.exec(`CREATE TABLE IF NOT EXISTS source_fact_revision_receipts (
    token_id TEXT NOT NULL, fact_type TEXT NOT NULL, revision INTEGER NOT NULL,
    processed_at INTEGER NOT NULL, PRIMARY KEY(token_id, fact_type, revision)
  )`);
  const now = input.now ?? Date.now;
  return Object.freeze({
    runOnce() {
      const at = now();
      const rows = input.database.prepare(`
        SELECT f.token_id tokenId, f.fact_type factType, f.revision
        FROM token_fact_status f
        LEFT JOIN source_fact_revision_receipts receipt
          ON receipt.token_id=f.token_id AND receipt.fact_type=f.fact_type AND receipt.revision=f.revision
        WHERE receipt.token_id IS NULL AND f.status IN ('available','partial')
          AND f.fact_type IN ('price_history','supply_history','milestone_crossings','early_trades')
        ORDER BY f.updated_at, f.token_id, f.fact_type LIMIT ?
      `).all(input.batchSize ?? 100) as Array<{ tokenId: string; factType: string; revision: number }>;
      let processed = 0;
      let deferred = 0;
      for (const row of rows) {
        const separator = row.tokenId.indexOf(":");
        if (separator < 1 || separator === row.tokenId.length - 1) { deferred += 1; continue; }
        const chain = row.tokenId.slice(0, separator);
        const address = row.tokenId.slice(separator + 1);
        const owners = input.database.prepare(`
          SELECT DISTINCT entity_id traderId FROM canonical_trader_events WHERE chain=? AND token_address=?
          UNION SELECT DISTINCT trader_id traderId FROM candidate_evidence_v3 WHERE token_id=?
        `).all(chain, address, row.tokenId) as Array<{ traderId: string }>;
        // Do not lose a new input revision while a previous ability job is still executing.
        if (owners.some(owner => input.jobs.activeJobForSubject("ability_evaluation", owner.traderId))) { deferred += 1; continue; }
        withAddressRadarWriteTransaction(input.database, () => {
          const receipt = input.database.prepare("INSERT OR IGNORE INTO source_fact_revision_receipts(token_id,fact_type,revision,processed_at) VALUES (?,?,?,?)")
            .run(row.tokenId, row.factType, row.revision, at);
          if (receipt.changes !== 1) return;
          const sourceKey = `source-fact:${row.factType}:${row.tokenId}:${row.revision}`;
          input.jobs.wakeBlockedSource(row.tokenId, at, "candidate_evidence");
          enqueueCandidateFactEvaluation({ database: input.database, jobs: input.jobs, tokenId: row.tokenId, sourceKey, evaluatedAt: at, now: at });
          for (const owner of owners) enqueueTraderAbilityEvaluation(input.jobs, owner.traderId, at, at, sourceKey);
          processed += 1;
        });
      }
      return Object.freeze({ examined: rows.length, processed, deferred, hasMore: rows.length === (input.batchSize ?? 100) });
    },
  });
}
