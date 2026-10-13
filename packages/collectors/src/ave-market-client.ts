import type { FetchLike } from './types.js';

export type AveCandidateReason = 'invalid_input' | 'identity_mismatch' | 'invalid_response' | 'unauthorized' | 'rate_limited' | 'http_failure' | 'transport_failure' | 'deadline' | 'aborted' | 'request_budget_exhausted' | 'response_too_large';
export interface AveIdentity { readonly chain: string; readonly token: string; readonly pool: string; readonly quote: string }
export interface AveWindow { readonly fromTime: number; readonly toTime: number; readonly intervalMinutes: number; readonly limit: number }
export interface AveMarketClientOptions {
  // The caller must bind this transport to its approved provider budget, lease and cooldown.
  // No global fetch fallback or retries are permitted here.
  readonly guardedFetch: FetchLike;
  readonly apiKey: string;
  readonly deadlineAtMs: number;
  readonly maximumRequests: number;
  readonly maximumResponseBytes: number;
}
export interface AveDeferred { readonly status: 'deferred'; readonly reason: AveCandidateReason }
interface Candidate { readonly status: 'candidate'; readonly verified: false; readonly independence: 'unverified' }
export interface AveTokenCandidate extends Candidate {
  readonly identity: AveIdentity;
  readonly reportedMarketCap: number | null;
  readonly reportedFdv: number | null;
  readonly reportedTvl: number | null;
  readonly reportedUpdatedAt: number;
  readonly circulatingMarketCapVerified: false;
  readonly amm: string | null;
}
export interface AveCandle { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number }
export interface AveKlineCandidate extends Candidate {
  readonly identity: AveIdentity;
  readonly window: AveWindow;
  readonly points: readonly AveCandle[];
  readonly denomination: 'USDT';
  readonly coverage: 'unverified';
  readonly liveParameterVerification: 'pending';
}
const intervals = new Set([1, 5, 15, 30, 60, 120, 240, 1440, 4320, 10080, 43200, 525600, 2628000]);
const deferred = (reason: AveCandidateReason): AveDeferred => ({ status: 'deferred', reason });
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function validSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (decoded > 0n) { bytes++; decoded >>= 8n; }
  let leadingZeroes = 0;
  while (value[leadingZeroes] === '1') leadingZeroes++;
  return leadingZeroes + bytes === 32;
}
function canonicalIdentity(value: AveIdentity): AveIdentity | null {
  const { chain, token, pool, quote } = value;
  if (!['eth', 'bsc', 'base', 'solana'].includes(chain)) return null;
  const addresses = [token, pool, quote];
  if (!addresses.every(address => typeof address === 'string' && (chain === 'solana' ? validSolanaAddress(address) : /^0x[0-9a-fA-F]{40}$/.test(address)))) return null;
  const normalized = { chain, token: chain === 'solana' ? token : token.toLowerCase(), pool: chain === 'solana' ? pool : pool.toLowerCase(), quote: chain === 'solana' ? quote : quote.toLowerCase() };
  return normalized.token === normalized.quote ? null : normalized;
}
function same(left: unknown, right: string, chain: string): boolean {
  return typeof left === 'string' && (chain === 'solana' ? left === right : left.toLowerCase() === right.toLowerCase());
}
class CandidateFailure extends Error {
  constructor(readonly reason: AveCandidateReason) { super(reason); }
}

