import { createHash } from "node:crypto";
import {
  createPostgresCaptureRepository, createPostgresNormalizationRepository, PostgresCommitUncertainError,
  type NormalizationLease, type PostgresCaptureEnvelope, type PostgresTransaction, type VerifiedForwardPurchase,
} from "@address-radar/database";
import { canonicalForwardTargetChannelFact, forwardTargetIdentityTrusted, type ForwardTargetChannelFact } from "@address-radar/domain";
import type { MonitoredWallet } from "@address-radar/identity";
import type { WalletCollector, WalletCollectorEvent, WalletCollectorResult } from "./contracts.js";

export const WALLET_CAPTURE_NAMESPACE = "wallet-chain";
export const WALLET_CAPTURE_PARSER_VERSION = "wallet-chain-v1";
export const POSTGRES_WALLET_CHANNEL_SCHEMA_SQL = `
CREATE TABLE wallet_channel_collectors (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id), collector_id text NOT NULL,
  checkpoints_json text NOT NULL DEFAULT '{}', claim_generation integer NOT NULL DEFAULT 0,
  lease_owner text, lease_expires_at bigint, updated_at bigint NOT NULL,
  PRIMARY KEY(generation_id,collector_id)
);
CREATE TABLE wallet_capture_generation_bindings (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  source_namespace text NOT NULL, source_event_id text NOT NULL, semantic_fingerprint text NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(generation_id,source_namespace,source_event_id,semantic_fingerprint),
  UNIQUE(source_namespace,source_event_id,semantic_fingerprint),
  FOREIGN KEY(source_namespace,source_event_id,semantic_fingerprint)
    REFERENCES capture_event_revisions(source_namespace,source_event_id,semantic_fingerprint)
);
CREATE INDEX wallet_capture_generation_time ON wallet_capture_generation_bindings(generation_id,created_at,source_event_id);
`;
export type WalletExecutionTrust = "rpc_execution" | "unverified";
export interface PostgresWalletProfile {
  readonly wallet: MonitoredWallet;
  readonly fact: ForwardTargetChannelFact;
  readonly profileEnabled: boolean;
  /** Absent only for pre-address-only profiles, whose original contract was realtime. */
  readonly monitoringPolicy?: "realtime" | "periodic" | "lightweight" | "off";
  readonly profileSuspended: boolean;
  readonly bindingState: "owned" | "unbound" | "conflict";
  readonly versionId: string;
}
export interface CapturedPostgresWalletEvent {
  readonly schemaVersion: typeof WALLET_CAPTURE_PARSER_VERSION;
  readonly generationId: string;
  readonly collectorId: string;
  readonly chainFamily: "evm" | "solana";
  readonly event: WalletCollectorEvent;
  readonly profile: PostgresWalletProfile | null;
  readonly purchase: VerifiedForwardPurchase | null;
  readonly externalBasis: VerifiedExternalWalletBasis | null;
  readonly entryPriceBasis: "executed_quote_per_token_nominal_usd" | null;
}
/** Issued by a trusted verifier after persisting the actual per-execution basis; never synthesize a reference. */
export interface VerifiedExternalWalletBasis {
  readonly verifierId: string; readonly evidenceRef: string; readonly generationId: string;
  readonly sourceReference: string; readonly executionKey: string; readonly purchaseFingerprint: string;
  readonly verifiedAt: number;
}
export type CapturedWalletPurchaseResolution =
  | { readonly status: "verified"; readonly purchase: VerifiedForwardPurchase; readonly externalBasis?: VerifiedExternalWalletBasis }
  | { readonly status: "deferred"; readonly reasonCode: string };
export type PostgresWalletRun = <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;

