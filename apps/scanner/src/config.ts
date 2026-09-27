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
  readonly fomoFilePaths: readonly string[];
  readonly onchainFilePath: string | null;
  readonly onchainRpcEndpoint: string | null;
  readonly onchainRpcFallbackEndpoint: string | null;
  readonly onchainRpcMethod: string;
  readonly fileStartAtEnd: boolean;
  readonly marketBaseUrl: string | null;
  readonly fomoLookupQueuePath: string;
  readonly gatewayEndpoint?: string | null;
  readonly gatewayDeliveryEnabled?: boolean;
  readonly gatewayKeyId?: string | null;
  readonly gatewaySharedSecret?: string | null;
  readonly gatewayDeliveryIntervalMs?: number;
  readonly gatewayTimeoutMs?: number;
  readonly recoveryEnabled: boolean;
  readonly recoveryPollIntervalMs: number;
  readonly recoveryLeaseMs: number;
  readonly recoveryRetryBaseMs: number;
  readonly minimumFreeDiskBytes: number;
  readonly diskCheckIntervalMs: number;
  readonly errorLogWindowMs: number;
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
  const databasePath = required(env, "ADDRESS_RADAR_DATABASE_PATH");
  return Object.freeze({
    databasePath,
    strategyVersion: required(env, "ADDRESS_RADAR_STRATEGY_VERSION"),
    signalThreshold,
    minimumPurchaseUsd: finiteNumber(env.ADDRESS_RADAR_MINIMUM_PURCHASE_USD, 0, "ADDRESS_RADAR_MINIMUM_PURCHASE_USD"),
    minimumAggregateBuyUsd: finiteNumber(env.ADDRESS_RADAR_MINIMUM_AGGREGATE_BUY_USD, 100, "ADDRESS_RADAR_MINIMUM_AGGREGATE_BUY_USD"),
    allowedChains: csv(env.ADDRESS_RADAR_ALLOWED_CHAINS).map(chain => chain.toLowerCase()),
    excludedTokenIds: csv(env.ADDRESS_RADAR_EXCLUDED_TOKEN_IDS),
    pollIntervalMs,
    fomoFilePaths: Object.freeze([env.ADDRESS_RADAR_FOMO_EVENT_LOG_PATH, env.ADDRESS_RADAR_FOMO_JOURNAL_PATH, env.ADDRESS_RADAR_FOMO_HISTORY_PATH].filter((value): value is string => Boolean(value?.trim())).map(value => value.trim())),
    onchainFilePath: env.ADDRESS_RADAR_ONCHAIN_EVENT_LOG_PATH?.trim() || null,
    onchainRpcEndpoint: env.ADDRESS_RADAR_ONCHAIN_RPC_ENDPOINT?.trim() || null,
    onchainRpcFallbackEndpoint: env.ADDRESS_RADAR_ONCHAIN_RPC_FALLBACK_ENDPOINT?.trim() || null,
    onchainRpcMethod: env.ADDRESS_RADAR_ONCHAIN_RPC_METHOD?.trim() || "address_radar_walletEvents",
    fileStartAtEnd: env.ADDRESS_RADAR_FILE_START_AT_END !== "false",
    marketBaseUrl: env.ADDRESS_RADAR_MARKET_BASE_URL?.trim() || null,
    fomoLookupQueuePath: env.ADDRESS_RADAR_FOMO_LOOKUP_QUEUE_PATH?.trim() || `${databasePath}.fomo-lookups.ndjson`,
    gatewayEndpoint: env.ADDRESS_RADAR_GATEWAY_ENDPOINT?.trim() || null,
    gatewayDeliveryEnabled: env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED === "true",
    gatewayKeyId: env.ADDRESS_RADAR_GATEWAY_KEY_ID?.trim() || null,
    gatewaySharedSecret: env.ADDRESS_RADAR_GATEWAY_SHARED_SECRET?.trim() || null,
    gatewayDeliveryIntervalMs: finiteNumber(env.ADDRESS_RADAR_GATEWAY_DELIVERY_INTERVAL_MS, 1_000, "ADDRESS_RADAR_GATEWAY_DELIVERY_INTERVAL_MS"),
    gatewayTimeoutMs: finiteNumber(env.ADDRESS_RADAR_GATEWAY_TIMEOUT_MS, 5_000, "ADDRESS_RADAR_GATEWAY_TIMEOUT_MS"),
    recoveryEnabled: env.ADDRESS_RADAR_RECOVERY_ENABLED === "true",
    recoveryPollIntervalMs: finiteNumber(env.ADDRESS_RADAR_RECOVERY_POLL_INTERVAL_MS, 5_000, "ADDRESS_RADAR_RECOVERY_POLL_INTERVAL_MS"),
    recoveryLeaseMs: finiteNumber(env.ADDRESS_RADAR_RECOVERY_LEASE_MS, 60_000, "ADDRESS_RADAR_RECOVERY_LEASE_MS"),
    recoveryRetryBaseMs: finiteNumber(env.ADDRESS_RADAR_RECOVERY_RETRY_BASE_MS, 30_000, "ADDRESS_RADAR_RECOVERY_RETRY_BASE_MS"),
    minimumFreeDiskBytes: finiteNumber(env.ADDRESS_RADAR_MINIMUM_FREE_DISK_BYTES, 2 * 1024 * 1024 * 1024, "ADDRESS_RADAR_MINIMUM_FREE_DISK_BYTES"),
    diskCheckIntervalMs: finiteNumber(env.ADDRESS_RADAR_DISK_CHECK_INTERVAL_MS, 60_000, "ADDRESS_RADAR_DISK_CHECK_INTERVAL_MS"),
    errorLogWindowMs: finiteNumber(env.ADDRESS_RADAR_ERROR_LOG_WINDOW_MS, 60_000, "ADDRESS_RADAR_ERROR_LOG_WINDOW_MS"),
  });
}

export interface ScannerPreflightFilesystem {
  writable(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
}

export interface ScannerPreflightReport {
  readonly ready: boolean;
  readonly delivery: "enabled" | "disabled_outbox_only";
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
  async exists(path) {
    try { await access(path, constants.F_OK); return true; } catch { return false; }
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
  const files = [...input.config.fomoFilePaths, ...(input.config.onchainFilePath ? [input.config.onchainFilePath] : [])];
  const usableFiles = (await Promise.all(files.map(path => filesystem.exists(path)))).filter(Boolean).length;
  if (usableFiles === 0 && !input.config.onchainRpcEndpoint) failures.push({ code: "collector_unavailable", message: "At least one usable collector is required" });
  const deliveryValues = [input.config.gatewayEndpoint, input.config.gatewayKeyId, input.config.gatewaySharedSecret];
  const configuredDeliveryValues = deliveryValues.filter(Boolean).length;
  if (input.config.gatewayDeliveryEnabled && configuredDeliveryValues < deliveryValues.length) failures.push({ code: "gateway_configuration_incomplete", message: "Gateway endpoint, key ID, and shared secret must be configured together when delivery is enabled" });
  return Object.freeze({ ready: failures.length === 0, delivery: input.config.gatewayDeliveryEnabled && configuredDeliveryValues === deliveryValues.length ? "enabled" as const : "disabled_outbox_only" as const, failures: Object.freeze(failures) });
}
