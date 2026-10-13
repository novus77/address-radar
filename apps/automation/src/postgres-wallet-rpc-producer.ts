import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { POSTGRES_PROVIDER_BUDGET_REASONS } from "./postgres-service-fact-adapters.js";
import {
  extractSolanaSwapEvidence, isSupportedSolanaSwapTransaction, SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION, SOLANA_USDC_MINT, SOLANA_USDT_MINT, SOLANA_WRAPPED_NATIVE_MINT,
  type SolanaSwapTransaction,
} from "../../../packages/collectors/src/solana-swap-evidence.js";
import { deriveExecutionBasis } from "../../wallet-monitor/src/execution-basis.js";
import {
  preparePostgresWalletCapture, selectPostgresWalletProfiles,
  type CapturedPostgresWalletEvent, type PostgresWalletChannelOptions, type PostgresWalletProfile,
} from "../../wallet-monitor/src/postgres-wallet-channel.js";

export interface PostgresSolanaExecutionProducerOptions {
  readonly generationId: string;
  readonly activatedAt: number;
  readonly providerId: string;
  readonly expectedGenesisHash: string;
  /** Bind to the configured RPC client using the durable PG-budgeted fetch port. No default transport. */
  readonly rpc: { request(chain: "solana", method: string, params: unknown[], signal: AbortSignal): Promise<unknown> };
  readonly profiles: PostgresWalletChannelOptions["profiles"];
  readonly maximumProfiles: number;
  readonly maximumPayloadBytes: number;
  readonly maximumRunMs: number;
  readonly now: () => number;
  /** Closed metadata only; never receives provider messages, parameters or endpoints. */
  readonly onRpcDiagnostic?: (diagnostic: PostgresExecutionRpcDiagnostic) => void;
}

/** Acquisition evidence only. An independent approved publisher must validate and persist its attestation. */
export interface PostgresSolanaExecutionCandidate {
  readonly generationId: string;
  readonly providerId: string;
  readonly genesisHash: string;
  readonly slot: number;
  readonly blockHash: string;
  readonly sourceReference: string;
  readonly profile: PostgresWalletProfile;
  readonly observedAt: number;
  readonly knownAt: number;
  readonly contentFingerprint: string;
  readonly purchaseCandidate: NonNullable<CapturedPostgresWalletEvent["purchase"]>;
  readonly evidence: { readonly signatureStatus: unknown; readonly transaction: unknown; readonly block: unknown };
}
export type PostgresSolanaExecutionAcquisition =
  | { readonly status: "acquired"; readonly candidate: PostgresSolanaExecutionCandidate }
  | { readonly status: "deferred"; readonly reasonCode: string };

