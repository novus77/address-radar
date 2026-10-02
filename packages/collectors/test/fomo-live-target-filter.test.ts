import { describe, expect, it } from "vitest";
import { selectFomoTargetActivity } from "../src/fomo/live-target-filter.js";
const payload = JSON.stringify({type:"data",topicType:"trading_activity",payload:{id:"trade",type:"swap_buy",userId:"account",userHandle:"alpha",tokenAddress:"Mint",networkId:1399811149,createdAt:"2026-10-02T09:00:00.000Z",usdAmount:100}});
const targets = [{accountId:"account",entityId:"trader"}];
describe("FOMO live target selection", () => {
  it("attributes a target by account ID without a wallet", () => {
    expect(selectFomoTargetActivity(payload,targets)).toMatchObject({entityId:"trader",activity:{accountId:"account",side:"buy"}});
  });
  it("does not match another account with the same handle", () => {
    expect(selectFomoTargetActivity(payload,[{accountId:"other",entityId:"trader"}])).toBeNull();
  });
  it("rejects conflicting target ownership", () => {
    expect(selectFomoTargetActivity(payload,[...targets,{accountId:"account",entityId:"other"}])).toBeNull();
  });
  it("accepts repeated identical ownership without double attribution", () => {
    expect(selectFomoTargetActivity(payload,[...targets,...targets])?.entityId).toBe("trader");
  });
  it("rejects malformed frames", () => {
    expect(selectFomoTargetActivity("not-json",targets)).toBeNull();
  });
});
