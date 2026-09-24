import { DatabaseSync } from "node:sqlite";
import type { DiscoveryChain } from "@address-radar/collectors";
import type { WalletAnalysisPosition } from "@address-radar/domain";
import type { WalletHistoryProvider } from "./runtime.js";

export interface HistoricalTokenEvent { readonly eventId: string; readonly chain: string; readonly tokenAddress: string; readonly side: "buy" | "sell"; readonly tokenAmount: number; readonly occurredAt: number; readonly source: string }
export interface HistoricalMarketSource { priceAt(chain: string, tokenAddress: string, observedAt: number): Promise<number | null>; peakPrice(chain: string, tokenAddress: string, from: number, to: number): Promise<number | null>; minimumPrice(chain: string, tokenAddress: string, from: number, to: number): Promise<number | null>; firstObservedAt(chain: string, tokenAddress: string): Promise<number | null> }
export interface AnalysisRpcClient { request(chain: DiscoveryChain, method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> }
export interface HistoricalEventStore { append(analysisId: string, events: readonly HistoricalTokenEvent[]): void; events(analysisId: string): readonly HistoricalTokenEvent[]; close(): void }

export function openHistoricalEventStore(databasePath: string): HistoricalEventStore {
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE IF NOT EXISTS wallet_analysis_provider_events(analysis_id TEXT NOT NULL, event_id TEXT NOT NULL, chain TEXT NOT NULL, token_address TEXT NOT NULL, side TEXT NOT NULL, token_amount REAL NOT NULL, occurred_at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY(analysis_id, event_id))");
  const store: HistoricalEventStore = {
    append(analysisId, events) { const insert = database.prepare("INSERT OR IGNORE INTO wallet_analysis_provider_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)"); database.exec("BEGIN IMMEDIATE"); try { for (const event of events) insert.run(analysisId, event.eventId, event.chain, event.tokenAddress, event.side, event.tokenAmount, event.occurredAt, event.source); database.exec("COMMIT"); } catch (error) { database.exec("ROLLBACK"); throw error; } },
    events(analysisId) { return database.prepare("SELECT event_id AS eventId, chain, token_address AS tokenAddress, side, token_amount AS tokenAmount, occurred_at AS occurredAt, source FROM wallet_analysis_provider_events WHERE analysis_id = ? ORDER BY occurred_at, event_id").all(analysisId) as unknown as readonly HistoricalTokenEvent[]; },
    close() { database.close(); },
  };
  return Object.freeze(store);
}

export function openSqliteHistoricalMarketSource(databasePath: string): HistoricalMarketSource & { close(): void } {
  const database = new DatabaseSync(databasePath);
  const row = (sql: string, args: readonly (string | number)[]) => database.prepare(sql).get(...args) as { value: number | null } | undefined;
  const market: HistoricalMarketSource & { close(): void } = {
    async priceAt(chain, token, at) { return row("SELECT price_usd AS value FROM market_observations WHERE chain = ? AND token_address = ? AND observed_at BETWEEN ? AND ? ORDER BY ABS(observed_at - ?) LIMIT 1", [chain.toLowerCase(), normalizeToken(chain, token), at - 1_800_000, at + 1_800_000, at])?.value ?? null; },
    async peakPrice(chain, token, from, to) { return row("SELECT MAX(price_usd) AS value FROM market_observations WHERE chain = ? AND token_address = ? AND observed_at BETWEEN ? AND ?", [chain.toLowerCase(), normalizeToken(chain, token), from, to])?.value ?? null; },
    async minimumPrice(chain, token, from, to) { return row("SELECT MIN(price_usd) AS value FROM market_observations WHERE chain = ? AND token_address = ? AND observed_at BETWEEN ? AND ? AND price_usd > 0", [chain.toLowerCase(), normalizeToken(chain, token), from, to])?.value ?? null; },
    async firstObservedAt(chain, token) { return row("SELECT MIN(observed_at) AS value FROM market_observations WHERE chain = ? AND token_address = ?", [chain.toLowerCase(), normalizeToken(chain, token)])?.value ?? null; },
    close() { database.close(); },
  };
  return Object.freeze(market);
}

export async function reconstructWalletPositions(input: { readonly events: readonly HistoricalTokenEvent[]; readonly market: HistoricalMarketSource; readonly limit: number; readonly observedAt: number }): Promise<readonly WalletAnalysisPosition[]> {
  const groups = new Map<string, HistoricalTokenEvent[]>();
  for (const event of input.events) { const key = `${event.chain.toLowerCase()}:${normalizeToken(event.chain, event.tokenAddress)}`; groups.set(key, [...(groups.get(key) ?? []), event]); }
  const selected = [...groups.entries()].sort((left, right) => Math.min(...right[1].map(item => item.occurredAt)) - Math.min(...left[1].map(item => item.occurredAt))).slice(0, input.limit);
  const positions: WalletAnalysisPosition[] = [];
  for (const [tokenId, events] of selected) {
    const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
    let investedUsd = 0, realizedValueUsd = 0, bought = 0, sold = 0; let largeBuy = false;
    for (const event of ordered) { const price = await input.market.priceAt(event.chain, event.tokenAddress, event.occurredAt); if (price === null || price <= 0) continue; const value = event.tokenAmount * price; if (event.side === "buy") { investedUsd += value; bought += event.tokenAmount; largeBuy ||= value >= 10_000; } else { realizedValueUsd += value; sold += event.tokenAmount; } }
    if (investedUsd <= 0 || bought <= 0) continue;
    const first = ordered[0]!, last = ordered.at(-1)!;
    const [current, peak, minimum, firstObserved] = await Promise.all([input.market.priceAt(first.chain, first.tokenAddress, input.observedAt), input.market.peakPrice(first.chain, first.tokenAddress, first.occurredAt, input.observedAt), input.market.minimumPrice(first.chain, first.tokenAddress, first.occurredAt, input.observedAt), input.market.firstObservedAt(first.chain, first.tokenAddress)]);
    const remaining = Math.max(0, bought - sold);
    if (peak === null || minimum === null || (remaining > 0 && current === null)) continue;
    positions.push(Object.freeze({ tokenId, enteredAt: first.occurredAt, investedUsd, realizedValueUsd, remainingValueUsd: remaining * (current ?? 0), peakValueUsd: bought * peak, holdingDurationMs: Math.max(0, (remaining > 0 ? input.observedAt : last.occurredAt) - first.occurredAt), maximumDrawdownRatio: Math.max(0, Math.min(1, 1 - minimum / (investedUsd / bought))), earlyEntry: firstObserved !== null && first.occurredAt - firstObserved <= 6 * 60 * 60_000, largeBuy }));
  }
  return Object.freeze(positions);
}

export function createSolanaRpcWalletHistoryProvider(input: { readonly rpc: AnalysisRpcClient; readonly market: HistoricalMarketSource; readonly events: HistoricalEventStore; readonly pageSize?: number }): WalletHistoryProvider {
  const pageSize = input.pageSize ?? 100;
  const provider: WalletHistoryProvider = { async collect(request) {
    const options = { commitment: "confirmed", limit: Math.min(pageSize, request.limit), ...(request.cursor ? { before: request.cursor } : {}) };
    const signatures = await input.rpc.request("solana", "getSignaturesForAddress", [request.address, options], request.signal) as readonly { signature: string; blockTime: number | null }[];
    const events: HistoricalTokenEvent[] = []; let reachedStart = false; let skipped = 0;
    for (const record of signatures) { const occurredAt = (record.blockTime ?? 0) * 1_000; if (occurredAt < request.from) { reachedStart = true; break; } if (occurredAt > request.to) continue; const tx = await input.rpc.request("solana", "getTransaction", [record.signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], request.signal) as SolanaTransaction | null; if (tx?.meta) { const extracted = solanaEvents(request.address, record.signature, occurredAt, tx); events.push(...extracted.events); skipped += extracted.skipped; } }
    input.events.append(request.analysisId, events);
    const done = reachedStart || signatures.length < Math.min(pageSize, request.limit);
    return Object.freeze({ positions: await reconstructWalletPositions({ events: input.events.events(request.analysisId), market: input.market, limit: request.limit, observedAt: request.to }), nextCursor: done ? null : signatures.at(-1)?.signature ?? null, done, provenance: `solana-rpc;skipped_insufficient_swap_evidence=${skipped}` });
  } };
  return Object.freeze(provider);
}

export function createEvmRpcWalletHistoryProvider(input: { readonly rpc: AnalysisRpcClient; readonly chains: readonly Exclude<DiscoveryChain, "solana">[]; readonly market: HistoricalMarketSource; readonly events: HistoricalEventStore; readonly blocksPerPage?: number }): WalletHistoryProvider {
  const pageSize = input.blocksPerPage ?? 100;
  const provider: WalletHistoryProvider = { async collect(request) {
    const state = parseEvmCursor(request.cursor); const chainIndex = state.chainIndex; const chain = input.chains[chainIndex];
    if (!chain) return { positions: await reconstructWalletPositions({ events: input.events.events(request.analysisId), market: input.market, limit: request.limit, observedAt: request.to }), nextCursor: null, done: true, provenance: "evm-rpc" };
    const head = parseHex(await input.rpc.request(chain, "eth_blockNumber", [], request.signal));
    const fromBlock = state.nextBlock ?? await blockAtOrAfter(input.rpc, chain, head, request.from, request.signal);
    const toBlock = await blockAtOrAfter(input.rpc, chain, head, request.to, request.signal);
    const end = Math.min(toBlock, fromBlock + pageSize - 1); const events: HistoricalTokenEvent[] = []; let skipped = 0;
    for (let blockNumber = fromBlock; blockNumber <= end; blockNumber += 1) { const block = await input.rpc.request(chain, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, true], request.signal) as { timestamp: string; transactions: readonly EvmTransaction[] } | null; if (!block) throw new Error(`Block ${blockNumber} is unavailable`); for (const tx of block.transactions) { const normalized = request.address.toLowerCase(); if (tx.from.toLowerCase() !== normalized && tx.to?.toLowerCase() !== normalized) continue; const receipt = await input.rpc.request(chain, "eth_getTransactionReceipt", [tx.hash], request.signal) as { logs: readonly EvmLog[] } | null; if (!receipt) throw new Error(`Receipt ${tx.hash} is unavailable`); const extracted = await evmEvents(chain, request.address, tx, parseHex(block.timestamp) * 1_000, receipt.logs, input.rpc, request.signal); events.push(...extracted.events); skipped += extracted.skipped; } }
    input.events.append(request.analysisId, events);
    const finishedChain = end >= toBlock; const done = finishedChain && chainIndex + 1 >= input.chains.length;
    const nextCursor = done ? null : JSON.stringify(finishedChain ? { chainIndex: chainIndex + 1 } : { chainIndex, nextBlock: end + 1 });
    return Object.freeze({ positions: await reconstructWalletPositions({ events: input.events.events(request.analysisId), market: input.market, limit: request.limit, observedAt: request.to }), nextCursor, done, provenance: `evm-rpc;skipped_insufficient_swap_evidence=${skipped}` });
  } };
  return Object.freeze(provider);
}