class MissingProof extends Error {}
export const POSTGRES_EXECUTION_ACQUISITION_TRANSPORT_REASONS = Object.freeze([
  "execution_rpc_provider_budget_unavailable", "execution_rpc_rate_limited", "execution_rpc_timed_out",
  "execution_rpc_response_error", "execution_rpc_aborted", "execution_rpc_transport_unavailable",
]);
export const POSTGRES_EXECUTION_RPC_METHODS = Object.freeze([
  "getGenesisHash", "getSignatureStatuses", "getTransaction", "getBlock", "getSignaturesForAddress",
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs", "eth_call",
] as const);
export const POSTGRES_EXECUTION_RPC_SUBCATEGORIES = Object.freeze([
  "invalid_params", "method_not_found", "unsupported_transaction_version", "authentication_required", "permission_denied",
  "resource_unavailable", "rpc_internal_error", "malformed_response", "other_rpc_error", "provider_budget_unavailable",
  "rate_limit", "ambiguous_limit", "timeout", "aborted", "transport_unavailable", "unknown_failure",
] as const);
/** Native runtime binding only; never accepted from request or response material. */
export interface PostgresRpcDiagnosticContext {
  readonly endpoint: string;
  readonly chain: "solana" | "eth" | "bsc" | "base";
  readonly providerId: string;
  readonly purpose: "source" | "replay";
}
export interface PostgresExecutionRpcDiagnostic {
  readonly method: typeof POSTGRES_EXECUTION_RPC_METHODS[number];
  readonly code: number | null;
  readonly httpStatus?: number;
  readonly retryAt?: number;
  readonly chain?: PostgresRpcDiagnosticContext["chain"];
  readonly providerId?: string;
  readonly purpose?: PostgresRpcDiagnosticContext["purpose"];
  readonly subcategory: typeof POSTGRES_EXECUTION_RPC_SUBCATEGORIES[number];
  readonly reasonCode: string;
  readonly budgetReason?: typeof POSTGRES_PROVIDER_BUDGET_REASONS[number];
  readonly transport?: "local" | "http" | "rpc" | "unknown";
}
interface RpcFailureSnapshot {
  readonly name: string; readonly code: number | null; readonly message: string; readonly ambiguous: boolean;
  readonly httpStatus?: number; readonly retryAt?: number;
  readonly budgetReason?: typeof POSTGRES_PROVIDER_BUDGET_REASONS[number];
  readonly transport?: "local" | "http" | "rpc" | "unknown";
}
function snapshotRpcFailure(error: unknown): RpcFailureSnapshot | null {
  // Native errors only; reject proxies before descriptor inspection can invoke their traps.
  if (utilTypes.isProxy(error) || !utilTypes.isNativeError(error)) return null;
  try {
    const descriptors = ["name","code","message","reasonCode","budgetReason","httpStatus","retryAt"].map(key => Object.getOwnPropertyDescriptor(error,key));
    if (descriptors.some(descriptor => descriptor !== undefined && !("value" in descriptor))) return null;
    const [name,code,message,reasonCode,budgetReason,httpStatus,retryAt] = descriptors.map(descriptor => descriptor?.value as unknown);
    return { name: typeof name === "string" ? name : "",code: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
      ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
      ...(typeof retryAt === "number" && Number.isSafeInteger(retryAt) && retryAt >= 0 ? { retryAt } : {}),
      message: typeof message === "string" ? message.slice(0,512) : "",ambiguous: reasonCode === "rpc_json_limit_ambiguous",
      ...(POSTGRES_PROVIDER_BUDGET_REASONS.some(allowed => allowed === budgetReason)
        ? { budgetReason: budgetReason as typeof POSTGRES_PROVIDER_BUDGET_REASONS[number],transport: "local" as const } : {}),
      ...(reasonCode === "rpc_http_rate_limited" ? { transport: "http" as const } :
        reasonCode === "rpc_json_rate_limited" || reasonCode === "rpc_json_limit_ambiguous" ? { transport: "rpc" as const } : {}) };
  } catch { return null; }
}
function rpcDiagnostic(method: PostgresExecutionRpcDiagnostic["method"],value: RpcFailureSnapshot | null,reasonCode: string): PostgresExecutionRpcDiagnostic {
  const code = value?.code ?? null;
  let subcategory: PostgresExecutionRpcDiagnostic["subcategory"] = "transport_unavailable";
  if (reasonCode === "execution_rpc_provider_budget_unavailable") subcategory = "provider_budget_unavailable";
  else if (reasonCode === "execution_rpc_rate_limited") subcategory = value?.ambiguous === true ? "ambiguous_limit" : "rate_limit";
  else if (reasonCode === "execution_rpc_timed_out") subcategory = "timeout";
  else if (reasonCode === "execution_rpc_aborted") subcategory = "aborted";
  else if (reasonCode === "execution_rpc_response_error") {
    // Inspect at most 512 characters in memory. No raw text is retained in the diagnostic or deferred result.
    const message = value?.message ?? "";
    if (code === -32602) subcategory = "invalid_params";
    else if (code === -32601) subcategory = "method_not_found";
    else if (code === -32015 || /^transaction version \(\d+\) is not supported by the requesting client\b/i.test(message)) subcategory = "unsupported_transaction_version";
    else if (/^JSON-RPC HTTP 401:|^(?:unauthorized|authentication required|invalid api[ -]?key|invalid access token|api[ -]?key (?:is )?invalid)\b/i.test(message)) subcategory = "authentication_required";
    else if (/^JSON-RPC HTTP 403:|^(?:forbidden|access denied|permission denied|method (?:is )?not (?:enabled|allowed) (?:for|on) (?:this|your) (?:plan|api key))\b/i.test(message)) subcategory = "permission_denied";
    else if (/^(?:transaction history is not available|block not available for slot|requested resource (?:is )?not available)\b/i.test(message)) subcategory = "resource_unavailable";
    else if (code === -32603) subcategory = "rpc_internal_error";
    else if (code === null && message === "Malformed JSON-RPC response") subcategory = "malformed_response";
    else subcategory = "other_rpc_error";
  }
  return Object.freeze({ method,code,subcategory,reasonCode,
    ...(value?.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(value?.retryAt === undefined ? {} : { retryAt: value.retryAt }),
    ...(value?.budgetReason ? { budgetReason: value.budgetReason } : {}),
    ...(value?.transport ? { transport: value.transport } : {}) });
}
function rpcFailureReason(value: RpcFailureSnapshot | null): string {
  const name = value?.name ?? "";
  switch (name) {
    case "PostgresProviderBudgetError": return "execution_rpc_provider_budget_unavailable";
    case "WalletRpcRateLimitError": case "JsonRpcRateLimitError": return "execution_rpc_rate_limited";
    case "JsonRpcTimeoutError": return "execution_rpc_timed_out";
    case "JsonRpcResponseError": return "execution_rpc_response_error";
    case "JsonRpcAbortError": return "execution_rpc_aborted";
    default: return "execution_rpc_transport_unavailable";
  }
}
function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new MissingProof(reason);
}
function record(value: unknown): Record<string, unknown> {
  requireProof(value && typeof value === "object" && !Array.isArray(value), "rpc_payload_missing");
  return value as Record<string, unknown>;
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid producer timestamp");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function sameOwner(left: PostgresWalletProfile, right: PostgresWalletProfile): boolean {
  return left.wallet.address === right.wallet.address && left.wallet.accountId === right.wallet.accountId
    && left.wallet.entityId === right.wallet.entityId && left.fact.ownershipEvidenceRef === right.fact.ownershipEvidenceRef
    && left.fact.identityEvidenceRef === right.fact.identityEvidenceRef;
}

