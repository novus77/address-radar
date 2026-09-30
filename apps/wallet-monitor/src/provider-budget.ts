export type ProviderRequestKind = "realtime" | "history";

export interface ProviderBudgetSnapshot {
  readonly realtime: ProviderBucketSnapshot;
  readonly history: ProviderBucketSnapshot;
  readonly cooldownUntil: number;
  readonly rateLimitCount: number;
  readonly lastRateLimitedAt: number | null;
}

export interface ProviderBucketSnapshot {
  readonly capacity: number;
  readonly tokens: number;
  readonly refillPerSecond: number;
}

export interface ProviderBudget {
  acquire(kind: ProviderRequestKind, signal: AbortSignal): Promise<void>;
  rateLimited(retryAt: number): void;
  snapshot(): ProviderBudgetSnapshot;
}

type BucketOptions = {
  readonly capacity: number;
  readonly refillPerSecond: number;
};

type MutableBucket = BucketOptions & {
  tokens: number;
  lastRefillAt: number;
};

export function createProviderBudget(input: {
  readonly realtime?: BucketOptions;
  readonly history?: BucketOptions;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
} = {}): ProviderBudget {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? abortableSleep;
  const realtime = createBucket(input.realtime ?? {
    capacity: 3,
    refillPerSecond: 3,
  }, now());
  const history = createBucket(input.history ?? {
    capacity: 1,
    refillPerSecond: 0.5,
  }, now());
  let cooldownUntil = 0;
  let rateLimitCount = 0;
  let lastRateLimitedAt: number | null = null;

  const budget: ProviderBudget = {
    async acquire(kind, signal) {
      const bucket = kind === "realtime" ? realtime : history;
      while (true) {
        if (signal.aborted) throw signal.reason ?? new Error("Aborted");
        const currentTime = now();
        if (cooldownUntil > currentTime) {
          await sleep(cooldownUntil - currentTime, signal);
          continue;
        }
        refill(bucket, currentTime);
        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          return;
        }
        const waitMs = Math.max(
          1,
          Math.ceil(((1 - bucket.tokens) / bucket.refillPerSecond) * 1_000),
        );
        await sleep(waitMs, signal);
      }
    },

    rateLimited(retryAt) {
      const currentTime = now();
      cooldownUntil = Math.max(cooldownUntil, retryAt, currentTime);
      rateLimitCount += 1;
      lastRateLimitedAt = currentTime;
    },

    snapshot() {
      return Object.freeze({
        realtime: snapshotBucket(realtime),
        history: snapshotBucket(history),
        cooldownUntil,
        rateLimitCount,
        lastRateLimitedAt,
      });
    },
  };
  return Object.freeze(budget);
}

function createBucket(options: BucketOptions, now: number): MutableBucket {
  if (!Number.isFinite(options.capacity) || options.capacity < 1) {
    throw new Error("Provider budget capacity must be at least one");
  }
  if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
    throw new Error("Provider budget refill rate must be positive");
  }
  return {
    ...options,
    tokens: options.capacity,
    lastRefillAt: now,
  };
}

function refill(bucket: MutableBucket, now: number): void {
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + (elapsedMs / 1_000) * bucket.refillPerSecond,
  );
  bucket.lastRefillAt = now;
}

function snapshotBucket(bucket: MutableBucket): ProviderBucketSnapshot {
  return Object.freeze({
    capacity: bucket.capacity,
    tokens: bucket.tokens,
    refillPerSecond: bucket.refillPerSecond,
  });
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    }
  });
}
