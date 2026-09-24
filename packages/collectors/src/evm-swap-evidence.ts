export interface EvmSwapLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex?: string;
}

export interface EvmSwapTransaction {
  readonly hash: string;
  readonly from: string;
  readonly to?: string | null;
  readonly value?: string;
}

export interface EvmWalletTransfer {
  readonly token: string;
  readonly amount: bigint;
  readonly incoming: boolean;
  readonly counterparty: string;
  readonly index: number;
  readonly log: EvmSwapLog;
}

const TRANSFER_TOPIC = "0xddf252ad";
const SWAP_TOPIC_PREFIXES = ["0xd78ad95f", "0xc42079f9"];

export function extractEvmSwapEvidence(input: {
  readonly wallet: string;
  readonly transaction: EvmSwapTransaction;
  readonly logs: readonly EvmSwapLog[];
  readonly quoteTokens: ReadonlySet<string>;
}): {
  readonly candidates: readonly EvmWalletTransfer[];
  readonly supportsSwap: (candidate: EvmWalletTransfer) => boolean;
} {
  const wallet = input.wallet.toLowerCase();
  const transfers = input.logs.flatMap((log, index) => {
    if (!log.topics[0]?.toLowerCase().startsWith(TRANSFER_TOPIC) || log.topics.length < 3) return [];
    const from = topicAddress(log.topics[1]!);
    const to = topicAddress(log.topics[2]!);
    if (from !== wallet && to !== wallet) return [];
    const incoming = to === wallet;
    return [{
      token: log.address.toLowerCase(),
      amount: BigInt(log.data),
      incoming,
      counterparty: incoming ? from : to,
      index,
      log,
    }];
  });
  const candidates = transfers.filter((transfer) => !input.quoteTokens.has(transfer.token));
  const quotes = transfers.filter((transfer) => input.quoteTokens.has(transfer.token));
  const swapEmitters = new Set(input.logs.flatMap((log) =>
    SWAP_TOPIC_PREFIXES.some((prefix) => log.topics[0]?.toLowerCase().startsWith(prefix))
      ? [log.address.toLowerCase()]
      : []));
  const transactionTarget = input.transaction.to?.toLowerCase() ?? null;
  const nativeOut = input.transaction.from.toLowerCase() === wallet && hexBigInt(input.transaction.value) > 0n;

  return Object.freeze({
    candidates: Object.freeze(candidates),
    supportsSwap(candidate) {
      const linkedQuote = quotes.some((quote) => {
        if (quote.incoming === candidate.incoming) return false;
        const sharedCounterparty = quote.counterparty === candidate.counterparty;
        const routerLinked = transactionTarget !== null
          && quote.counterparty === transactionTarget
          && candidate.counterparty === transactionTarget;
        return (sharedCounterparty && swapEmitters.has(candidate.counterparty))
          || (routerLinked && swapEmitters.size > 0);
      });
      if (linkedQuote) return true;
      const nativeSwapLinked = swapEmitters.has(candidate.counterparty)
        || (transactionTarget !== null && swapEmitters.has(transactionTarget));
      return candidate.incoming && nativeOut && nativeSwapLinked;
    },
  });
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}
function hexBigInt(value: unknown): bigint {
  if (typeof value !== "string" || value === "0x") return 0n;
  try { return BigInt(value); } catch { return 0n; }
}
