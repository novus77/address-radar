import { describe, expect, it } from "vitest";

import { createSignatureMessage, signGatewayRequest, verifyGatewayRequestSignature } from "../src/index.js";

const vector = { timestamp: "1790236800000", nonce: "nonce-1", body: "{\"signalId\":\"signal-1\"}", secret: "shared-secret" } as const;
const expected = "70ef33a75848a9790390c32fc7867369fd14a6897766f0a1d32c9c3ecf03e1fc";

describe("gateway request signature", () => {
  it("uses a stable canonical message and signature", () => {
    expect(createSignatureMessage(vector)).toBe(`${vector.timestamp}.${vector.nonce}.${vector.body}`);
    expect(signGatewayRequest(vector)).toBe(expected);
  });

  it("rejects malformed and mismatched signatures", () => {
    expect(verifyGatewayRequestSignature({ ...vector, signature: expected })).toBe(true);
    expect(verifyGatewayRequestSignature({ ...vector, signature: "00" })).toBe(false);
    expect(verifyGatewayRequestSignature({ ...vector, body: "{}", signature: expected })).toBe(false);
  });
});
