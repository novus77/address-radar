import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "./connection.js";

export const EVENT_PROJECTION_EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_projection_execution_contexts (
  event_id TEXT NOT NULL,
  projection_type TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  execution_snapshot TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY(event_id,projection_type,source_revision)
);
`;

export function initializeEventProjectionExecutionSchema(database: DatabaseSync): void {
  withAddressRadarWriteTransaction(database, () => database.exec(EVENT_PROJECTION_EXECUTION_SCHEMA_SQL));
}

export interface ProjectionExecutionInput {
  readonly eventId: string;
  readonly accountId: string;
  readonly entityId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly side: string;
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly tokenAgeMs: number | null;
  readonly occurredAt: number;
}

interface ProjectionKey {
  readonly eventId: string;
  readonly projectionType: string;
  readonly sourceRevision: string;
  readonly owner: string;
}
interface ExecutionHead {
  readonly source: string;
  readonly entity_id: string;
  readonly chain: string;
  readonly token_address: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly projection_state: string;
}
interface ExecutionSnapshot {
  readonly event: Record<string, unknown> | null;
  readonly heads: readonly ExecutionHead[];
  readonly inputVerified?: boolean;
}

function snapshot(database: DatabaseSync, eventId: string): ExecutionSnapshot {
  const event = database.prepare(`SELECT event_id,account_id,entity_id,chain,token_address,side,
    amount_usd,price_usd,market_cap_usd,token_age_ms,occurred_at FROM trader_events WHERE event_id=?`).get(eventId);
  const heads = database.prepare(`SELECT source,entity_id,chain,token_address,revision,fingerprint,projection_state
    FROM trader_execution_heads WHERE event_id=? ORDER BY source`).all(eventId) as unknown as readonly ExecutionHead[];
  return { event: event ?? null, heads };
}

export function matchesEventProjectionInput(database: DatabaseSync, eventId: string, input: ProjectionExecutionInput): boolean {
  const event = snapshot(database, eventId).event;
  if (!event || input.eventId !== eventId) return false;
  const chain = input.chain.toLowerCase();
  const address = (value: string) => chain === "solana" ? value : value.toLowerCase();
  return event.event_id === input.eventId && event.account_id === input.accountId
    && event.entity_id === input.entityId && String(event.chain).toLowerCase() === chain
    && address(String(event.token_address)) === address(input.tokenAddress)
    && event.side === input.side && event.amount_usd === input.amountUsd
    && event.price_usd === input.priceUsd && event.market_cap_usd === input.marketCapUsd
    && event.token_age_ms === input.tokenAgeMs && event.occurred_at === input.occurredAt;
}

export function captureEventProjectionExecution(database: DatabaseSync, input: ProjectionKey & { readonly now: number; readonly executionInput?: ProjectionExecutionInput }): void {
  database.prepare(`INSERT INTO event_projection_execution_contexts
    (event_id,projection_type,source_revision,lease_owner,execution_snapshot,claimed_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(event_id,projection_type,source_revision) DO UPDATE SET
    lease_owner=excluded.lease_owner,execution_snapshot=excluded.execution_snapshot,claimed_at=excluded.claimed_at`)
    .run(input.eventId,input.projectionType,input.sourceRevision,input.owner,JSON.stringify({ ...snapshot(database,input.eventId), inputVerified: input.executionInput !== undefined && matchesEventProjectionInput(database,input.eventId,input.executionInput) }),input.now);
}

function captured(database: DatabaseSync, input: ProjectionKey): ExecutionSnapshot | null {
  const row = database.prepare(`SELECT execution_snapshot FROM event_projection_execution_contexts
    WHERE event_id=? AND projection_type=? AND source_revision=? AND lease_owner=?`)
    .get(input.eventId,input.projectionType,input.sourceRevision,input.owner) as { execution_snapshot: string } | undefined;
  return row ? JSON.parse(row.execution_snapshot) as ExecutionSnapshot : null;
}

export function matchesEventProjectionExecution(database: DatabaseSync, input: ProjectionKey): boolean {
  const prior = captured(database,input);
  // Existing leases can finish after an additive rollout, but cannot create a version receipt.
  if (!prior) return true;
  const current = snapshot(database,input.eventId);
  return !current.heads.some(head => head.revision > 0 && head.projection_state !== "applied")
    && JSON.stringify({ event: prior.event, heads: prior.heads }) === JSON.stringify(current);
}

export function acknowledgeEventProjectionExecution(database: DatabaseSync, input: ProjectionKey & {
  readonly resultKey: string;
  readonly completedAt: number;
}): void {
  const prior = captured(database,input);
  if (!prior?.inputVerified || !matchesEventProjectionExecution(database,input)) return;
  const outcome = input.resultKey.startsWith("filtered:") ? "projection_filtered" : "projection_recomputed";
  const update = database.prepare(`UPDATE execution_revision_requests SET
    applied_revision=desired_revision,dispatched_revision=MAX(dispatched_revision,desired_revision),
    applied_at=?,last_outcome=? WHERE source=? AND event_id=? AND consumer_type='event_projection'
    AND desired_revision=? AND applied_revision<desired_revision`);
  for (const head of prior.heads) {
    if (head.revision <= 0 || head.projection_state !== "applied") continue;
    update.run(input.completedAt,outcome,head.source,input.eventId,head.revision);
  }
}
