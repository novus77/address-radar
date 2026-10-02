import { describe, expect, it } from "vitest";
import { createFomoLiveCollector } from "../src/fomo-live-collector.js";
const frame = JSON.stringify({type:"data",topicType:"trading_activity",payload:{id:"trade",type:"swap_buy",userId:"account",userHandle:"alpha",tokenAddress:"Mint",networkId:1399811149,createdAt:"2026-10-02T09:00:00.000Z",usdAmount:100}});
describe("FOMO live collector acknowledgement", () => {
  it("retains pending trades until scanner commit", async () => {
    const collector = createFomoLiveCollector({targets:()=>[{accountId:"account",entityId:"entity"}],now:()=>100});
    collector.receive(frame);
    const first = await collector.collect();
    expect(first.observations[0]?.event).toMatchObject({entityId:"entity",accountId:"account",source:"fomo_stream",amountUsd:100});
    expect((await collector.collect()).observations).toEqual(first.observations);
    first.commit?.();
    expect((await collector.collect()).observations).toEqual([]);
  });
  it("does not discard a newer message when committing an older batch", async () => {
    const collector = createFomoLiveCollector({targets:()=>[{accountId:"account",entityId:"entity"}]});
    collector.receive(frame);
    const batch=await collector.collect();
    collector.receive(frame.replace('"trade"','"later"'));
    batch.commit?.();
    expect((await collector.collect()).observations).toHaveLength(1);
  });
  it("rejects unknown accounts and reports bounded overflow", async () => {
    const collector=createFomoLiveCollector({targets:()=>[{accountId:"account",entityId:"entity"}],capacity:1});
    expect(collector.receive(frame.replace('"account"','"other"'))).toBe(false);
    expect(collector.receive(frame)).toBe(true);
    expect(collector.receive(frame.replace('"trade"','"later"'))).toBe(false);
    expect(collector.diagnostics()).toMatchObject({pending:1,overflow:1,coverageComplete:false});
  });
  it("drops revoked targets before returning a batch", async () => {
    let enabled=true;
    const collector=createFomoLiveCollector({targets:()=>enabled?[{accountId:"account",entityId:"entity"}]:[]});
    collector.receive(frame);enabled=false;
    expect((await collector.collect()).observations).toEqual([]);
  });
});
