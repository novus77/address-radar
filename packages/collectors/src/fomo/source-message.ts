import { normalizeFomoLiveActivity, type FomoLiveActivity } from "./live-activity.js";

const sourceFields = ["tradeId", "id", "userId", "userHandle", "tokenAddress", "networkId", "type", "createdAt", "usdAmount", "price", "marketCap"] as const;
const secret = /(?:Bearer\s+\S+|fapi_[a-z0-9]+)/gi;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export interface FomoSourceMessage {
  // The observer must supply a stable message identity, not a position/trade ID.
  readonly sourceMessageId: string;
  readonly sourceUrl: string;
  readonly approvedOrigins: readonly string[];
  readonly body: string;
  readonly maximumPayloadBytes: number;
}

export interface PreparedFomoSourceMessage {
  readonly sourceEventId: string;
  // An allowlisted source projection, not a lossless copy of the original frame.
  readonly scrubbedPayload: string;
  readonly semanticPayload: string;
  readonly activity: FomoLiveActivity | null;
  readonly normalizationReason: "ready" | "unsupported_or_incomplete_activity";
}

function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "wss:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function prepareFomoSourceMessage(input: FomoSourceMessage): PreparedFomoSourceMessage | null {
  if (!Number.isSafeInteger(input.maximumPayloadBytes) || input.maximumPayloadBytes <= 0) {
    throw new Error("FOMO payload limit must be a positive safe integer");
  }
  const sourceOrigin = origin(input.sourceUrl);
  if (!sourceOrigin || !input.approvedOrigins.some(value => origin(value) === sourceOrigin)) return null;
  if (!input.sourceMessageId.trim() || input.sourceMessageId.length > 512
    || /\s|fapi_|bearer/i.test(input.sourceMessageId)) return null;
  if (Buffer.byteLength(input.body, "utf8") > Math.min(input.maximumPayloadBytes, 64 * 1024)) return null;
  let root: Record<string, unknown> | null;
  try { root = object(JSON.parse(input.body)); } catch { return null; }
  if (root?.type !== "data" || root.topicType !== "trading_activity") return null;
  const payload = object(root.payload);
  if (!payload) return null;
  const projected: Record<string, string | number | null> = {};
  for (const key of sourceFields) {
    const value = payload[key];
    if (value === null || typeof value === "number" || typeof value === "string") {
      // Do not persist headers, credentials, arbitrary nested objects, or transport metadata.
      projected[key] = typeof value === "string" ? value.replace(secret, "[REDACTED]") : value;
    }
  }
  const scrubbedPayload = JSON.stringify({ type: "data", topicType: "trading_activity", payload: projected });
  if (Buffer.byteLength(scrubbedPayload, "utf8") > input.maximumPayloadBytes) return null;
  const activity = normalizeFomoLiveActivity(scrubbedPayload);
  const semantic = Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "userHandle"));
  return Object.freeze({ sourceEventId: input.sourceMessageId, scrubbedPayload,
    semanticPayload: JSON.stringify(semantic), activity,
    normalizationReason: activity ? "ready" : "unsupported_or_incomplete_activity" });
}

export function fomoSourceObservation(activity: FomoLiveActivity, sourceEventId: string) {
  if (!sourceEventId.trim() || sourceEventId.length > 512 || /\s|fapi_|bearer/i.test(sourceEventId)) {
    throw new Error("FOMO source message identity is invalid");
  }
  const { eventId: _legacyEventId, sourceTradeId: sourcePositionId, ...fields } = activity;
  return Object.freeze({ ...fields, sourceEventId, sourcePositionId,
    observationIdentityBasis: sourceEventId.startsWith("fomo-cdp-delivery:") ? "collector_delivery" as const : "unverified_source_message" as const,
    entityId: null, identityStatus: "unresolved" as const,
    amountBasis: activity.amountUsd === null ? "missing" as const : "source_reported_usd" as const,
    amountEstimated: null, entryBasis: "awaiting_execution_verification" as const,
    economicTradeIdentity: "unverified" as const, eligibleForOpportunity: false });
}
