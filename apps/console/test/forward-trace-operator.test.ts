import { describe,expect,it } from "vitest";
import { createTraceResponseFence,summarizeTracePurchase,summarizeTraceSignal } from "../public/forward-trace.js";
const row={revisionState:"original",pendingRevision:false,executionEvidenceRef:"trade:verified",ownershipEvidenceRef:"owner:verified",entryPriceUsd:"0.1",amountUsd:"50",amountEstimated:true,expiresAt:300,opportunity:{currentExecution:true,status:"hit",tier:3}};
describe("forward trace operator labels",()=>{
  it("describes opportunity rather than realized profit and preserves estimated amount",()=>{
    const result=summarizeTracePurchase(row,200);
    expect(result.opportunityLabel).toBe("已发现 3x 机会"); expect(result.amountLabel).toContain("名义估算");
  });
  it("does not show a hit without verified execution basis",()=>{expect(summarizeTracePurchase({...row,executionEvidenceRef:null},200).opportunityLabel).toBe("待补成交依据");});
  it("marks projections from another execution revision as stale",()=>{expect(summarizeTracePurchase({...row,opportunity:{...row.opportunity,currentExecution:false}},200).opportunityLabel).toBe("旧评估待重算");});
  it("does not treat expired observation with incomplete coverage as failure",()=>{expect(summarizeTracePurchase({...row,opportunity:{currentExecution:true,status:"observing"}},301).opportunityLabel).toContain("覆盖待核验");});
  it("never calls pending, validated or cancelled intents delivered",()=>{
    for(const status of ["validated","deferred","cancelled",null]) expect(summarizeTraceSignal({intentStatus:"pending",readinessStatus:status})).toContain("未播报");
  });
  it("rejects a response belonging to an older target or session",()=>{const fence=createTraceResponseFence(),old=fence.capture();fence.invalidate();expect(fence.isCurrent(old)).toBe(false);expect(fence.isCurrent(fence.capture())).toBe(true);});
});