interface EvmLog { address: string; logIndex?: string; data: string; topics: readonly string[] }
interface EvmTransaction { hash: string; from: string; to?: string | null; value?: string }
interface SolanaBalance { accountIndex?: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
interface SolanaTransaction { transaction?: { message?: { accountKeys?: readonly (string | { pubkey: string })[]; instructions?: readonly { programId?: string }[] } }; meta: { preBalances?: readonly number[]; postBalances?: readonly number[]; preTokenBalances?: readonly SolanaBalance[]; postTokenBalances?: readonly SolanaBalance[] } | null }
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SOLANA_QUOTES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const SOLANA_SWAP_PROGRAMS = new Set(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzG3bC4iY6n", "675kPX9MHTjS2zt1qfr1NYHuzeTHKq9gXQDA8T3o1ut"]);
const EVM_QUOTES: Readonly<Record<string, ReadonlySet<string>>> = { eth: new Set(["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]), base: new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0x4200000000000000000000000000000000000006"]), bsc: new Set(["0x55d398326f99059ff775485246999027b3197955", "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"]) };
async function evmEvents(chain: Exclude<DiscoveryChain, "solana">, wallet: string, tx: EvmTransaction, occurredAt: number, logs: readonly EvmLog[], rpc: AnalysisRpcClient, signal: AbortSignal): Promise<{ events: HistoricalTokenEvent[]; skipped: number }> { const normalized = wallet.toLowerCase(); const quotes = EVM_QUOTES[chain] ?? new Set<string>(); const transfers = logs.flatMap((log) => { if (log.topics[0]?.toLowerCase() !== TRANSFER || log.topics.length < 3 || BigInt(log.data) <= 0n) return []; const from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase(), to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase(); const side = to === normalized ? "buy" as const : from === normalized ? "sell" as const : null; return side ? [{ log, side }] : []; }); const candidates = transfers.filter(({ log }) => !quotes.has(log.address.toLowerCase())); const quoteLegs = transfers.filter(({ log }) => quotes.has(log.address.toLowerCase())); const hasSwapLog = logs.some((log) => ["0xd78ad95f", "0xc42079f9"].some((prefix) => log.topics[0]?.toLowerCase().startsWith(prefix))); const nativeOut = tx.from.toLowerCase() === normalized && typeof tx.value === "string" && BigInt(tx.value) > 0n; const events: HistoricalTokenEvent[] = []; for (const candidate of candidates) { const opposite = quoteLegs.some((quote) => quote.side !== candidate.side) || (candidate.side === "buy" && nativeOut); if (!hasSwapLog || !opposite) continue; const decimals = parseHex(await rpc.request(chain, "eth_call", [{ to: candidate.log.address, data: "0x313ce567" }, "latest"], signal)); events.push({ eventId: `${chain}:${tx.hash}:${candidate.log.logIndex ?? candidate.log.data}:${candidate.side}`, chain, tokenAddress: candidate.log.address.toLowerCase(), side: candidate.side, tokenAmount: Number(BigInt(candidate.log.data)) / 10 ** decimals, occurredAt, source: `onchain:${chain}:${tx.hash}` }); } return { events, skipped: candidates.length > 0 && events.length === 0 ? 1 : 0 }; }
function solanaEvents(wallet: string, signature: string, occurredAt: number, tx: SolanaTransaction): { events: HistoricalTokenEvent[]; skipped: number } { const values = new Map<string, { pre: bigint; post: bigint; decimals: number }>(); for (const item of tx.meta?.preTokenBalances ?? []) if (item.owner === wallet) values.set(item.mint, { pre: BigInt(item.uiTokenAmount.amount), post: 0n, decimals: item.uiTokenAmount.decimals }); for (const item of tx.meta?.postTokenBalances ?? []) if (item.owner === wallet) { const old = values.get(item.mint); values.set(item.mint, { pre: old?.pre ?? 0n, post: BigInt(item.uiTokenAmount.amount), decimals: item.uiTokenAmount.decimals }); } const deltas = [...values.entries()].flatMap(([tokenAddress, value]) => { const delta = value.post - value.pre; return delta === 0n ? [] : [{ tokenAddress, delta, decimals: value.decimals }]; }); const quoteDeltas = deltas.filter((item) => SOLANA_QUOTES.has(item.tokenAddress)); const candidates = deltas.filter((item) => !SOLANA_QUOTES.has(item.tokenAddress)); const keys = tx.transaction?.message?.accountKeys ?? []; const walletIndex = keys.findIndex((key) => (typeof key === "string" ? key : key.pubkey) === wallet); const nativeDelta = walletIndex < 0 ? 0 : (tx.meta?.postBalances?.[walletIndex] ?? 0) - (tx.meta?.preBalances?.[walletIndex] ?? 0); const programs = [...keys.flatMap((key) => typeof key === "string" ? [key] : [key.pubkey]), ...(tx.transaction?.message?.instructions ?? []).flatMap((item) => item.programId ? [item.programId] : [])]; const knownProgram = programs.some((program) => SOLANA_SWAP_PROGRAMS.has(program)); const hasPositive = deltas.some((item) => item.delta > 0n) || nativeDelta > 0; const hasNegative = deltas.some((item) => item.delta < 0n) || nativeDelta < 0; const events = candidates.flatMap((item) => { const opposingQuote = quoteDeltas.some((quote) => Math.sign(Number(quote.delta)) === -Math.sign(Number(item.delta))) || (nativeDelta !== 0 && Math.sign(nativeDelta) === -Math.sign(Number(item.delta))); if (!opposingQuote && !(knownProgram && hasPositive && hasNegative)) return []; const side = item.delta > 0n ? "buy" as const : "sell" as const; return [{ eventId: `solana:${signature}:${item.tokenAddress}:${side}`, chain: "solana", tokenAddress: item.tokenAddress, side, tokenAmount: Number(item.delta > 0n ? item.delta : -item.delta) / 10 ** item.decimals, occurredAt, source: `onchain:solana:${signature}` }]; }); return { events, skipped: candidates.length > 0 && events.length === 0 ? 1 : 0 }; }
async function blockAtOrAfter(rpc: AnalysisRpcClient, chain: Exclude<DiscoveryChain, "solana">, head: number, timestamp: number, signal: AbortSignal) { let low = 0, high = head; while (low < high) { const middle = Math.floor((low + high) / 2); const block = await rpc.request(chain, "eth_getBlockByNumber", [`0x${middle.toString(16)}`, false], signal) as { timestamp: string } | null; if (!block || parseHex(block.timestamp) * 1_000 < timestamp) low = middle + 1; else high = middle; } return low; }
function parseEvmCursor(value: string | null): { chainIndex: number; nextBlock?: number } { if (!value) return { chainIndex: 0 }; try { const parsed = JSON.parse(value) as { chainIndex?: unknown; nextBlock?: unknown }; return { chainIndex: Number.isSafeInteger(parsed.chainIndex) ? parsed.chainIndex as number : 0, ...(Number.isSafeInteger(parsed.nextBlock) ? { nextBlock: parsed.nextBlock as number } : {}) }; } catch { return { chainIndex: 0 }; } }
function parseHex(value: unknown): number { if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid hexadecimal RPC value"); return Number.parseInt(value, 16); }
function normalizeToken(chain: string, token: string) { return chain.toLowerCase() === "solana" ? token.trim() : token.trim().toLowerCase(); }
