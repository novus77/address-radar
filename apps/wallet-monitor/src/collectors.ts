import type { DiscoveryChain, TokenMarketProvider } from "@address-radar/collectors";
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
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOLANA_QUOTES = new Set([SOLANA_USDC, SOLANA_USDT]);
const KNOWN_SOLANA_SWAP_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzG3bC4iY6n",
  "675kPX9MHTjS2zt1qfr1NYHuzeTHKq9gXQDA8T3o1ut",
]);

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
  readonly now?: () => number;
}): WalletCollector {
  const confirmationDepth = input.confirmationDepth ?? 2;
  const maxBlocksPerPoll = input.maxBlocksPerPoll ?? 20;
  const now = input.now ?? Date.now;

  return {
    name: `evm:${input.chain}`,
    chainFamily: "evm",
    async collect(request): Promise<WalletCollectorResult> {
      const partitionKey = `chain:${input.chain}`;
      const head = hexNumber(await input.rpc.request(input.chain, "eth_blockNumber", [], request.signal));
      const safeHead = Math.max(0, head - confirmationDepth);
      const previous = parseBlockCheckpoint(request.checkpoint(partitionKey));
      if (previous !== null && previous >= safeHead) {
        return {
          partitions: [{
            partitionKey,
            nextCheckpoint: JSON.stringify({ blockNumber: previous, checkedAt: now() }),
            events: [],
          }],
        };
      }
      const from = previous === null ? safeHead : Math.min(previous + 1, safeHead);
      const to = Math.min(safeHead, from + maxBlocksPerPoll - 1);
      const walletByAddress = new Map(request.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
      const events: WalletCollectorEvent[] = [];
      const diagnostics: Array<NonNullable<WalletCollectorResult["diagnostics"]>[number]> = [];

      for (let blockNumber = from; blockNumber <= to; blockNumber += 1) {
        if (request.signal.aborted) break;
        const block = await input.rpc.request(input.chain, "eth_getBlockByNumber", [
          `0x${blockNumber.toString(16)}`,
          true,
        ], request.signal) as EvmBlock | null;
        for (const transaction of block?.transactions ?? []) {
          const wallet = walletByAddress.get(transaction.from.toLowerCase())
            ?? (transaction.to ? walletByAddress.get(transaction.to.toLowerCase()) : undefined);
          if (!wallet) continue;
          const receipt = await input.rpc.request(input.chain, "eth_getTransactionReceipt", [
            transaction.hash,
          ], request.signal) as EvmReceipt | null;
          const extracted = await evmSwapEvents({
            chain: input.chain,
            wallet,
            transaction,
            receipt,
            market: input.market,
            occurredAt: hexNumber(block?.timestamp ?? "0x0") * 1_000 || now(),
          });
          events.push(...extracted.events);
          if (extracted.events.length === 0 && extracted.hadCandidateTransfer) {
            diagnostics.push({
              partitionKey,
              reason: "insufficient_swap_evidence",
              sourceReference: `${input.chain}:${transaction.hash}`,
            });
          }
        }
      }

      return {
        partitions: [{
          partitionKey,
          nextCheckpoint: JSON.stringify({ blockNumber: to, checkedAt: now() }),
          events,
        }],
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
  const batchSize = input.batchSize ?? 25;
  const now = input.now ?? Date.now;

  return {
    name: "solana",
    chainFamily: "solana",
    async collect(request): Promise<WalletCollectorResult> {
      const ordered = [...request.wallets].sort((left, right) => left.address.localeCompare(right.address));
      const schedule = parseScheduleCheckpoint(request.checkpoint("schedule"));
      const selected = selectRotating(ordered, schedule.nextIndex, batchSize);
      const nextIndex = ordered.length === 0 ? 0 : (schedule.nextIndex + selected.length) % ordered.length;
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
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ], input.signal) as SolanaTransaction | null;
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
  readonly transaction: SolanaTransaction | null;
  readonly market: TokenMarketProvider | undefined;
  readonly occurredAt: number;
}) {
  const deltas = solanaTokenDeltas(input.transaction, input.wallet.address);
  const nativeDelta = solanaNativeDelta(input.transaction, input.wallet.address);
  const candidateDeltas = deltas.filter((delta) => !SOLANA_QUOTES.has(delta.mint));
  const quoteDeltas = deltas.filter((delta) => SOLANA_QUOTES.has(delta.mint));
  const programEvidence = solanaProgramIds(input.transaction).some((program) => KNOWN_SOLANA_SWAP_PROGRAMS.has(program));
  const hasOpposingQuote = (candidate: SolanaDelta) =>
    quoteDeltas.some((quote) => Math.sign(quote.amount) === -Math.sign(candidate.amount))
    || (nativeDelta !== 0 && Math.sign(nativeDelta) === -Math.sign(candidate.amount));
  const hasTwoLegProgramSwap = programEvidence
    && [...deltas.map((delta) => delta.amount), nativeDelta].some((amount) => amount > 0)
    && [...deltas.map((delta) => delta.amount), nativeDelta].some((amount) => amount < 0);
  const events: WalletCollectorEvent[] = [];

  for (const delta of candidateDeltas) {
    if (!hasOpposingQuote(delta) && !hasTwoLegProgramSwap) continue;
    const snapshot = input.market ? await input.market.lookup("solana", delta.mint) : null;
    const stableQuote = quoteDeltas.find((quote) => Math.sign(quote.amount) === -Math.sign(delta.amount));
    const amountUsd = stableQuote ? Math.abs(stableQuote.amount)
      : snapshot?.priceUsd === null || snapshot?.priceUsd === undefined
        ? null
        : Math.abs(delta.amount) * snapshot.priceUsd;
    events.push({
      eventId: `solana:${input.signature}:${delta.accountIndex}`,
      chain: "solana",
      walletAddress: input.wallet.address,
      tokenAddress: delta.mint,
      side: delta.amount > 0 ? "buy" : "sell",
      amountUsd,
      priceUsd: snapshot?.priceUsd ?? null,
      marketCapUsd: snapshot?.marketCapUsd ?? null,
      occurredAt: input.occurredAt,
      sourceReference: `solana:${input.signature}`,
    });
  }
  return { events, hadCandidateDelta: candidateDeltas.length > 0 };
}

async function evmSwapEvents(input: {
  readonly chain: EvmChain;
  readonly wallet: MonitoredWallet;
  readonly transaction: EvmTransaction;
  readonly receipt: EvmReceipt | null;
  readonly market: TokenMarketProvider | undefined;
  readonly occurredAt: number;
}) {
  const wallet = input.wallet.address.toLowerCase();
  const transfers = (input.receipt?.logs ?? []).flatMap((log, index) => {
    if (!log.topics[0]?.toLowerCase().startsWith(TRANSFER_TOPIC) || log.topics.length < 3) return [];
    const from = topicAddress(log.topics[1]!);
    const to = topicAddress(log.topics[2]!);
    if (from !== wallet && to !== wallet) return [];
    return [{ token: log.address.toLowerCase(), amount: BigInt(log.data), incoming: to === wallet, index }];
  });
  const quotes = EVM_QUOTES[input.chain] ?? new Set<string>();
  const candidates = transfers.filter((transfer) => !quotes.has(transfer.token));
  const quoteTransfers = transfers.filter((transfer) => quotes.has(transfer.token));
  const nativeOut = input.transaction.from.toLowerCase() === wallet && hexBigInt(input.transaction.value) > 0n;
  const swapLog = (input.receipt?.logs ?? []).some((log) =>
    SWAP_TOPIC_PREFIXES.some((prefix) => log.topics[0]?.toLowerCase().startsWith(prefix)));
  const events: WalletCollectorEvent[] = [];

  for (const candidate of candidates) {
    const oppositeQuote = quoteTransfers.some((quote) => quote.incoming !== candidate.incoming);
    if (!oppositeQuote && !(nativeOut && candidate.incoming) && !swapLog) continue;
    const snapshot = input.market ? await input.market.lookup(input.chain, candidate.token) : null;
    events.push({
      eventId: `${input.chain}:${input.transaction.hash}:${candidate.index}`,
      chain: input.chain,
      walletAddress: input.wallet.address,
      tokenAddress: candidate.token,
      side: candidate.incoming ? "buy" : "sell",
      amountUsd: null,
      priceUsd: snapshot?.priceUsd ?? null,
      marketCapUsd: snapshot?.marketCapUsd ?? null,
      occurredAt: input.occurredAt,
      sourceReference: `${input.chain}:${input.transaction.hash}`,
    });
  }
  return { events, hadCandidateTransfer: candidates.length > 0 };
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

function parseBlockCheckpoint(value: string | null): number | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { block?: unknown; blockNumber?: unknown };
    const block = parsed.blockNumber ?? parsed.block;
    return typeof block === "number" ? block : null;
  } catch {
    return null;
  }
}

function solanaTokenDeltas(transaction: SolanaTransaction | null, wallet: string): SolanaDelta[] {
  const previous = new Map<number, { mint: string; amount: number }>();
  for (const balance of transaction?.meta?.preTokenBalances ?? []) {
    if (balance.owner === wallet) previous.set(balance.accountIndex, {
      mint: balance.mint,
      amount: tokenAmount(balance),
    });
  }
  const result: SolanaDelta[] = [];
  for (const balance of transaction?.meta?.postTokenBalances ?? []) {
    if (balance.owner !== wallet) continue;
    const before = previous.get(balance.accountIndex);
    const amount = tokenAmount(balance) - (before?.amount ?? 0);
    if (amount !== 0) result.push({ accountIndex: balance.accountIndex, mint: balance.mint, amount });
    previous.delete(balance.accountIndex);
  }
  for (const [accountIndex, before] of previous) {
    if (before.amount !== 0) result.push({ accountIndex, mint: before.mint, amount: -before.amount });
  }
  return result;
}

function solanaNativeDelta(transaction: SolanaTransaction | null, wallet: string): number {
  const keys = transaction?.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((key) => (typeof key === "string" ? key : key.pubkey) === wallet);
  if (index < 0) return 0;
  return ((transaction?.meta?.postBalances?.[index] ?? 0) - (transaction?.meta?.preBalances?.[index] ?? 0)) / 1_000_000_000;
}

function solanaProgramIds(transaction: SolanaTransaction | null): string[] {
  const keys = transaction?.transaction?.message?.accountKeys ?? [];
  const direct = keys.flatMap((key) => typeof key === "string" ? [] : key.signer ? [] : [key.pubkey]);
  const instructions = transaction?.transaction?.message?.instructions ?? [];
  return [...direct, ...instructions.flatMap((instruction) => instruction.programId ? [instruction.programId] : [])];
}

function tokenAmount(balance: SolanaTokenBalance): number {
  return balance.uiTokenAmount.uiAmount
    ?? Number(balance.uiTokenAmount.amount ?? 0) / 10 ** (balance.uiTokenAmount.decimals ?? 0);
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
interface SolanaTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly uiAmount?: number | null; readonly amount?: string; readonly decimals?: number };
}
interface SolanaTransaction {
  readonly blockTime?: number | null;
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly (string | { readonly pubkey: string; readonly signer?: boolean })[];
      readonly instructions?: readonly { readonly programId?: string }[];
    };
  };
  readonly meta?: {
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly preTokenBalances?: readonly SolanaTokenBalance[];
    readonly postTokenBalances?: readonly SolanaTokenBalance[];
  } | null;
}
interface SolanaDelta {
  readonly accountIndex: number;
  readonly mint: string;
  readonly amount: number;
}
interface EvmBlock {
  readonly timestamp?: string;
  readonly transactions?: readonly EvmTransaction[];
}
interface EvmTransaction {
  readonly hash: string;
  readonly from: string;
  readonly to?: string | null;
  readonly value?: string;
}
interface EvmReceipt {
  readonly logs?: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
}
