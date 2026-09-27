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
