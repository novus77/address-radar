import { describe, expect, it } from "vitest";

import { createGatewayClient, GatewayDeliveryError } from "../src/index.js";

const signal = { schemaVersion: "1", signalId: "solana:a", idempotencyKey: "solana:a:1", token: { chain: "solana", contractAddress: "a", symbol: null, name: null, imageUrl: null }, category: "new_token_discovery", broadcastSequence: 1, score: 0.8, confidence: 0.8, marketCapUsd: null, priceUsd: null, triggeredAt: "2026-09-24T08:00:00.000Z", expiresAt: "2026-09-24T08:15:00.000Z", display: { title: "Signal", summary: "Summary", reasonCodes: ["reason"] } } as const;

describe("gateway client", () => {
  it.each([200, 202])("accepts HTTP %s", async status => {
    const client = createGatewayClient({ endpoint: "http://gateway/signals", keyId: "key", secret: "secret", now: () => 1, nonce: () => "nonce", fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get("x-address-radar-signature")).toMatch(/^[a-f0-9]{64}$/);
      return new Response(null, { status });
    } });
    await expect(client.deliver(signal)).resolves.toBeUndefined();
  });

  it("classifies permanent and retryable failures", async () => {
    const permanent = createGatewayClient({ endpoint: "http://gateway/signals", keyId: "key", secret: "secret", fetch: async () => new Response(null, { status: 400 }) });
    const retryable = createGatewayClient({ endpoint: "http://gateway/signals", keyId: "key", secret: "secret", fetch: async () => new Response(null, { status: 500 }) });
    await expect(permanent.deliver(signal)).rejects.toMatchObject({ permanent: true, status: 400 } satisfies Partial<GatewayDeliveryError>);
    await expect(retryable.deliver(signal)).rejects.toMatchObject({ permanent: false, status: 500 } satisfies Partial<GatewayDeliveryError>);
  });
});
