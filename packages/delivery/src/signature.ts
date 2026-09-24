import { createHmac, timingSafeEqual } from "node:crypto";

export interface GatewaySignatureInput {
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: string;
}

export function createSignatureMessage(input: GatewaySignatureInput): string {
  return `${input.timestamp}.${input.nonce}.${input.body}`;
}

export function signGatewayRequest(input: GatewaySignatureInput & { readonly secret: string }): string {
  return createHmac("sha256", input.secret).update(createSignatureMessage(input)).digest("hex");
}

export function verifyGatewayRequestSignature(
  input: GatewaySignatureInput & { readonly secret: string; readonly signature: string },
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const expected = Buffer.from(signGatewayRequest(input), "hex");
  const actual = Buffer.from(input.signature, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}
