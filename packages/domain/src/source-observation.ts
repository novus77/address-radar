import { createHash } from "node:crypto";

export const SOURCE_OBSERVATION_FINGERPRINT_VERSION = 2;

export type SourceObservationWriteResult =
  | Readonly<{ status: "inserted" }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "conflict"; conflictId: string }>;

export const DISCOVERY_CHAINS = Object.freeze(["solana", "eth", "bsc", "base", "robinhood"] as const);
export type DiscoveryChain = typeof DISCOVERY_CHAINS[number];

export const SOURCE_IDS = Object.freeze([
  "fomo_feed",
  "fomo_token_page",
  "fomo_leaderboard",
  "rpc_evm",
  "rpc_solana",
  "dexscreener",
  "dune",
  "manual",
  "journal_replay",
] as const);
export type SourceId = typeof SOURCE_IDS[number];

export const SOURCE_HEALTH_STATES = Object.freeze([
  "healthy",
  "degraded",
  "rate_limited",
  "stale",
  "unavailable",
  "misconfigured",
] as const);
export type SourceHealthState = typeof SOURCE_HEALTH_STATES[number];

export const SOURCE_EXTRACTION_MODES = Object.freeze([
  "network",
  "dom",
  "rpc",
  "api",
  "manual",
  "replay",
] as const);
export type SourceExtractionMode = typeof SOURCE_EXTRACTION_MODES[number];

export interface SourceObservation<TPayload = unknown> {
  readonly observationId: string;
  readonly source: SourceId;
  readonly sourceEventId: string;
  readonly chain: DiscoveryChain;
  readonly observedAt: number;
  readonly collectedAt: number;
  readonly payloadVersion: number;
  readonly payload: TPayload;
  readonly confidence: number;
  readonly extractionMode: SourceExtractionMode;
  readonly provenance: Readonly<Record<string, unknown>>;
}

const chainAliases: Readonly<Record<string, DiscoveryChain>> = Object.freeze({
  sol: "solana",
  solana: "solana",
  eth: "eth",
  ethereum: "eth",
  bnb: "bsc",
  "bnb-chain": "bsc",
  bnbchain: "bsc",
  bsc: "bsc",
  base: "base",
  robinhood: "robinhood",
});

export function normalizeDiscoveryChain(value: string): DiscoveryChain {
  const normalized = chainAliases[value.trim().toLowerCase()];
  if (!normalized) throw new Error(`Unsupported discovery chain: ${value}`);
  return normalized;
}

export function normalizeDiscoveryAddress(chain: string, address: string): string {
  const normalizedChain = normalizeDiscoveryChain(chain);
  const trimmed = address.trim();
  if (!trimmed) throw new Error("Discovery address is required");
  return normalizedChain === "solana" ? trimmed : trimmed.toLowerCase();
}

export function sourceObservationId(source: SourceId, sourceEventId: string, payloadVersion: number): string {
  if (!SOURCE_IDS.includes(source)) throw new Error(`Unsupported source: ${source}`);
  const normalizedEventId = sourceEventId.trim();
  if (!normalizedEventId) throw new Error("sourceEventId is required");
  if (!Number.isSafeInteger(payloadVersion) || payloadVersion < 1) throw new Error("payloadVersion must be a positive integer");
  const digest = createHash("sha256")
    .update(source)
    .update("\u0000")
    .update(normalizedEventId)
    .update("\u0000")
    .update(String(payloadVersion))
    .digest("hex");
  return `source-observation:${digest}`;
}

const semanticValue = (value: unknown, stripCollectionTime = false): unknown => {
  if (Array.isArray(value)) return value.map((item) => semanticValue(item));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const isTraderEventPayload = stripCollectionTime
    && typeof record.eventId === "string"
    && typeof record.source === "string"
    && typeof record.occurredAt === "number";

  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !(isTraderEventPayload && key === "collectedAt"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, semanticValue(item)]));
};

export function semanticSourceObservationFingerprint(observation: SourceObservation): string {
  return createHash("sha256")
    .update(JSON.stringify({
      source: observation.source,
      sourceEventId: observation.sourceEventId,
      chain: observation.chain,
      observedAt: observation.observedAt,
      payloadVersion: observation.payloadVersion,
      payload: semanticValue(observation.payload, true),
      confidence: observation.confidence,
      extractionMode: observation.extractionMode,
      provenance: semanticValue(observation.provenance),
    }))
    .digest("hex");
}

export function createSourceObservation<TPayload>(input: {
  readonly source: SourceId;
  readonly sourceEventId: string;
  readonly chain: string;
  readonly observedAt: number;
  readonly collectedAt: number;
  readonly payloadVersion: number;
  readonly payload: TPayload;
  readonly confidence: number;
  readonly extractionMode: SourceExtractionMode;
  readonly provenance: Readonly<Record<string, unknown>>;
}): SourceObservation<TPayload> {
  if (!SOURCE_IDS.includes(input.source)) throw new Error(`Unsupported source: ${input.source}`);
  if (!SOURCE_EXTRACTION_MODES.includes(input.extractionMode)) throw new Error(`Unsupported extraction mode: ${input.extractionMode}`);
  if (!Number.isFinite(input.observedAt) || input.observedAt < 0) throw new Error("observedAt must be a non-negative timestamp");
  if (!Number.isFinite(input.collectedAt) || input.collectedAt < 0) throw new Error("collectedAt must be a non-negative timestamp");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("confidence must be between 0 and 1");
  const sourceEventId = input.sourceEventId.trim();
  return Object.freeze({
    observationId: sourceObservationId(input.source, sourceEventId, input.payloadVersion),
    source: input.source,
    sourceEventId,
    chain: normalizeDiscoveryChain(input.chain),
    observedAt: input.observedAt,
    collectedAt: input.collectedAt,
    payloadVersion: input.payloadVersion,
    payload: input.payload,
    confidence: input.confidence,
    extractionMode: input.extractionMode,
    provenance: Object.freeze({ ...input.provenance }),
  });
}
