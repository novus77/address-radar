import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/types.js';
import { createAveMarketClient } from '../src/ave-market-client.js';

// Synthetic fixtures only; none of these candidates constitute production evidence.
const identity = { chain: 'solana', token: '1'.repeat(31) + '2', pool: '1'.repeat(31) + '3', quote: '1'.repeat(31) + '4' };
const detail = () => ({ status: 1, data: { token: { token: identity.token, chain: identity.chain, market_cap: '100', fdv: '500', tvl: '20', updated_at: 120 }, pairs: [{ pair: identity.pool, chain: identity.chain, target_token: identity.token, token0_address: identity.token, token1_address: identity.quote, amm: 'reported-amm' }] } });
const candles = () => ({ status: 1, data: { pair_id: `${identity.pool}-solana`, target_token_id: `${identity.token}-solana`, interval: 1, points: [{ time: 120, open: '1', high: '2', low: '0.5', close: '1.5', volume: '4' }] } });
const window = { fromTime: 120, toTime: 240, intervalMinutes: 1, limit: 10 };
function setup(body: unknown = detail(), status = 200, extra: Record<string, unknown> = {}) {
  const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status }));
  const client = createAveMarketClient({ guardedFetch: fetch, apiKey: 'synthetic-secret', deadlineAtMs: Date.now() + 5000, maximumRequests: 2, maximumResponseBytes: 4096, ...extra });
  return { client, fetch };
}
describe('AVE candidate-only client', () => {
  it('separates reported cap and FDV without claiming circulating supply or authority', async () => {
    const { client, fetch } = setup();
    const result = await client.tokenDetail(identity);
    expect(result).toMatchObject({ status: 'candidate', verified: false, independence: 'unverified', reportedMarketCap: 100, reportedFdv: 500, circulatingMarketCapVerified: false, amm: 'reported-amm' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { 'X-API-KEY': 'synthetic-secret' } });
  });
  it.each(['chain', 'token', 'pool', 'quote'] as const)('rejects mismatched %s', async (field) => {
    const { client } = setup();
    expect(await client.tokenDetail({ ...identity, [field]: 'Wrong123' })).toMatchObject({ status: 'deferred' });
  });
  it('requests explicit limit and keeps incomplete windows unverified', async () => {
    let count = 0;
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(count++ === 0 ? detail() : candles())));
    const client = createAveMarketClient({ guardedFetch: fetch, apiKey: 'synthetic-secret', deadlineAtMs: Date.now() + 5000, maximumRequests: 2, maximumResponseBytes: 4096 });
    const result = await client.pairKlines(identity, window);
    expect(result).toMatchObject({ status: 'candidate', verified: false, coverage: 'unverified', liveParameterVerification: 'pending', denomination: 'USDT', points: [{ time: 120 }] });
    const url = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('size')).toBe(false);
    expect(url.searchParams.get('category')).toBe('u');
  });
  it.each(['pair_id', 'target_token_id', 'interval'])('rejects K-line metadata drift %s', async (field) => {
    const body = candles(); Object.assign(body.data, { [field]: 'wrong' });
    let count = 0;
    const { client } = setup();
    const other = createAveMarketClient({ guardedFetch: async () => new Response(JSON.stringify(count++ === 0 ? detail() : body)), apiKey: 'key', deadlineAtMs: Date.now() + 5000, maximumRequests: 2, maximumResponseBytes: 4096 });
    void client;
    expect(await other.pairKlines(identity, window)).toMatchObject({ status: 'deferred', reason: 'identity_mismatch' });
  });
  it.each([401, 403, 429])('sanitizes HTTP %s and stops subsequent requests', async (status) => {
    const { client, fetch } = setup({ msg: 'synthetic-secret' }, status);
    const first = await client.tokenDetail(identity);
    expect(first).toMatchObject({ status: 'deferred', reason: status === 429 ? 'rate_limited' : 'unauthorized' });
    await client.tokenDetail(identity);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('synthetic-secret');
  });
  it('caps streamed response bytes', async () => {
    const { client } = setup({ large: 'x'.repeat(5000) });
    expect(await client.tokenDetail(identity)).toMatchObject({ reason: 'response_too_large' });
  });
  it('does not call transport after deadline, cancellation or exhausted request budget', async () => {
    const expired = setup(detail(), 200, { deadlineAtMs: 1 });
    expect(await expired.client.tokenDetail(identity)).toMatchObject({ reason: 'deadline' });
    expect(expired.fetch).not.toHaveBeenCalled();
    const { client, fetch } = setup(detail(), 200, { maximumRequests: 1 });
    const abort = new AbortController(); abort.abort();
    expect(await client.tokenDetail(identity, abort.signal)).toMatchObject({ reason: 'aborted' });
    await client.tokenDetail(identity); await client.tokenDetail(identity);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sanitizes transport errors and bounds a transport ignoring cancellation', async () => {
    const failed = createAveMarketClient({ guardedFetch: async () => { throw new Error('synthetic-secret'); }, apiKey: 'key', deadlineAtMs: Date.now() + 5000, maximumRequests: 1, maximumResponseBytes: 4096 });
    expect(await failed.tokenDetail(identity)).toEqual({ status: 'deferred', reason: 'transport_failure' });
    const hung = createAveMarketClient({ guardedFetch: () => new Promise<Response>(() => {}), apiKey: 'key', deadlineAtMs: Date.now() + 20, maximumRequests: 1, maximumResponseBytes: 4096 });
    expect(await hung.tokenDetail(identity)).toMatchObject({ reason: 'deadline' });
  });
  it.each(['open', 'invalid', 'duplicate', 'outside'])('rejects %s candles without claiming coverage', async (kind) => {
    const body = candles(); const point = body.data.points[0]!;
    if (kind === 'open') point.time = 240;
    if (kind === 'invalid') point.high = '0.1';
    if (kind === 'duplicate') body.data.points.push({ ...point });
    if (kind === 'outside') point.time = 60;
    let count = 0;
    const client = createAveMarketClient({ guardedFetch: async () => new Response(JSON.stringify(count++ === 0 ? detail() : body)), apiKey: 'key', deadlineAtMs: Date.now() + 5000, maximumRequests: 2, maximumResponseBytes: 4096 });
    expect(await client.pairKlines(identity, window)).toMatchObject({ status: 'deferred', reason: 'invalid_response' });
  });
});

