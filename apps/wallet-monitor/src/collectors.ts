import { deriveExecutionBasis } from "./execution-basis.js";
import {
  extractEvmSwapEvidence,
  extractSolanaSwapEvidence,
  type DiscoveryChain,
  type EvmSwapLog,
  type EvmSwapTransaction,
  type SolanaSwapTransaction,
  type TokenMarketProvider,
} from "@address-radar/collectors";
import type { MonitoredWallet } from "@address-radar/identity";

import type {
  WalletCollector,
  WalletCollectorEvent,
  WalletCollectorPartition,
  WalletCollectorResult,
} from "./contracts.js";
import type { WalletRpcClient } from "./rpc.js";

type EvmChain = Exclude<DiscoveryChain, "solana">;

const TRANSFER_TOPIC = "0xddf252ad";
const SWAP_TOPIC_PREFIXES = ["0xd78ad95f", "0xc42079f9"];

const EVM_QUOTES: Readonly<Partial<Record<EvmChain, ReadonlySet<string>>>> = {
  eth: new Set([
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  ]),
  base: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x4200000000000000000000000000000000000006",
  ]),
  bsc: new Set([
    "0x55d398326f99059ff775485246999027b3197955",
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  ]),
};

interface SolanaCheckpoint {
  readonly latestSignature: string | null;
  readonly checkedAt: number;
  readonly backlog?: {
    readonly newestSignature: string;
    readonly before: string;
  };
}

