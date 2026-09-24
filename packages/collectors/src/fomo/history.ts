import type { TraderEvent } from "@address-radar/domain";

const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export interface FomoHistoryObservation {
  readonly event: TraderEvent;
  readonly handle: string;
  readonly sourceTradeId: string | null;
}

export function parseFomoHistoryLine(line: string, input: { readonly collectedAt: number }): FomoHistoryObservation | null {
  let root: Record<string, unknown> | null;
  try { root = object(JSON.parse(line)); } catch { return null; }
  const value = object(root?.value);
  const payload = object(value?.payload);
  const asset = object(payload?.asset);
  const trader = object(payload?.trader);
  const eventType = text(value?.eventType);
  const eventId = text(value?.eventId);
  const accountId = text(trader?.id);
  const handle = text(trader?.handle);
  const chain = text(asset?.chain)?.toLowerCase() ?? null;
  const rawTokenAddress = text(asset?.tokenAddress);
  const side = payload?.action;
  const occurredAt = finite(payload?.occurredAt) ?? finite(value?.occurredAt);
  if (
    root?.kind !== "event" || !eventType?.startsWith("fomo.activity.") || !eventId || !accountId || !handle ||
    !chain || !rawTokenAddress || (side !== "buy" && side !== "sell") || occurredAt === null ||
    !Number.isSafeInteger(occurredAt) || occurredAt < 0 || !Number.isSafeInteger(input.collectedAt) || input.collectedAt < 0
  ) return null;
  const event: TraderEvent = Object.freeze({
    eventId,
    accountId,
    entityId: `fomo:${accountId}`,
    chain,
    tokenAddress: chain === "solana" ? rawTokenAddress : rawTokenAddress.toLowerCase(),
    side,
    amountUsd: finite(payload?.usdAmount),
    priceUsd: finite(payload?.price),
    marketCapUsd: finite(payload?.marketCap),
    tokenAgeMs: null,
    occurredAt,
    collectedAt: input.collectedAt,
    source: "fomo_token_history",
  });
  return Object.freeze({
    event,
    handle: handle.replace(/^@/, "").toLowerCase(),
    sourceTradeId: text(payload?.sourceTradeId),
  });
}

export function normalizeFomoHistoryLine(line: string, input: { readonly collectedAt: number }): TraderEvent | null {
  return parseFomoHistoryLine(line, input)?.event ?? null;
}
