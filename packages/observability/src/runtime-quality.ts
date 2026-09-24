export type ProviderStatus = "ready" | "degraded" | "unavailable";

export interface RuntimeQualityInput {
  readonly now: number;
  readonly lastEventAt: number | null;
  readonly oldestQueuedAt: number | null;
  readonly latestAggregationAt: number | null;
  readonly registryVersion: number;
  readonly providerStatuses: Readonly<Record<string, ProviderStatus>>;
  readonly staleAfterMs?: number;
}

export interface RuntimeQualitySnapshot {
  readonly recordedAt: number;
  readonly eventFreshnessMs: number | null;
  readonly queueLagMs: number;
  readonly aggregationLagMs: number | null;
  readonly registryVersion: number;
  readonly providerStatuses: Readonly<Record<string, ProviderStatus>>;
  readonly status: "healthy" | "degraded" | "unavailable";
}

const lag = (now: number, timestamp: number | null): number | null =>
  timestamp === null ? null : Math.max(0, now - timestamp);

export function createRuntimeQualitySnapshot(input: RuntimeQualityInput): RuntimeQualitySnapshot {
  const statuses = Object.freeze({ ...input.providerStatuses });
  const values = Object.values(statuses);
  const staleAfterMs = input.staleAfterMs ?? Number.POSITIVE_INFINITY;
  const stale = [lag(input.now, input.lastEventAt), lag(input.now, input.latestAggregationAt)].some(value => value !== null && value > staleAfterMs);
  const status = values.includes("unavailable")
    ? "unavailable"
    : values.includes("degraded") || stale
      ? "degraded"
      : "healthy";
  return Object.freeze({
    recordedAt: input.now,
    eventFreshnessMs: lag(input.now, input.lastEventAt),
    queueLagMs: lag(input.now, input.oldestQueuedAt) ?? 0,
    aggregationLagMs: lag(input.now, input.latestAggregationAt),
    registryVersion: input.registryVersion,
    providerStatuses: statuses,
    status,
  });
}

export interface RuntimeQualityRepository {
  saveRuntimeQualitySnapshot(snapshot: RuntimeQualitySnapshot): void;
  latestRuntimeQualitySnapshot(): RuntimeQualitySnapshot | null;
}
