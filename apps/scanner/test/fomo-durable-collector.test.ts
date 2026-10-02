import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFomoLiveInbox, initializeFomoLiveInboxSchema } from "@address-radar/database";
import { createFomoLiveCollector } from "../src/fomo-live-collector.js";
const frame=JSON.stringify({type:"data",topicType:"trading_activity",payload:{id:"trade",type:"swap_buy",userId:"account",userHandle:"alpha",tokenAddress:"Mint",networkId:1399811149,createdAt:"2026-10-02T09:00:00.000Z",usdAmount:100,secret:"must-not-persist"}});
describe("durable scanner FOMO capture",()=>{
  it("replays persisted input after collector recreation and acknowledges only committed batches",async()=>{
    const db=new DatabaseSync(":memory:");initializeFomoLiveInboxSchema(db);
    try {
      const inbox=createFomoLiveInbox(db);const options={inbox,targets:()=>[{accountId:"account",entityId:"entity"}]};
      createFomoLiveCollector(options).receive(frame);
      const restarted=createFomoLiveCollector(options);const batch=await restarted.collect();
      expect(batch.observations).toHaveLength(1);expect((await restarted.collect()).observations).toHaveLength(1);
      expect(String((db.prepare("SELECT raw_payload AS raw FROM fomo_live_inbox").get() as {raw:string}).raw)).not.toContain("must-not-persist");
      batch.commit?.();expect((await restarted.collect()).observations).toEqual([]);
    } finally {db.close();}
  });
});
