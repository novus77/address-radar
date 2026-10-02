import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction, type AutomationJobStore } from "@address-radar/database";
import { enqueueCandidateFactEvaluation } from "./candidate-evidence-worker.js";
import { enqueueTraderAbilityEvaluation } from "./trader-ability-worker.js";

export function createSourceFactRevisionReconciler(input: { readonly database: DatabaseSync; readonly jobs: AutomationJobStore; readonly now?: () => number; readonly batchSize?: number }) {
  input.database.exec(`CREATE TABLE IF NOT EXISTS source_fact_revision_receipts (
    token_id TEXT NOT NULL, fact_type TEXT NOT NULL, revision INTEGER NOT NULL,
    processed_at INTEGER NOT NULL, PRIMARY KEY(token_id, fact_type, revision)
  );
  CREATE TABLE IF NOT EXISTS source_fact_ability_dispatches (
    token_id TEXT NOT NULL, fact_type TEXT NOT NULL, revision INTEGER NOT NULL,
    trader_id TEXT NOT NULL, requested_at INTEGER NOT NULL, dispatched_at INTEGER,
    PRIMARY KEY(token_id, fact_type, revision, trader_id)
  );
  CREATE INDEX IF NOT EXISTS source_fact_ability_dispatches_pending
    ON source_fact_ability_dispatches(dispatched_at, requested_at)`);
  const now = input.now ?? Date.now;
  const batchSize = input.batchSize ?? 100;
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
      `).all(batchSize) as Array<{ tokenId: string; factType: string; revision: number }>;
      let processed = 0;
      let deferred = 0;
      for (const row of rows) {
        const separator = row.tokenId.indexOf(":");
        if (separator < 1 || separator === row.tokenId.length - 1) { deferred += 1; continue; }
        const chain = row.tokenId.slice(0, separator);
        const address = row.tokenId.slice(separator + 1);
        withAddressRadarWriteTransaction(input.database, () => {
          const receipt = input.database.prepare("INSERT OR IGNORE INTO source_fact_revision_receipts(token_id,fact_type,revision,processed_at) VALUES (?,?,?,?)")
            .run(row.tokenId, row.factType, row.revision, at);
          if (receipt.changes !== 1) return;
          const owners = input.database.prepare(`
            SELECT DISTINCT entity_id traderId FROM canonical_trader_events WHERE chain=? AND token_address=?
            UNION SELECT DISTINCT trader_id traderId FROM candidate_evidence_v3 WHERE token_id=?
          `).all(chain, address, row.tokenId) as Array<{ traderId: string }>;
          // Candidate wake-up must not wait for unrelated ability work. Persist that work separately.
          for (const owner of owners) {
            input.database.prepare(`INSERT OR IGNORE INTO source_fact_ability_dispatches
              (token_id,fact_type,revision,trader_id,requested_at) VALUES (?,?,?,?,?)`)
              .run(row.tokenId, row.factType, row.revision, owner.traderId, at);
          }
          const sourceKey = `source-fact:${row.factType}:${row.tokenId}:${row.revision}`;
          input.jobs.wakeBlockedSource(row.tokenId, at, "candidate_evidence");
          enqueueCandidateFactEvaluation({ database: input.database, jobs: input.jobs, tokenId: row.tokenId, sourceKey, evaluatedAt: at, now: at });
          processed += 1;
        });
      }
      let abilityDispatched = 0;
      withAddressRadarWriteTransaction(input.database, () => {
        // Filter busy subjects before LIMIT so an old blocked owner cannot monopolize every batch.
        const pending = input.database.prepare(`
          SELECT d.token_id tokenId,d.fact_type factType,d.revision,d.trader_id traderId
          FROM source_fact_ability_dispatches d
          WHERE d.dispatched_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM automation_jobs j WHERE j.job_type='ability_evaluation' AND j.subject_key=d.trader_id
              AND j.status IN ('pending','leased','running','waiting_source','blocked_source','retryable')
          ) ORDER BY d.requested_at,d.token_id,d.fact_type,d.revision,d.trader_id LIMIT ?
        `).all(batchSize) as Array<{ tokenId: string; factType: string; revision: number; traderId: string }>;
        for (const row of pending) {
          if (input.jobs.runnableCount("ability_evaluation") >= 1_000) break;
          if (input.jobs.activeJobForSubject("ability_evaluation", row.traderId)) continue;
          const sourceKey = `source-fact:${row.factType}:${row.tokenId}:${row.revision}`;
          enqueueTraderAbilityEvaluation(input.jobs, row.traderId, at, at, sourceKey);
          if (!input.jobs.activeJobForSubject("ability_evaluation", row.traderId)) continue;
          input.database.prepare(`UPDATE source_fact_ability_dispatches SET dispatched_at=?
            WHERE token_id=? AND fact_type=? AND revision=? AND trader_id=? AND dispatched_at IS NULL`)
            .run(at, row.tokenId, row.factType, row.revision, row.traderId);
          abilityDispatched += 1;
        }
      });
      const abilityPending = Number((input.database.prepare(`SELECT COUNT(*) count FROM source_fact_ability_dispatches
        WHERE dispatched_at IS NULL`).get() as { count: number }).count);
      return Object.freeze({ examined: rows.length, processed, deferred, abilityDispatched, abilityPending,
        hasMore: rows.length === batchSize || abilityPending > 0 });
    },
  });
}
