import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "./connection.js";

export function createSharedProviderRequestGate(input: {
  readonly database: DatabaseSync;
  readonly provider: string;
  readonly minimumIntervalMs: number;
  readonly now?: () => number;
}) {
  if (!input.provider || !Number.isFinite(input.minimumIntervalMs) || input.minimumIntervalMs <= 0) throw new Error("Invalid shared provider request gate");
  const now = input.now ?? Date.now;
  withAddressRadarWriteTransaction(input.database, () => input.database.exec(`
    CREATE TABLE IF NOT EXISTS provider_request_gates (
      provider TEXT PRIMARY KEY, next_request_at INTEGER NOT NULL,
      cooldown_until INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `), { label: "initialize_provider_request_gate" });
  const read = () => input.database.prepare("SELECT next_request_at, cooldown_until FROM provider_request_gates WHERE provider=?").get(input.provider) as { next_request_at: number; cooldown_until: number } | undefined;
  const waitFor = (at: number) => { const row = read(); return Math.max(0, (row?.next_request_at ?? 0) - at, (row?.cooldown_until ?? 0) - at); };
  return Object.freeze({
    async acquire(signal?: AbortSignal): Promise<void> {
      for (;;) {
        signal?.throwIfAborted();
        let waitMs = waitFor(now());
        if (waitMs === 0) waitMs = withAddressRadarWriteTransaction(input.database, () => {
          const at = now();
          const remaining = waitFor(at);
          if (remaining > 0) return remaining;
          signal?.throwIfAborted();
          input.database.prepare(`INSERT INTO provider_request_gates VALUES(?,?,0,?)
            ON CONFLICT(provider) DO UPDATE SET next_request_at=excluded.next_request_at,updated_at=excluded.updated_at`)
            .run(input.provider, at + input.minimumIntervalMs, at);
          return 0;
        }, { label: "acquire_provider_request_slot" });
        if (waitMs === 0) return;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Request aborted")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, waitMs);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    },
    cooldown(delayMs: number): void {
      if (!Number.isFinite(delayMs) || delayMs <= 0) throw new Error("Invalid provider cooldown");
      withAddressRadarWriteTransaction(input.database, () => {
        const at = now();
        input.database.prepare(`INSERT INTO provider_request_gates VALUES(?,0,?,?)
          ON CONFLICT(provider) DO UPDATE SET cooldown_until=MAX(cooldown_until,excluded.cooldown_until),updated_at=excluded.updated_at`)
          .run(input.provider, at + delayMs, at);
      }, { label: "share_provider_cooldown" });
    },
  });
}
