import type { DiscoveryChain, TokenMarketProvider } from "@address-radar/collectors";
import type { MonitoredWallet } from "@address-radar/identity";
import type { WalletCollector, WalletCollectorEvent } from "./contracts.js";
import type { WalletRpcClient } from "./rpc.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
type EvmChain = Exclude<DiscoveryChain, "solana">;

export function createEvmBlockWalletCollector(input: { readonly chain: EvmChain; readonly rpc: WalletRpcClient; readonly market?: TokenMarketProvider; readonly confirmationDepth?: number; readonly maxBlocksPerPoll?: number; readonly now?: () => number }): WalletCollector {
  const source = `evm:${input.chain}`;
  const partitionKey = `chain:${input.chain}`;
  const confirmationDepth = input.confirmationDepth ?? 2;
  const maxBlocks = input.maxBlocksPerPoll ?? 25;
  const now = input.now ?? Date.now;
  const collector: WalletCollector = {
    name: source,
    chainFamily: "evm" as const,
    async collect({ wallets, checkpoint, signal }) {
      const head = parseHex(await input.rpc.request(input.chain, "eth_blockNumber", [], signal));
      const confirmedHead = Math.max(0, head - confirmationDepth);
      const previous = parseEvmCheckpoint(checkpoint(partitionKey));
      const first = previous === null ? confirmedHead : previous + 1;
      const last = Math.min(confirmedHead, first + maxBlocks - 1);
      const tracked = new Map(wallets.map(wallet => [wallet.address.toLowerCase(), wallet]));
      const events: WalletCollectorEvent[] = [];
      for (let blockNumber = first; blockNumber <= last; blockNumber += 1) {
        const block = await input.rpc.request(input.chain, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, true], signal) as { readonly timestamp: string; readonly transactions: readonly { readonly hash: string; readonly from: string }[] } | null;
        if (!block) throw new Error(`Block ${blockNumber} is unavailable`);
        for (const transaction of block.transactions) {
          const walletAddress = transaction.from.toLowerCase();
          if (!tracked.has(walletAddress)) continue;
          const receipt = await input.rpc.request(input.chain, "eth_getTransactionReceipt", [transaction.hash], signal) as { readonly transactionHash: string; readonly logs: readonly { readonly address: string; readonly logIndex: string; readonly data: string; readonly topics: readonly string[] }[] } | null;
          if (!receipt) throw new Error(`Receipt ${transaction.hash} is unavailable`);
          for (const log of receipt.logs) {
            if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3 || BigInt(log.data) <= 0n) continue;
            const from = topicAddress(log.topics[1]!);
            const to = topicAddress(log.topics[2]!);
            const side = to === walletAddress ? "buy" as const : from === walletAddress ? "sell" as const : null;
            if (!side) continue;
            const valued = await valueEvm(input.chain, log.address.toLowerCase(), log.data, input.rpc, input.market, signal);
            events.push(Object.freeze({ eventId: `${input.chain}:${receipt.transactionHash}:${log.logIndex}`, chain: input.chain, walletAddress, tokenAddress: log.address.toLowerCase(), side, ...valued, occurredAt: parseHex(block.timestamp) * 1_000, sourceReference: `${input.chain}:block:${blockNumber}:tx:${receipt.transactionHash}:log:${log.logIndex}` }));
          }
        }
      }
      const blockNumber = first <= last ? last : previous ?? confirmedHead;
      return Object.freeze({ partitions: Object.freeze([{ partitionKey, nextCheckpoint: JSON.stringify({ blockNumber, checkedAt: now() }), events: Object.freeze(events) }]) });
    },
  };
  return Object.freeze(collector);
}

