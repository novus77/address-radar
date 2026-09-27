export interface AutomationConfig {
  readonly enabled: boolean;
  readonly enabledJobTypes: readonly AutomationJobType[];
  readonly planningIntervalMs: number;
  readonly databasePath: string;
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly traderLightweightBatchSize: number;
  readonly traderDeepBackfillConcurrency: number;
  readonly tokenMiningConcurrency: number;
  readonly solanaHistoryConcurrency: number;
  readonly solanaWalletBatchSize: number;
  readonly identityExportBatchSize: number;
  readonly identityExportIntervalMs: number;
  readonly backfillWindowDays: number;
  readonly backfillMaximumTokens: number;
  readonly evidenceMinimumBuyUsd: number;
  readonly historyStartAt: number;
  readonly recentTokenShare: number;
  readonly historicalTokenShare: number;
  readonly existingTraderShare: number;
  readonly tokenMiningShare: number;
  readonly repairShare: number;
  readonly gatewayDeliveryEnabled: boolean;
}

export const AUTOMATION_JOB_TYPES = Object.freeze([
  "trader_lightweight_evaluation",
  "initial_wallet_backfill",
  "historical_token_partition",
  "candidate_evidence",
  "ability_evaluation",
] as const);

export type AutomationJobType = typeof AUTOMATION_JOB_TYPES[number];

export function loadAutomationConfig(
  env: Readonly<Record<string, string | undefined>>,
): AutomationConfig {
  const historyStartAt = Date.parse(
    env.ADDRESS_RADAR_HISTORY_START_AT?.trim() || "2026-08-09T16:00:00.000Z",
  );
  if (!Number.isFinite(historyStartAt)) throw new Error("Invalid history start time");
  const recentTokenShare = ratio(env.ADDRESS_RADAR_RECENT_TOKEN_SHARE, 0.7, "recent token share");
  const historicalTokenShare = ratio(env.ADDRESS_RADAR_HISTORICAL_TOKEN_SHARE, 0.3, "historical token share");
  const existingTraderShare = ratio(env.ADDRESS_RADAR_EXISTING_TRADER_SHARE, 0.4, "existing trader share");
  const tokenMiningShare = ratio(env.ADDRESS_RADAR_TOKEN_MINING_SHARE, 0.4, "token mining share");
  const repairShare = ratio(env.ADDRESS_RADAR_REPAIR_SHARE, 0.2, "repair share");
  if (Math.abs(recentTokenShare + historicalTokenShare - 1) > 1e-9) {
    throw new Error("Recent and historical token shares must total 1");
  }
  if (Math.abs(existingTraderShare + tokenMiningShare + repairShare - 1) > 1e-9) {
    throw new Error("Resource shares must total 1");
  }

  return Object.freeze({
    enabled: strictBoolean(env.ADDRESS_RADAR_AUTOMATION_ENABLED, false, "automation enabled"),
    enabledJobTypes: automationJobTypes(env.ADDRESS_RADAR_AUTOMATION_ENABLED_JOB_TYPES),
    planningIntervalMs: positiveInteger(
      env.ADDRESS_RADAR_AUTOMATION_PLANNING_INTERVAL_MS,
      300_000,
      "automation planning interval",
    ),
    databasePath: env.ADDRESS_RADAR_DATABASE_PATH?.trim() || ".address-radar/address-radar.sqlite",
    intervalMs: positiveInteger(env.ADDRESS_RADAR_AUTOMATION_INTERVAL_MS, 1_000, "automation interval"),
    leaseMs: positiveInteger(env.ADDRESS_RADAR_AUTOMATION_LEASE_MS, 60_000, "automation lease"),
    traderLightweightBatchSize: positiveInteger(env.ADDRESS_RADAR_TRADER_LIGHTWEIGHT_BATCH_SIZE, 10, "trader lightweight batch size"),
    traderDeepBackfillConcurrency: positiveInteger(env.ADDRESS_RADAR_TRADER_DEEP_BACKFILL_CONCURRENCY, 2, "trader deep backfill concurrency"),
    tokenMiningConcurrency: positiveInteger(env.ADDRESS_RADAR_TOKEN_MINING_CONCURRENCY, 2, "token mining concurrency"),
    solanaHistoryConcurrency: positiveInteger(env.ADDRESS_RADAR_SOLANA_HISTORY_CONCURRENCY, 1, "Solana history concurrency"),
    solanaWalletBatchSize: positiveInteger(env.ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE, 3, "Solana wallet batch size"),
    identityExportBatchSize: positiveInteger(env.ADDRESS_RADAR_IDENTITY_EXPORT_BATCH_SIZE, 25, "identity export batch size"),
    identityExportIntervalMs: positiveInteger(env.ADDRESS_RADAR_IDENTITY_EXPORT_INTERVAL_MS, 43_200_000, "identity export interval"),
    backfillWindowDays: positiveInteger(env.ADDRESS_RADAR_BACKFILL_WINDOW_DAYS, 60, "backfill window days"),
    backfillMaximumTokens: positiveInteger(env.ADDRESS_RADAR_BACKFILL_MAX_TOKENS, 300, "backfill maximum tokens"),
    evidenceMinimumBuyUsd: positiveNumber(env.ADDRESS_RADAR_EVIDENCE_MINIMUM_BUY_USD, 50, "evidence minimum buy USD"),
    historyStartAt,
    recentTokenShare,
    historicalTokenShare,
    existingTraderShare,
    tokenMiningShare,
    repairShare,
    gatewayDeliveryEnabled: strictBoolean(env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED, false, "gateway delivery enabled"),
  });
}

function automationJobTypes(value: string | undefined): readonly AutomationJobType[] {
  if (!value?.trim()) return Object.freeze([]);
  const supported = new Set<string>(AUTOMATION_JOB_TYPES);
  const parsed = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const unsupported = parsed.filter((item) => !supported.has(item));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported automation job types: ${unsupported.join(",")}`);
  }
  return Object.freeze(parsed as AutomationJobType[]);
}

function strictBoolean(value: string | undefined, fallback: boolean, label: string): boolean {
  if (!value?.trim()) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${label}`);
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function positiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function ratio(value: string | undefined, fallback: number, label: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`Invalid ${label}`);
  return parsed;
}
