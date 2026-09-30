const HOUR_MS = 3_600_000;
export type HistoricalPrice = readonly [number, number];
export interface HistoricalPriceRange { readonly fromAt: number; readonly toAt: number }

export function mergeHistoricalPrices(primary: readonly HistoricalPrice[], fallback: readonly HistoricalPrice[], range: HistoricalPriceRange): HistoricalPrice[] {
  const points = new Map<number, number>();
  for (const [timestamp, price] of [...primary, ...fallback]) {
    if (!Number.isFinite(timestamp) || timestamp < Math.max(0, range.fromAt - HOUR_MS) || timestamp > range.toAt) continue;
    if (!Number.isFinite(price) || price <= 0 || points.has(timestamp)) continue;
    points.set(timestamp, price);
  }
  return [...points].sort((left, right) => left[0] - right[0]);
}

export function hasHistoricalPriceCoverage(prices: readonly HistoricalPrice[], range: HistoricalPriceRange): boolean {
  const points = mergeHistoricalPrices(prices, [], range);
  if (points.length === 0 || points[0]![0] > range.fromAt || points.at(-1)![0] < range.toAt - HOUR_MS) return false;
  return points.every((point, index) => index === 0 || point[0] - points[index - 1]![0] <= HOUR_MS);
}