export function createAveMarketClient(options: AveMarketClientOptions) {
  // Capture each field once before validation; caller mutation cannot change the contract.
  const config = Object.freeze({ guardedFetch: options.guardedFetch, apiKey: options.apiKey, deadlineAtMs: options.deadlineAtMs, maximumRequests: options.maximumRequests, maximumResponseBytes: options.maximumResponseBytes });
  if (typeof config.guardedFetch !== 'function' || typeof config.apiKey !== 'string' || !config.apiKey || /[\r\n]/.test(config.apiKey) || !Number.isSafeInteger(config.deadlineAtMs) || !Number.isSafeInteger(config.maximumRequests) || config.maximumRequests < 1 || !Number.isSafeInteger(config.maximumResponseBytes) || config.maximumResponseBytes < 1) {
    throw new Error('Invalid AVE client configuration');
  }
  let requests = 0;
  let blocked: 'unauthorized' | 'rate_limited' | undefined;
  async function request(path: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new CandidateFailure('aborted');
    const remaining = config.deadlineAtMs - Date.now();
    if (remaining <= 0 || remaining > 2_147_483_647) throw new CandidateFailure('deadline');
    if (blocked) throw new CandidateFailure(blocked);
    if (requests >= config.maximumRequests) throw new CandidateFailure('request_budget_exhausted');
    requests++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop: (error: CandidateFailure) => void = () => {};
    const stop = new Promise<never>((_, reject) => { rejectStop = reject; });
    const cancel = (reason: 'deadline' | 'aborted') => { controller.abort(); rejectStop(new CandidateFailure(reason)); };
    const onAbort = () => cancel('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => cancel('deadline'), remaining);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const work = async () => {
      const response = await config.guardedFetch(`https://prod.ave-api.com/v2/${path}`, { method: 'GET', redirect: 'error', headers: { 'X-API-KEY': config.apiKey }, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new CandidateFailure(signal?.aborted ? 'aborted' : 'deadline'); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) { blocked = 'unauthorized'; throw new CandidateFailure(blocked); }
        if (response.status === 429) { blocked = 'rate_limited'; throw new CandidateFailure(blocked); }
        throw new CandidateFailure('http_failure');
      }
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > config.maximumResponseBytes) { void response.body?.cancel().catch(() => {}); throw new CandidateFailure('response_too_large'); }
      if (!response.body) throw new CandidateFailure('invalid_response');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new CandidateFailure(signal?.aborted ? 'aborted' : 'deadline');
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > config.maximumResponseBytes) throw new CandidateFailure('response_too_large');
        chunks.push(chunk.value);
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      let envelope: Record<string, unknown>;
      try { envelope = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))); } catch { throw new CandidateFailure('invalid_response'); }
      if (envelope.status !== 1) throw new CandidateFailure('invalid_response');
      return envelope.data;
    };
    try { return await Promise.race([work(), stop]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  const failure = (error: unknown): AveDeferred => deferred(error instanceof CandidateFailure ? error.reason : 'transport_failure');
  async function tokenDetail(identity: AveIdentity, signal?: AbortSignal): Promise<AveTokenCandidate | AveDeferred> {
    const normalized = canonicalIdentity(identity);
    if (!normalized) return deferred('invalid_input');
    identity = normalized;
    try {
      const data = record(await request(`tokens/${identity.token}-${identity.chain}`, signal));
      const token = record(data.token);
      if (token.chain !== identity.chain || !same(token.token, identity.token, identity.chain)) return deferred('identity_mismatch');
      const pairs = Array.isArray(data.pairs) ? data.pairs.map(record).filter(pair => pair.chain === identity.chain && same(pair.pair, identity.pool, identity.chain)) : [];
      if (pairs.length !== 1) return deferred('identity_mismatch');
      const pair = pairs[0]!;
      const sidesMatch = (same(pair.token0_address, identity.token, identity.chain) && same(pair.token1_address, identity.quote, identity.chain)) || (same(pair.token1_address, identity.token, identity.chain) && same(pair.token0_address, identity.quote, identity.chain));
      if (!sidesMatch || !same(pair.target_token, identity.token, identity.chain)) return deferred('identity_mismatch');
      const updatedAt = numeric(token.updated_at);
      if (updatedAt === null || !Number.isSafeInteger(updatedAt) || updatedAt <= 0 || updatedAt > Math.floor(Date.now() / 1000)) return deferred('invalid_response');
      return { status: 'candidate', verified: false, independence: 'unverified', identity, reportedMarketCap: numeric(token.market_cap), reportedFdv: numeric(token.fdv), reportedTvl: numeric(token.tvl), reportedUpdatedAt: updatedAt, circulatingMarketCapVerified: false, amm: typeof pair.amm === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(pair.amm) ? pair.amm : null };
    } catch (error) { return failure(error); }
  }
  async function pairKlines(identity: AveIdentity, window: AveWindow, signal?: AbortSignal): Promise<AveKlineCandidate | AveDeferred> {
    const normalized = canonicalIdentity(identity);
    if (!normalized || !Number.isSafeInteger(window.fromTime) || window.fromTime < 0 || !Number.isSafeInteger(window.toTime) || window.toTime <= window.fromTime || window.toTime > Math.floor(Date.now() / 1000) || !intervals.has(window.intervalMinutes) || !Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 1000) return deferred('invalid_input');
    identity = normalized; window = { ...window };
    const detail = await tokenDetail(identity, signal);
    if (detail.status === 'deferred') return detail;
    try {
      const query = new URLSearchParams({ category: 'u', interval: String(window.intervalMinutes), from_time: String(window.fromTime), to_time: String(window.toTime), limit: String(window.limit) });
      const data = record(await request(`klines/pair/${identity.pool}-${identity.chain}?${query}`, signal));
      if (!same(data.pair_id, `${identity.pool}-${identity.chain}`, identity.chain) || !same(data.target_token_id, `${identity.token}-${identity.chain}`, identity.chain) || data.interval !== window.intervalMinutes) return deferred('identity_mismatch');
      if (!Array.isArray(data.points) || data.points.length > window.limit) return deferred('invalid_response');
      const points: AveCandle[] = [];
      let previous = -1;
      for (const raw of data.points) {
        const item = record(raw);
        const time = numeric(item.time), open = numeric(item.open), high = numeric(item.high), low = numeric(item.low), close = numeric(item.close), volume = numeric(item.volume);
        if (time === null || !Number.isSafeInteger(time) || time <= previous || time < window.fromTime || time + window.intervalMinutes * 60 > window.toTime || time % (window.intervalMinutes * 60) !== 0 || open === null || high === null || low === null || close === null || volume === null || low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || low > high) return deferred('invalid_response');
        points.push({ time, open, high, low, close, volume }); previous = time;
      }
      return { status: 'candidate', verified: false, independence: 'unverified', identity, window, points, denomination: 'USDT', coverage: 'unverified', liveParameterVerification: 'pending' };
    } catch (error) { return failure(error); }
  }
  return { tokenDetail, pairKlines };
}
