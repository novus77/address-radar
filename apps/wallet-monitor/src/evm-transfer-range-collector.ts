import { classifyJsonRpcLimit, type DiscoveryChain } from "@address-radar/collectors";
import type { MonitoredWallet } from "@address-radar/identity";
import { performance } from "node:perf_hooks";
import type { WalletCollector, WalletCollectorEvent, WalletCollectorResult } from "./contracts.js";
import type { WalletRpcClient } from "./rpc.js";
import { walletRpcDiagnostic } from "./rpc-diagnostics.js";

type EvmChain = Exclude<DiscoveryChain, "solana">;
export interface EvmTransferRangeLog {
  readonly address: string; readonly topics: readonly string[]; readonly data: string;
  readonly logIndex: string; readonly blockNumber: string; readonly blockHash: string;
  readonly transactionHash: string; readonly removed?: boolean;
}
export interface EvmTransferRangeReceipt {
  readonly transactionHash: string; readonly blockNumber: string; readonly blockHash: string;
  readonly status: string;
  readonly logs: readonly { readonly address: string; readonly topics: readonly string[];
    readonly data: string; readonly logIndex: string }[];
}
export interface EvmTransferRangeTransaction {
  readonly hash: string; readonly blockNumber: string; readonly blockHash: string;
  readonly from: string; readonly to: string | null; readonly value: string;
}
/** Adapt the existing receipt decoder here; this collector never implements swap/price rules. */
export type EvmTransferRangeReceiptDecoder = (input: {
  readonly chain: EvmChain; readonly wallet: MonitoredWallet;
  readonly transaction: EvmTransferRangeTransaction; readonly receipt: EvmTransferRangeReceipt;
  readonly occurredAt: number; readonly rpc: WalletRpcClient; readonly signal: AbortSignal;
}) => Promise<{ readonly events: readonly WalletCollectorEvent[]; readonly hadCandidateTransfer: boolean }>;
export interface EvmTransferRangeCollectorOptions {
  readonly chain: EvmChain; readonly rpc: WalletRpcClient;
  readonly decodeReceipt: EvmTransferRangeReceiptDecoder;
  readonly maximumLogs: number; readonly maximumRequests: number;
  readonly maximumPayloadBytes: number; readonly maximumRunMs: number;
  readonly rangeSize?: number; readonly maximumWalletsPerQuery?: number;
  readonly confirmationDepth?: number; readonly reorgLookback?: number;
  readonly maximumAdaptiveAttempts?: number;
  readonly minimumBackoffMs?: number; readonly maximumBackoffMs?: number;
  readonly now?: () => number;
  readonly bootstrap?: { readonly generation: string; readonly fromBlock: number };
}
export interface EvmTransferRangeBootstrapAnchor {
  readonly format: "evm-transfer-bootstrap-v1";
  readonly generation: string;
  readonly collector: string;
  readonly fromBlock: number;
  readonly boundaryNumber: number;
  readonly boundaryHash: string;
  readonly scope: "erc20_transfer_only";
}
interface Header { readonly number: number; readonly hash: string; readonly timestamp: number }
interface Checkpoint { readonly blockNumber: number; readonly blockHash: string }
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
function positive(value: number, maximum = 2_147_483_647): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("Explicit bounded EVM range budget required");
}
function natural(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid EVM range clock/depth");
}
function hex(value: number): string { return `0x${value.toString(16)}`; }
function quantity(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Failure("evm_range_invalid_quantity");
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Failure("evm_range_invalid_quantity");
  return parsed;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Failure("evm_range_invalid_response");
  return value as Record<string, unknown>;
}
class Failure extends Error {
  constructor(readonly reason: string, readonly adaptive = false) { super(reason); }
}
function rpcLimit(error: unknown, method?: string): "range_limit" | "rate_limit" | "ambiguous_limit" | null {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : undefined;
  const httpStatus = typeof record.status === "number" ? record.status
    : typeof record.statusCode === "number" ? record.statusCode : undefined;
  const classified = classifyJsonRpcLimit({ ...(method === undefined ? {} : { method }), code: record.code, message,
    ...(httpStatus === undefined ? {} : { httpStatus }) });
  // The RPC client removes provider text; retain its precise typed range classification.
  if (classified !== "rate_limit" && method === "eth_getLogs" && record.code === -32005
    && record.reasonCode === "rpc_range_limit") return "range_limit";
  if (classified !== null) return classified;
  return record.name === "WalletRpcRateLimitError" || record.name === "JsonRpcRateLimitError"
    || /provider cooldown|Durable provider budget unavailable/i.test(message ?? "") ? "rate_limit" : null;
}
function sameLog(left: { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly logIndex?: string },
  right: { readonly address: string; readonly topics: readonly string[]; readonly data: string; readonly logIndex?: string }): boolean {
  return left.address.toLowerCase() === right.address.toLowerCase() && left.data.toLowerCase() === right.data.toLowerCase()
    && left.logIndex !== undefined && right.logIndex !== undefined && quantity(left.logIndex) === quantity(right.logIndex)
    && JSON.stringify(left.topics.map(value => value.toLowerCase())) === JSON.stringify(right.topics.map(value => value.toLowerCase()));
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Failure("evm_range_aborted_or_timed_out"));
    if (signal.aborted) { promise.catch(() => {}); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => {
      signal.removeEventListener("abort", aborted); reject(error);
    });
  });
}