export function createSolanaWalletCollector(input: { readonly rpc: WalletRpcClient; readonly market?: TokenMarketProvider; readonly signatureLimit?: number; readonly batchSize?: number; readonly now?: () => number }): WalletCollector {
  const now = input.now ?? Date.now;
  const signatureLimit = input.signatureLimit ?? 25;
  const batchSize = input.batchSize ?? 20;
  const collector: WalletCollector = {
    name: "solana",
    chainFamily: "solana" as const,
    async collect({ wallets, checkpoint, signal }) {
      const results = await Promise.allSettled(wallets.slice(0, batchSize).map(async wallet => collectSolanaWallet(wallet, checkpoint, input.rpc, input.market, signatureLimit, now, signal)));
      return Object.freeze({
        partitions: Object.freeze(results.flatMap(result => result.status === "fulfilled" ? [result.value] : [])),
        failures: Object.freeze(results.flatMap((result, index) => result.status === "rejected" ? [{ partitionKey: `wallet:${wallets[index]!.address}`, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : [])),
      });
    },
  };
  return Object.freeze(collector);
}

async function collectSolanaWallet(wallet: MonitoredWallet, checkpoint: (partitionKey: string) => string | null, rpc: WalletRpcClient, market: TokenMarketProvider | undefined, limit: number, now: () => number, signal: AbortSignal) {
  const partitionKey = `wallet:${wallet.address}`;
  const previous = parseSolanaCheckpoint(checkpoint(partitionKey));
  const options = { commitment: "confirmed", limit, ...(previous.signature ? { until: previous.signature } : {}) };
  const signatures = await rpc.request("solana", "getSignaturesForAddress", [wallet.address, options], signal) as readonly { readonly signature: string; readonly blockTime: number | null }[];
  const events: WalletCollectorEvent[] = [];
  for (const record of [...signatures].reverse()) {
    const transaction = await rpc.request("solana", "getTransaction", [record.signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], signal) as SolanaTransaction | null;
    if (!transaction?.meta) throw new Error(`Transaction ${record.signature} is unavailable`);
    for (const delta of solanaDeltas(wallet.address, transaction)) {
      const snapshot = market ? await market.lookup("solana", delta.tokenAddress).catch(() => null) : null;
      const priceUsd = snapshot?.priceUsd ?? null;
      events.push(Object.freeze({ eventId: `solana:${record.signature}:${delta.tokenAddress}:${delta.side}`, chain: "solana", walletAddress: wallet.address, tokenAddress: delta.tokenAddress, side: delta.side, amountUsd: priceUsd === null ? null : priceUsd * delta.tokenAmount, priceUsd, marketCapUsd: snapshot?.marketCapUsd ?? null, occurredAt: (transaction.blockTime ?? record.blockTime ?? 0) * 1_000, sourceReference: `solana:signature:${record.signature}` }));
    }
  }
  return Object.freeze({ partitionKey, nextCheckpoint: JSON.stringify({ signature: signatures[0]?.signature ?? previous.signature, checkedAt: now() }), events: Object.freeze(events) });
}

interface SolanaBalance { readonly mint: string; readonly owner?: string; readonly uiTokenAmount: { readonly amount: string; readonly decimals: number } }
interface SolanaTransaction { readonly blockTime: number | null; readonly meta: { readonly preTokenBalances?: readonly SolanaBalance[]; readonly postTokenBalances?: readonly SolanaBalance[] } | null }

function solanaDeltas(wallet: string, transaction: SolanaTransaction) {
  const balances = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const item of transaction.meta?.preTokenBalances ?? []) if (item.owner === wallet) balances.set(item.mint, { pre: BigInt(item.uiTokenAmount.amount), post: 0n, decimals: item.uiTokenAmount.decimals });
  for (const item of transaction.meta?.postTokenBalances ?? []) if (item.owner === wallet) { const current = balances.get(item.mint); balances.set(item.mint, { pre: current?.pre ?? 0n, post: BigInt(item.uiTokenAmount.amount), decimals: item.uiTokenAmount.decimals }); }
  return [...balances.entries()].flatMap(([tokenAddress, balance]) => { const delta = balance.post - balance.pre; if (delta === 0n) return []; return [{ tokenAddress, side: delta > 0n ? "buy" as const : "sell" as const, tokenAmount: Number(delta > 0n ? delta : -delta) / 10 ** balance.decimals }]; });
}

async function valueEvm(chain: EvmChain, token: string, rawAmount: string, rpc: WalletRpcClient, market: TokenMarketProvider | undefined, signal: AbortSignal) {
  try {
    const [decimalsHex, snapshot] = await Promise.all([rpc.request(chain, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"], signal), market?.lookup(chain, token)]);
    const decimals = parseHex(decimalsHex);
    const tokenAmount = Number(BigInt(rawAmount)) / 10 ** decimals;
    const priceUsd = snapshot?.priceUsd ?? null;
    return { amountUsd: priceUsd === null ? null : tokenAmount * priceUsd, priceUsd, marketCapUsd: snapshot?.marketCapUsd ?? null };
  } catch { return { amountUsd: null, priceUsd: null, marketCapUsd: null }; }
}

function parseEvmCheckpoint(value: string | null): number | null { if (!value) return null; try { const parsed = JSON.parse(value) as { blockNumber?: unknown }; return Number.isSafeInteger(parsed.blockNumber) ? parsed.blockNumber as number : null; } catch { return null; } }
function parseSolanaCheckpoint(value: string | null): { signature: string | null } { if (!value) return { signature: null }; try { const parsed = JSON.parse(value) as { signature?: unknown }; return { signature: typeof parsed.signature === "string" ? parsed.signature : null }; } catch { return { signature: null }; } }
function parseHex(value: unknown): number { if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid hexadecimal RPC value"); const parsed = Number.parseInt(value, 16); if (!Number.isSafeInteger(parsed)) throw new Error("Unsafe hexadecimal RPC value"); return parsed; }
function topicAddress(value: string): string { return `0x${value.slice(-40)}`.toLowerCase(); }
