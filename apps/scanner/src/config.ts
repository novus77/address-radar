import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export interface ScannerPolicyConfig {
  readonly strategyVersion: string;
  readonly signalThreshold: number;
  readonly minimumPurchaseUsd: number;
  readonly minimumAggregateBuyUsd: number;
  readonly allowedChains: readonly string[];
  readonly excludedTokenIds: readonly string[];
}

export interface ScannerConfig extends ScannerPolicyConfig {
  readonly databasePath: string;
  readonly pollIntervalMs: number;
}

const required = (env: Readonly<Record<string, string | undefined>>, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const finiteNumber = (value: string | undefined, fallback: number, key: string): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative number`);
  return parsed;
};

const csv = (value: string | undefined): readonly string[] => Object.freeze(
  (value ?? "").split(",").map(item => item.trim()).filter(Boolean),
);

export function parseScannerConfig(env: Readonly<Record<string, string | undefined>>): ScannerConfig {
  const signalThreshold = finiteNumber(env.ADDRESS_RADAR_SIGNAL_THRESHOLD, 0.7, "ADDRESS_RADAR_SIGNAL_THRESHOLD");
  if (signalThreshold <= 0 || signalThreshold > 1) {
    throw new Error("ADDRESS_RADAR_SIGNAL_THRESHOLD must be between 0 and 1");
  }
  const pollIntervalMs = finiteNumber(env.ADDRESS_RADAR_POLL_INTERVAL_MS, 15_000, "ADDRESS_RADAR_POLL_INTERVAL_MS");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("ADDRESS_RADAR_POLL_INTERVAL_MS must be a positive integer");
  }
  return Object.freeze({
    databasePath: required(env, "ADDRESS_RADAR_DATABASE_PATH"),
    strategyVersion: required(env, "ADDRESS_RADAR_STRATEGY_VERSION"),
    signalThreshold,
    minimumPurchaseUsd: finiteNumber(env.ADDRESS_RADAR_MINIMUM_PURCHASE_USD, 0, "ADDRESS_RADAR_MINIMUM_PURCHASE_USD"),
    minimumAggregateBuyUsd: finiteNumber(env.ADDRESS_RADAR_MINIMUM_AGGREGATE_BUY_USD, 100, "ADDRESS_RADAR_MINIMUM_AGGREGATE_BUY_USD"),
    allowedChains: csv(env.ADDRESS_RADAR_ALLOWED_CHAINS).map(chain => chain.toLowerCase()),
    excludedTokenIds: csv(env.ADDRESS_RADAR_EXCLUDED_TOKEN_IDS),
    pollIntervalMs,
  });
}

export interface ScannerPreflightFilesystem {
  writable(path: string): Promise<boolean>;
}

export interface ScannerPreflightReport {
  readonly ready: boolean;
  readonly failures: readonly { readonly code: string; readonly message: string }[];
}

const localFilesystem: ScannerPreflightFilesystem = {
  async writable(path) {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export async function runScannerPreflight(input: {
  readonly config: ScannerConfig;
  readonly filesystem?: ScannerPreflightFilesystem;
}): Promise<ScannerPreflightReport> {
  const filesystem = input.filesystem ?? localFilesystem;
  const failures: Array<{ readonly code: string; readonly message: string }> = [];
  if (!(await filesystem.writable(dirname(input.config.databasePath)))) {
    failures.push({ code: "address_database_unavailable", message: "Address database directory is not writable" });
  }
  return Object.freeze({ ready: failures.length === 0, failures: Object.freeze(failures) });
}