describe('AVE identity and immutable operation contract regressions', () => {
  it.each([
    { ...identity, token: 'ABC' }, { ...identity, pool: 'POOL' }, { ...identity, quote: 'USDT' },
    { ...identity, token: '1'.repeat(31) }, { ...identity, token: '1'.repeat(33) },
    { ...identity, token: 'z'.repeat(44) }, { ...identity, token: '0'.repeat(32) },
    { ...identity, chain: 'robinhood' },
    { chain: 'eth', token: 'ABC', pool: '0x' + '2'.repeat(40), quote: '0x' + '3'.repeat(40) },
    { chain: 'base', token: '0x' + 'a'.repeat(39), pool: '0x' + '2'.repeat(40), quote: '0x' + '3'.repeat(40) },
    { chain: 'bsc', token: '0x' + 'a'.repeat(40), pool: '0x' + '2'.repeat(40), quote: '0x' + 'A'.repeat(40) },
  ])('rejects invalid encoding, byte length, chain or aliased quote %# without transport', async (input) => {
    const { client, fetch } = setup();
    expect(await client.tokenDetail(input)).toEqual({ status: 'deferred', reason: 'invalid_input' });
    expect(await client.pairKlines(input, window)).toEqual({ status: 'deferred', reason: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['eth', 'bsc', 'base'])('canonicalizes valid %s addresses consistently in requests and responses', async (chain) => {
    const input = { chain, token: '0x' + 'Ab'.repeat(20), pool: '0x' + 'Cd'.repeat(20), quote: '0x' + 'Ef'.repeat(20) };
    const body = { status: 1, data: { token: { token: input.token.toLowerCase(), chain, updated_at: 120 }, pairs: [{ pair: input.pool, chain, target_token: input.token, token0_address: input.quote, token1_address: input.token }] } };
    const { client, fetch } = setup(body);
    expect(await client.tokenDetail(input)).toMatchObject({ status: 'candidate', identity: { chain, token: input.token.toLowerCase(), pool: input.pool.toLowerCase(), quote: input.quote.toLowerCase() } });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(input.token.toLowerCase());
  });
  it('snapshots all options at construction, including transport and key', async () => {
    const original = vi.fn<FetchLike>(async () => new Response(JSON.stringify(detail())));
    const replacement = vi.fn<FetchLike>(async () => new Response('{}'));
    const options = { guardedFetch: original, apiKey: 'original-key', deadlineAtMs: Date.now() + 5000, maximumRequests: 1, maximumResponseBytes: 4096 };
    const client = createAveMarketClient(options);
    Object.assign(options, { guardedFetch: replacement, apiKey: 'replacement-key', deadlineAtMs: 1, maximumRequests: 99, maximumResponseBytes: 1 });
    expect(await client.tokenDetail(identity)).toMatchObject({ status: 'candidate' });
    expect(await client.tokenDetail(identity)).toMatchObject({ reason: 'request_budget_exhausted' });
    expect(original.mock.calls[0]?.[1]?.headers).toEqual({ 'X-API-KEY': 'original-key' });
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
  it('does not extend an expired construction deadline through mutation', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('{}'));
    const options = { guardedFetch: fetch, apiKey: 'key', deadlineAtMs: 1, maximumRequests: 1, maximumResponseBytes: 64 };
    const client = createAveMarketClient(options);
    options.deadlineAtMs = Date.now() + 5000;
    expect(await client.tokenDetail(identity)).toMatchObject({ reason: 'deadline' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps original body cap when mutated while awaiting transport', async () => {
    let deliver!: (response: Response) => void;
    const fetch = vi.fn<FetchLike>(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const options = { guardedFetch: fetch, apiKey: 'key', deadlineAtMs: Date.now() + 5000, maximumRequests: 1, maximumResponseBytes: 64 };
    const client = createAveMarketClient(options);
    const pending = client.tokenDetail(identity);
    options.maximumResponseBytes = 100000;
    deliver(new Response(JSON.stringify(detail())));
    expect(await pending).toMatchObject({ reason: 'response_too_large' });
  });
  it('keeps transport and key between detail await and K-line request', async () => {
    let deliver!: (response: Response) => void;
    let calls = 0;
    const original = vi.fn<FetchLike>(() => ++calls === 1 ? new Promise<Response>(resolve => { deliver = resolve; }) : Promise.resolve(new Response(JSON.stringify(candles()))));
    const replacement = vi.fn<FetchLike>(async () => new Response('{}'));
    const options = { guardedFetch: original, apiKey: 'original-key', deadlineAtMs: Date.now() + 5000, maximumRequests: 2, maximumResponseBytes: 4096 };
    const client = createAveMarketClient(options);
    const pending = client.pairKlines(identity, window);
    Object.assign(options, { guardedFetch: replacement, apiKey: 'replacement-key', deadlineAtMs: 1, maximumRequests: 99, maximumResponseBytes: 1 });
    deliver(new Response(JSON.stringify(detail())));
    expect(await pending).toMatchObject({ status: 'candidate', verified: false, liveParameterVerification: 'pending' });
    expect(original).toHaveBeenCalledTimes(2);
    expect(original.mock.calls[1]?.[1]?.headers).toEqual({ 'X-API-KEY': 'original-key' });
    expect(await client.tokenDetail(identity)).toMatchObject({ reason: 'request_budget_exhausted' });
    expect(replacement).not.toHaveBeenCalled();
  });
  it('does not expand request budget while the first stage is awaiting', async () => {
    let deliver!: (response: Response) => void;
    const fetch = vi.fn<FetchLike>(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const options = { guardedFetch: fetch, apiKey: 'key', deadlineAtMs: Date.now() + 5000, maximumRequests: 1, maximumResponseBytes: 4096 };
    const client = createAveMarketClient(options);
    const pending = client.pairKlines(identity, window);
    options.maximumRequests = 99;
    deliver(new Response(JSON.stringify(detail())));
    expect(await pending).toMatchObject({ reason: 'request_budget_exhausted' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not extend a running deadline while awaiting transport', async () => {
    const options = { guardedFetch: (() => new Promise<Response>(() => {})) as FetchLike, apiKey: 'key', deadlineAtMs: Date.now() + 25, maximumRequests: 1, maximumResponseBytes: 4096 };
    const client = createAveMarketClient(options);
    const pending = client.tokenDetail(identity);
    options.deadlineAtMs = Date.now() + 5000;
    expect(await pending).toMatchObject({ reason: 'deadline' });
  });
});
