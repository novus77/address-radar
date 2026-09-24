import type { ChainFamily, IdentityConfidence } from "./model.js";

const confidenceOrder: Readonly<Record<IdentityConfidence, number>> = Object.freeze({ low: 0, medium: 1, high: 2, confirmed: 3 });

export function normalizeFomoHandle(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "").toLowerCase();
  if (!normalized || normalized.length > 128) throw new Error("Invalid Fomo handle");
  return normalized;
}

export function normalizeWalletAddress(chainFamily: ChainFamily, address: string): string {
  const normalized = address.trim();
  if (!normalized || normalized.length > 256) throw new Error("Invalid wallet address");
  return chainFamily === "evm" ? normalized.toLowerCase() : normalized;
}

export function strongestIdentityConfidence(left: IdentityConfidence, right: IdentityConfidence): IdentityConfidence {
  return confidenceOrder[left] >= confidenceOrder[right] ? left : right;
}
