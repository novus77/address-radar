import { statfs } from "node:fs/promises";

export interface RateLimitedErrorReporter {
  report(scope: string, error: unknown): void;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createRateLimitedErrorReporter(input: {
  readonly emit: (message: string, error?: unknown) => void;
  readonly windowMs: number;
  readonly now?: () => number;
}): RateLimitedErrorReporter {
  const now = input.now ?? Date.now;
  const entries = new Map<string, { lastEmittedAt: number; suppressed: number }>();
  return Object.freeze({
    report(scope: string, error: unknown): void {
      const key = `${scope}\u0000${errorMessage(error)}`;
      const timestamp = now();
      const existing = entries.get(key);
      if (existing && timestamp - existing.lastEmittedAt < input.windowMs) {
        existing.suppressed += 1;
        return;
      }
      const suppressed = existing?.suppressed ?? 0;
      entries.set(key, { lastEmittedAt: timestamp, suppressed: 0 });
      const suffix = suppressed > 0 ? ` (${suppressed} similar errors suppressed)` : "";
      input.emit(`${scope}: ${errorMessage(error)}${suffix}`, error);
    },
  });
}

export function createDiskHeadroomGuard(input: {
  readonly path: string;
  readonly minimumFreeBytes: number;
  readonly checkIntervalMs: number;
  readonly now?: () => number;
  readonly freeBytes?: (path: string) => Promise<number>;
}) {
  const now = input.now ?? Date.now;
  const freeBytes = input.freeBytes ?? (async (path: string) => {
    const stats = await statfs(path, { bigint: true });
    return Number(stats.bavail * stats.bsize);
  });
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  let lastFreeBytes = Number.POSITIVE_INFINITY;

  return Object.freeze({
    async assertHealthy(): Promise<void> {
      const timestamp = now();
      if (timestamp - lastCheckedAt >= input.checkIntervalMs) {
        lastFreeBytes = await freeBytes(input.path);
        lastCheckedAt = timestamp;
      }
      if (lastFreeBytes < input.minimumFreeBytes) {
        throw new Error(`scanner_disk_headroom_low free_bytes=${lastFreeBytes} minimum_bytes=${input.minimumFreeBytes}`);
      }
    },
  });
}
