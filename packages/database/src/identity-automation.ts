import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withAddressRadarWriteTransaction } from "./connection.js";

export const IDENTITY_WALLET_BACKFILL_STRATEGY_VERSION =
  "trader-backfill-v1";

export type ResolvedWalletAutomationInput = {
  traderId: string;
  accountId: string;
  chainFamily: "evm" | "solana";
  address: string;
  occurredAt: number;
};

type ResolvedWalletPayload = ResolvedWalletAutomationInput & {
  windowDays: 60;
  maximumTokens: 300;
  strategyVersion: typeof IDENTITY_WALLET_BACKFILL_STRATEGY_VERSION;
};

function normalizeAddress(
  chainFamily: ResolvedWalletAutomationInput["chainFamily"],
  address: string,
): string {
  const trimmed = address.trim();
  return chainFamily === "evm" ? trimmed.toLowerCase() : trimmed;
}

function toPayload(input: ResolvedWalletAutomationInput): ResolvedWalletPayload {
  return {
    ...input,
    address: normalizeAddress(input.chainFamily, input.address),
    windowDays: 60,
    maximumTokens: 300,
    strategyVersion: IDENTITY_WALLET_BACKFILL_STRATEGY_VERSION,
  };
}

function eventIdFor(payload: ResolvedWalletPayload): string {
  return [
    "identity-wallet",
    payload.traderId,
    payload.chainFamily,
    payload.address,
  ].join(":");
}

function backfillKeyFor(payload: ResolvedWalletPayload): string {
  return [
    "initial-wallet-backfill",
    payload.traderId,
    payload.chainFamily,
    payload.address,
    `${payload.windowDays}d`,
    payload.maximumTokens,
    payload.strategyVersion,
  ].join(":");
}

export function recordResolvedWalletAutomation(
  database: DatabaseSync,
  input: ResolvedWalletAutomationInput,
): boolean {
  const payload = toPayload(input);
  const inserted = database
    .prepare(
      `INSERT OR IGNORE INTO monitoring_registry_outbox(
         event_id,
         entity_id,
         event_type,
         payload,
         status,
         created_at,
         published_at
       ) VALUES (?, ?, 'identity.wallet_resolved', ?, 'pending', ?, NULL)`,
    )
    .run(
      eventIdFor(payload),
      payload.traderId,
      JSON.stringify(payload),
      payload.occurredAt,
    );

  if (Number(inserted.changes) === 0) return false;

  database
    .prepare(
      `INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at)
       VALUES (?, 'realtime', ?)
       ON CONFLICT(trader_id) DO UPDATE SET
         policy = 'realtime',
         updated_at = excluded.updated_at
       WHERE trader_monitoring_policy.policy != 'off'`,
    )
    .run(payload.traderId, payload.occurredAt);

  database
    .prepare(
      `INSERT INTO trader_coverage_state(
         trader_id,
         tier,
         coverage_state,
         last_covered_at,
         next_evaluation_at,
         strategy_version,
         updated_at
       ) VALUES (?, 'T1', 'queued', NULL, ?, ?, ?)
       ON CONFLICT(trader_id) DO UPDATE SET
         tier = CASE
           WHEN trader_coverage_state.tier = 'T0' THEN 'T0'
           ELSE 'T1'
         END,
         coverage_state = 'queued',
         next_evaluation_at = MIN(
           trader_coverage_state.next_evaluation_at,
           excluded.next_evaluation_at
         ),
         strategy_version = excluded.strategy_version,
         updated_at = MAX(trader_coverage_state.updated_at, excluded.updated_at)`,
    )
    .run(
      payload.traderId,
      payload.occurredAt,
      payload.strategyVersion,
      payload.occurredAt,
    );

  database
    .prepare(
      `UPDATE monitoring_registry_state
       SET version = version + 1,
           updated_at = ?
       WHERE singleton = 1`,
    )
    .run(payload.occurredAt);

  return true;
}