const stableQuotes: Readonly<Record<string, Readonly<Record<string, "USDT" | "USDC">>>> = {
  solana: { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" },
  eth: { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC", "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT" },
  base: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC" },
  bsc: { "0x55d398326f99059ff775485246999027b3197955": "USDT", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC" },
};
function identifier(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Explicit bounded wallet identity required");
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid wallet clock");
}
function positive(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid wallet resource budget");
}
const addressKey = (family: "evm" | "solana", address: string) => family === "evm" ? address.toLowerCase() : address;
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** Expand a finite collector number; never invent precision lost by the RPC collector. */
function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid wallet execution decimal");
  const representation = String(value);
  if (!representation.includes("e")) return representation;
  const [mantissa = "", exponent = "0"] = representation.split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = whole + fraction, position = whole.length + Number(exponent);
  return position <= 0 ? `0.${"0".repeat(-position)}${digits}`
    : position >= digits.length ? digits + "0".repeat(position - digits.length)
      : `${digits.slice(0, position)}.${digits.slice(position)}`;
}

export function selectPostgresWalletProfiles(profiles: readonly PostgresWalletProfile[], family: "evm" | "solana") {
  const owners = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const key = addressKey(family, profile.wallet.address);
    const entities = owners.get(key) ?? new Set<string>();
    entities.add(profile.wallet.entityId); owners.set(key, entities);
  }
  const selected = new Map<string, PostgresWalletProfile>();
  for (const profile of profiles) {
    const fact = canonicalForwardTargetChannelFact(profile.fact);
    const key = addressKey(family, profile.wallet.address);
    if (fact.channel !== "wallet" || fact.walletFamily !== family || fact.subjectId !== key
      || fact.entityId !== profile.wallet.entityId || owners.get(key)?.size !== 1
      || !profile.profileEnabled || profile.profileSuspended || !fact.monitoringEnabled || fact.suspended
      || (profile.monitoringPolicy !== undefined && profile.monitoringPolicy !== "realtime")
      || profile.bindingState !== "owned" || !forwardTargetIdentityTrusted(fact)) continue;
    identifier(profile.wallet.accountId); identifier(profile.versionId);
    const previous = selected.get(key);
    // Conflicting account mappings cannot be silently resolved by input order.
    if (previous && (previous.wallet.accountId !== profile.wallet.accountId || previous.versionId !== profile.versionId)) {
      throw new Error("Conflicting wallet profile snapshot");
    }
    selected.set(key, profile);
  }
  return [...selected.values()].sort((left, right) => left.wallet.address.localeCompare(right.wallet.address));
}

export function walletPurchaseBasisFingerprint(purchase: VerifiedForwardPurchase): string {
  return hash(purchaseProjection(purchase));
}
function assertPurchaseMatches(purchase: VerifiedForwardPurchase, event: WalletCollectorEvent, profile: PostgresWalletProfile,
  externalBasis: VerifiedExternalWalletBasis | null = null): void {
  if (event.side !== "buy" || purchase.chain !== event.chain || purchase.tokenAddress !== event.tokenAddress
    || purchase.entityId !== profile.wallet.entityId || purchase.sourceUserId !== profile.wallet.accountId
    || purchase.occurredAt !== event.occurredAt || purchase.ownershipEvidenceRef !== profile.fact.ownershipEvidenceRef) {
    throw new Error("Verified per-purchase input does not match the wallet event and owner");
  }
  for (const key of [purchase.executionKey, purchase.executionEvidenceRef, purchase.ownershipEvidenceRef]) identifier(key);
  for (const value of [purchase.tokenQuantity, purchase.quoteAmount, purchase.amountUsd, purchase.entryPriceUsd]) {
    if (typeof value !== "string" || value.length > 512 || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
      throw new Error("Verified purchase requires positive lossless decimal strings");
    }
  }
  if (!purchase.amountEstimated || purchase.amountBasis !== "stablecoin_nominal"
    || !["USDT", "USDC"].includes(purchase.quoteAsset) || purchase.amountUsd !== purchase.quoteAmount) {
    throw new Error("Wallet slice requires explicitly estimated nominal USDT/USDC execution");
  }
  const basis = event.executionBasis;
  const family = event.chain === "solana" ? "solana" : "evm";
  const matchesCollector = basis?.status === "estimated" && basis.reason === "nominal_stablecoin_usd"
    && basis.amountBasis === "nominal_stablecoin" && basis.side === "buy"
    && addressKey(family, basis.tokenAddress) === event.tokenAddress
    && stableQuotes[event.chain]?.[addressKey(family, basis.quoteAsset)] === purchase.quoteAsset
    && purchase.tokenQuantity === decimal(basis.tokenQuantity) && purchase.quoteAmount === decimal(basis.quoteQuantity)
    && purchase.amountUsd === decimal(basis.amountUsd) && purchase.entryPriceUsd === decimal(basis.priceUsd)
    && basis.amountUsd === basis.quoteQuantity && basis.priceUsd === basis.amountUsd / basis.tokenQuantity
    && purchase.executionEvidenceRef === event.sourceReference
    && purchase.executionKey === `${event.sourceReference}:${event.tokenAddress}`;
  if (matchesCollector) return;
  if (!externalBasis) throw new Error("Verified purchase does not match actual execution quantities, price and evidence reference");
  [externalBasis.verifierId, externalBasis.evidenceRef, externalBasis.generationId, externalBasis.executionKey,
    externalBasis.sourceReference, externalBasis.purchaseFingerprint].forEach(identifier);
  timestamp(externalBasis.verifiedAt);
  if (externalBasis.executionKey !== purchase.executionKey || externalBasis.sourceReference !== event.sourceReference
    || externalBasis.evidenceRef !== purchase.executionEvidenceRef || externalBasis.verifiedAt < event.occurredAt
    || externalBasis.purchaseFingerprint !== walletPurchaseBasisFingerprint(purchase)) {
    throw new Error("External execution basis does not bind the actual per-purchase input");
  }
}

function purchaseProjection(purchase: VerifiedForwardPurchase): VerifiedForwardPurchase {
  return { executionKey: purchase.executionKey, chain: purchase.chain, tokenAddress: purchase.tokenAddress,
    entityId: purchase.entityId, sourceUserId: purchase.sourceUserId, occurredAt: purchase.occurredAt,
    tokenQuantity: purchase.tokenQuantity, quoteAsset: purchase.quoteAsset, quoteAmount: purchase.quoteAmount,
    amountUsd: purchase.amountUsd, entryPriceUsd: purchase.entryPriceUsd, amountBasis: purchase.amountBasis,
    amountEstimated: purchase.amountEstimated, executionEvidenceRef: purchase.executionEvidenceRef,
    ownershipEvidenceRef: purchase.ownershipEvidenceRef };
}

export function preparePostgresWalletCapture(input: {
  readonly generationId: string; readonly collectorId: string; readonly sessionId: string;
  readonly chainFamily: "evm" | "solana"; readonly receivedAt: number;
  readonly event: WalletCollectorEvent; readonly profile: PostgresWalletProfile | null;
  readonly executionTrust: WalletExecutionTrust; readonly verifiedPurchase?: VerifiedForwardPurchase;
  readonly externalBasis?: VerifiedExternalWalletBasis | null;
}) {
  [input.generationId, input.collectorId, input.sessionId].forEach(identifier); timestamp(input.receivedAt);
  const source = input.event;
  [source.eventId, source.chain, source.walletAddress, source.tokenAddress, source.sourceReference].forEach(identifier);
  timestamp(source.occurredAt);
  if (input.executionTrust !== "rpc_execution" && input.executionTrust !== "unverified") throw new Error("Explicit wallet execution trust required");
  for (const reference of [source.sourceReference, input.profile?.fact.identityEvidenceRef,
    input.profile?.fact.ownershipEvidenceRef, input.verifiedPurchase?.executionEvidenceRef, input.externalBasis?.evidenceRef]) {
    if (reference && /^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
      const url = new URL(reference);
      if (url.username || url.password || url.search || url.hash) throw new Error("Wallet provenance must exclude URL credentials and query data");
    }
  }
  if (source.occurredAt > input.receivedAt || !["buy", "sell"].includes(source.side)
    || (source.chain === "solana") !== (input.chainFamily === "solana")) throw new Error("Invalid wallet execution source");
  // Copy only the collector contract. Unexpected provider fields never cross the durable boundary.
  const event: WalletCollectorEvent = { eventId: source.eventId, chain: source.chain.toLowerCase(),
    walletAddress: addressKey(input.chainFamily, source.walletAddress), tokenAddress: addressKey(input.chainFamily, source.tokenAddress),
    side: source.side, amountUsd: source.amountUsd, priceUsd: source.priceUsd, marketCapUsd: source.marketCapUsd,
    occurredAt: source.occurredAt, sourceReference: source.sourceReference,
    ...(source.sourceBlockNumber === undefined ? {} : { sourceBlockNumber: source.sourceBlockNumber }),
    ...(source.sourceBlockHash === undefined ? {} : { sourceBlockHash: source.sourceBlockHash }),
    ...(source.executionBasis === undefined ? {} : { executionBasis: source.executionBasis.status === "estimated"
      ? { status: source.executionBasis.status, reason: source.executionBasis.reason, tokenAddress: source.executionBasis.tokenAddress,
        side: source.executionBasis.side, tokenQuantity: source.executionBasis.tokenQuantity, quoteAsset: source.executionBasis.quoteAsset,
        quoteQuantity: source.executionBasis.quoteQuantity, amountUsd: source.executionBasis.amountUsd, priceUsd: source.executionBasis.priceUsd,
        amountBasis: source.executionBasis.amountBasis }
      : { status: "unavailable", reason: source.executionBasis.reason, tokenAddress: null, tokenQuantity: null, amountUsd: null, priceUsd: null } }) };
  const selected = input.profile && selectPostgresWalletProfiles([input.profile], input.chainFamily)[0];
  const profile: PostgresWalletProfile | null = selected && addressKey(input.chainFamily, selected.wallet.address) === event.walletAddress
    ? { wallet: { address: addressKey(input.chainFamily, selected.wallet.address), accountId: selected.wallet.accountId,
      entityId: selected.wallet.entityId, lifecycle: selected.wallet.lifecycle }, fact: canonicalForwardTargetChannelFact(selected.fact),
      profileEnabled: selected.profileEnabled, profileSuspended: selected.profileSuspended,
      ...(selected.monitoringPolicy === undefined ? {} : { monitoringPolicy: selected.monitoringPolicy }),
      bindingState: selected.bindingState, versionId: selected.versionId } : null;
  let purchase: VerifiedForwardPurchase | null = null;
  let externalBasis: VerifiedExternalWalletBasis | null = null;
  if (input.verifiedPurchase) {
    if (!profile) throw new Error("Verified purchase has no matching enabled wallet owner");
    if (input.externalBasis && (input.externalBasis.generationId !== input.generationId || input.externalBasis.verifiedAt > input.receivedAt)) {
      throw new Error("External execution basis belongs to another generation or future verification");
    }
    assertPurchaseMatches(input.verifiedPurchase, event, profile, input.externalBasis ?? null);
    purchase = purchaseProjection(input.verifiedPurchase);
    externalBasis = input.externalBasis ? { verifierId: input.externalBasis.verifierId, evidenceRef: input.externalBasis.evidenceRef,
      generationId: input.externalBasis.generationId, sourceReference: input.externalBasis.sourceReference,
      executionKey: input.externalBasis.executionKey, purchaseFingerprint: input.externalBasis.purchaseFingerprint,
      verifiedAt: input.externalBasis.verifiedAt } : null;
  } else if (profile && event.side === "buy" && input.executionTrust === "rpc_execution") {
    const basis = event.executionBasis;
    if (basis?.status === "estimated" && basis.side === event.side
      && addressKey(input.chainFamily, basis.tokenAddress) === event.tokenAddress
      && basis.amountBasis === "nominal_stablecoin" && basis.reason === "nominal_stablecoin_usd"
      && event.amountUsd === basis.amountUsd && event.priceUsd === basis.priceUsd
      && basis.quoteQuantity === basis.amountUsd && basis.tokenQuantity > 0
      && basis.priceUsd === basis.amountUsd / basis.tokenQuantity) {
      const quoteAsset = stableQuotes[event.chain]?.[addressKey(input.chainFamily, basis.quoteAsset)];
      if (quoteAsset && event.sourceReference.startsWith(`${event.chain}:`)) {
        purchase = { executionKey: `${event.sourceReference}:${event.tokenAddress}`, chain: event.chain as VerifiedForwardPurchase["chain"],
          tokenAddress: event.tokenAddress, entityId: profile.wallet.entityId, sourceUserId: profile.wallet.accountId,
          occurredAt: event.occurredAt, tokenQuantity: decimal(basis.tokenQuantity), quoteAsset,
          quoteAmount: decimal(basis.quoteQuantity), amountUsd: decimal(basis.amountUsd), entryPriceUsd: decimal(basis.priceUsd),
          amountBasis: "stablecoin_nominal", amountEstimated: true,
          executionEvidenceRef: event.sourceReference, ownershipEvidenceRef: profile.fact.ownershipEvidenceRef! };
        assertPurchaseMatches(purchase, event, profile);
      }
    }
  }
  const payload: CapturedPostgresWalletEvent = { schemaVersion: WALLET_CAPTURE_PARSER_VERSION,
    generationId: input.generationId, collectorId: input.collectorId, chainFamily: input.chainFamily, event, profile, purchase,
    externalBasis, entryPriceBasis: purchase ? "executed_quote_per_token_nominal_usd" : null };
  const semanticPayload = JSON.stringify(payload);
  const envelope: PostgresCaptureEnvelope = { sourceNamespace: WALLET_CAPTURE_NAMESPACE,
    // The same transaction can contain multiple tokens and monitored owners. Collector names are transport metadata.
    sourceEventId: hash([event.chain, event.walletAddress, event.eventId, event.tokenAddress]),
    collectorId: input.collectorId, sessionId: input.sessionId, receivedAt: input.receivedAt,
    scrubbedPayload: semanticPayload, semanticPayload };
  return Object.freeze({ envelope, payload });
}

export function resolveCapturedWalletPurchase(payload: CapturedPostgresWalletEvent, generationId: string): CapturedWalletPurchaseResolution {
  if (payload.schemaVersion !== WALLET_CAPTURE_PARSER_VERSION || payload.generationId !== generationId) {
    return { status: "deferred", reasonCode: "wallet_generation_mismatch" };
  }
  if (!payload.purchase || !payload.profile) return { status: "deferred", reasonCode: "wallet_execution_or_owner_unavailable" };
  if (!selectPostgresWalletProfiles([payload.profile], payload.chainFamily).length) return { status: "deferred", reasonCode: "wallet_profile_disabled" };
  if (payload.externalBasis && payload.externalBasis.generationId !== generationId) return { status: "deferred", reasonCode: "wallet_execution_generation_mismatch" };
  assertPurchaseMatches(payload.purchase, payload.event, payload.profile, payload.externalBasis ?? null);
  return { status: "verified", purchase: payload.purchase, ...(payload.externalBasis ? { externalBasis: payload.externalBasis } : {}) };
}

export async function normalizePostgresWalletLease(transaction: PostgresTransaction, lease: NormalizationLease,
  input: { readonly now: number; readonly maximumPayloadBytes: number }): Promise<boolean> {
  if (lease.sourceNamespace !== WALLET_CAPTURE_NAMESPACE || lease.parserVersion !== WALLET_CAPTURE_PARSER_VERSION) {
    throw new Error("Wallet normalization lease belongs to another source adapter");
  }
  const repository = createPostgresNormalizationRepository(transaction, input.maximumPayloadBytes);
  const result = await transaction.query(`SELECT semantic_payload FROM capture_event_revisions
    WHERE source_namespace=$1 AND source_event_id=$2 AND semantic_fingerprint=$3`,
  [lease.sourceNamespace, lease.sourceEventId, lease.semanticFingerprint]);
  const stored = result.rows[0]?.semantic_payload;
  if (typeof stored !== "string") return repository.retry(lease, { now: input.now, retryAt: input.now + 1000, reason: "wallet_payload_unavailable" });
  let payload: CapturedPostgresWalletEvent;
  try {
    payload = JSON.parse(stored) as CapturedPostgresWalletEvent;
    if (payload.schemaVersion !== WALLET_CAPTURE_PARSER_VERSION || !payload.event || !payload.generationId) throw new Error("Invalid wallet payload");
    // Recheck persisted attribution rather than treating JSON presence as execution proof.
    const prepared = preparePostgresWalletCapture({ ...payload, sessionId: "normalization", receivedAt: input.now,
      executionTrust: "unverified", externalBasis: payload.externalBasis ?? null,
      ...(payload.purchase ? { verifiedPurchase: payload.purchase } : {}) });
    payload = prepared.payload;
  } catch {
    return repository.quarantine(lease, { now: input.now, reason: "invalid_wallet_source_projection" });
  }
  return repository.complete(lease, { eventKind: payload.event.side, sourceUserId: payload.profile?.wallet.accountId ?? null,
    entityId: payload.profile?.wallet.entityId ?? null, chain: payload.event.chain, tokenAddress: payload.event.tokenAddress,
    occurredAt: payload.event.occurredAt, normalizedPayload: JSON.stringify(payload) }, input.now);
}

/** Durable scan intent only: neither a completed range nor native execution/coverage authority. */
export type PostgresEvmTransferBootstrapAnchor = import("./evm-transfer-range-collector.js").EvmTransferRangeBootstrapAnchor;

import { sanitizeWalletRpcDiagnostic, type WalletRpcDiagnostic } from "./rpc-diagnostics.js";

export interface PostgresWalletChannelOptions {
  readonly run: PostgresWalletRun; readonly generationId: string; readonly ownerId: string; readonly sessionId: string;
  readonly collectors: readonly { readonly collector: WalletCollector; readonly executionTrust: WalletExecutionTrust;
    readonly bootstrap?: { readonly generation: string; readonly fromBlock: number } }[];
  readonly profiles: { load(input: { readonly generationId: string; readonly chainFamily: "evm" | "solana";
    readonly asOf: number; readonly limit: number; readonly signal: AbortSignal }): Promise<
      { readonly status: "ready"; readonly profiles: readonly PostgresWalletProfile[] }
      | { readonly status: "deferred"; readonly reasonCode: string }> };
  readonly verifyPurchase?: (input: { readonly generationId: string; readonly collector: WalletCollector; readonly event: WalletCollectorEvent;
    readonly profile: PostgresWalletProfile | null; readonly signal: AbortSignal }) => Promise<CapturedWalletPurchaseResolution>;
  readonly maximumProfiles: number; readonly maximumEvents: number; readonly collectorQuota: number;
  readonly leaseMs: number; readonly maximumPayloadBytes: number; readonly maximumRunMs?: number; readonly now: () => number;
}

export interface PostgresWalletPollDiagnostic {
  readonly rpc?: WalletRpcDiagnostic;
  readonly kind: "collector_failure" | "collector_diagnostic" | "exception";
  readonly collector: "solana" | "evm:eth" | "evm:bsc" | "evm:base" | "evm:robinhood" | "other";
  readonly chainFamily: "solana" | "evm";
  readonly stage: "profiles" | "collect" | "prepare" | "verify_purchase" | "commit" | "release";
  readonly partitionKind: "wallet" | "chain" | "schedule" | "other";
  readonly reasonCode: string;
}

/** Only fixed categories cross the log boundary, never provider text, URLs, wallets or signatures. */
const evmRangeDiagnosticReasons = new Set([
  "evm_range_rpc_diagnostic",
  "evm_range_aborted_or_timed_out", "evm_range_adaptive_attempts_exhausted", "evm_range_backoff",
  "evm_range_bootstrap_canonical_mismatch", "evm_range_busy", "evm_range_canonical_mismatch",
  "evm_range_clock_regressed", "evm_range_conflicting_logs", "evm_range_deadline_exceeded",
  "evm_range_decoder_contract_invalid", "evm_range_decoder_rpc_rejected", "evm_range_event_budget_exceeded",
  "evm_range_filter_mismatch", "evm_range_head_behind_bootstrap_anchor", "evm_range_head_behind_checkpoint",
  "evm_range_invalid_bootstrap_anchor", "evm_range_invalid_checkpoint", "evm_range_invalid_header",
  "evm_range_invalid_logs", "evm_range_invalid_quantity", "evm_range_invalid_response",
  "evm_range_invalid_transfer_log", "evm_range_invalid_wallet", "evm_range_logs_budget_exceeded",
  "evm_range_logs_saturated", "evm_range_malformed_receipt", "evm_range_output_budget_exceeded",
  "evm_range_payload_budget_exceeded", "evm_range_provider_backoff", "evm_range_receipt_log_index_duplicate",
  "evm_range_receipt_log_index_missing_or_invalid", "evm_range_receipt_log_index_order_or_gap",
  "evm_range_receipt_logs_mismatch", "evm_range_receipt_mismatch", "evm_range_request_budget_exceeded",
  "evm_range_rpc_or_decoder_unavailable", "evm_range_transaction_mismatch", "evm_range_wallet_budget_exceeded",
  "evm_range_wallet_owner_conflict", "evm_range_wallet_query_budget_exceeded",
]);
function walletDiagnosticReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "WalletRpcRateLimitError" || name === "JsonRpcRateLimitError") return "rpc_rate_limited";
  if (name === "PostgresProviderBudgetError") return "provider_budget_unavailable";
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  if (name === "PostgresCommitUncertainError") return "commit_uncertain";
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const databaseReasons: Record<string, string> = { "42501": "database_permission_denied", "57014": "database_query_cancelled",
    "55P03": "database_lock_unavailable", "40001": "database_serialization_failure", "40P01": "database_deadlock",
    "08006": "database_connection_failure" };
  if (typeof code === "string" && Object.hasOwn(databaseReasons, code)) return databaseReasons[code]!;
  const text = (typeof error === "string" ? error : error instanceof Error ? error.message : "").slice(0, 2048);
  // Solana collector failures retain the fixed message, not the original error class.
  if (text === "Durable provider budget unavailable") return "provider_budget_unavailable";
  if (evmRangeDiagnosticReasons.has(text)) return text;
  if (/\b429\b|rate.?limit|cooling down/i.test(text)) return "rpc_rate_limited";
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(text)) return "rpc_access_denied";
  if (/method not found|method not supported|unsupported method/i.test(text)) return "rpc_method_unavailable";
  if (/timeout|timed out|deadline/i.test(text)) return "timeout";
  if (/abort/i.test(text)) return "aborted";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(text)) return "rpc_transport_unavailable";
  if (text === "insufficient_swap_evidence") return "insufficient_swap_evidence";
  if (text.startsWith("canonical_block_unavailable:")) return "canonical_block_unavailable";
  if (text.startsWith("block_unavailable:")) return "block_unavailable";
  if (text.startsWith("receipt_unavailable:")) return "receipt_unavailable";
  if (text.startsWith("block_failed:")) return "block_failed";
  if (text.startsWith("receipt_failed:")) return "receipt_failed";
  if (text === "Wallet collector lease lost") return "collector_lease_lost";
  if (text === "Wallet collector lease expired before commit") return "collector_lease_expired";
  if (text === "Invalid durable wallet checkpoints") return "invalid_checkpoint";
  if (text === "External execution basis belongs to another generation or future verification") {
    return "execution_verification_time_or_generation_mismatch";
  }
  return "unknown_failure";
}

