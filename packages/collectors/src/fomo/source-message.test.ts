import { describe, expect, it } from "vitest";
import { prepareFomoSourceMessage, fomoSourceObservation } from "./source-message.js";

const payload = { tradeId: "position-1", userId: "account-1", userHandle: "trader",
  tokenAddress: "0xAbC", networkId: 8453, type: "swap_buy", createdAt: "2026-10-02T00:00:00Z",
  usdAmount: 50, price: 0.01, marketCap: 100000 };
const input = (fields = payload) => ({ sourceMessageId: "message-1", sourceUrl: "wss://feed.example/live?access_token=secret",
  approvedOrigins: ["wss://feed.example"], maximumPayloadBytes: 65536,
  body: JSON.stringify({ type: "data", topicType: "trading_activity", authorization: "Bearer secret", payload: fields }) });

describe("FOMO source projection", () => {
  it("removes credentials and retains a reported purchase without granting economic eligibility", () => {
    const prepared = prepareFomoSourceMessage(input())!;
    expect(prepared.scrubbedPayload).not.toContain("secret");
    expect(prepared.activity?.tokenAddress).toBe("0xabc");
    expect(fomoSourceObservation(prepared.activity!, prepared.sourceEventId)).toMatchObject({ amountBasis: "source_reported_usd",
      amountEstimated: null, entityId: null, eligibleForOpportunity: false, entryBasis: "awaiting_execution_verification" });
  });
  it("rejects unapproved origins, missing source identities and oversized payloads", () => {
    expect(prepareFomoSourceMessage({ ...input(), sourceUrl: "wss://feed.example.attacker/live" })).toBeNull();
    expect(prepareFomoSourceMessage({ ...input(), sourceMessageId: "" })).toBeNull();
    expect(prepareFomoSourceMessage({ ...input(), maximumPayloadBytes: 10 })).toBeNull();
  });
  it("keeps separate source messages sharing a position identity", () => {
    expect(prepareFomoSourceMessage(input())?.sourceEventId).toBe("message-1");
    expect(prepareFomoSourceMessage({ ...input(), sourceMessageId: "message-2" })?.sourceEventId).toBe("message-2");
  });
  it("does not treat handle changes as a business revision", () => {
    const original = prepareFomoSourceMessage(input())!;
    const renamed = prepareFomoSourceMessage(input({ ...payload, userHandle: "new-name" }))!;
    expect(renamed.semanticPayload).toBe(original.semanticPayload);
    expect(renamed.scrubbedPayload).not.toBe(original.scrubbedPayload);
  });
  it("retains incomplete known fields without inventing a purchase", () => {
    const prepared = prepareFomoSourceMessage({ ...input(), body: JSON.stringify({ type: "data", topicType: "trading_activity",
      payload: { userId: "account-1", type: "swap_buy", password: "secret", extra: { cookie: "secret" } } }) })!;
    expect(prepared.activity).toBeNull();
    expect(prepared.normalizationReason).toBe("unsupported_or_incomplete_activity");
    expect(prepared.scrubbedPayload).not.toContain("secret");
  });
  it("distinguishes a sell and missing amount from a qualified buy", () => {
    const prepared = prepareFomoSourceMessage({ ...input(), body: JSON.stringify({ type: "data", topicType: "trading_activity",
      payload: { ...payload, type: "swap_sell", usdAmount: null } }) })!;
    expect(fomoSourceObservation(prepared.activity!, prepared.sourceEventId)).toMatchObject({ side: "sell", amountUsd: null, amountBasis: "missing", eligibleForOpportunity: false });
  });
  it("does not convert unsupported transfers to purchases", () => {
    expect(prepareFomoSourceMessage(input({ ...payload, type: "transfer" }))?.activity).toBeNull();
  });
});

it("separates message identity from position identity without exposing a legacy event key", () => {
  const prepared = prepareFomoSourceMessage(input())!;
  const first = fomoSourceObservation(prepared.activity!, "message-1");
  const second = fomoSourceObservation(prepared.activity!, "message-2");
  expect(first.sourceEventId).not.toBe(second.sourceEventId);
  expect(first.sourcePositionId).toBe(second.sourcePositionId);
  expect(first).not.toHaveProperty("eventId");
  expect(first).not.toHaveProperty("sourceTradeId");
  expect(first.economicTradeIdentity).toBe("unverified");
});

it("rejects an absent source message identity instead of substituting a position ID", () => {
  const prepared = prepareFomoSourceMessage(input())!;
  expect(() => fomoSourceObservation(prepared.activity!, "")).toThrow("message identity is invalid");
});
