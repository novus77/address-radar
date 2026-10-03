import { describe,expect,it } from "vitest";
import * as domain from "../src/index.js";
describe("forward signal policy",() => {
  it("provides the confirmed forward policy separately from the legacy score route",() => {
    expect(typeof (domain as unknown as Record<string,unknown>).evaluateForwardSignal).toBe("function");
  });
});

import { evaluateForwardSignal,type ForwardSignalEvidence } from "../src/forward-signal-policy.js";
const now = 2_000_000;
const evidence = (entityId: string,overrides: Partial<ForwardSignalEvidence> = {}): ForwardSignalEvidence => ({
  sample: { sampleId: `sample:${entityId}`,executionFingerprint: `execution:${entityId}`,entityId,chain: "base",tokenAddress: "token",boughtAt: now,
    amountUsd: "50",amountEstimated: true,entryPriceUsd: "1",entryBasisVerified: true,executionEvidenceRef: `entry:${entityId}` },
  economicKey: `trade:${entityId}`,radarEligible: true,qualificationPending: false,authorizationStamp: `authorization:${entityId}`,refreshReceiptId: `refresh:${entityId}`,
  liveSourceVerified: true,sourceEvidenceRef: `live:${entityId}`,independenceKey: entityId,riskVerdict: "validated",riskEvidenceRef: `risk:${entityId}`,...overrides,
});
describe("confirmed forward signal gates",() => {
  it("accepts two independent fifty-dollar buyers without launch time, score or sales",() => {
    const result = evaluateForwardSignal({ asOf: now,evidence: [evidence("a"),evidence("b")] });
    expect(result.action).toBe("ready"); expect(result.participantCount).toBe(2); expect(result.windowMs).toBe(900_000);
    expect(result.accepted[0]!.sample.amountEstimated).toBe(true);
  });
  it("counts FOMO and wallet representations of the same execution once",() => {
    const item = evidence("a"); const result = evaluateForwardSignal({ asOf: now,evidence: [item,{ ...item,sourceEvidenceRef: "wallet-proof" }] });
    expect(result.action).toBe("observe"); expect(result.participantCount).toBe(1); expect(result.accepted).toHaveLength(0);
  });
  it("does not count repeated buys by the same trader as independent participants",() => {
    const item = evidence("a"); const result = evaluateForwardSignal({ asOf: now,evidence: [item,{ ...item,economicKey: "second-trade" }] });
    expect(result.participantCount).toBe(1);
  });
  it("quarantines conflicting economic-event ownership",() => {
    const result = evaluateForwardSignal({ asOf: now,evidence: [evidence("a"),evidence("b",{ economicKey: "trade:a" })] });
    expect(result.action).toBe("deferred"); expect(result.reasonCodes).toContain("economic_event_conflict");
  });
  it("anchors the window to now rather than reviving stale history",() => {
    const a = evidence("a"),b = evidence("b");
    expect(evaluateForwardSignal({ asOf: now+900_001,evidence: [a,b] }).action).toBe("observe");
    expect(evaluateForwardSignal({ asOf: now+900_000,evidence: [a,b] }).action).toBe("ready");
  });
  it("defers missing provenance and refresh proofs without acknowledging samples",() => {
    const result = evaluateForwardSignal({ asOf: now,evidence: [evidence("a",{ qualificationPending: true }),evidence("b",{ liveSourceVerified: false })] });
    expect(result.action).toBe("deferred"); expect(result.accepted).toHaveLength(0); expect(result.consumedEconomicKeys).toHaveLength(0);
  });
  it("collapses risk-linked identities and requires an explicit risk assessment",() => {
    expect(evaluateForwardSignal({ asOf: now,evidence: [evidence("a",{ independenceKey: "group" }),evidence("b",{ independenceKey: "group" })] }).participantCount).toBe(1);
    expect(evaluateForwardSignal({ asOf: now,evidence: [evidence("a"),evidence("b",{ riskVerdict: "pending" })] }).action).toBe("deferred");
  });
  it("does not accumulate sub-threshold buys into a qualifying single buy",() => {
    const a = evidence("a"),b = evidence("b");
    expect(evaluateForwardSignal({ asOf: now,evidence: [{ ...a,sample: { ...a.sample,amountUsd: "49.99" } },b] }).action).toBe("observe");
  });
});