/** Async collectors run outside transactions; capture, work admission and cursor advancement commit together. */
export function createPostgresWalletChannel(options: PostgresWalletChannelOptions) {
  [options.generationId, options.ownerId, options.sessionId].forEach(identifier);
  positive(options.maximumProfiles, 10000); positive(options.maximumEvents, 10000); positive(options.collectorQuota, 1000);
  positive(options.leaseMs); positive(options.maximumPayloadBytes);
  const maximumRunMs = options.maximumRunMs ?? Math.min(options.leaseMs, 30_000);
  positive(maximumRunMs, 2_147_483_647);
  if (new Set(options.collectors.map(item => item.collector.name)).size !== options.collectors.length) throw new Error("Duplicate wallet collector identity");
  for (const registration of options.collectors) {
    if (registration.bootstrap !== undefined && (!registration.bootstrap || typeof registration.bootstrap !== "object"
      || Object.keys(registration.bootstrap).sort().join(",") !== "fromBlock,generation"
      || registration.bootstrap.generation !== options.generationId
      || !Number.isSafeInteger(registration.bootstrap.fromBlock) || registration.bootstrap.fromBlock < 1
      || registration.collector.chainFamily !== "evm" || !/^evm:(eth|bsc|base)$/.test(registration.collector.name))) {
      throw new Error("Explicit supported EVM bootstrap registration required");
    }
  }
  let nextCollector = 0, running = false;
  const pendingReads = new Set<Promise<unknown>>();
  let fatalRead: { error: unknown } | null = null;
  const read = <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => boundedRead(() => {
    const work = Promise.resolve().then(operation);
    pendingReads.add(work);
    void work.then(() => pendingReads.delete(work), error => {
      pendingReads.delete(work);
      if (uncertainWalletCommit(error)) fatalRead ??= { error };
    });
    return work;
  }, signal);
  return Object.freeze({ async pollOnce(signal: AbortSignal = new AbortController().signal) {
    if (running) throw new Error("Wallet channel is already running");
    signal.throwIfAborted();
    if (fatalRead) throw fatalRead.error;
    running = true;
    // The service entrypoint already serializes this report into its structured poll log.
    const report = { captured: 0, duplicates: 0, revisions: 0, deferred: 0, failed: 0, attempted: 0,
      diagnostics: [] as PostgresWalletPollDiagnostic[], diagnosticsDropped: 0 };
    const diagnose = (collector: WalletCollector, kind: PostgresWalletPollDiagnostic["kind"],
      stage: PostgresWalletPollDiagnostic["stage"], error: unknown, partition?: string, rpcInput?: unknown) => {
      if (report.diagnostics.length >= 32) { report.diagnosticsDropped++; return; }
      const name = collector.name;
      const rpc = sanitizeWalletRpcDiagnostic(rpcInput);
      report.diagnostics.push({ kind, collector: name === "solana" || name === "evm:eth" || name === "evm:bsc"
        || name === "evm:base" || name === "evm:robinhood" ? name : "other",
        chainFamily: collector.chainFamily === "solana" ? "solana" : "evm", stage,
        partitionKind: partition === "schedule" ? "schedule" : partition?.startsWith("wallet:") ? "wallet"
          : partition?.startsWith("chain:") ? "chain" : "other", reasonCode: walletDiagnosticReason(error),
        ...(rpc === undefined ? {} : { rpc }) });
    };
    try {
      // A timeout is not a drain acknowledgement. Do not overlap an abandoned read's
      // provider-budget transactions with another claim; the existing lease expires normally.
      if (pendingReads.size) { report.deferred++; return Object.freeze(report); }
      const count = Math.min(options.collectorQuota, options.collectors.length);
      const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(maximumRunMs)]);
      for (let index = 0; index < count; index++) {
        signal.throwIfAborted();
        if (pollSignal.aborted) break;
        const collectorSignal = AbortSignal.any([pollSignal, AbortSignal.timeout(Math.max(1, Math.floor(maximumRunMs / count)))]);
        // Stop network work before the hard boundary so cooperative cancellation can
        // release provider leases and return a fully completed prefix for durable commit.
        const workSignal = AbortSignal.any([collectorSignal,
          AbortSignal.timeout(Math.max(1, Math.floor(maximumRunMs / count * 0.75)))]);
        const registration = options.collectors[nextCollector % options.collectors.length]!;
        nextCollector = (nextCollector + 1) % options.collectors.length;
        report.attempted++;
        const collector = registration.collector, startedAt = options.now(); timestamp(startedAt);
        timestamp(startedAt + options.leaseMs);
        const claim = await options.run(async transaction => {
          await transaction.query(`INSERT INTO wallet_channel_collectors(generation_id,collector_id,updated_at)
            VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [options.generationId, collector.name, startedAt]);
          const result = await transaction.query(`UPDATE wallet_channel_collectors SET lease_owner=$3,
            lease_expires_at=$4,claim_generation=claim_generation+1
            WHERE generation_id=$1 AND collector_id=$2 AND (lease_owner IS NULL OR lease_expires_at<=$5)
            RETURNING claim_generation,checkpoints_json,lease_expires_at`,
          [options.generationId, collector.name, options.ownerId, startedAt + options.leaseMs, startedAt]);
          return result.rows[0] ?? null;
        });
        if (!claim) { report.deferred++; continue; }
        const release = async () => options.run(transaction => transaction.query(`UPDATE wallet_channel_collectors
          SET lease_owner=NULL,lease_expires_at=NULL WHERE generation_id=$1 AND collector_id=$2 AND lease_owner=$3 AND claim_generation=$4`,
        [options.generationId, collector.name, options.ownerId, Number(claim.claim_generation)]));
        let stage: PostgresWalletPollDiagnostic["stage"] = "profiles";
        try {
          const snapshot = await read(() => options.profiles.load({ generationId: options.generationId, chainFamily: collector.chainFamily,
            asOf: startedAt, limit: options.maximumProfiles, signal: collectorSignal }), collectorSignal);
          if (snapshot.status !== "ready" || snapshot.profiles.length > options.maximumProfiles) {
            await release(); report.deferred++; continue;
          }
          const profiles = selectPostgresWalletProfiles(snapshot.profiles, collector.chainFamily);
          // EVM block checkpoints must see the entire selection. Paginating wallets would skip transactions.
          const decoded: unknown = JSON.parse(String(claim.checkpoints_json));
          if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
            || Object.values(decoded).some(value => typeof value !== "string")) throw new Error("Invalid durable wallet checkpoints");
          const checkpoints = Object.assign(Object.create(null) as Record<string, string>, decoded);
          const bootstrap = walletBootstrapState(registration, checkpoints, options.generationId, options.maximumPayloadBytes);
          stage = "collect";
          const result = structuredClone(await read(() => collector.collect({ wallets: profiles.map(profile => profile.wallet),
            checkpoint: partition => checkpoints[partition] ?? null, signal: workSignal }), collectorSignal));
          validateWalletBootstrapResult(bootstrap, result, checkpoints, options.maximumPayloadBytes);
          for (const failure of result.failures ?? []) diagnose(collector, "collector_failure", "collect", failure.error, failure.partitionKey);
          for (const diagnostic of result.diagnostics ?? []) diagnose(collector, "collector_diagnostic", "collect", diagnostic.reason, diagnostic.partitionKey, diagnostic.rpc);
          signal.throwIfAborted();
          if (result.partitions.reduce((sum, partition) => sum + partition.events.length, 0) > options.maximumEvents) {
            await release(); report.deferred++; continue;
          }
          stage = "prepare";
          const prepared: ReturnType<typeof preparePostgresWalletCapture>[] = [];
          const advanced = { ...checkpoints };
          // A collector can emit completed partitions and failures for another partition; retain only completed cursors.
          for (const partition of result.partitions) {
            identifier(partition.partitionKey);
            if (typeof partition.nextCheckpoint !== "string" || Buffer.byteLength(partition.nextCheckpoint) > options.maximumPayloadBytes) throw new Error("Invalid wallet checkpoint");
            for (const event of partition.events) {
              const profile = profiles.find(item => addressKey(collector.chainFamily, item.wallet.address) === addressKey(collector.chainFamily, event.walletAddress)) ?? null;
              stage = "verify_purchase";
              const verification = options.verifyPurchase ? await read(() => options.verifyPurchase!({ generationId: options.generationId,
                collector, event, profile, signal: collectorSignal }), collectorSignal) : null;
              stage = "prepare";
              // Independent validation/publication can finish after collection. Receipt
              // time must include that work, without accepting a genuinely future proof.
              const receivedAt = options.now(); timestamp(receivedAt);
              prepared.push(preparePostgresWalletCapture({ generationId: options.generationId, collectorId: collector.name,
                sessionId: options.sessionId, chainFamily: collector.chainFamily, receivedAt, event, profile,
                executionTrust: verification?.status === "deferred" ? "unverified" : registration.executionTrust,
                ...(verification?.status === "verified" ? { verifiedPurchase: verification.purchase,
                  ...(verification.externalBasis ? { externalBasis: verification.externalBasis } : {}) } : {}) }));
            }
            advanced[partition.partitionKey] = partition.nextCheckpoint;
          }
          collectorSignal.throwIfAborted();
          stage = "commit";
          const committed = await options.run(async transaction => {
            const assertOwned = async () => {
              const at = options.now(); timestamp(at);
              const owned = await transaction.query(`SELECT * FROM wallet_channel_collectors WHERE generation_id=$1 AND collector_id=$2
                AND lease_owner=$3 AND claim_generation=$4 AND lease_expires_at=$5 AND lease_expires_at>$6 FOR UPDATE`,
              [options.generationId, collector.name, options.ownerId, Number(claim.claim_generation), Number(claim.lease_expires_at), at]);
              if (!owned.rows[0]) throw new Error("Wallet collector lease lost");
            };
            await assertOwned();
            const capture = createPostgresCaptureRepository(transaction, { maximumPayloadBytes: options.maximumPayloadBytes });
            const normalization = createPostgresNormalizationRepository(transaction, options.maximumPayloadBytes);
            const counts = { captured: 0, duplicates: 0, revisions: 0 };
            for (const item of prepared) {
              const stored = await capture.append(item.envelope);
              await transaction.query(`INSERT INTO wallet_capture_generation_bindings
                (generation_id,source_namespace,source_event_id,semantic_fingerprint,created_at) VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(generation_id,source_namespace,source_event_id,semantic_fingerprint) DO NOTHING`,
              [options.generationId,item.envelope.sourceNamespace,item.envelope.sourceEventId,stored.semanticFingerprint,item.envelope.receivedAt]);
              await normalization.request({ sourceNamespace: item.envelope.sourceNamespace, sourceEventId: item.envelope.sourceEventId,
                semanticFingerprint: stored.semanticFingerprint, parserVersion: WALLET_CAPTURE_PARSER_VERSION, requestedAt: item.envelope.receivedAt });
              counts.captured++; if (stored.status === "duplicate") counts.duplicates++;
              if (stored.status === "revision_pending") counts.revisions++;
            }
            await assertOwned();
            const checkpoint = JSON.stringify(advanced);
            if (Buffer.byteLength(checkpoint) > options.maximumPayloadBytes) throw new Error("Wallet checkpoint map exceeds budget");
            await transaction.query(`UPDATE wallet_channel_collectors SET checkpoints_json=$5,updated_at=$6,
              lease_owner=NULL,lease_expires_at=NULL WHERE generation_id=$1 AND collector_id=$2 AND lease_owner=$3 AND claim_generation=$4`,
            [options.generationId, collector.name, options.ownerId, Number(claim.claim_generation), checkpoint, options.now()]);
            if (options.now() >= Number(claim.lease_expires_at)) throw new Error("Wallet collector lease expired before commit");
            return counts;
          });
          report.captured += committed.captured; report.duplicates += committed.duplicates; report.revisions += committed.revisions;
          report.failed += result.failures?.length ?? 0;
        } catch (error) {
          diagnose(collector, "exception", stage, error);
          // A failed/uncertain commit is not an acknowledgement. Replay uses durable fingerprints and saved cursors.
          if (uncertainWalletCommit(error)) throw error;
          if (fatalRead) throw fatalRead.error;
          report.failed++;
          signal.throwIfAborted();
          if (pendingReads.size) break;
          await release().catch(error => {
            diagnose(collector, "exception", "release", error);
            if (uncertainWalletCommit(error)) throw error;
          });
        }
      }
      return Object.freeze(report);
    } finally { running = false; }
  } });
}

interface WalletBootstrapState {
  readonly generationId: string; readonly collectorId: string; readonly chain: "eth" | "bsc" | "base";
  readonly fromBlock: number;
  readonly key: string; readonly completedKey: string;
  readonly existing: PostgresEvmTransferBootstrapAnchor | null;
}

function parseWalletBootstrapAnchor(value: string, state: Omit<WalletBootstrapState, "existing">,
  maximumBytes: number): PostgresEvmTransferBootstrapAnchor {
  if (Buffer.byteLength(value) > maximumBytes) throw new Error("Wallet bootstrap anchor exceeds budget");
  const anchor = JSON.parse(value) as PostgresEvmTransferBootstrapAnchor;
  const keys = "boundaryHash,boundaryNumber,collector,format,fromBlock,generation,scope";
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) || Object.keys(anchor).sort().join(",") !== keys
    || anchor.format !== "evm-transfer-bootstrap-v1" || anchor.scope !== "erc20_transfer_only"
    || anchor.generation !== state.generationId || anchor.collector !== state.collectorId
    || !Number.isSafeInteger(anchor.fromBlock) || anchor.fromBlock !== state.fromBlock
    || anchor.boundaryNumber !== Math.max(0, anchor.fromBlock - 1)
    || typeof anchor.boundaryHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(anchor.boundaryHash)) {
    throw new Error("Invalid bound wallet bootstrap anchor");
  }
  return anchor;
}

function walletBootstrapState(registration: PostgresWalletChannelOptions["collectors"][number],
  checkpoints: Record<string, string>, generationId: string, maximumBytes: number): WalletBootstrapState | null {
  const storedKeys = Object.keys(checkpoints).filter(key => key.startsWith("bootstrap:"));
  if (!registration.bootstrap) {
    if (storedKeys.length) throw new Error("Wallet bootstrap requires explicit registration");
    return null;
  }
  const chain = registration.collector.name.slice(4) as WalletBootstrapState["chain"];
  const state = { generationId, collectorId: registration.collector.name, chain, fromBlock: registration.bootstrap.fromBlock,
    key: `bootstrap:chain:${chain}`, completedKey: `chain:${chain}` };
  if (storedKeys.some(key => key !== state.key)) throw new Error("Wallet bootstrap collector mismatch");
  const value = checkpoints[state.key];
  return { ...state, existing: value === undefined ? null : parseWalletBootstrapAnchor(value, state, maximumBytes) };
}

function validateWalletBootstrapResult(state: WalletBootstrapState | null, result: WalletCollectorResult,
  checkpoints: Record<string, string>, maximumBytes: number): void {
  const anchors = result.partitions.filter(partition => partition.partitionKey.startsWith("bootstrap:"));
  if (anchors.length) {
    const partition = anchors[0]!;
    if (!state || anchors.length !== 1 || result.partitions.length !== 1 || partition.partitionKey !== state.key
      || partition.events.length !== 0 || (result.failures?.length ?? 0) !== 0
      || typeof partition.nextCheckpoint !== "string") throw new Error("Wallet bootstrap must be an opted-in anchor-only result");
    const anchor = parseWalletBootstrapAnchor(partition.nextCheckpoint, state, maximumBytes);
    if (state.existing && checkpoints[state.key] !== partition.nextCheckpoint) throw new Error("Wallet bootstrap anchor is immutable");
    const blocks = partition.canonicalBlocks;
    if (!blocks || blocks.length !== 0) throw new Error("Wallet bootstrap cannot claim completed canonical blocks");
    return;
  }
  if (!state) return;
  if (!state.existing && checkpoints[state.completedKey] === undefined && result.partitions.length) {
    throw new Error("Wallet bootstrap must commit before range completion");
  }
  for (const partition of result.partitions) {
    if (partition.partitionKey !== state.completedKey) throw new Error("Wallet range partition binding mismatch");
    const cursor = JSON.parse(partition.nextCheckpoint) as { blockNumber?: unknown; blockHash?: unknown };
    const floor = checkpoints[state.completedKey] === undefined ? state.existing?.fromBlock ?? 0 : 0;
    if (!cursor || !Number.isSafeInteger(cursor.blockNumber) || Number(cursor.blockNumber) < floor
      || typeof cursor.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(cursor.blockHash)) {
      throw new Error("Wallet range completion precedes bootstrap anchor");
    }
  }
}

function uncertainWalletCommit(error: unknown): boolean {
  return error instanceof PostgresCommitUncertainError
    || (error instanceof AggregateError && error.errors.some(uncertainWalletCommit));
}

async function boundedRead<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let reject!: (error: unknown) => void;
  const aborted = new Promise<never>((_resolve, fail) => { reject = fail; });
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