/** A bounded Transfer discovery cursor, never exhaustive trade/non-hit coverage. */
export function createEvmTransferRangeWalletCollector(input: EvmTransferRangeCollectorOptions): WalletCollector {
  const options = { ...input };
  const bootstrapGeneration = input.bootstrap?.generation;
  const bootstrapFromBlock = input.bootstrap?.fromBlock;
  if (input.bootstrap !== undefined && (typeof bootstrapGeneration !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bootstrapGeneration)
    || !Number.isSafeInteger(bootstrapFromBlock) || Number(bootstrapFromBlock) < 0)) {
    throw new Error("Explicit sealed bootstrap generation and floor required");
  }
  const rangeSize = options.rangeSize ?? 512, walletChunk = options.maximumWalletsPerQuery ?? 64;
  const depth = options.confirmationDepth ?? 2, lookback = options.reorgLookback ?? 12;
  const attempts = options.maximumAdaptiveAttempts ?? 3;
  const minimumBackoff = options.minimumBackoffMs ?? 1_000, maximumBackoff = options.maximumBackoffMs ?? 30_000;
  [options.maximumLogs, options.maximumRequests, options.maximumPayloadBytes, options.maximumRunMs,
    minimumBackoff, maximumBackoff].forEach(value => positive(value));
  positive(rangeSize, 512); positive(walletChunk, 256); positive(attempts, 8); natural(depth); natural(lookback);
  if (lookback > 512 || maximumBackoff < minimumBackoff || typeof options.decodeReceipt !== "function"
    || typeof options.rpc?.request !== "function" || !["eth", "bsc", "base"].includes(options.chain)) {
    throw new Error("Explicit EVM range decoder/provider configuration required");
  }
  const now = options.now ?? Date.now;
  let adaptiveRange = rangeSize, retryAt = 0, failedRounds = 0, busy = false, outstanding = 0;
  // Bootstrap intent is not a completed checkpoint. Retain it even after returning an uncommitted batch.
  let pendingStart: number | null = null;
  return Object.freeze({
    name: `evm:${options.chain}`, chainFamily: "evm" as const,
    async collect(request: Parameters<WalletCollector["collect"]>[0]): Promise<WalletCollectorResult> {
      const partitionKey = `chain:${options.chain}`;
      const failure = (reason: string): WalletCollectorResult => ({ partitions: [], failures: [{ partitionKey, error: reason }] });
      if (request.signal.aborted) return failure("evm_range_aborted_or_timed_out");
      if (busy || outstanding > 0) return failure("evm_range_busy");
      const startedAt = now(); natural(startedAt);
      const startedMonotonic = performance.now();
      if (startedAt < retryAt) return { partitions: [], diagnostics: [{ partitionKey, reason: "evm_range_backoff",
        sourceReference: `${options.chain}:retry:${retryAt}`, rpc: { rpcOrigin: "local_cooldown" } }] };
      busy = true;
      const controller = new AbortController(), signal = AbortSignal.any([request.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), options.maximumRunMs);
      let requests = 0, bytes = 0, previous = startedAt;
      const check = () => {
        signal.throwIfAborted(); const at = now(); natural(at);
        if (at < previous) throw new Failure("evm_range_clock_regressed");
        if (at - startedAt >= options.maximumRunMs || performance.now() - startedMonotonic >= options.maximumRunMs) {
          throw new Failure("evm_range_deadline_exceeded");
        }
        previous = at; return at;
      };
      let swallowedRpcFailure: unknown = null;
      let failedRpcMethod: string | undefined;
      const remote = async (method: string, params: readonly unknown[]): Promise<unknown> => {
        check();
        if (++requests > options.maximumRequests) throw new Failure("evm_range_request_budget_exceeded");
        outstanding++;
        const work = Promise.resolve().then(() => { check(); return options.rpc.request(options.chain, method, params, signal); })
          .finally(() => { outstanding--; });
        try {
          const value = await abortable(work, signal); check();
          bytes += Buffer.byteLength(JSON.stringify(value) ?? "null");
          if (bytes > options.maximumPayloadBytes) throw new Failure("evm_range_payload_budget_exceeded", true);
          return value;
        } catch (error) { swallowedRpcFailure = error; failedRpcMethod = method; throw error; }
      };
      try {
        const wallets = new Map<string, MonitoredWallet>();
        if (Buffer.byteLength(JSON.stringify(request.wallets)) > options.maximumPayloadBytes) throw new Failure("evm_range_wallet_budget_exceeded");
        for (const wallet of request.wallets) {
          if (!address(wallet.address)) throw new Failure("evm_range_invalid_wallet");
          const key = wallet.address.toLowerCase(), existing = wallets.get(key);
          if (existing && (existing.entityId !== wallet.entityId || existing.accountId !== wallet.accountId)) throw new Failure("evm_range_wallet_owner_conflict");
          wallets.set(key, structuredClone(wallet));
        }
        if (!wallets.size) return { partitions: [], diagnostics: [{ partitionKey, reason: "no_monitored_wallets", sourceReference: options.chain }] };
        const topicWallets = [...wallets.keys()].map(value => `0x${value.slice(2).padStart(64, "0")}`);
        const queryCount = Math.ceil(topicWallets.length / walletChunk) * 2;
        if (queryCount + 5 > options.maximumRequests) throw new Failure("evm_range_wallet_query_budget_exceeded");
        const saved = request.checkpoint(partitionKey);
        let checkpoint: Checkpoint | null = null;
        if (saved !== null) {
          const value = object(JSON.parse(saved));
          if (!Number.isSafeInteger(value.blockNumber) || Number(value.blockNumber) < 0 || !hash(value.blockHash)) throw new Failure("evm_range_invalid_checkpoint");
          checkpoint = { blockNumber: Number(value.blockNumber), blockHash: value.blockHash.toLowerCase() };
        }
        const head = quantity(await remote("eth_blockNumber", []));
        if (head < depth) return { partitions: [] };
        const safeHead = head - depth;
        if (checkpoint && checkpoint.blockNumber > safeHead) throw new Failure("evm_range_head_behind_checkpoint");
        const headers = new Map<number, Header>();
        const header = async (number: number, fresh = false): Promise<Header> => {
          if (!fresh && headers.has(number)) return headers.get(number)!;
          const raw = await remote("eth_getBlockByNumber", [hex(number), false]);
          if (raw === null) throw new Failure(`canonical_block_unavailable:${number}`);
          const value = object(raw);
          if (!hash(value.hash) || quantity(value.number) !== number) throw new Failure("evm_range_invalid_header");
          const timestamp = quantity(value.timestamp) * 1_000; natural(timestamp);
          const result = { number, hash: value.hash.toLowerCase(), timestamp };
          if (!fresh) headers.set(number, result);
          return result;
        };
        let rewound = false;
        if (checkpoint) rewound = (await header(checkpoint.blockNumber)).hash !== checkpoint.blockHash;
        let anchoredStart: number | null = null;
        if (!checkpoint && bootstrapGeneration !== undefined) {
          const bootstrapKey = `bootstrap:${partitionKey}`;
          const savedBootstrap = request.checkpoint(bootstrapKey);
          if (savedBootstrap === null) {
            const fromBlock = bootstrapFromBlock!;
            if (fromBlock > safeHead) throw new Failure("evm_range_head_behind_bootstrap_anchor");
            const boundaryNumber = Math.max(0, fromBlock - 1);
            const boundary = await header(boundaryNumber);
            const anchor: EvmTransferRangeBootstrapAnchor = {
              format: "evm-transfer-bootstrap-v1", generation: bootstrapGeneration,
              collector: `evm:${options.chain}`, fromBlock, boundaryNumber, boundaryHash: boundary.hash,
              scope: "erc20_transfer_only",
            };
            check();
            return { partitions: [{ partitionKey: bootstrapKey, events: [], canonicalBlocks: [],
              nextCheckpoint: JSON.stringify(anchor) }] };
          }
          const anchor = object(JSON.parse(savedBootstrap));
          if (Object.keys(anchor).sort().join(",") !== "boundaryHash,boundaryNumber,collector,format,fromBlock,generation,scope"
            || anchor.format !== "evm-transfer-bootstrap-v1" || anchor.generation !== bootstrapGeneration
            || anchor.collector !== `evm:${options.chain}` || anchor.scope !== "erc20_transfer_only"
            || !Number.isSafeInteger(anchor.fromBlock) || Number(anchor.fromBlock) < 0
            || anchor.fromBlock !== bootstrapFromBlock
            || anchor.boundaryNumber !== Math.max(0, Number(anchor.fromBlock) - 1) || !hash(anchor.boundaryHash)) {
            throw new Failure("evm_range_invalid_bootstrap_anchor");
          }
          anchoredStart = Number(anchor.fromBlock);
          if (anchoredStart > safeHead) throw new Failure("evm_range_head_behind_bootstrap_anchor");
          if ((await header(Number(anchor.boundaryNumber))).hash !== anchor.boundaryHash.toLowerCase()) {
            throw new Failure("evm_range_bootstrap_canonical_mismatch");
          }
        }
        if (!checkpoint && bootstrapGeneration === undefined && pendingStart === null) pendingStart = Math.max(0, safeHead - rangeSize + 1);
        const start = checkpoint ? rewound ? Math.max(0, checkpoint.blockNumber - lookback) : checkpoint.blockNumber + 1
          : anchoredStart ?? pendingStart!;
        if (start > safeHead) return { partitions: [] };
        const left = start > 0 ? await header(start - 1) : null;
        for (let attempt = 0; attempt < attempts; attempt++) {
          check(); swallowedRpcFailure = null; failedRpcMethod = undefined;
          const end = Math.min(safeHead, start + adaptiveRange - 1);
          try {
            const right = await header(end);
            const logs = new Map<string, EvmTransferRangeLog>();
            const transactionLogs = new Map<string, EvmTransferRangeLog[]>();
            const transactionWallets = new Map<string, Set<string>>();
            for (let index = 0; index < topicWallets.length; index += walletChunk) {
              const chunk = topicWallets.slice(index, index + walletChunk), allowed = new Set(chunk);
              for (const direction of [1, 2] as const) {
                const topics = direction === 1 ? [TRANSFER, chunk, null] : [TRANSFER, null, chunk];
                const response = await remote("eth_getLogs", [{ fromBlock: hex(start), toBlock: hex(end), topics }]);
                if (!Array.isArray(response)) throw new Failure("evm_range_invalid_logs");
                if (response.length >= options.maximumLogs) throw new Failure("evm_range_logs_saturated", true);
                for (const item of response) {
                  const value = object(item), record = value as unknown as EvmTransferRangeLog;
                  if (!address(value.address) || !Array.isArray(value.topics) || value.topics.length !== 3
                    || !value.topics.every(hash) || value.topics[0]!.toLowerCase() !== TRANSFER
                    || !hash(value.blockHash) || !hash(value.transactionHash) || !hash(value.data)
                    || (value.removed !== undefined && value.removed !== false)) throw new Failure("evm_range_invalid_transfer_log");
                  const block = quantity(value.blockNumber); quantity(value.logIndex);
                  if (block < start || block > end || !allowed.has(value.topics[direction]!.toLowerCase())) throw new Failure("evm_range_filter_mismatch");
                  const identity = `${record.blockHash.toLowerCase()}:${record.transactionHash.toLowerCase()}:${quantity(record.logIndex)}`;
                  const duplicate = logs.get(identity);
                  if (duplicate && !sameLog(duplicate, record)) throw new Failure("evm_range_conflicting_logs");
                  const txHash = record.transactionHash.toLowerCase();
                  const participants = transactionWallets.get(txHash) ?? new Set<string>();
                  for (const topic of record.topics.slice(1)) {
                    const wallet = `0x${topic.slice(-40)}`.toLowerCase(); if (wallets.has(wallet)) participants.add(wallet);
                  }
                  transactionWallets.set(txHash, participants);
                  if (!duplicate) {
                    logs.set(identity, structuredClone(record));
                    const current = transactionLogs.get(txHash) ?? []; current.push(structuredClone(record)); transactionLogs.set(txHash, current);
                    if (logs.size > options.maximumLogs) throw new Failure("evm_range_logs_budget_exceeded", true);
                  }
                }
              }
            }
            const events: WalletCollectorEvent[] = [], diagnostics: NonNullable<WalletCollectorResult["diagnostics"]>[number][] = [];
            const decimals = new Map<string, Promise<unknown>>();
            const ordered = [...transactionLogs].sort(([, a], [, b]) => quantity(a[0]!.blockNumber) - quantity(b[0]!.blockNumber)
              || quantity(a[0]!.logIndex) - quantity(b[0]!.logIndex));
            for (const [txHash, discovered] of ordered) {
              const blockNumber = quantity(discovered[0]!.blockNumber), canonical = await header(blockNumber);
              if (discovered.some(log => quantity(log.blockNumber) !== blockNumber || log.blockHash.toLowerCase() !== canonical.hash)) {
                throw new Failure("evm_range_canonical_mismatch");
              }
              const rawReceipt = await remote("eth_getTransactionReceipt", [txHash]);
              if (rawReceipt === null) throw new Failure(`receipt_unavailable:${txHash}`);
              const receipt = object(rawReceipt) as unknown as EvmTransferRangeReceipt;
              if (!hash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== txHash || !hash(receipt.blockHash)
                || receipt.blockHash.toLowerCase() !== canonical.hash || quantity(receipt.blockNumber) !== blockNumber
                || !["0x0", "0x1"].includes(receipt.status) || !Array.isArray(receipt.logs)) throw new Failure("evm_range_receipt_mismatch");
              const receiptLogIndexes = new Set<number>();
              let previousLogIndex: number | null = null;
              for (const log of receipt.logs) {
                if (!address(log.address) || !Array.isArray(log.topics) || !log.topics.every(hash)
                  || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) throw new Failure("evm_range_malformed_receipt");
                if (typeof log.logIndex !== "string" || !/^0x[0-9a-f]+$/i.test(log.logIndex)) {
                  throw new Failure("evm_range_receipt_log_index_missing_or_invalid");
                }
                const logIndex = quantity(log.logIndex);
                if (receiptLogIndexes.has(logIndex)) throw new Failure("evm_range_receipt_log_index_duplicate");
                // logIndex is block-global: a receipt may start above zero, but its complete log sequence is contiguous.
                if (previousLogIndex !== null && logIndex !== previousLogIndex + 1) {
                  throw new Failure("evm_range_receipt_log_index_order_or_gap");
                }
                receiptLogIndexes.add(logIndex); previousLogIndex = logIndex;
              }
              if (discovered.some(log => !receipt.logs.some(item => sameLog(log, item)))) throw new Failure("evm_range_receipt_logs_mismatch");
              const rawTransaction = await remote("eth_getTransactionByHash", [txHash]);
              if (rawTransaction === null) throw new Failure(`transaction_unavailable:${txHash}`);
              const transaction = object(rawTransaction) as unknown as EvmTransferRangeTransaction;
              if (!hash(transaction.hash) || transaction.hash.toLowerCase() !== txHash || !hash(transaction.blockHash)
                || transaction.blockHash.toLowerCase() !== canonical.hash || quantity(transaction.blockNumber) !== blockNumber
                || !address(transaction.from) || (transaction.to !== null && !address(transaction.to))
                || !/^0x[0-9a-f]+$/i.test(transaction.value)) throw new Failure("evm_range_transaction_mismatch");
              const decoderRpc: WalletRpcClient = { async request(chain, method, params) {
                if (chain !== options.chain || method !== "eth_call" || params[1] !== hex(blockNumber)) throw new Failure("evm_range_decoder_rpc_rejected");
                const key = JSON.stringify(params); let work = decimals.get(key);
                if (!work) { work = remote(method, params); decimals.set(key, work); }
                return work;
              } };
              for (const walletAddress of transactionWallets.get(txHash)!) {
                check();
                const work = Promise.resolve().then(() => options.decodeReceipt({ chain: options.chain, wallet: wallets.get(walletAddress)!,
                  transaction: structuredClone(transaction), receipt: structuredClone(receipt), occurredAt: canonical.timestamp, rpc: decoderRpc, signal }));
                outstanding++; const tracked = work.finally(() => { outstanding--; });
                const decoded = await abortable(tracked, signal); check();
                if (swallowedRpcFailure) throw swallowedRpcFailure;
                if (!decoded || !Array.isArray(decoded.events)) throw new Failure("evm_range_decoder_contract_invalid");
                events.push(...decoded.events);
                if (events.length > options.maximumLogs) throw new Failure("evm_range_event_budget_exceeded", true);
                if (decoded.hadCandidateTransfer && !decoded.events.length) diagnostics.push({ partitionKey,
                  reason: "insufficient_swap_evidence", sourceReference: `${options.chain}:${txHash}` });
              }
            }
            if ((await header(end, true)).hash !== right.hash || (left && (await header(left.number, true)).hash !== left.hash)) {
              throw new Failure("evm_range_canonical_mismatch");
            }
            check();
            diagnostics.push({ partitionKey, reason: "erc20_transfer_observations_only", sourceReference: `${options.chain}:range:${start}-${end}` });
            const canonicalBlocks = [...headers.values()].filter(item => item.number >= start - 1 && item.number <= end)
              .sort((a, b) => a.number - b.number).map(item => ({ blockNumber: item.number, blockHash: item.hash }));
            const result: WalletCollectorResult = { partitions: [{ partitionKey, events, canonicalBlocks,
              nextCheckpoint: JSON.stringify({ blockNumber: end, blockHash: right.hash }) }], diagnostics };
            if (Buffer.byteLength(JSON.stringify(result)) > options.maximumPayloadBytes) throw new Failure("evm_range_output_budget_exceeded", true);
            failedRounds = 0; retryAt = 0;
            // Grow only after an actually completed range; every retry still shares the same request/time budget.
            adaptiveRange = Math.min(rangeSize, adaptiveRange * 2);
            return result;
          } catch (error) {
            const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
            const limit = rpcLimit(error, failedRpcMethod);
            const limited = limit === "rate_limit" || limit === "ambiguous_limit";
            const oversized = !limited && (error instanceof Failure ? error.adaptive : limit === "range_limit"
              || (failedRpcMethod === "eth_getLogs" && (record.status === 413 || record.statusCode === 413)));
            if (!signal.aborted && oversized && adaptiveRange > 1) {
              adaptiveRange = Math.max(1, Math.floor(adaptiveRange / 2));
              if (attempt + 1 < attempts) continue;
            }
            throw error;
          }
        }
        throw new Failure("evm_range_adaptive_attempts_exhausted");
      } catch (error) {
        // Exhausted polls must stop immediately. Only the next poll receives a smaller range and a fresh request allocation.
        if (error instanceof Failure && error.reason === "evm_range_request_budget_exceeded") {
          adaptiveRange = Math.max(1, Math.floor(adaptiveRange / 2));
        }
        failedRounds++;
        const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const limit = rpcLimit(error, failedRpcMethod);
        const limited = limit === "rate_limit" || limit === "ambiguous_limit";
        const at = now();
        const backoff = Math.min(maximumBackoff, minimumBackoff * 2 ** Math.min(failedRounds - 1, 20));
        retryAt = Math.max(startedAt, Number.isSafeInteger(at) ? at : startedAt) + backoff;
        if (limited && typeof record.retryAt === "number" && Number.isSafeInteger(record.retryAt) && record.retryAt >= 0) retryAt = Math.max(retryAt, record.retryAt);
        const result = failure(signal.aborted ? "evm_range_aborted_or_timed_out" : limited ? "evm_range_provider_backoff"
          : error instanceof Failure ? error.reason : "evm_range_rpc_or_decoder_unavailable");
        const rpc = walletRpcDiagnostic(error, failedRpcMethod);
        return rpc === undefined ? result : { ...result, diagnostics: [{ partitionKey,
          reason: "evm_range_rpc_diagnostic", sourceReference: options.chain, rpc }] };
      } finally { clearTimeout(timer); controller.abort(); busy = false; }
    },
  });
}
