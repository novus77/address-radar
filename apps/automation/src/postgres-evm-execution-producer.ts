import { createHash } from "node:crypto";
import { extractEvmSwapEvidence, type EvmSwapLog, type EvmSwapTransaction } from "../../../packages/collectors/src/evm-swap-evidence.js";
import type { FetchLike } from "../../../packages/collectors/src/types.js";
import { createConfiguredWalletRpcClient } from "../../wallet-monitor/src/rpc.js";
import { deriveExecutionBasis } from "../../wallet-monitor/src/execution-basis.js";
import { preparePostgresWalletCapture, selectPostgresWalletProfiles,
  type CapturedPostgresWalletEvent, type PostgresWalletChannelOptions, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresSolanaExecutionCandidate } from "./postgres-wallet-rpc-producer.js";

export interface PostgresEvmExecutionCandidate extends Omit<PostgresSolanaExecutionCandidate, "genesisHash" | "slot" | "evidence"> {
  readonly chainId: string; readonly genesisBlockHash: string; readonly blockNumber: number;
  readonly evidence: { readonly transaction: unknown; readonly receipt: unknown; readonly canonicalBlock: unknown;
    readonly finalizedBlock: unknown; readonly tokenDecimals: readonly { readonly tokenAddress: string; readonly decimals: number; readonly response: string }[] };
}
export type PostgresEvmExecutionAcquisition =
  | { readonly status: "acquired"; readonly candidate: PostgresEvmExecutionCandidate }
  | { readonly status: "deferred"; readonly reasonCode: string };
