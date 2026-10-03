import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_CAPTURE_HEALTH_SCHEMA_SQL = `
CREATE TABLE capture_source_sessions (
  session_id text PRIMARY KEY, source_namespace text NOT NULL, collector_id text NOT NULL, page_id text NOT NULL,
  started_at bigint NOT NULL, last_seen_at bigint NOT NULL, state_changed_at bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('starting','connected','disconnected','paused','closed','abandoned')),
  closed_at bigint
);
CREATE INDEX capture_source_session_scope ON capture_source_sessions(source_namespace,collector_id,page_id,started_at);
CREATE TABLE capture_source_heads (
  source_namespace text NOT NULL, collector_id text NOT NULL, page_id text NOT NULL,
  active_session_id text REFERENCES capture_source_sessions(session_id),
  PRIMARY KEY(source_namespace,collector_id,page_id)
);
CREATE TABLE capture_source_health_events (
  event_id text PRIMARY KEY, session_id text NOT NULL REFERENCES capture_source_sessions(session_id),
  event_kind text NOT NULL CHECK(event_kind IN ('connected','disconnected','capacity','persistence','closed')),
  occurred_at bigint NOT NULL
);
CREATE TABLE capture_source_gaps (
  gap_id text PRIMARY KEY, session_id text NOT NULL REFERENCES capture_source_sessions(session_id),
  reason_code text NOT NULL, opened_at bigint NOT NULL, resumed_at bigint,
  start_is_lower_bound boolean NOT NULL,
  coverage_state text NOT NULL CHECK(coverage_state IN ('open','awaiting_verification'))
);
CREATE UNIQUE INDEX capture_source_one_open_gap ON capture_source_gaps(session_id) WHERE resumed_at IS NULL;
CREATE INDEX capture_source_unverified_gap ON capture_source_gaps(session_id,opened_at,gap_id);
`;
export interface CaptureSourceSession {
  readonly sessionId: string;
  readonly sourceNamespace: string;
  readonly collectorId: string;
  readonly pageId: string;
  readonly startedAt: number;
}
export type CaptureHealthKind = "connected" | "disconnected" | "capacity" | "persistence" | "closed";

function id(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Capture health identity is invalid");
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Capture health timestamp is invalid");
}

