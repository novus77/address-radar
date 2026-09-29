import type { DatabaseSync } from "node:sqlite";

import { withAddressRadarWriteTransaction } from "./connection.js";

export type RecoveryFactLinkStatus = "pending" | "satisfied" | "terminal";

export interface RecoveryFactLink {
  readonly recoveryJobId: string;
  readonly factType: string;
  readonly factKey: string;
  readonly status: RecoveryFactLinkStatus;
  readonly terminalReason: string | null;
  readonly verifiedAt: number | null;
  readonly updatedAt: number;
}

const decode = (row: Record<string, unknown>): RecoveryFactLink => Object.freeze({
  recoveryJobId: String(row.recovery_job_id),
  factType: String(row.fact_type),
  factKey: String(row.fact_key),
  status: row.status as RecoveryFactLinkStatus,
  terminalReason: row.terminal_reason as string | null,
  verifiedAt: row.verified_at as number | null,
  updatedAt: Number(row.updated_at),
});

export function initializeRecoveryFactLinkSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS recovery_fact_links (
      recovery_job_id TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','satisfied','terminal')),
      terminal_reason TEXT,
      verified_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(recovery_job_id, fact_type, fact_key),
      CHECK(status <> 'terminal' OR terminal_reason IS NOT NULL),
      CHECK(status <> 'satisfied' OR verified_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS recovery_fact_links_unresolved
      ON recovery_fact_links(status, updated_at, fact_type);
    CREATE INDEX IF NOT EXISTS recovery_fact_links_fact
      ON recovery_fact_links(fact_type, fact_key, status);
  `);
}

export function createRecoveryFactLinkStore(database: DatabaseSync) {
  const load = (recoveryJobId: string, factType: string, factKey: string): RecoveryFactLink | null => {
    const row = database.prepare(`
      SELECT * FROM recovery_fact_links
      WHERE recovery_job_id=? AND fact_type=? AND fact_key=?
    `).get(recoveryJobId, factType, factKey) as Record<string, unknown> | undefined;
    return row ? decode(row) : null;
  };

  return Object.freeze({
    ensure(recoveryJobId: string, factType: string, factKey: string, now: number): RecoveryFactLink {
      return withAddressRadarWriteTransaction(database, () => {
        database.prepare(`
          INSERT OR IGNORE INTO recovery_fact_links(
            recovery_job_id, fact_type, fact_key, status, updated_at
          ) VALUES (?, ?, ?, 'pending', ?)
        `).run(recoveryJobId, factType, factKey, now);
        return load(recoveryJobId, factType, factKey)!;
      });
    },
    get: load,
    satisfy(recoveryJobId: string, factType: string, factKey: string, now: number): RecoveryFactLink {
      return withAddressRadarWriteTransaction(database, () => {
        const current = load(recoveryJobId, factType, factKey);
        if (!current) throw new Error(`Recovery fact link does not exist: ${recoveryJobId}:${factType}:${factKey}`);
        database.prepare(`
          UPDATE recovery_fact_links
          SET status='satisfied', terminal_reason=NULL, verified_at=?, updated_at=?
          WHERE recovery_job_id=? AND fact_type=? AND fact_key=?
        `).run(now, now, recoveryJobId, factType, factKey);
        return load(recoveryJobId, factType, factKey)!;
      });
    },
    terminal(recoveryJobId: string, factType: string, factKey: string, reason: string, now: number): RecoveryFactLink {
      if (!reason.trim()) throw new Error("Terminal recovery fact links require a reason");
      return withAddressRadarWriteTransaction(database, () => {
        const current = load(recoveryJobId, factType, factKey);
        if (!current) throw new Error(`Recovery fact link does not exist: ${recoveryJobId}:${factType}:${factKey}`);
        database.prepare(`
          UPDATE recovery_fact_links
          SET status='terminal', terminal_reason=?, verified_at=?, updated_at=?
          WHERE recovery_job_id=? AND fact_type=? AND fact_key=?
        `).run(reason, now, now, recoveryJobId, factType, factKey);
        return load(recoveryJobId, factType, factKey)!;
      });
    },
  });
}

export type ReturnTypeOfCreateRecoveryFactLinkStore = ReturnType<typeof createRecoveryFactLinkStore>;