export function createEvmBlockWalletCollector(input: {
  readonly chain: EvmChain;
  readonly rpc: WalletRpcClient;
  readonly market?: TokenMarketProvider;
  readonly confirmationDepth?: number;
  readonly maxBlocksPerPoll?: number;
  readonly reorgLookback?: number;
  readonly now?: () => number;
}): WalletCollector {
  const confirmationDepth = input.confirmationDepth ?? 2;
  const maxBlocksPerPoll = input.maxBlocksPerPoll ?? 20;
  const reorgLookback = input.reorgLookback ?? Math.max(confirmationDepth, 12);
  const now = input.now ?? Date.now;

  return {
    name: `evm:${input.chain}`,
    chainFamily: "evm",
    async collect(request): Promise<WalletCollectorResult> {
      const partitionKey = `chain:${input.chain}`;
      const head = hexNumber(await input.rpc.request(input.chain, "eth_blockNumber", [], request.signal));
      const safeHead = Math.max(0, head - confirmationDepth);
      const previous = parseBlockCheckpoint(request.checkpoint(partitionKey));
      let reorg = false;
      if (previous?.blockHash) {
        const canonical = await input.rpc.request(input.chain, "eth_getBlockByNumber", [
          `0x${previous.blockNumber.toString(16)}`, false,
        ], request.signal) as EvmBlock | null;
        if (!canonical) {
          return { partitions: [], failures: [{ partitionKey, error: `canonical_block_unavailable:${previous.blockNumber}` }] };
        }
        reorg = canonical.hash !== previous.blockHash;
      }
      if (!reorg && previous && previous.blockNumber >= safeHead) {
        return { partitions: [{
          partitionKey,
          nextCheckpoint: JSON.stringify({ blockNumber: previous.blockNumber, blockHash: previous.blockHash }),
          events: [],
          canonicalBlocks: previous.blockHash ? [{ blockNumber: previous.blockNumber, blockHash: previous.blockHash }] : [],
        }] };
      }

      const from = reorg && previous
        ? Math.max(0, previous.blockNumber - reorgLookback)
        : previous ? previous.blockNumber + 1 : safeHead;
      const to = Math.min(safeHead, from + maxBlocksPerPoll - 1);
      const walletByAddress = new Map(request.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
      const events: WalletCollectorEvent[] = [];
      const diagnostics: Array<NonNullable<WalletCollectorResult["diagnostics"]>[number]> = [];
      const failures: Array<NonNullable<WalletCollectorResult["failures"]>[number]> = [];
      const canonicalBlocks: Array<{ blockNumber: number; blockHash: string }> = [];
      let lastCompleted = reorg ? null : previous;

      for (let blockNumber = from; blockNumber <= to; blockNumber += 1) {
        if (request.signal.aborted) {
          failures.push({ partitionKey, error: "aborted" });
          break;
        }
        let block: EvmBlock | null;
        try {
          block = await input.rpc.request(input.chain, "eth_getBlockByNumber", [
            `0x${blockNumber.toString(16)}`, true,
          ], request.signal) as EvmBlock | null;
        } catch (error) {
          failures.push({ partitionKey, error: request.signal.aborted ? "aborted" : `block_failed:${blockNumber}:${error instanceof Error ? error.message : String(error)}` });
          break;
        }
        if (!block?.hash) {
          failures.push({ partitionKey, error: `block_unavailable:${blockNumber}` });
          break;
        }
        const blockEvents: WalletCollectorEvent[] = [];
        const blockDiagnostics: Array<NonNullable<WalletCollectorResult["diagnostics"]>[number]> = [];
        let complete = true;
        for (const transaction of block.transactions ?? []) {
          const wallet = walletByAddress.get(transaction.from.toLowerCase())
            ?? (transaction.to ? walletByAddress.get(transaction.to.toLowerCase()) : undefined);
          if (!wallet) continue;
          let receipt: EvmReceipt | null;
          try {
            receipt = await input.rpc.request(input.chain, "eth_getTransactionReceipt", [
              transaction.hash,
            ], request.signal) as EvmReceipt | null;
          } catch (error) {
            failures.push({ partitionKey, error: request.signal.aborted ? "aborted" : `receipt_failed:${transaction.hash}:${error instanceof Error ? error.message : String(error)}` });
            complete = false;
            break;
          }
          if (!receipt || (receipt.blockHash && receipt.blockHash !== block.hash)) {
            failures.push({ partitionKey, error: `receipt_unavailable:${transaction.hash}` });
            complete = false;
            break;
          }
          const extracted = await evmSwapEvents({
            rpc: input.rpc, signal: request.signal,
            chain: input.chain,
            wallet,
            transaction,
            receipt,
            market: input.market,
            occurredAt: hexNumber(block.timestamp ?? "0x0") * 1_000 || now(),
            blockNumber,
            blockHash: block.hash,
          });
          blockEvents.push(...extracted.events);
          if (extracted.events.length === 0 && extracted.hadCandidateTransfer) {
            blockDiagnostics.push({
              partitionKey,
              reason: "insufficient_swap_evidence",
              sourceReference: `${input.chain}:${transaction.hash}`,
            });
          }
        }
        if (!complete) break;
        events.push(...blockEvents);
        diagnostics.push(...blockDiagnostics);
        canonicalBlocks.push({ blockNumber, blockHash: block.hash });
        lastCompleted = { blockNumber, blockHash: block.hash };
      }

      return {
        partitions: lastCompleted ? [{
          partitionKey,
          nextCheckpoint: JSON.stringify(lastCompleted),
          events,
          canonicalBlocks,
        }] : [],
        failures,
        diagnostics,
      };
    },
  };
}

export function createSolanaWalletCollector(input: {
  readonly rpc: WalletRpcClient;
  readonly market?: TokenMarketProvider;
  readonly signatureLimit?: number;
  readonly batchSize?: number;
  readonly now?: () => number;
}): WalletCollector {
  const signatureLimit = input.signatureLimit ?? 100;
  const batchSize = input.batchSize ?? 3;
  const now = input.now ?? Date.now;

  return {
    name: "solana",
    chainFamily: "solana",
    async collect(request): Promise<WalletCollectorResult> {
      const ordered = [...request.wallets].sort((left, right) => left.address.localeCompare(right.address));
      const schedule = parseScheduleCheckpoint(request.checkpoint("schedule"));
      const selected = selectRotating(ordered, schedule.nextIndex, batchSize);
      let nextIndex = ordered.length === 0 ? 0 : (schedule.nextIndex + selected.length) % ordered.length;
      const settled = await Promise.allSettled(selected.map((wallet) => collectSolanaWallet({
        wallet,
        rpc: input.rpc,
        market: input.market,
        signatureLimit,
        checkpoint: request.checkpoint(`wallet:${wallet.address}`),
        signal: request.signal,
        now,
      })));
      const partitions: WalletCollectorPartition[] = [{
        partitionKey: "schedule",
        nextCheckpoint: JSON.stringify({ nextIndex }),
        events: [],
      }];
      const failures: Array<NonNullable<WalletCollectorResult["failures"]>[number]> = [];
      const diagnostics: Array<NonNullable<WalletCollectorResult["diagnostics"]>[number]> = [];
      const firstRateLimitedIndex = settled.findIndex((result) =>
        result.status === "rejected"
        && result.reason instanceof Error
        && result.reason.name === "WalletRpcRateLimitError");
      if (firstRateLimitedIndex >= 0 && ordered.length > 0) {
        nextIndex = (schedule.nextIndex + firstRateLimitedIndex) % ordered.length;
        partitions[0] = {
          partitionKey: "schedule",
          nextCheckpoint: JSON.stringify({ nextIndex }),
          events: [],
        };
      }
      settled.forEach((result, index) => {
        const wallet = selected[index]!;
        if (result.status === "fulfilled") {
          partitions.push(result.value.partition);
          diagnostics.push(...result.value.diagnostics);
        } else {
          failures.push({
            partitionKey: `wallet:${wallet.address}`,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
      return { partitions, failures, diagnostics };
    },
  };
}

async function collectSolanaWallet(input: {
  readonly wallet: MonitoredWallet;
  readonly rpc: WalletRpcClient;
  readonly market: TokenMarketProvider | undefined;
  readonly signatureLimit: number;
  readonly checkpoint: string | null;
  readonly signal: AbortSignal;
  readonly now: () => number;
}) {
  const partitionKey = `wallet:${input.wallet.address}`;
  const checkpoint = parseSolanaCheckpoint(input.checkpoint);
  const options: Record<string, unknown> = { limit: input.signatureLimit };
  if (checkpoint.latestSignature) options.until = checkpoint.latestSignature;
  if (checkpoint.backlog) options.before = checkpoint.backlog.before;
  const signatures = await input.rpc.request("solana", "getSignaturesForAddress", [
    input.wallet.address,
    options,
  ], input.signal) as readonly SolanaSignature[];
  const newestSignature = checkpoint.backlog?.newestSignature ?? signatures[0]?.signature ?? checkpoint.latestSignature;
  const events: WalletCollectorEvent[] = [];
  const diagnostics: Array<NonNullable<WalletCollectorResult["diagnostics"]>[number]> = [];

  for (const signature of [...signatures].reverse()) {
    const transaction = await input.rpc.request("solana", "getTransaction", [
      signature.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
    ], input.signal) as (SolanaSwapTransaction & { readonly blockTime?: number | null }) | null;
    if (!transaction) throw new Error(`transaction_unavailable:${signature.signature}`);
    const extracted = await solanaSwapEvents({
      wallet: input.wallet,
      signature: signature.signature,
      transaction,
      market: input.market,
      occurredAt: (transaction?.blockTime ?? signature.blockTime ?? 0) * 1_000 || input.now(),
    });
    events.push(...extracted.events);
    if (extracted.hadCandidateDelta && extracted.events.length === 0) {
      diagnostics.push({
        partitionKey,
        reason: "insufficient_swap_evidence",
        sourceReference: `solana:${signature.signature}`,
      });
    }
  }

  const hasMore = signatures.length === input.signatureLimit;
  const last = signatures.at(-1);
  const nextCheckpoint: SolanaCheckpoint = hasMore && last && newestSignature
    ? {
        latestSignature: checkpoint.latestSignature,
        checkedAt: checkpoint.checkedAt,
        backlog: { newestSignature, before: last.signature },
      }
    : {
        latestSignature: newestSignature,
        checkedAt: Math.max(checkpoint.checkedAt, ...signatures.map((item) => (item.blockTime ?? 0) * 1_000), input.now()),
      };

  return {
    partition: { partitionKey, nextCheckpoint: JSON.stringify(nextCheckpoint), events },
    diagnostics,
  };
}

async function solanaSwapEvents(input: {
  readonly wallet: MonitoredWallet;
  readonly signature: string;
  readonly transaction: SolanaSwapTransaction | null;
  readonly market: TokenMarketProvider | undefined;
  readonly occurredAt: number;
}) {
  const events: WalletCollectorEvent[] = [];
  if (!input.transaction?.meta || input.transaction.meta.err != null) {
    return { events, hadCandidateDelta: false };
  }
  const evidence = extractSolanaSwapEvidence(input.transaction, input.wallet.address);
  const basis = deriveExecutionBasis({
    successful: input.transaction.meta.err === null,
    swapConfirmed: evidence.knownSwapProgram,
    tokenDeltas: evidence.candidateDeltas.map((delta) => ({ asset: delta.mint, quantity: delta.amount })),
    quoteDeltas: [...evidence.stableQuoteDeltas.map((delta) => ({
      asset: delta.mint, quantity: delta.amount, verifiedStablecoin: true,
      symbol: delta.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? "USDC" : "USDT",
    })),
      ...(evidence.nativeDelta !== 0 || evidence.wrappedNativeDeltas.length > 0
        ? [{ asset: "solana-native", symbol: "SOL", quantity: evidence.nativeDelta, verifiedStablecoin: false }]
        : []),
    ],
  });
  const tokens = new Map<string, { mint: string; accountIndex: number; amount: number }>();
  for (const delta of evidence.candidateDeltas) {
    const current = tokens.get(delta.mint);
    tokens.set(delta.mint, {
      mint: delta.mint, accountIndex: Math.min(current?.accountIndex ?? delta.accountIndex, delta.accountIndex),
      amount: (current?.amount ?? 0) + delta.amount,
    });
  }
  for (const delta of tokens.values()) {
    if (!evidence.supportsSwap(delta)) continue;
    events.push({
      eventId: `solana:${input.signature}:${delta.accountIndex}`,
      chain: "solana", walletAddress: input.wallet.address, tokenAddress: delta.mint,
      side: delta.amount > 0 ? "buy" : "sell",
      amountUsd: basis.amountUsd, priceUsd: basis.priceUsd, marketCapUsd: null,
      occurredAt: input.occurredAt, sourceReference: `solana:${input.signature}`,
      executionBasis: basis,
    });
  }
  return { events, hadCandidateDelta: evidence.candidateDeltas.length > 0 };
}

async function evmSwapEvents(input: {
  readonly chain: EvmChain;
  readonly rpc: WalletRpcClient;
  readonly signal: AbortSignal;
  readonly wallet: MonitoredWallet;
  readonly transaction: EvmSwapTransaction;
  readonly receipt: EvmReceipt;
  readonly market: TokenMarketProvider | undefined;
  readonly occurredAt: number;
  readonly blockNumber: number;
  readonly blockHash: string;
}) {
  if (input.receipt.status === "0x0") return { events: [], hadCandidateTransfer: false };
  const quotes = EVM_QUOTES[input.chain] ?? new Set<string>();
  const evidence = extractEvmSwapEvidence({
    wallet: input.wallet.address,
    transaction: input.transaction,
    logs: input.receipt.logs ?? [],
    quoteTokens: quotes,
  });
  const stableAssets: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    eth: { "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC", "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT" },
    base: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC" },
    bsc: { "0x55d398326f99059ff775485246999027b3197955": "USDT" },
  };
  const decimals = new Map<string, number | null>();
  const quantity = async (asset: string, amount: bigint): Promise<number> => {
    if (input.receipt.status !== "0x1") return NaN;
    if (!decimals.has(asset)) {
      try {
        const response = await input.rpc.request(input.chain, "eth_call", [
          { to: asset, data: "0x313ce567" }, `0x${input.blockNumber.toString(16)}`,
        ], input.signal, "history");
        const value = typeof response === "string" && /^0x[0-9a-f]+$/i.test(response) ? Number(BigInt(response)) : NaN;
        decimals.set(asset, Number.isSafeInteger(value) && value >= 0 && value <= 36 ? value : null);
      } catch (error) {
        if (input.signal.aborted) throw error;
        decimals.set(asset, null);
      }
    }
    const precision = decimals.get(asset);
    return precision === null || precision === undefined ? NaN : Number(amount) / 10 ** precision;
  };
  const tokenDeltas = await Promise.all(evidence.candidates.map(async (candidate) => ({
    asset: candidate.token,
    quantity: await quantity(candidate.token, candidate.amount) * (candidate.incoming ? 1 : -1),
  })));
  const quoteDeltas = await Promise.all(evidence.quoteTransfers.map(async (quote) => ({
    asset: quote.token, symbol: stableAssets[input.chain]?.[quote.token] ?? "unsupported",
    verifiedStablecoin: Boolean(stableAssets[input.chain]?.[quote.token]),
    quantity: await quantity(quote.token, quote.amount) * (quote.incoming ? 1 : -1),
  })));
  if (hexBigInt(input.transaction.value) !== 0n) quoteDeltas.push({
    asset: "native", symbol: "unsupported", verifiedStablecoin: false, quantity: NaN,
  });
  const basis = deriveExecutionBasis({ successful: input.receipt.status === "0x1", swapConfirmed: evidence.candidates.some(candidate => evidence.supportsSwap(candidate)), tokenDeltas, quoteDeltas });
  const events: WalletCollectorEvent[] = [];
  const candidates = new Map<string, typeof evidence.candidates[number]>();
  for (const candidate of evidence.candidates) {
    if (!evidence.supportsSwap(candidate)) continue;
    const net = tokenDeltas.filter(delta => delta.asset === candidate.token).reduce((sum, delta) => sum + delta.quantity, 0);
    if (Number.isFinite(net) && net === 0) continue;
    if (!candidates.has(candidate.token)) candidates.set(candidate.token, { ...candidate, incoming: Number.isFinite(net) ? net > 0 : candidate.incoming });
  }
  for (const candidate of candidates.values()) {
    if (!evidence.supportsSwap(candidate)) continue;
    events.push({
      eventId: `${input.chain}:${input.transaction.hash}:${candidate.index}`,
      chain: input.chain,
      walletAddress: input.wallet.address,
      tokenAddress: candidate.token,
      side: candidate.incoming ? "buy" : "sell",
      amountUsd: basis.amountUsd,
      priceUsd: basis.priceUsd,
      marketCapUsd: null,
      executionBasis: basis,
      occurredAt: input.occurredAt,
      sourceReference: `${input.chain}:${input.transaction.hash}`,
      sourceBlockNumber: input.blockNumber,
      sourceBlockHash: input.blockHash,
    });
  }
  return { events, hadCandidateTransfer: evidence.candidates.length > 0 };
}

function selectRotating<T>(values: readonly T[], start: number, limit: number): T[] {
  if (values.length === 0) return [];
  const count = Math.min(values.length, limit);
  return Array.from({ length: count }, (_, offset) => values[(start + offset) % values.length]!);
}

function parseScheduleCheckpoint(value: string | null): { nextIndex: number } {
  if (!value) return { nextIndex: 0 };
  try {
    const parsed = JSON.parse(value) as { nextIndex?: unknown };
    return { nextIndex: typeof parsed.nextIndex === "number" && parsed.nextIndex >= 0 ? parsed.nextIndex : 0 };
  } catch {
    return { nextIndex: 0 };
  }
}

function parseSolanaCheckpoint(value: string | null): SolanaCheckpoint {
  if (!value) return { latestSignature: null, checkedAt: 0 };
  try {
    const parsed = JSON.parse(value) as {
      latestSignature?: unknown;
      signature?: unknown;
      checkedAt?: unknown;
      backlog?: unknown;
    };
    const backlog = parsed.backlog && typeof parsed.backlog === "object"
      ? parsed.backlog as { newestSignature?: unknown; before?: unknown }
      : null;
    return {
      latestSignature: typeof parsed.latestSignature === "string"
        ? parsed.latestSignature
        : typeof parsed.signature === "string" ? parsed.signature : null,
      checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : 0,
      ...(backlog && typeof backlog.newestSignature === "string" && typeof backlog.before === "string"
        ? { backlog: { newestSignature: backlog.newestSignature, before: backlog.before } }
        : {}),
    };
  } catch {
    return { latestSignature: null, checkedAt: 0 };
  }
}

function parseBlockCheckpoint(value: string | null): { blockNumber: number; blockHash: string | null } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { block?: unknown; blockNumber?: unknown; blockHash?: unknown };
    const blockNumber = parsed.blockNumber ?? parsed.block;
    return typeof blockNumber === "number"
      ? { blockNumber, blockHash: typeof parsed.blockHash === "string" ? parsed.blockHash : null }
      : null;
  } catch {
    return null;
  }
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function hexNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 16);
  return 0;
}

function hexBigInt(value: unknown): bigint {
  if (typeof value !== "string" || value === "0x") return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

interface SolanaSignature {
  readonly signature: string;
  readonly blockTime?: number | null;
}
interface EvmBlock {
  readonly hash?: string;
  readonly timestamp?: string;
  readonly transactions?: readonly EvmSwapTransaction[];
}
interface EvmReceipt {
  readonly status?: string;
  readonly blockHash?: string;
  readonly logs?: readonly EvmSwapLog[];
}
