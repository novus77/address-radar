import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FetchLike } from "../../../packages/collectors/src/types.js";
import { createConfiguredWalletRpcClient } from "../../wallet-monitor/src/rpc.js";
import { preparePostgresWalletCapture, walletPurchaseBasisFingerprint,
  type PostgresWalletChannelOptions } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { createPostgresSolanaExecutionProducer, type PostgresExecutionRpcDiagnostic } from "./postgres-wallet-rpc-producer.js";
import { createPostgresEvmExecutionProducer, type PostgresEvmExecutionProducerOptions } from "./postgres-evm-execution-producer.js";
import { executionValidationSigningPayload, type PostgresExecutionCandidate,
  type PostgresExecutionValidationClaims, type SignedPostgresExecutionValidation } from "./postgres-execution-fact-publisher.js";

interface ReviewedProviderPair {
  readonly sourceProviderId: string;
  /** Trusted root configuration, never an endpoint supplied by a candidate. */
  readonly sourceEndpoint: string;
  readonly replayProviderId: string;
  readonly replayEndpoint: string;
}
export type ReviewedPostgresExecutionProviderBinding = ReviewedProviderPair & (
  | { readonly chain: "solana"; readonly expectedGenesisHash: string }
  | { readonly chain: "eth" | "bsc" | "base"; readonly expectedChainId: string;
    readonly expectedGenesisBlockHash: string; readonly stableQuoteTokens: PostgresEvmExecutionProducerOptions["stableQuoteTokens"] }
);
export interface PostgresIndependentExecutionValidatorOptions {
  readonly generationId: string;
  readonly activatedAt: number;
  readonly validatorId: string;
  readonly keyId: string;
  readonly publicKey: string;
  /** Trusted local key port. Candidate material never supplies a key or signing operation. */
  readonly signingKey: { loadPrivateKey(): KeyObject };
  readonly reviewedProviderBindings: readonly ReviewedPostgresExecutionProviderBinding[];
  /** Root supplies its independently budgeted transport and current profile repository. */
  readonly fetch: FetchLike;
  readonly profiles: PostgresWalletChannelOptions["profiles"];
  readonly maximumProfiles: number;
  readonly maximumRpcRequests: number;
  readonly maximumLogs: number;
  readonly maximumDecimalsReads: number;
  readonly maximumPayloadBytes: number;
  readonly maximumRunMs: number;
  readonly validationTtlMs: number;
  readonly maximumNonces: number;
  readonly nonce: () => string;
  readonly now: () => number;
  readonly onRpcDiagnostic?: (diagnostic: PostgresExecutionRpcDiagnostic) => void;
}
export type PostgresIndependentExecutionValidationResult =
  | { readonly status: "verified"; readonly validation: SignedPostgresExecutionValidation }
  | { readonly status: "deferred"; readonly reasonCode: string };

class ReplayRefused extends Error {}
function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new ReplayRefused(reason);
}
function identity(value: unknown, maximum = 128): asserts value is string {
  requireProof(typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum
    && !/[\x00-\x20]/.test(value) && !value.includes("://"), "validator_identity_invalid");
}
function time(value: number): void {
  requireProof(Number.isSafeInteger(value) && value >= 0, "validator_clock_invalid");
}
function positive(value: number, maximum: number): void {
  requireProof(Number.isSafeInteger(value) && value > 0 && value <= maximum, "validator_explicit_budget_required");
}
function endpoint(value: string): URL {
  const url = new URL(value);
  requireProof(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash,
    "validator_endpoint_invalid");
  return url;
}
/** Bound traversal before copying untrusted content; reject accessors, cycles and lossy JSON. */
function boundedCanonical(value: unknown, maximumBytes: number): string {
  const parts: string[] = [], active = new Set<object>(); let bytes = 0, nodes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text); requireProof(bytes <= maximumBytes, "validator_content_budget"); parts.push(text);
  };
  function visit(item: unknown, depth: number): void {
    requireProof(++nodes <= 10_000 && depth <= 24, "validator_content_budget");
    if (typeof item === "string") {
      requireProof(Buffer.byteLength(item) <= maximumBytes, "validator_content_budget"); append(JSON.stringify(item)); return;
    }
    if (item === null || typeof item === "boolean") { append(JSON.stringify(item)); return; }
    if (typeof item === "number") {
      requireProof(Number.isFinite(item), "validator_content_invalid"); append(JSON.stringify(item)); return;
    }
    requireProof(item && typeof item === "object" && !active.has(item) && Object.getOwnPropertySymbols(item).length === 0,
      "validator_content_invalid");
    requireProof(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null,
      "validator_content_invalid");
    active.add(item);
    const keys = Object.keys(item);
    requireProof(keys.length <= 10_000 && (!Array.isArray(item) || keys.length === item.length), "validator_content_budget");
    append(Array.isArray(item) ? "[" : "{");
    const ordered = Array.isArray(item) ? keys : keys.sort((a, b) => a.localeCompare(b));
    ordered.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      requireProof(Object.hasOwn(descriptor, "value"), "validator_content_invalid");
      if (index) append(",");
      if (!Array.isArray(item)) { append(JSON.stringify(key)); append(":"); }
      visit(descriptor.value, depth + 1);
    });
    append(Array.isArray(item) ? "]" : "}"); active.delete(item);
  }
  visit(value, 0); return parts.join("");
}

