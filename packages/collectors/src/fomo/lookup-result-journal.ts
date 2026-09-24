export interface FomoTokenLookupResult {
  readonly version: 1 | 2;
  readonly lookupId: string;
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly completedAt: number;
  readonly holderCount: number;
  readonly queriedTraderCount: number;
  readonly observationCount: number;
  readonly eventIds?: readonly string[];
  readonly purpose?: "milestone_backfill";
  readonly milestoneId?: string;
  readonly beforeAt?: number;
}

export interface FomoTokenLookupResultLease {
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  readonly result: FomoTokenLookupResult;
}

export interface FomoTokenLookupResultConsumer {
  next(): Promise<FomoTokenLookupResultLease | null>;
  complete(lease: FomoTokenLookupResultLease): Promise<void>;
}

const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function parseFomoLookupResult(line: string): FomoTokenLookupResult | null {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    value = parsed as Record<string, unknown>;
  } catch { return null; }
  if (
    (value.version !== 1 && value.version !== 2) || typeof value.lookupId !== "string" || !value.lookupId.trim() ||
    typeof value.chainId !== "string" || !value.chainId.trim() || typeof value.tokenAddress !== "string" || !value.tokenAddress.trim() ||
    !nonNegativeInteger(value.completedAt) || !nonNegativeInteger(value.holderCount) ||
    !nonNegativeInteger(value.queriedTraderCount) || !nonNegativeInteger(value.observationCount)
  ) return null;
  if (value.eventIds !== undefined && (!Array.isArray(value.eventIds) || value.eventIds.some(item => typeof item !== "string" || !item))) return null;
  if (value.purpose !== undefined && value.purpose !== "milestone_backfill") return null;
  if (value.milestoneId !== undefined && typeof value.milestoneId !== "string") return null;
  if (value.beforeAt !== undefined && !nonNegativeInteger(value.beforeAt)) return null;
  return Object.freeze(value as unknown as FomoTokenLookupResult);
}
