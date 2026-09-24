export type TokenLifecycleStage =
  | "created"
  | "launched_0_2h"
  | "launched_2_12h"
  | "launched_12_24h"
  | "older_1_7d"
  | "older_7d_plus"
  | "unknown";

export type AddressSignalFamily = "NEW_TOKEN_DISCOVERY" | "OLD_TOKEN_MOVEMENT";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export function classifyTokenLifecycle(input: {
  readonly observedAt: number;
  readonly createdAt?: number | null;
  readonly launchedAt?: number | null;
}): TokenLifecycleStage {
  if (input.launchedAt === null && input.createdAt !== undefined && input.createdAt !== null) return "created";
  if (input.launchedAt === undefined || input.launchedAt === null) return "unknown";
  const ageMs = Math.max(0, input.observedAt - input.launchedAt);
  if (ageMs < 2 * HOUR_MS) return "launched_0_2h";
  if (ageMs < 12 * HOUR_MS) return "launched_2_12h";
  if (ageMs < DAY_MS) return "launched_12_24h";
  if (ageMs < 7 * DAY_MS) return "older_1_7d";
  return "older_7d_plus";
}

export function signalFamilyForStage(stage: TokenLifecycleStage): AddressSignalFamily | null {
  if (stage === "unknown") return null;
  if (stage === "older_1_7d" || stage === "older_7d_plus") return "OLD_TOKEN_MOVEMENT";
  return "NEW_TOKEN_DISCOVERY";
}
