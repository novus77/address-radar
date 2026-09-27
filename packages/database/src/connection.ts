import { DatabaseSync } from "node:sqlite";

export const ADDRESS_RADAR_BUSY_TIMEOUT_MS = 1_000;

export interface WriteTransactionOptions {
  readonly maximumAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
}

const isRetryableWriteConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { code?: string; errcode?: number };
  const message = value.message.toLowerCase();
  return value.code === "SQLITE_BUSY"
    || value.code === "SQLITE_LOCKED"
    || value.errcode === 5
    || value.errcode === 6
    || message.includes("database is locked")
    || message.includes("database table is locked")
    || message.includes("database is busy");
};

const sleepSync = (delayMs: number): void => {
  if (delayMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
};

export function withAddressRadarWriteTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: WriteTransactionOptions = {},
): T {
  const maximumAttempts = options.maximumAttempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 10;
  const maximumDelayMs = options.maximumDelayMs ?? 500;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
    throw new Error("maximumAttempts must be a positive safe integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maximumDelayMs) || maximumDelayMs < baseDelayMs) {
    throw new Error("Write retry delays are invalid");
  }

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let started = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      started = true;
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (started) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure if SQLite already rolled back.
        }
      }
      if (!isRetryableWriteConflict(error) || attempt === maximumAttempts) throw error;
      const exponentialDelay = baseDelayMs * (2 ** (attempt - 1));
      const jitter = baseDelayMs === 0 ? 0 : Math.floor(Math.random() * (baseDelayMs + 1));
      sleepSync(Math.min(maximumDelayMs, exponentialDelay + jitter));
    }
  }
  throw new Error("Unreachable write transaction state");
}

export function configureAddressRadarDatabase(database: DatabaseSync): DatabaseSync {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${ADDRESS_RADAR_BUSY_TIMEOUT_MS};
    PRAGMA foreign_keys = ON;
  `);
  return database;
}

export function openAddressRadarDatabase(databasePath: string): DatabaseSync {
  return configureAddressRadarDatabase(new DatabaseSync(databasePath));
}
