import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFomoLiveInbox, initializeFomoLiveInboxSchema } from "@address-radar/database";
import { createFomoLiveCollector } from "../src/fomo-live-collector.js";
const frame=JSON.stringify({type:"data",topicType:"trading_activity",payload:{id:"original-trade",type:"swap_buy",userId:"account",userHandle:"alpha",tokenAddress:"Mint",networkId:1399811149,createdAt:"2026-10-02T09:00:00.000Z",usdAmount:100}});
it("preserves sanitized original source fields after a failed first durable write",async()=>{
  const db=new DatabaseSync(":memory:");initializeFomoLiveInboxSchema(db);
  try {
    const store=createFomoLiveInbox(db);let failed=false;
    const inbox={...store,append:(...args:Parameters<typeof store.append>)=>{if(!failed){failed=true;throw new Error("temporary write failure");}return store.append(...args);}};
    const collector=createFomoLiveCollector({inbox,targets:()=>[{accountId:"account",entityId:"entity"}]});
    expect(()=>collector.receive(frame)).toThrow("temporary write failure");
    expect((await collector.collect()).observations).toHaveLength(1);
    const row=db.prepare("SELECT raw_payload AS raw FROM fomo_live_inbox").get() as {raw:string};
    expect(JSON.parse(row.raw)).toMatchObject({payload:{id:"original-trade",userId:"account",createdAt:"2026-10-02T09:00:00.000Z"}});
  } finally {db.close();}
});
