import { createHash } from "node:crypto";

export interface FomoLiveActivity {
  readonly eventId: string;
  readonly sourceTradeId: string;
  readonly accountId: string;
  readonly handle: string;
  readonly chain: "solana" | "eth" | "bsc" | "base" | "robinhood";
  readonly tokenAddress: string;
  readonly side: "buy" | "sell";
  readonly occurredAt: number;
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 128 ? value.trim() : null;
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const chains: Readonly<Record<number, FomoLiveActivity["chain"]>> = {
  1: "eth", 56: "bsc", 8453: "base", 4663: "robinhood", 1399811149: "solana",
};

export function normalizeFomoLiveActivity(body: string): FomoLiveActivity | null {
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) return null;
  let root: Record<string, unknown> | null;
  try { root = record(JSON.parse(body)); } catch { return null; }
  if (root?.type !== "data" || root.topicType !== "trading_activity") return null;
  const payload = record(root.payload);
  if (!payload) return null;
  const sourceTradeId = text(payload.tradeId) ?? text(payload.id);
  const accountId = text(payload.userId);
  const handle = text(payload.userHandle);
  const address = text(payload.tokenAddress);
  const chain = typeof payload.networkId === "number" ? chains[payload.networkId] : undefined;
  const side = payload.type === "swap_buy" ? "buy" : payload.type === "swap_sell" ? "sell" : null;
  const occurredAt = typeof payload.createdAt === "string" ? Date.parse(payload.createdAt) : NaN;
  if (!sourceTradeId || !accountId || !handle || !address || !chain || !side || !Number.isSafeInteger(occurredAt) || occurredAt < 0) return null;
  for (const key of ["usdAmount", "price", "marketCap"] as const) {
    if (payload[key] !== undefined && payload[key] !== null && amount(payload[key]) === null) return null;
  }
  const tokenAddress = chain === "solana" ? address : address.toLowerCase();
  const eventId = `fomo-live:${createHash("sha256").update(JSON.stringify([accountId, sourceTradeId, chain, tokenAddress, side])).digest("hex")}`;
  return Object.freeze({ eventId, sourceTradeId, accountId, handle, chain, tokenAddress, side,
    occurredAt, amountUsd: amount(payload.usdAmount), priceUsd: amount(payload.price), marketCapUsd: amount(payload.marketCap) });
}