export function createPostgresIndependentExecutionValidator(options: PostgresIndependentExecutionValidatorOptions) {
  const { generationId, activatedAt, validatorId, keyId, maximumProfiles, maximumRpcRequests, maximumLogs,
    maximumDecimalsReads, maximumPayloadBytes, maximumRunMs, validationTtlMs, maximumNonces, now, nonce } = options;
  [generationId, validatorId, keyId].forEach(value => identity(value)); time(activatedAt);
  for (const [value, maximum] of [[maximumProfiles, 10_000], [maximumRpcRequests, 10_000], [maximumLogs, 10_000],
    [maximumDecimalsReads, 1000], [maximumPayloadBytes, 10_000_000], [maximumRunMs, 300_000],
    [validationTtlMs, 300_000], [maximumNonces, 10_000]] as const) positive(value, maximum);
  requireProof(typeof now === "function" && typeof nonce === "function" && typeof options.fetch === "function"
    && typeof options.profiles?.load === "function", "validator_trusted_ports_required");
  const privateKey = options.signingKey.loadPrivateKey(), publicKey = createPublicKey(options.publicKey);
  requireProof(privateKey.type === "private" && privateKey.asymmetricKeyType === "ed25519" && publicKey.asymmetricKeyType === "ed25519"
    && createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(publicKey.export({ type: "spki", format: "der" })),
    "validator_reviewed_ed25519_key_required");
  const fetchPort = options.fetch, loadProfiles = options.profiles.load.bind(options.profiles);
  requireProof(Array.isArray(options.reviewedProviderBindings) && options.reviewedProviderBindings.length > 0
    && options.reviewedProviderBindings.length <= 100, "validator_reviewed_bindings_required");
  const bindings = new Map<string, ReviewedPostgresExecutionProviderBinding>();
  for (const original of options.reviewedProviderBindings) {
    const binding = JSON.parse(boundedCanonical(original, maximumPayloadBytes)) as ReviewedPostgresExecutionProviderBinding;
    [binding.sourceProviderId, binding.replayProviderId].forEach(value => identity(value));
    const source = endpoint(binding.sourceEndpoint), replay = endpoint(binding.replayEndpoint);
    requireProof(binding.sourceProviderId !== binding.replayProviderId && binding.sourceProviderId !== validatorId
      && source.hostname !== replay.hostname, "validator_independent_provider_endpoint_required");
    requireProof(["solana", "eth", "bsc", "base"].includes(binding.chain), "validator_chain_not_reviewed");
    if (binding.chain === "solana") identity(binding.expectedGenesisHash, 512);
    else {
      requireProof(/^0x[0-9a-f]{1,64}$/.test(binding.expectedChainId) && BigInt(binding.expectedChainId) > 0n
        && /^0x[0-9a-f]{64}$/.test(binding.expectedGenesisBlockHash) && Array.isArray(binding.stableQuoteTokens)
        && binding.stableQuoteTokens.length > 0 && binding.stableQuoteTokens.length <= 100, "validator_chain_pins_required");
    }
    const index = JSON.stringify([binding.chain, binding.sourceProviderId]);
    requireProof(!bindings.has(index), "validator_duplicate_provider_binding"); bindings.set(index, binding);
  }
  const nonces = new Map<string, number>(); let busy = false, outstandingPorts = 0;
  return Object.freeze({
    async validateExecution(input: { readonly candidate: PostgresExecutionCandidate; readonly signal: AbortSignal }): Promise<PostgresIndependentExecutionValidationResult> {
      const deferred = (reasonCode: string): PostgresIndependentExecutionValidationResult => ({ status: "deferred", reasonCode });
      if (busy || outstandingPorts > 0) return deferred("validator_busy");
      if (input.signal.aborted) return deferred("validator_aborted_or_timed_out");
      busy = true;
      const controller = new AbortController(), abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
      const timer = setTimeout(abort, maximumRunMs), startedWall = performance.now();
      let lastAt: number | undefined, deadlineAt: number | undefined;
      const check = () => {
        controller.signal.throwIfAborted(); const at = now(); controller.signal.throwIfAborted(); time(at);
        requireProof((lastAt === undefined || at >= lastAt) && performance.now() - startedWall < maximumRunMs,
          "validator_clock_or_deadline");
        if (deadlineAt === undefined) { deadlineAt = at + maximumRunMs; time(deadlineAt); }
        requireProof(at < deadlineAt, "validator_clock_or_deadline"); lastAt = at; return at;
      };
      let onAbort: () => void = () => {};
      const stopped = new Promise<PostgresIndependentExecutionValidationResult>(resolve => {
        onAbort = () => resolve(deferred("validator_aborted_or_timed_out"));
        controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort();
      });
      async function replayAndSign(): Promise<PostgresIndependentExecutionValidationResult> {
        const startedAt = check();
        const candidate = JSON.parse(boundedCanonical(input.candidate, maximumPayloadBytes)) as PostgresExecutionCandidate;
        const purchase = candidate.purchaseCandidate, chain = purchase.chain;
        const binding = bindings.get(JSON.stringify([chain, candidate.providerId]));
        requireProof(binding && candidate.generationId === generationId && candidate.observedAt === purchase.occurredAt,
          "validator_candidate_binding_mismatch");
        time(candidate.observedAt); time(candidate.knownAt);
        requireProof(candidate.observedAt >= activatedAt && candidate.knownAt >= candidate.observedAt && candidate.knownAt <= startedAt
          && /^[a-f0-9]{64}$/.test(candidate.contentFingerprint), "validator_candidate_clock_or_fingerprint");
        identity(candidate.sourceReference, 512);
        if (binding.chain === "solana") {
          requireProof("genesisHash" in candidate && candidate.genesisHash === binding.expectedGenesisHash,
            "validator_candidate_chain_pin_mismatch");
        } else {
          requireProof("chainId" in candidate && candidate.chainId === `0x${BigInt(binding.expectedChainId).toString(16)}`
            && candidate.genesisBlockHash === binding.expectedGenesisBlockHash, "validator_candidate_chain_pin_mismatch");
        }
        const family = binding.chain === "solana" ? "solana" : "evm";
        const payload = preparePostgresWalletCapture({ generationId, collectorId: validatorId, sessionId: binding.replayProviderId,
          chainFamily: family, receivedAt: startedAt, profile: candidate.profile, executionTrust: "unverified",
          event: { eventId: `${candidate.sourceReference}:${purchase.tokenAddress}:buy`, chain, walletAddress: candidate.profile.wallet.address,
            tokenAddress: purchase.tokenAddress, side: "buy", occurredAt: candidate.observedAt, amountUsd: null, priceUsd: null,
            marketCapUsd: null, sourceReference: candidate.sourceReference, sourceBlockHash: candidate.blockHash,
            sourceBlockNumber: "slot" in candidate ? candidate.slot : candidate.blockNumber } }).payload;
        let requests = 0, responseBytes = 0;
        const fetch: FetchLike = async (url, init) => {
          outstandingPorts++;
          try {
          check(); requireProof(new URL(String(url)).href === new URL(binding.replayEndpoint).href && ++requests <= maximumRpcRequests,
            "validator_rpc_request_budget");
          const response = await fetchPort(url, { ...init, signal: controller.signal, redirect: "error" }); check();
          requireProof(!response.redirected && (!response.url || new URL(response.url).href === new URL(binding.replayEndpoint).href),
            "validator_rpc_redirect_refused");
          const reader = response.body?.getReader();
          requireProof(reader, "validator_rpc_body_missing");
          const chunks: Uint8Array[] = [];
          const cancelRead = () => { void reader.cancel().catch(() => {}); };
          controller.signal.addEventListener("abort", cancelRead, { once: true });
          if (controller.signal.aborted) cancelRead();
          try {
            while (true) {
              check(); const chunk = await reader.read(); check(); if (chunk.done) break;
              responseBytes += chunk.value.byteLength;
              requireProof(responseBytes <= maximumPayloadBytes, "validator_rpc_content_budget"); chunks.push(chunk.value);
            }
          } finally {
            controller.signal.removeEventListener("abort", cancelRead); cancelRead(); reader.releaseLock();
          }
          return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
          } finally { outstandingPorts--; }
        };
        // Producer deadline races do not prove that an injected port has actually settled.
        const replayProfiles: PostgresWalletChannelOptions["profiles"] = { async load(request) {
          outstandingPorts++;
          try { check(); const result = await loadProfiles(request); check(); return result; }
          finally { outstandingPorts--; }
        } };
        const common = { generationId, activatedAt, providerId: binding.replayProviderId, profiles: replayProfiles,
          maximumProfiles, maximumPayloadBytes, maximumRunMs, now: check };
        const producer = binding.chain === "solana"
          ? createPostgresSolanaExecutionProducer({ ...common, expectedGenesisHash: binding.expectedGenesisHash,
            ...(options.onRpcDiagnostic ? { onRpcDiagnostic: options.onRpcDiagnostic } : {}),
            rpc: createConfiguredWalletRpcClient({ endpoints: { solana: { primary: binding.replayEndpoint } }, fetch }) })
          : createPostgresEvmExecutionProducer({ ...common, chain: binding.chain, expectedChainId: binding.expectedChainId,
            expectedGenesisBlockHash: binding.expectedGenesisBlockHash, endpoint: binding.replayEndpoint, fetch,
            stableQuoteTokens: binding.stableQuoteTokens, maximumLogs, maximumDecimalsReads, maximumRpcRequests });
        const result = await producer.acquire({ payload, signal: controller.signal }); check();
        if (result.status !== "acquired") return deferred(result.reasonCode);
        const replay = result.candidate;
        requireProof(replay.providerId === binding.replayProviderId && replay.generationId === candidate.generationId
          && replay.sourceReference === candidate.sourceReference && replay.blockHash === candidate.blockHash
          && replay.observedAt === candidate.observedAt
          && boundedCanonical(replay.profile, maximumPayloadBytes) === boundedCanonical(candidate.profile, maximumPayloadBytes)
          && boundedCanonical(replay.purchaseCandidate, maximumPayloadBytes) === boundedCanonical(purchase, maximumPayloadBytes),
          "validator_independent_replay_mismatch");
        requireProof("slot" in candidate
          ? "slot" in replay && replay.slot === candidate.slot && replay.genesisHash === candidate.genesisHash
          : "chainId" in replay && replay.blockNumber === candidate.blockNumber && replay.chainId === candidate.chainId
            && replay.genesisBlockHash === candidate.genesisBlockHash, "validator_independent_chain_mismatch");
        const checkedAt = check(), expiresAt = checkedAt + validationTtlMs; time(expiresAt);
        for (const [value, expiry] of nonces) if (expiry <= checkedAt) nonces.delete(value);
        const value = nonce();
        requireProof(typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value)
          && !nonces.has(value) && nonces.size < maximumNonces, "validator_nonce_refused");
        const validationRef = `${validatorId}:${keyId}:${value}`, evidenceRef = `${binding.replayProviderId}:${replay.sourceReference}`;
        identity(validationRef, 512); identity(evidenceRef, 512);
        const verifiedPurchase = { ...replay.purchaseCandidate, executionEvidenceRef: validationRef };
        const claims: PostgresExecutionValidationClaims = { format: 1, generationId, providerId: candidate.providerId, validatorId, keyId,
          candidateFingerprint: candidate.contentFingerprint, sourceReference: replay.sourceReference, validationRef, checkedAt, expiresAt,
          sourceBasis: { kind: "independent_rpc_replay", providerId: replay.providerId, evidenceRef, contentFingerprint: replay.contentFingerprint },
          purchase: verifiedPurchase, purchaseFingerprint: walletPurchaseBasisFingerprint(verifiedPurchase) };
        boundedCanonical(claims, maximumPayloadBytes); check();
        const signature = sign(null, executionValidationSigningPayload(claims), privateKey).toString("base64");
        requireProof(check() < expiresAt, "validator_validation_expired"); nonces.set(value, expiresAt);
        return { status: "verified", validation: { claims, signature } };
      }
      try {
        const operation = replayAndSign().catch(error => deferred(error instanceof ReplayRefused
          ? error.message : "validator_replay_unavailable")).finally(() => { busy = false; });
        return await Promise.race([operation, stopped]);
      } finally {
        controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  });
}
