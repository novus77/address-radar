import { randomUUID } from "node:crypto";

import type { RadarSignalV1 } from "@address-radar/radar-signal";

import { signGatewayRequest } from "./signature.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GatewayDeliveryError extends Error {
  readonly name = "GatewayDeliveryError";
  constructor(message: string, readonly permanent: boolean, readonly status: number | null) { super(message); }
}

export function createGatewayClient(input: {
  readonly endpoint: string;
  readonly keyId: string;
  readonly secret: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly timeoutMs?: number;
}) {
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? randomUUID;
  const timeoutMs = input.timeoutMs ?? 5_000;
  return Object.freeze({
    async deliver(signal: RadarSignalV1): Promise<void> {
      const body = JSON.stringify(signal);
      const timestamp = String(now());
      const requestNonce = nonce();
      const signature = signGatewayRequest({ timestamp, nonce: requestNonce, body, secret: input.secret });
      let response: Response;
      try {
        response = await fetcher(input.endpoint, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "content-type": "application/json",
            "x-address-radar-key-id": input.keyId,
            "x-address-radar-timestamp": timestamp,
            "x-address-radar-nonce": requestNonce,
            "x-address-radar-signature": signature,
          },
        });
      } catch (error) {
        throw new GatewayDeliveryError(error instanceof Error ? error.message : String(error), false, null);
      }
      if (response.status === 200 || response.status === 202) return;
      const permanent = response.status === 400 || response.status === 401 || response.status === 404;
      throw new GatewayDeliveryError(`Gateway returned HTTP ${response.status}`, permanent, response.status);
    },
  });
}
