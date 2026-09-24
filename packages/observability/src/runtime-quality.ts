export type ProviderStatus = "ready" | "degraded" | "unavailable";

export interface RuntimeQualityInput {
  readonly now: number;
  readonly lastEventAt: number | null;
  readonly oldestQueuedAt: number | null;
  readonly latestAggregationAt: number | null;
  readonly registryVersion: number;
  readonly providerStatuses: Readonly<Record<string, ProviderStatus>>;
}

export interface RuntimeQualitySnapshot {
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
  const status = values.includes("unavailable")
    ? "unavailable"
    : values.includes("degraded")
      ? "degraded"
      : "healthy";
  return Object.freeze({
    eventFreshnessMs: lag(input.now, input.lastEventAt),
    queueLagMs: lag(input.now, input.oldestQueuedAt) ?? 0,
    aggregationLagMs: lag(input.now, input.latestAggregationAt),
    registryVersion: input.registryVersion,
    providerStatuses: statuses,
    status,
  });
}
