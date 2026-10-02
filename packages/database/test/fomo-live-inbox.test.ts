import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFomoLiveInbox, initializeFomoLiveInboxSchema } from "../src/fomo-live-inbox.js";
import type { TraderEvent } from "@address-radar/domain";
const event: TraderEvent = {eventId:"event",accountId:"account",entityId:"trader",chain:"solana",tokenAddress:"Mint",side:"buy",amountUsd:100,priceUsd:1,marketCapUsd:null,occurredAt:1,collectedAt:2,tokenAgeMs:null,source:"fomo_stream"};
describe("durable FOMO live inbox",()=>{
  it("replays unacknowledged events after store recreation",()=>{
    const db=new DatabaseSync(":memory:");initializeFomoLiveInboxSchema(db);
    try {
      const first=createFomoLiveInbox(db);expect(first.append(event,"{}" )).toBe("inserted");
      const recovered=createFomoLiveInbox(db);expect(recovered.pending(10)[0]?.event).toEqual(event);
      recovered.acknowledge(["event"],3);expect(recovered.pending(10)).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) n FROM fomo_live_inbox").get()).toEqual({n:1});
    } finally {db.close();}
  });
  it("deduplicates collection-time changes and audits business revisions",()=>{
    const db=new DatabaseSync(":memory:");initializeFomoLiveInboxSchema(db);
    try {
      const inbox=createFomoLiveInbox(db);inbox.append(event,"{}");
      expect(inbox.append({...event,collectedAt:3},"{}")).toBe("duplicate");
      expect(inbox.append({...event,priceUsd:2,collectedAt:4},"{\"priceUsd\":2}")).toBe("revision_pending");
      expect(inbox.pending(10)[0]?.event.priceUsd).toBe(1);
      expect(db.prepare("SELECT status FROM fomo_live_inbox_revisions").get()).toEqual({status:"pending"});
    } finally {db.close();}
  });
  it("records an uncovered restart interval without confirming coverage",()=>{
    const db=new DatabaseSync(":memory:");initializeFomoLiveInboxSchema(db);
    try {
      const first=createFomoLiveInbox(db);first.startSession("one",10);first.connection("one",true,20);
      const next=createFomoLiveInbox(db);next.startSession("two",30);next.connection("two",true,40);
      expect(db.prepare("SELECT starts_at AS start,ends_at AS end,status FROM fomo_live_capture_gaps WHERE reason='process_restart'").get()).toEqual({start:20,end:40,status:"uncovered"});
    } finally {db.close();}
  });
});