export function drainResolvedWalletAutomationOutbox(
  database: DatabaseSync,
  occurredAt: number,
): number {
  return withAddressRadarWriteTransaction(database, () => {
    const events = database
      .prepare(
        `SELECT event_id, payload
         FROM monitoring_registry_outbox
         WHERE event_type = 'identity.wallet_resolved'
           AND status = 'pending'
         ORDER BY created_at ASC, event_id ASC`,
      )
      .all() as Array<{ event_id: string; payload: string }>;

    for (const event of events) {
      const payload = JSON.parse(event.payload) as ResolvedWalletPayload;
      const idempotencyKey = backfillKeyFor(payload);
      database
        .prepare(
          `INSERT OR IGNORE INTO automation_jobs(
             job_id,
             idempotency_key,
             lane,
             job_type,
             subject_key,
             priority,
             status,
             cursor,
             attempt_count,
             next_attempt_at,
             lease_expires_at,
             lease_owner,
             payload,
             last_error,
             created_at,
             updated_at,
             completed_at
           ) VALUES (?, ?, 'trader_backfill', 'initial_wallet_backfill', ?, 20,
                     'pending', NULL, 0, ?, NULL, NULL, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          randomUUID(),
          idempotencyKey,
          `${payload.chainFamily}:${payload.address}`,
          payload.occurredAt,
          JSON.stringify(payload),
          payload.occurredAt,
          payload.occurredAt,
        );
      database
        .prepare(
          `UPDATE monitoring_registry_outbox
           SET status = 'published',
               published_at = ?
           WHERE event_id = ?
             AND status = 'pending'`,
        )
        .run(occurredAt, event.event_id);
    }

    return events.length;
  });
}

export function materializeLegacyWalletIdentities(database: DatabaseSync): { readonly inserted: number; readonly conflicts: number } {
  database.exec(`
    CREATE TABLE IF NOT EXISTS wallet_identity_materialization_conflicts (
      conflict_id TEXT PRIMARY KEY,
      chain_family TEXT NOT NULL,
      address TEXT NOT NULL,
      canonical_entity_id TEXT NOT NULL,
      conflicting_entity_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const rows = database.prepare(`
    SELECT ea.entity_id AS entityId, ea.account_id AS accountId,
      w.chain_family AS chainFamily, w.address, w.confidence, w.source,
      w.first_observed_at AS firstObservedAt, w.last_observed_at AS lastObservedAt
    FROM entity_accounts ea
    JOIN wallet_identities w ON w.account_id = ea.account_id
    ORDER BY w.last_observed_at, ea.entity_id, w.chain_family, w.address
  `).all() as Array<{ entityId: string; accountId: string; chainFamily: "evm" | "solana"; address: string; confidence: string; source: string; firstObservedAt: number; lastObservedAt: number }>;
  const findOwner = database.prepare("SELECT entity_id AS entityId FROM entity_wallet_identities WHERE chain_family=? AND address=? ORDER BY first_observed_at, entity_id LIMIT 1");
  const insert = database.prepare(`INSERT OR IGNORE INTO entity_wallet_identities(entity_id, chain_family, address, confidence, source, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const conflict = database.prepare(`INSERT OR IGNORE INTO wallet_identity_materialization_conflicts(conflict_id, chain_family, address, canonical_entity_id, conflicting_entity_id, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  let conflicts = 0;
  for (const row of rows) {
    const address = normalizeAddress(row.chainFamily, row.address);
    const owner = findOwner.get(row.chainFamily, address) as { entityId: string } | undefined;
    if (owner && owner.entityId !== row.entityId) {
      const result = conflict.run(`wallet-materialization:${row.chainFamily}:${address}:${row.entityId}`, row.chainFamily, address, owner.entityId, row.entityId, row.accountId, row.lastObservedAt);
      conflicts += Number(result.changes);
      continue;
    }
    const result = insert.run(row.entityId, row.chainFamily, address, row.confidence, `legacy:${row.source}`, row.firstObservedAt, row.lastObservedAt);
    if (Number(result.changes) === 0) continue;
    inserted += 1;
    recordResolvedWalletAutomation(database, { traderId: row.entityId, accountId: row.accountId, chainFamily: row.chainFamily, address, occurredAt: row.lastObservedAt });
  }
  return Object.freeze({ inserted, conflicts });
}