export function createPostgresCaptureHealthRepository(transaction: PostgresTransaction) {
  async function owned(sessionId: string, allowClosed = false) {
    id(sessionId);
    const result = await transaction.query(`SELECT s.* FROM capture_source_heads h
      JOIN capture_source_sessions s ON s.session_id=h.active_session_id
      WHERE s.session_id=$1 FOR UPDATE OF h,s`, [sessionId]);
    const row = result.rows[0];
    if (!row || (!allowClosed && ["closed","abandoned"].includes(String(row.state)))) throw new Error("Capture source session is no longer active");
    return row;
  }
  async function openGap(sessionId: string, gapId: string, reason: string, openedAt: number, lowerBound: boolean) {
    await transaction.query(`INSERT INTO capture_source_gaps(gap_id,session_id,reason_code,opened_at,start_is_lower_bound,coverage_state)
      VALUES($1,$2,$3,$4,$5,'open') ON CONFLICT(session_id) WHERE resumed_at IS NULL DO NOTHING`,
    [gapId,sessionId,reason,openedAt,lowerBound]);
  }
  return Object.freeze({
    async start(input: CaptureSourceSession): Promise<boolean> {
      [input.sessionId,input.sourceNamespace,input.collectorId,input.pageId].forEach(id); time(input.startedAt);
      const scope = [input.sourceNamespace,input.collectorId,input.pageId];
      await transaction.query(`INSERT INTO capture_source_heads(source_namespace,collector_id,page_id)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,scope);
      const heads = await transaction.query(`SELECT active_session_id FROM capture_source_heads
        WHERE source_namespace=$1 AND collector_id=$2 AND page_id=$3 FOR UPDATE`,scope);
      const head = heads.rows[0];
      if (!head) throw new Error("Capture source head was not persisted");
      const existing = await transaction.query("SELECT * FROM capture_source_sessions WHERE session_id=$1",[input.sessionId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.source_namespace!==input.sourceNamespace || row.collector_id!==input.collectorId || row.page_id!==input.pageId
          || Number(row.started_at)!==input.startedAt || head.active_session_id!==input.sessionId
          || ["closed","abandoned"].includes(String(row.state))) throw new Error("Capture session restart identity conflicts with its durable owner");
        return false;
      }
      if (head.active_session_id !== null) {
        const prior = await transaction.query("SELECT * FROM capture_source_sessions WHERE session_id=$1 FOR UPDATE",[head.active_session_id]);
        const row = prior.rows[0];
        if (!row) throw new Error("Previous capture source session is missing");
        if (input.startedAt < Number(row.last_seen_at)) throw new Error("Capture replacement cannot precede the previous session heartbeat");
        if (!["closed","abandoned"].includes(String(row.state))) {
          await openGap(String(row.session_id),`${input.sessionId}:replaced`,"session_replaced",Number(row.last_seen_at),true);
          await transaction.query(`UPDATE capture_source_sessions SET state='abandoned',closed_at=$2,state_changed_at=$2
            WHERE session_id=$1`,[row.session_id,input.startedAt]);
        }
      }
      await transaction.query(`INSERT INTO capture_source_sessions(session_id,source_namespace,collector_id,page_id,
        started_at,last_seen_at,state_changed_at,state) VALUES($1,$2,$3,$4,$5,$5,$5,'starting')`,
      [input.sessionId,...scope,input.startedAt]);
      await transaction.query(`UPDATE capture_source_heads SET active_session_id=$4
        WHERE source_namespace=$1 AND collector_id=$2 AND page_id=$3`,[...scope,input.sessionId]);
      await openGap(input.sessionId,`${input.sessionId}:startup`,"collector_starting",input.startedAt,false);
      return true;
    },
    async assertActive(sessionId: string): Promise<void> { await owned(sessionId); },
    async heartbeat(sessionId: string, observedAt: number): Promise<void> {
      time(observedAt); const row = await owned(sessionId);
      if (observedAt < Number(row.started_at)) throw new Error("Capture heartbeat precedes session start");
      await transaction.query("UPDATE capture_source_sessions SET last_seen_at=GREATEST(last_seen_at,$2) WHERE session_id=$1",[sessionId,observedAt]);
    },
    async transition(sessionId: string, event: { readonly eventId:string; readonly kind:CaptureHealthKind; readonly occurredAt:number }): Promise<boolean> {
      id(sessionId); id(event.eventId); time(event.occurredAt);
      if (!["connected","disconnected","capacity","persistence","closed"].includes(event.kind)) throw new Error("Capture health event kind is invalid");
      const replayed = async () => {
        const duplicate = await transaction.query("SELECT * FROM capture_source_health_events WHERE event_id=$1",[event.eventId]);
        const row = duplicate.rows[0];
        if (!row) return false;
        if (row.session_id!==sessionId || row.event_kind!==event.kind || Number(row.occurred_at)!==event.occurredAt) {
          throw new Error("Capture health event identity conflicts with its original content");
        }
        return true;
      };
      if (await replayed()) return false;
      const row = await owned(sessionId,true);
      // A concurrent delivery may have committed while this transaction waited for ownership.
      if (await replayed()) return false;
      if (["closed","abandoned"].includes(String(row.state))) throw new Error("Capture source session is no longer active");
      if (event.occurredAt < Number(row.state_changed_at)) throw new Error("Capture state transition would reverse event time");
      await transaction.query(`INSERT INTO capture_source_health_events(event_id,session_id,event_kind,occurred_at)
        VALUES($1,$2,$3,$4)`,[event.eventId,sessionId,event.kind,event.occurredAt]);
      if (event.kind === "connected") {
        // Connection recovery bounds the missing interval, not proof that its data was replayed.
        await transaction.query(`UPDATE capture_source_gaps g SET resumed_at=$4,coverage_state='awaiting_verification'
          FROM capture_source_sessions s WHERE s.session_id=g.session_id AND s.source_namespace=$1
          AND s.collector_id=$2 AND s.page_id=$3 AND g.resumed_at IS NULL AND g.opened_at<=$4`,
        [row.source_namespace,row.collector_id,row.page_id,event.occurredAt]);
      } else await openGap(sessionId,event.eventId,event.kind,event.occurredAt,false);
      const state = event.kind === "connected" ? "connected" : event.kind === "disconnected" ? "disconnected"
        : event.kind === "closed" ? "closed" : "paused";
      await transaction.query(`UPDATE capture_source_sessions SET state=$2,state_changed_at=$3,last_seen_at=GREATEST(last_seen_at,$3),
        closed_at=CASE WHEN $2='closed' THEN $3 ELSE NULL END WHERE session_id=$1`,[sessionId,state,event.occurredAt]);
      return true;
    },
    async unverifiedGaps(input: { readonly sourceNamespace:string; readonly collectorId:string; readonly pageId:string; readonly limit:number }) {
      [input.sourceNamespace,input.collectorId,input.pageId].forEach(id);
      if (!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>1000) throw new Error("Capture gap read limit must be between 1 and 1000");
      const result = await transaction.query(`SELECT g.* FROM capture_source_gaps g JOIN capture_source_sessions s USING(session_id)
        WHERE s.source_namespace=$1 AND s.collector_id=$2 AND s.page_id=$3 ORDER BY g.opened_at,g.gap_id LIMIT $4`,
      [input.sourceNamespace,input.collectorId,input.pageId,input.limit]);
      return result.rows;
    },
  });
}
