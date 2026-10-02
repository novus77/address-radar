import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AddressRadarRepository } from "@address-radar/database";

type Evidence = ReturnType<AddressRadarRepository["addressSignalEvidenceForToken"]>[number];
interface ExecutionInput {
  readonly source: string;
  readonly eventId: string;
  readonly consumer: string;
  readonly revision: number;
  readonly headFingerprint: string;
  readonly evidenceFingerprint: string;
}
interface InputRow {
  source: string; eventId: string; consumer: string; revision: number; entityId: string;
  headRevision: number | null; headFingerprint: string | null; headState: string | null;
  projectedRevision: number | null; projectionOutcome: string | null;
  eventEntity: string | null; eventAmount: number | null; eventSide: string | null; eventAt: number | null;
  signalEntity: string | null; signalAmount: number | null; signalSide: string | null; signalAt: number | null;
  contribution: number | null; lifecycleStage: string | null; signalSource: string | null; traderTags: string | null; dedupeKey: string | null;
}

export const SIGNAL_EXECUTION_RECEIPT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS signal_projection_execution_receipts (
  token_id TEXT NOT NULL, projection_revision INTEGER NOT NULL, source TEXT NOT NULL,
  event_id TEXT NOT NULL, consumer_type TEXT NOT NULL, execution_revision INTEGER NOT NULL,
  execution_fingerprint TEXT NOT NULL, evidence_fingerprint TEXT NOT NULL,
  decision_action TEXT NOT NULL, completed_at INTEGER NOT NULL,
  PRIMARY KEY(token_id,projection_revision,source,event_id,consumer_type,execution_revision)
)`;

export function initializeSignalExecutionReceiptSchema(database: DatabaseSync): void {
  database.exec(SIGNAL_EXECUTION_RECEIPT_SCHEMA_SQL);
}

export function captureSignalExecutionInputs(database: DatabaseSync, tokenId: string, evidence: readonly Evidence[]) {
  const byEvent = new Map(evidence.map(item => [item.eventId, item]));
  const rows = database.prepare(`
    SELECT r.source,r.event_id eventId,r.consumer_type consumer,r.desired_revision revision,r.entity_id entityId,
      h.revision headRevision,h.fingerprint headFingerprint,h.projection_state headState,
      p.applied_revision projectedRevision,p.last_outcome projectionOutcome,
      e.entity_id eventEntity,e.amount_usd eventAmount,e.side eventSide,e.occurred_at eventAt,
      a.entity_id signalEntity,a.amount_usd signalAmount,a.side signalSide,a.occurred_at signalAt,
      a.contribution,a.lifecycle_stage lifecycleStage,a.source signalSource,a.trader_tags traderTags,a.dedupe_key dedupeKey
    FROM execution_revision_requests r
    LEFT JOIN trader_execution_heads h ON h.source=r.source AND h.event_id=r.event_id
      AND h.entity_id=r.entity_id AND h.chain||':'||h.token_address=r.token_id
    LEFT JOIN execution_revision_requests p ON p.source=r.source AND p.event_id=r.event_id AND p.consumer_type='event_projection'
    LEFT JOIN trader_events e ON e.event_id=r.event_id AND e.entity_id=h.entity_id AND e.chain=h.chain AND e.token_address=h.token_address
    LEFT JOIN address_signal_evidence a ON a.event_id=r.event_id AND a.chain=h.chain AND a.token_address=h.token_address
    WHERE r.token_id=? AND r.consumer_type IN ('signal_projection','token_aggregation') AND r.desired_revision>r.applied_revision
  `).all(tokenId) as unknown as InputRow[];
  const inputs: ExecutionInput[] = [];
  let waiting = 0;
  for (const row of rows) {
    const item = byEvent.get(row.eventId);
    // Out-of-window and filtered events are not claimed as consumed by this evaluation.
    if (!item) continue;
    const matches = row.headRevision === row.revision && row.headState === "applied"
      && row.projectedRevision === row.revision && row.projectionOutcome === "projection_recomputed"
      && row.entityId === item.entityId && row.eventEntity === item.entityId && row.signalEntity === item.entityId
      && row.eventSide === item.side && row.signalSide === item.side
      && row.eventAmount === item.amountUsd && row.signalAmount === item.amountUsd
      && typeof item.amountUsd === "number" && Number.isFinite(item.amountUsd) && item.amountUsd > 0
      && row.eventAt === item.occurredAt && row.signalAt === item.occurredAt
      && row.contribution === item.contribution && row.lifecycleStage === (item.lifecycleStage ?? null)
      && row.signalSource === (item.source ?? null) && row.dedupeKey === (item.dedupeKey ?? null)
      && JSON.stringify(JSON.parse(row.traderTags ?? "[]")) === JSON.stringify(item.traderTags ?? []);
    if (!matches || !row.headFingerprint) { waiting += 1; continue; }
    inputs.push({ source: row.source, eventId: row.eventId, consumer: row.consumer, revision: row.revision,
      headFingerprint: row.headFingerprint, evidenceFingerprint: createHash("sha256").update(JSON.stringify(item)).digest("hex") });
  }
  return { inputs, waiting };
}

// Called inside the same write transaction that confirms the token projection revision.
export function acknowledgeSignalExecutionInputs(database: DatabaseSync, input: {
  readonly tokenId: string; readonly projectionRevision: number; readonly inputs: readonly ExecutionInput[];
  readonly evidence: readonly Evidence[]; readonly action: string; readonly completedAt: number;
}): number {
  const current = captureSignalExecutionInputs(database, input.tokenId, input.evidence).inputs;
  let acknowledged = 0;
  for (const consumed of input.inputs) {
    if (!current.some(item => JSON.stringify(item) === JSON.stringify(consumed))) continue;
    const update = database.prepare(`UPDATE execution_revision_requests SET applied_revision=?,
      dispatched_revision=MAX(dispatched_revision,?),applied_at=?,last_outcome=?
      WHERE source=? AND event_id=? AND consumer_type=? AND token_id=? AND desired_revision=? AND applied_revision<?`)
      .run(consumed.revision, consumed.revision, input.completedAt, `signal_evaluated:${input.action}`,
        consumed.source, consumed.eventId, consumed.consumer, input.tokenId, consumed.revision, consumed.revision);
    if (update.changes !== 1) continue;
    database.prepare(`INSERT OR IGNORE INTO signal_projection_execution_receipts
      (token_id,projection_revision,source,event_id,consumer_type,execution_revision,execution_fingerprint,evidence_fingerprint,decision_action,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.tokenId, input.projectionRevision, consumed.source, consumed.eventId,
        consumed.consumer, consumed.revision, consumed.headFingerprint, consumed.evidenceFingerprint, input.action, input.completedAt);
    acknowledged += 1;
  }
  return acknowledged;
}