export interface PostgresEvmExecutionProducerOptions {
  readonly generationId: string; readonly activatedAt: number; readonly chain: "eth" | "bsc" | "base";
  readonly expectedChainId: string; readonly expectedGenesisBlockHash: string; readonly providerId: string;
  readonly endpoint: string;
  /** Required durable PG-budgeted transport for every RPC, including metadata and canonical rechecks. */
  readonly fetch: FetchLike; readonly profiles: PostgresWalletChannelOptions["profiles"];
  readonly stableQuoteTokens: readonly { readonly address: string; readonly symbol: "USDT" | "USDC" }[];
  readonly maximumProfiles: number; readonly maximumLogs: number; readonly maximumDecimalsReads: number;
  readonly maximumRpcRequests: number; readonly maximumPayloadBytes: number; readonly maximumRunMs: number; readonly now: () => number;
}
// These are the existing nominal-stablecoin contracts accepted by the wallet capture kernel, not inferred chain IDs or pegs.
const quotes: Readonly<Record<PostgresEvmExecutionProducerOptions["chain"], Readonly<Record<string, "USDT" | "USDC">>>> = {
  eth: { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC", "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT" },
  base: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC" },
  bsc: { "0x55d398326f99059ff775485246999027b3197955": "USDT", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC" },
};
class MissingProof extends Error {}
function requireProof(value: unknown, reason: string): asserts value { if (!value) throw new MissingProof(reason); }
function object(value: unknown): Record<string, unknown> {
  requireProof(value && typeof value === "object" && !Array.isArray(value), "rpc_payload_missing"); return value as Record<string, unknown>;
}
function address(value: unknown): string {
  requireProof(typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value), "execution_address_invalid"); return value.toLowerCase();
}
function blockHash(value: unknown): string {
  requireProof(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value), "execution_hash_invalid"); return value.toLowerCase();
}
function quantity(value: unknown): bigint {
  requireProof(typeof value === "string" && /^0x[0-9a-f]{1,64}$/i.test(value), "execution_quantity_missing"); return BigInt(value);
}
function safe(value: unknown): number {
  const parsed = quantity(value); requireProof(parsed <= BigInt(Number.MAX_SAFE_INTEGER), "execution_integer_unsafe"); return Number(parsed);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function decimal(units: bigint, decimals: number): string {
  const raw = (units < 0n ? -units : units).toString().padStart(decimals + 1, "0");
  const fraction = decimals === 0 ? "" : raw.slice(-decimals).replace(/0+$/, "");
  const whole = decimals === 0 ? raw : raw.slice(0, -decimals);
  return `${units < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
function numberDecimal(value: number): string {
  const [coefficient, exponent = "0"] = value.toString().toLowerCase().split("e"), [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`, point = whole!.length + Number(exponent);
  return (point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
    : `${digits.slice(0, point)}.${digits.slice(point)}`).replace(/\.0+$/, "");
}
function sameOwner(left: PostgresWalletProfile, right: PostgresWalletProfile): boolean {
  return address(left.wallet.address) === address(right.wallet.address) && left.wallet.accountId === right.wallet.accountId
    && left.wallet.entityId === right.wallet.entityId && left.fact.identityEvidenceRef === right.fact.identityEvidenceRef
    && left.fact.ownershipEvidenceRef === right.fact.ownershipEvidenceRef;
}

export function createPostgresEvmExecutionProducer(options: PostgresEvmExecutionProducerOptions) {
  for (const value of [options.generationId, options.providerId]) {
    if (!value.trim() || value.length > 512 || value.includes("://")) throw new Error("Explicit EVM source identity required");
  }
  if (!["eth", "bsc", "base"].includes(options.chain) || typeof options.fetch !== "function") throw new Error("Explicit supported EVM chain and PG-budgeted fetch required");
  const expectedChainId = quantity(options.expectedChainId); requireProof(expectedChainId > 0n, "explicit_chain_id_required");
  const genesisHash = blockHash(options.expectedGenesisBlockHash), endpoint = new URL(options.endpoint);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Approved RPC endpoint required");
  if (!Number.isSafeInteger(options.activatedAt) || options.activatedAt < 0) throw new Error("Explicit generation activation required");
  for (const [value, maximum] of [[options.maximumProfiles, 10_000], [options.maximumLogs, 10_000],
    [options.maximumDecimalsReads, 1000], [options.maximumRpcRequests, 10_000], [options.maximumPayloadBytes, 10_000_000],
    [options.maximumRunMs, 2_147_483_647]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new Error("Explicit bounded EVM acquisition budget required");
  }
  const stable = new Map<string, "USDT" | "USDC">();
  for (const token of options.stableQuoteTokens) {
    const key = address(token.address);
    if (quotes[options.chain][key] !== token.symbol || stable.has(key)) throw new Error("Reviewed chain-specific stable quote contract required");
    stable.set(key, token.symbol);
  }
  if (!stable.size) throw new Error("Explicit stable quote mapping required");
  const rpc = createConfiguredWalletRpcClient({ endpoints: { [options.chain]: { primary: options.endpoint } }, fetch: options.fetch });
  let busy = false;
  async function collect(payload: CapturedPostgresWalletEvent, signal: AbortSignal): Promise<PostgresEvmExecutionAcquisition> {
    const asOf = options.now();
    requireProof(Number.isSafeInteger(asOf) && asOf >= options.activatedAt, "generation_clock_unavailable");
    requireProof(payload.generationId === options.generationId && payload.chainFamily === "evm"
      && payload.event.chain === options.chain && payload.event.side === "buy", "capture_generation_or_chain_mismatch");
    const event = payload.event, wallet = address(event.walletAddress), tokenAddress = address(event.tokenAddress);
    requireProof(Number.isSafeInteger(event.occurredAt) && event.occurredAt >= options.activatedAt && event.occurredAt <= asOf, "outside_forward_generation");
    requireProof(event.sourceReference.startsWith(`${options.chain}:`), "execution_reference_missing");
    const hash = blockHash(event.sourceReference.slice(options.chain.length + 1));
    async function profileAt(at: number) {
      const cohort = await options.profiles.load({ generationId: options.generationId, chainFamily: "evm", asOf: at, limit: options.maximumProfiles, signal });
      requireProof(cohort.status === "ready" && cohort.profiles.length <= options.maximumProfiles, "profile_cohort_unavailable");
      const profile = selectPostgresWalletProfiles(cohort.profiles, "evm").find(item => address(item.wallet.address) === wallet);
      requireProof(profile && payload.profile && sameOwner(profile, payload.profile), "current_wallet_owner_unavailable"); return profile;
    }
    const profile = await profileAt(asOf);
    let requests = 0, bytes = 0;
    async function request(method: string, params: unknown[]) {
      signal.throwIfAborted(); requireProof(requests < options.maximumRpcRequests, "evm_request_budget_exceeded"); requests++;
      const result = await rpc.request(options.chain, method, params, signal); signal.throwIfAborted();
      bytes += Buffer.byteLength(JSON.stringify(result) ?? "null"); requireProof(bytes <= options.maximumPayloadBytes, "evm_payload_budget_exceeded"); return result;
    }
    requireProof(quantity(await request("eth_chainId", [])) === expectedChainId, "rpc_chain_id_mismatch");
    const genesis = object(await request("eth_getBlockByNumber", ["0x0", false]));
    requireProof(safe(genesis.number) === 0 && blockHash(genesis.hash) === genesisHash, "rpc_genesis_mismatch");
    const transaction = object(await request("eth_getTransactionByHash", [hash]));
    const receipt = object(await request("eth_getTransactionReceipt", [hash]));
    const number = safe(receipt.blockNumber), blockNumberHex = `0x${number.toString(16)}`, executionBlockHash = blockHash(receipt.blockHash);
    const index = safe(receipt.transactionIndex), nativeValue = quantity(transaction.value);
    requireProof(blockHash(transaction.hash) === hash && blockHash(receipt.transactionHash) === hash && quantity(receipt.status) === 1n
      && safe(transaction.blockNumber) === number && blockHash(transaction.blockHash) === executionBlockHash && safe(transaction.transactionIndex) === index
      && address(transaction.from) === address(receipt.from) && address(transaction.to) === address(receipt.to), "transaction_receipt_mismatch");
    const block = object(await request("eth_getBlockByNumber", [blockNumberHex, false]));
    requireProof(safe(block.number) === number && blockHash(block.hash) === executionBlockHash && Array.isArray(block.transactions)
      && blockHash(block.transactions[index]) === hash, "canonical_block_membership_missing");
    const occurredAt = safe(block.timestamp) * 1000;
    requireProof(Number.isSafeInteger(occurredAt) && occurredAt === event.occurredAt, "execution_time_mismatch");
    requireProof((event.sourceBlockNumber === undefined || event.sourceBlockNumber === number)
      && (event.sourceBlockHash === undefined || blockHash(event.sourceBlockHash) === executionBlockHash), "capture_block_mismatch");
    const finalized = object(await request("eth_getBlockByNumber", ["finalized", false]));
    const finalizedNumber = safe(finalized.number); blockHash(finalized.hash);
    requireProof(finalizedNumber >= number && (finalizedNumber !== number || blockHash(finalized.hash) === executionBlockHash), "execution_not_finalized");
    requireProof(Array.isArray(receipt.logs) && receipt.logs.length <= options.maximumLogs, "execution_logs_missing_or_over_budget");
    const positions = new Set<number>();
    const logs = receipt.logs.map(value => {
      const log = object(value), position = safe(log.logIndex);
      requireProof(!positions.has(position) && log.removed === false && blockHash(log.transactionHash) === hash
        && blockHash(log.blockHash) === executionBlockHash && safe(log.blockNumber) === number && safe(log.transactionIndex) === index
        && Array.isArray(log.topics) && log.topics.every(topic => typeof topic === "string" && /^0x[0-9a-f]{64}$/i.test(topic))
        && typeof log.data === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(log.data), "noncanonical_receipt_log");
      positions.add(position); return { address: address(log.address), topics: log.topics as string[], data: log.data,
        logIndex: `0x${position.toString(16)}` } satisfies EvmSwapLog;
    });
    const swap = extractEvmSwapEvidence({ wallet, transaction: transaction as unknown as EvmSwapTransaction,
      logs, quoteTokens: new Set(stable.keys()) });
    requireProof(swap.candidates.some(candidate => candidate.token === tokenAddress && swap.supportsSwap(candidate)), "actual_swap_linkage_missing");
    const atomic = new Map<string, bigint>();
    for (const transfer of [...swap.candidates, ...swap.quoteTransfers]) atomic.set(transfer.token,
      (atomic.get(transfer.token) ?? 0n) + (transfer.incoming ? transfer.amount : -transfer.amount));
    const nonzero = [...atomic].filter(([, units]) => units !== 0n).sort(([a], [b]) => a.localeCompare(b));
    requireProof(nonzero.length <= options.maximumDecimalsReads, "evm_decimals_budget_exceeded");
    const tokenDecimals: { tokenAddress: string; decimals: number; response: string }[] = [];
    const deltas: { asset: string; quantity: number; exact: string }[] = [];
    for (const [asset, units] of nonzero) {
      const response = await request("eth_call", [{ to: asset, data: "0x313ce567" }, { blockHash: executionBlockHash, requireCanonical: true }]);
      requireProof(typeof response === "string" && /^0x[0-9a-f]{64}$/i.test(response), "block_specific_decimals_missing");
      const decimals = safe(response); requireProof(decimals <= 255, "invalid_erc20_decimals");
      const exact = decimal(units, decimals), value = Number(exact);
      requireProof(Number.isFinite(value) && value !== 0 && numberDecimal(Math.abs(value)) === decimal(units < 0n ? -units : units, decimals),
        "execution_quantity_not_losslessly_representable");
      tokenDecimals.push({ tokenAddress: asset, decimals, response }); deltas.push({ asset, quantity: value, exact });
    }
    const basis = deriveExecutionBasis({ successful: true, swapConfirmed: true,
      tokenDeltas: deltas.filter(delta => !stable.has(delta.asset)),
      quoteDeltas: deltas.filter(delta => stable.has(delta.asset)).map(delta => ({ ...delta, symbol: stable.get(delta.asset)!, verifiedStablecoin: true })) });
    requireProof(nativeValue === 0n, "unsupported_native_quote_payment");
    requireProof(basis.status === "estimated" && basis.side === "buy" && basis.tokenAddress === tokenAddress
      && basis.amountBasis === "nominal_stablecoin", "actual_nominal_execution_basis_unavailable");
    requireProof((event.amountUsd === null || event.amountUsd === basis.amountUsd) && (event.priceUsd === null || event.priceUsd === basis.priceUsd),
      "capture_execution_quantities_mismatch");
    if (event.executionBasis?.status === "estimated") requireProof(canonical(event.executionBasis) === canonical(basis), "capture_execution_basis_mismatch");
    const finalBlock = object(await request("eth_getBlockByNumber", [blockNumberHex, false]));
    requireProof(blockHash(finalBlock.hash) === executionBlockHash && canonical(finalBlock) === canonical(block), "canonical_block_changed_during_acquisition");
    requireProof(quantity(await request("eth_chainId", [])) === expectedChainId, "rpc_chain_changed_during_acquisition");
    const knownAt = options.now(); requireProof(Number.isSafeInteger(knownAt) && knownAt >= asOf, "producer_clock_regressed");
    const current = await profileAt(knownAt); requireProof(sameOwner(current, profile) && current.versionId === profile.versionId, "profile_changed_during_acquisition");
    const purchase = preparePostgresWalletCapture({ generationId: options.generationId, collectorId: payload.collectorId, sessionId: options.providerId,
      chainFamily: "evm", receivedAt: knownAt, profile: current, executionTrust: "rpc_execution",
      event: { ...event, amountUsd: basis.amountUsd, priceUsd: basis.priceUsd, executionBasis: basis } }).payload.purchase;
    requireProof(purchase, "nominal_execution_purchase_unavailable");
    if (payload.purchase) requireProof(canonical(payload.purchase) === canonical(purchase), "capture_purchase_mismatch");
    const chainId = `0x${expectedChainId.toString(16)}`;
    const evidence = { transaction, receipt, canonicalBlock: block, finalizedBlock: finalized, tokenDecimals };
    // The moving finalized tip is a witness, not a new execution revision or a fresh historical event.
    const contentFingerprint = createHash("sha256").update(canonical({ generationId: options.generationId, providerId: options.providerId,
      chainId, genesisBlockHash: genesisHash, sourceReference: event.sourceReference, profile: current, purchase,
      transaction, receipt, canonicalBlock: block, tokenDecimals })).digest("hex");
    return { status: "acquired", candidate: { generationId: options.generationId, providerId: options.providerId, chainId,
      genesisBlockHash: genesisHash, blockNumber: number, blockHash: executionBlockHash, sourceReference: event.sourceReference,
      profile: current, observedAt: event.occurredAt, knownAt, contentFingerprint, purchaseCandidate: purchase, evidence } };
  }
  return Object.freeze({ async acquire(input: { readonly payload: CapturedPostgresWalletEvent; readonly signal: AbortSignal }): Promise<PostgresEvmExecutionAcquisition> {
    if (busy) return { status: "deferred", reasonCode: "evm_producer_busy" };
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
    const timer = setTimeout(abort, options.maximumRunMs); let onAbort: () => void = () => {};
    const stopped = new Promise<PostgresEvmExecutionAcquisition>(resolve => { onAbort = () => resolve({ status: "deferred", reasonCode: "evm_aborted_or_timed_out" });
      controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
    try { return await Promise.race([collect(input.payload, controller.signal).catch(error => ({ status: "deferred" as const,
      reasonCode: error instanceof MissingProof ? error.message : "evm_execution_acquisition_unavailable" })), stopped]); }
    finally { controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort); busy = false; }
  } });
}

/** The root registers only explicitly approved per-chain factories; missing/unknown chains never fall back. */
export function createPostgresEvmExecutionDispatcher(options: {
  readonly generationId: string;
  readonly producers: Readonly<Partial<Record<PostgresEvmExecutionProducerOptions["chain"], Pick<ReturnType<typeof createPostgresEvmExecutionProducer>, "acquire">>>>;
}) {
  if (!options.generationId.trim() || !Object.keys(options.producers).length
    || Object.keys(options.producers).some(chain => !["eth", "bsc", "base"].includes(chain))) {
    throw new Error("Explicit bounded EVM producer registry required");
  }
  const producers = { ...options.producers };
  return Object.freeze({ async acquire(input: { readonly payload: CapturedPostgresWalletEvent; readonly signal: AbortSignal }): Promise<PostgresEvmExecutionAcquisition> {
    if (input.payload.generationId !== options.generationId || input.payload.chainFamily !== "evm") {
      return { status: "deferred", reasonCode: "capture_generation_or_chain_mismatch" };
    }
    const chain = input.payload.event.chain;
    const producer = ["eth", "bsc", "base"].includes(chain) ? producers[chain as PostgresEvmExecutionProducerOptions["chain"]] : undefined;
    return producer ? producer.acquire(input) : { status: "deferred", reasonCode: "evm_chain_not_explicitly_configured" };
  } });
}
