import type { TraderEvent } from "@address-radar/domain";

const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const finiteNonNegative = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};

export interface FomoHistoryObservation {
  readonly event: TraderEvent;
  readonly handle: string;
  readonly sourceTradeId: string | null;
}

export interface FomoHistoryEvent {
  readonly eventId: string;
  readonly accountId: string;
  readonly handle: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly occurredAt: number;
  readonly sourceTradeId: string | null;
}

export interface FomoHistoryRepository {
  accountByHandle(handle: string): { readonly accountId: string } | null;
  upsertFomoAccount(input: { readonly accountId: string; readonly handle: string; readonly firstSeenAt: number; readonly lastSeenAt: number }): unknown;
  ensureTraderEntity(input: { readonly entityId: string; readonly lifecycle: "suspended"; readonly manual: false; readonly locked: false; readonly createdAt: number; readonly updatedAt: number }): unknown;
  linkAccountToEntity(input: { readonly entityId: string; readonly accountId: string; readonly confidence: "high"; readonly source: "fomo_token_history"; readonly observedAt: number }): unknown;
  insertTraderEvent(event: TraderEvent): { readonly inserted: boolean };
}

export function parseFomoHistoryEvent(line: string): FomoHistoryEvent | null {
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
  if (root?.kind !== "event" || !eventId || !accountId || !handle || !chain || !rawTokenAddress || (side !== "buy" && side !== "sell") || eventType !== `fomo.activity.${side}` || occurredAt === null || !Number.isSafeInteger(occurredAt) || occurredAt < 0) return null;
  return Object.freeze({
    eventId,
    accountId,
    handle: handle.replace(/^@/, "").toLowerCase(),
    chain,
    tokenAddress: chain === "solana" ? rawTokenAddress : rawTokenAddress.toLowerCase(),
    side,
    amountUsd: finiteNonNegative(payload?.usdAmount),
    priceUsd: finiteNonNegative(payload?.price),
    marketCapUsd: finiteNonNegative(payload?.marketCap),
    occurredAt,
    sourceTradeId: text(payload?.sourceTradeId),
  });
}

const traderEvent = (event: FomoHistoryEvent, accountId: string, collectedAt: number): TraderEvent => Object.freeze({
  eventId: event.eventId,
  accountId,
  entityId: `fomo:${accountId}`,
  chain: event.chain,
  tokenAddress: event.tokenAddress,
  side: event.side,
  amountUsd: finiteNonNegative(event.amountUsd),
  priceUsd: finiteNonNegative(event.priceUsd),
  marketCapUsd: finiteNonNegative(event.marketCapUsd),
  tokenAgeMs: null,
  occurredAt: event.occurredAt,
  collectedAt,
  source: "fomo_token_history",
});

export function importFomoHistoryEvent(repository: FomoHistoryRepository, event: FomoHistoryEvent, collectedAt: number): boolean {
  const existing = repository.accountByHandle(event.handle);
  const accountId = existing?.accountId ?? event.accountId;
  const entityId = `fomo:${accountId}`;
  repository.upsertFomoAccount({ accountId, handle: event.handle, firstSeenAt: event.occurredAt, lastSeenAt: event.occurredAt });
  repository.ensureTraderEntity({ entityId, lifecycle: "suspended", manual: false, locked: false, createdAt: event.occurredAt, updatedAt: event.occurredAt });
  repository.linkAccountToEntity({ entityId, accountId, confidence: "high", source: "fomo_token_history", observedAt: event.occurredAt });
  return repository.insertTraderEvent(traderEvent(event, accountId, collectedAt)).inserted;
}

export function parseFomoHistoryLine(line: string, input: { readonly collectedAt: number }): FomoHistoryObservation | null {
  const parsed = parseFomoHistoryEvent(line);
  if (!parsed || !Number.isSafeInteger(input.collectedAt) || input.collectedAt < 0) return null;
  const event = traderEvent(parsed, parsed.accountId, input.collectedAt);
  return Object.freeze({
    event,
    handle: parsed.handle,
    sourceTradeId: parsed.sourceTradeId,
  });
}

export function normalizeFomoHistoryLine(line: string, input: { readonly collectedAt: number }): TraderEvent | null {
  return parseFomoHistoryLine(line, input)?.event ?? null;
}
