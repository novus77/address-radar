import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TraderEvent } from "@address-radar/domain";
import { withAddressRadarWriteTransaction } from "./connection.js";

export const FOMO_LIVE_INBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fomo_live_inbox (
  event_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  event_json TEXT NOT NULL, raw_payload TEXT NOT NULL, content_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL, processed_at INTEGER, discard_reason TEXT
);
CREATE INDEX IF NOT EXISTS fomo_live_inbox_pending ON fomo_live_inbox(received_at,event_id) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS fomo_live_inbox_revisions (
  event_id TEXT NOT NULL, content_hash TEXT NOT NULL, event_json TEXT NOT NULL,
  raw_payload TEXT NOT NULL, observed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(event_id,content_hash)
);
CREATE TABLE IF NOT EXISTS fomo_live_capture_sessions (
  session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, last_connected_at INTEGER,
  connected INTEGER NOT NULL DEFAULT 0, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS fomo_live_capture_gaps (
  gap_id TEXT PRIMARY KEY, starts_at INTEGER NOT NULL, ends_at INTEGER,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'uncovered'
);
`;
export function initializeFomoLiveInboxSchema(database: DatabaseSync): void { database.exec(FOMO_LIVE_INBOX_SCHEMA_SQL); }

export function createFomoLiveInbox(database: DatabaseSync) {
  const write = <T>(operation:()=>T):T => withAddressRadarWriteTransaction(database,operation,{label:"fomo-live-inbox"});
  return Object.freeze({
    append(event:TraderEvent,rawPayload:string):"inserted"|"duplicate"|"revision_pending" {
      const {collectedAt:ignored,...semantic}=event;
      const contentHash=createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
      return write(()=>{
        const existing=database.prepare("SELECT content_hash AS hash FROM fomo_live_inbox WHERE event_id=?").get(event.eventId) as {hash:string}|undefined;
        if(existing?.hash===contentHash) return "duplicate";
        if(existing) {
          database.prepare("INSERT OR IGNORE INTO fomo_live_inbox_revisions(event_id,content_hash,event_json,raw_payload,observed_at) VALUES (?,?,?,?,?)").run(event.eventId,contentHash,JSON.stringify(event),rawPayload,event.collectedAt);
          return "revision_pending";
        }
        database.prepare("INSERT INTO fomo_live_inbox(event_id,account_id,entity_id,event_json,raw_payload,content_hash,received_at) VALUES (?,?,?,?,?,?,?)").run(event.eventId,event.accountId,event.entityId,JSON.stringify(event),rawPayload,contentHash,event.collectedAt);
        return "inserted";
      });
    },
    pending(limit:number):readonly {event:TraderEvent}[] {
      if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error("inbox limit must be between 1 and 1000");
      const rows=database.prepare("SELECT event_json AS json FROM fomo_live_inbox WHERE processed_at IS NULL ORDER BY received_at,event_id LIMIT ?").all(limit) as unknown as {json:string}[];
      return Object.freeze(rows.map(row=>Object.freeze({event:JSON.parse(row.json) as TraderEvent})));
    },
    acknowledge(eventIds:readonly string[],at:number,discardReason:string|null=null):void {
      write(()=>{for(const id of eventIds) database.prepare("UPDATE fomo_live_inbox SET processed_at=?,discard_reason=? WHERE event_id=? AND processed_at IS NULL").run(at,discardReason,id);});
    },
    startSession(sessionId:string,at:number):void {
      write(()=>{
        const previous=database.prepare("SELECT session_id AS id,COALESCE(last_connected_at,started_at) AS last FROM fomo_live_capture_sessions WHERE ended_at IS NULL").all() as unknown as {id:string;last:number}[];
        for(const row of previous) {
          database.prepare("INSERT OR IGNORE INTO fomo_live_capture_gaps(gap_id,starts_at,reason) VALUES (?,?,'process_restart')").run(`restart:${row.id}`,row.last);
          database.prepare("UPDATE fomo_live_capture_sessions SET ended_at=?,connected=0 WHERE session_id=?").run(at,row.id);
        }
        database.prepare("INSERT INTO fomo_live_capture_sessions(session_id,started_at) VALUES (?,?)").run(sessionId,at);
        if(previous.length===0) database.prepare("INSERT INTO fomo_live_capture_gaps(gap_id,starts_at,reason) VALUES (?,?,'startup_coverage_unverified')").run(`startup:${sessionId}`,at);
      });
    },
    connection(sessionId:string,connected:boolean,at:number):void {
      write(()=>{
        const current=database.prepare("SELECT connected,COALESCE(last_connected_at,started_at) AS last FROM fomo_live_capture_sessions WHERE session_id=? AND ended_at IS NULL").get(sessionId) as {connected:number;last:number}|undefined;
        if(!current) throw new Error("active FOMO capture session is required");
        if(connected) {
          database.prepare("UPDATE fomo_live_capture_sessions SET connected=1,last_connected_at=? WHERE session_id=?").run(at,sessionId);
          database.prepare("UPDATE fomo_live_capture_gaps SET ends_at=? WHERE ends_at IS NULL").run(at);
        } else if(current.connected===1) {
          database.prepare("INSERT INTO fomo_live_capture_gaps(gap_id,starts_at,reason) VALUES (?,?,'cdp_disconnected')").run(randomUUID(),current.last);
          database.prepare("UPDATE fomo_live_capture_sessions SET connected=0 WHERE session_id=?").run(sessionId);
        }
      });
    },
    endSession(sessionId:string,at:number):void {
      this.connection(sessionId,false,at);
      write(()=>{database.prepare("UPDATE fomo_live_capture_sessions SET ended_at=? WHERE session_id=?").run(at,sessionId);});
    },
  });
}
export type FomoLiveInbox = ReturnType<typeof createFomoLiveInbox>;
