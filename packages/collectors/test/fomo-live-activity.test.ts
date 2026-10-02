import { describe, expect, it } from "vitest";
import { normalizeFomoLiveActivity } from "../src/fomo/live-activity.js";
const frame = {type:"data",topicType:"trading_activity",payload:{id:"activity-1",type:"swap_buy",userId:"account",userHandle:"alpha",tokenAddress:"CaseSensitiveMint",networkId:1399811149,createdAt:"2026-10-02T09:00:00.000Z",usdAmount:100,price:0.001}};
describe("FOMO live activity boundary", () => {
  it("preserves account and execution basis without a wallet", () => {
    const result = normalizeFomoLiveActivity(JSON.stringify(frame));
    expect(result).toMatchObject({accountId:"account",handle:"alpha",chain:"solana",tokenAddress:"CaseSensitiveMint",side:"buy",amountUsd:100,priceUsd:0.001,occurredAt:Date.parse(frame.payload.createdAt)});
    expect(normalizeFomoLiveActivity(JSON.stringify(frame))).toEqual(result);
  });
  it.each([1,56,8453,4663])("accepts supported EVM network %s", networkId => {
    expect(normalizeFomoLiveActivity(JSON.stringify({...frame,payload:{...frame.payload,networkId,tokenAddress:"0xAbC"}}))?.tokenAddress).toBe("0xabc");
  });
  it.each([{id:undefined},{userId:undefined},{type:"transfer_out"},{networkId:143},{createdAt:"invalid"},{usdAmount:-1},{price:-1}])("rejects invalid or unsupported activity %j", patch => {
    expect(normalizeFomoLiveActivity(JSON.stringify({...frame,payload:{...frame.payload,...patch}}))).toBeNull();
  });
  it("does not manufacture missing amount or price", () => {
    expect(normalizeFomoLiveActivity(JSON.stringify({...frame,payload:{...frame.payload,usdAmount:undefined,price:undefined}}))).toMatchObject({amountUsd:null,priceUsd:null});
  });
});