export function createPostgresSolanaExecutionProducer(options: PostgresSolanaExecutionProducerOptions) {
  for (const value of [options.generationId, options.providerId, options.expectedGenesisHash]) {
    if (!value.trim() || value.length > 512 || value.includes("://")) throw new Error("Explicit reviewed producer identity required");
  }
  timestamp(options.activatedAt);
  for (const [value, maximum] of [[options.maximumProfiles, 10_000], [options.maximumPayloadBytes, 10_000_000],
    [options.maximumRunMs, 2_147_483_647]]) {
    if (!Number.isSafeInteger(value) || value! <= 0 || value! > maximum!) throw new Error("Explicit bounded producer budget required");
  }
  let busy = false;
  async function acquireEvidence(payload: CapturedPostgresWalletEvent, signal: AbortSignal): Promise<PostgresSolanaExecutionAcquisition> {
    const startedAt = options.now(); timestamp(startedAt);
    requireProof(payload.generationId === options.generationId && payload.chainFamily === "solana"
      && payload.event.chain === "solana" && payload.event.side === "buy", "capture_generation_or_chain_mismatch");
    const event = payload.event;
    requireProof(Number.isSafeInteger(event.occurredAt) && event.occurredAt >= options.activatedAt
      && event.occurredAt <= startedAt, "outside_forward_generation");
    requireProof(event.sourceReference.startsWith("solana:"), "execution_reference_missing");
    const signature = event.sourceReference.slice("solana:".length);
    requireProof(signature.length > 0 && signature.length <= 512 && !signature.includes(":"), "execution_reference_invalid");

    async function currentProfile(asOf: number): Promise<PostgresWalletProfile> {
      const cohort = await options.profiles.load({ generationId: options.generationId, chainFamily: "solana",
        asOf, limit: options.maximumProfiles, signal });
      requireProof(cohort.status === "ready", "profile_cohort_unavailable");
      requireProof(cohort.profiles.length <= options.maximumProfiles, "profile_cohort_overflow");
      const profile = selectPostgresWalletProfiles(cohort.profiles, "solana").find(item => item.wallet.address === event.walletAddress);
      requireProof(profile && payload.profile && sameOwner(profile, payload.profile), "current_wallet_owner_unavailable");
      return profile;
    }
    const profile = await currentProfile(startedAt);
    let bytes = 0;
    async function request(method: PostgresExecutionRpcDiagnostic["method"], params: unknown[]): Promise<unknown> {
      signal.throwIfAborted();
      let result: unknown;
      try { result = await options.rpc.request("solana", method, params, signal); }
      catch (error) {
        const snapshot = snapshotRpcFailure(error);
        const reasonCode = rpcFailureReason(snapshot);
        try { options.onRpcDiagnostic?.(rpcDiagnostic(method,snapshot,reasonCode)); } catch { /* Diagnostics never change acquisition semantics. */ }
        throw new MissingProof(reasonCode);
      }
      signal.throwIfAborted();
      bytes += Buffer.byteLength(JSON.stringify(result) ?? "null");
      requireProof(bytes <= options.maximumPayloadBytes, "execution_payload_budget_exceeded");
      return result;
    }
    const genesisHash = await request("getGenesisHash", []);
    requireProof(genesisHash === options.expectedGenesisHash, "rpc_chain_identity_mismatch");
    const statuses = record(await request("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]));
    requireProof(Array.isArray(statuses.value) && statuses.value.length === 1, "signature_status_missing");
    const status = record(statuses.value[0]);
    requireProof(status.err === null && status.confirmationStatus === "finalized"
      && Number.isSafeInteger(status.slot) && Number(status.slot) >= 0, "execution_not_finalized");
    const slot = Number(status.slot);
    const transaction = record(await request("getTransaction", [signature,
      { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION }]));
    requireProof(isSupportedSolanaSwapTransaction(transaction), "execution_transaction_mismatch");
    const meta = record(transaction.meta), body = record(transaction.transaction);
    requireProof(meta.err === null && transaction.slot === slot && Array.isArray(body.signatures)
      && body.signatures[0] === signature, "execution_transaction_mismatch");
    requireProof(Number.isSafeInteger(transaction.blockTime) && Number(transaction.blockTime) * 1000 === event.occurredAt,
      "execution_time_mismatch");
    const block = record(await request("getBlock", [slot,
      { commitment: "finalized", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION }]));
    requireProof(typeof block.blockhash === "string" && block.blockhash.length > 0 && block.blockhash.length <= 512
      && block.blockTime === transaction.blockTime && Array.isArray(block.signatures) && block.signatures.includes(signature),
      "canonical_block_membership_missing");
    requireProof((event.sourceBlockNumber === undefined || event.sourceBlockNumber === slot)
      && (event.sourceBlockHash === undefined || event.sourceBlockHash === block.blockhash), "capture_block_mismatch");

    const extracted = extractSolanaSwapEvidence(transaction as SolanaSwapTransaction, event.walletAddress);
    const basis = deriveExecutionBasis({ successful: true,
      swapConfirmed: extracted.candidateDeltas.some(delta => extracted.supportsSwap(delta)),
      tokenDeltas: extracted.candidateDeltas.map(delta => ({ asset: delta.mint, quantity: delta.amount })),
      quoteDeltas: [
        ...extracted.stableQuoteDeltas.map(delta => ({ asset: delta.mint,
          symbol: delta.mint === SOLANA_USDC_MINT ? "USDC" : delta.mint === SOLANA_USDT_MINT ? "USDT" : "",
          quantity: delta.amount, verifiedStablecoin: true })),
        ...extracted.wrappedNativeDeltas.map(delta => ({ asset: SOLANA_WRAPPED_NATIVE_MINT,
          symbol: "SOL", quantity: delta.amount, verifiedStablecoin: false })),
        ...(extracted.nativeDelta === 0 ? [] : [{ asset: "SOL", symbol: "SOL", quantity: extracted.nativeDelta, verifiedStablecoin: false }]),
      ] });
    requireProof(basis.status === "estimated" && basis.tokenAddress === event.tokenAddress && basis.side === "buy"
      && basis.amountBasis === "nominal_stablecoin", "actual_trade_basis_unavailable");
    requireProof((event.amountUsd === null || event.amountUsd === basis.amountUsd)
      && (event.priceUsd === null || event.priceUsd === basis.priceUsd), "capture_execution_quantities_mismatch");
    if (event.executionBasis?.status === "estimated") requireProof(canonical(event.executionBasis) === canonical(basis),
      "capture_execution_basis_mismatch");
    const knownAt = options.now(); timestamp(knownAt);
    requireProof(knownAt >= startedAt, "producer_clock_regressed");
    const current = await currentProfile(knownAt);
    requireProof(sameOwner(current, profile) && current.versionId === profile.versionId, "profile_changed_during_acquisition");
    const prepared = preparePostgresWalletCapture({ generationId: options.generationId,
      collectorId: payload.collectorId, sessionId: options.providerId, chainFamily: "solana", receivedAt: knownAt,
      executionTrust: "rpc_execution", profile: current,
      event: { ...event, amountUsd: basis.amountUsd, priceUsd: basis.priceUsd, executionBasis: basis } });
    const purchase = prepared.payload.purchase;
    requireProof(purchase, "nominal_execution_purchase_unavailable");
    if (payload.purchase) requireProof(canonical(payload.purchase) === canonical(purchase), "capture_purchase_mismatch");
    const evidence = { signatureStatus: status, transaction, block };
    const contentFingerprint = createHash("sha256").update(canonical({ generationId: options.generationId,
      providerId: options.providerId, genesisHash, sourceReference: event.sourceReference,
      profile: current, purchase, evidence })).digest("hex");
    return { status: "acquired", candidate: { generationId: options.generationId, providerId: options.providerId,
      genesisHash: options.expectedGenesisHash, slot, blockHash: block.blockhash as string,
      sourceReference: event.sourceReference, profile: current, observedAt: event.occurredAt, knownAt,
      contentFingerprint, purchaseCandidate: purchase, evidence } };
  }
  return Object.freeze({
    async acquire(input: { readonly payload: CapturedPostgresWalletEvent; readonly signal: AbortSignal }): Promise<PostgresSolanaExecutionAcquisition> {
      if (busy) return { status: "deferred", reasonCode: "producer_busy" };
      busy = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const timer = setTimeout(abort, options.maximumRunMs);
      let onAbort: () => void = () => {};
      const aborted = new Promise<PostgresSolanaExecutionAcquisition>(resolve => {
        onAbort = () => resolve({ status: "deferred", reasonCode: "producer_aborted_or_timed_out" });
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        return await Promise.race([acquireEvidence(input.payload, controller.signal).catch(error => ({ status: "deferred" as const,
          reasonCode: error instanceof MissingProof ? error.message : "execution_acquisition_unavailable" })), aborted]);
      } finally {
        controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort); busy = false;
      }
    },
  });
}
