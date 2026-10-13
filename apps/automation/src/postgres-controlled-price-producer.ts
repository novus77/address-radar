import type { AveIdentity, AveTokenCandidate, AveDeferred } from '../../../packages/collectors/src/ave-market-client.js';
import { forwardDecimal } from '../../../packages/domain/src/forward-opportunity-policy.js';
import { createHash } from "node:crypto";
import { createGeckoTerminalClient, type GeckoTerminalOhlcvCandle } from "../../../packages/collectors/src/gecko-terminal-client.js";
import type { DiscoveryChain } from "../../../packages/collectors/src/rpc-provider.js";

export interface PostgresPricePoolMapping {
  readonly chain: DiscoveryChain; readonly tokenAddress: string; readonly poolAddress: string;
  readonly tokenSide: "base" | "quote"; readonly network: string; readonly evidenceRef: string; readonly knownAt: number;
}
export interface PostgresControlledPriceOptions {
  readonly generationId: string; readonly activatedAt: number; readonly providerId: string;
  /** Inject the durable PG-global provider guard; never a per-process rate-limit substitute. */
  readonly fetch: typeof globalThis.fetch; readonly baseUrl: string;
  readonly timeoutMs: number; readonly minimumRequestIntervalMs: number; readonly rateLimitCooldownMs: number;
  readonly maximumRunMs: number; readonly maximumPayloadBytes: number; readonly maximumCandles: number;
  readonly maximumWindowMs: number; readonly maximumMappingAgeMs: number;
  readonly timeframe: "minute" | "hour" | "day"; readonly aggregate: number; readonly now: () => number;
}
export interface PostgresGeckoTerminalPriceCandidate {
  readonly kind?: "candle";
  readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
  readonly providerId: string; readonly boughtAt: number; readonly until: number; readonly knownAt: number;
  readonly mapping: PostgresPricePoolMapping; readonly candles: readonly GeckoTerminalOhlcvCandle[];
  readonly contentFingerprint: string; readonly coverage: "bounded_observations_only";
}
export function createPostgresGeckoTerminalPriceProducer(options: PostgresControlledPriceOptions) {
  const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const identity = (value: string) => typeof value === "string" && !!value.trim() && value.length <= 512 && !value.includes("://");
  if (!identity(options.generationId) || !identity(options.providerId) || !validTime(options.activatedAt)
    || typeof options.fetch !== "function") throw new Error("Explicit reviewed price source required");
  const url = new URL(options.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Approved credential-free HTTPS price origin required");
  for (const value of [options.timeoutMs, options.rateLimitCooldownMs, options.maximumRunMs, options.maximumPayloadBytes,
    options.maximumCandles, options.maximumWindowMs, options.maximumMappingAgeMs, options.aggregate]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Explicit bounded price budget required");
  }
  if (!validTime(options.minimumRequestIntervalMs) || options.maximumCandles > 1000 || options.maximumPayloadBytes > 10_000_000
    || options.maximumRunMs > 2_147_483_647 || !["minute", "hour", "day"].includes(options.timeframe)) throw new Error("Invalid bounded price options");
  const candleMs = ({ minute: 60_000, hour: 3_600_000, day: 86_400_000 })[options.timeframe] * options.aggregate;
  if (!Number.isSafeInteger(candleMs)) throw new Error("Unsafe candle interval");
  let busy = false;
  return Object.freeze({
    async acquire(input: { readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
      readonly boughtAt: number; readonly until: number; readonly mapping: PostgresPricePoolMapping; readonly signal: AbortSignal }): Promise<
      { readonly status: "acquired"; readonly candidate: PostgresGeckoTerminalPriceCandidate }
      | { readonly status: "deferred"; readonly reasonCode: string }> {
      const deferred = (reasonCode: string) => ({ status: "deferred" as const, reasonCode });
      if (busy) return deferred("price_producer_busy");
      const asOf = options.now(), mapping = structuredClone(input.mapping);
      if (input.generationId !== options.generationId || !identity(input.sampleId) || !/^[a-f0-9]{64}$/.test(input.executionFingerprint)
        || !validTime(asOf) || !validTime(input.boughtAt) || !validTime(input.until) || input.boughtAt < options.activatedAt
        || input.until <= input.boughtAt || input.until > asOf || input.until - input.boughtAt > options.maximumWindowMs
        || !validTime(mapping.knownAt) || mapping.knownAt > asOf || asOf - mapping.knownAt > options.maximumMappingAgeMs
        || !identity(mapping.evidenceRef) || !identity(mapping.tokenAddress) || !identity(mapping.poolAddress)
        || !identity(mapping.network) || !["base", "quote"].includes(mapping.tokenSide)) return deferred("price_mapping_or_range_unavailable");
      busy = true;
      const controller = new AbortController(), abort = () => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
      const timer = setTimeout(abort, options.maximumRunMs);
      let onAbort: () => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("price_deadline")); controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        const acquire = async () => {
          let sourceBytes = 0;
          const fetch: typeof globalThis.fetch = async (request, init) => {
            controller.signal.throwIfAborted();
            const requestSignal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
            const response = await options.fetch(request, { ...init, signal: requestSignal });
            const reader = response.body?.getReader(); const chunks: Uint8Array[] = [];
            try {
              if (reader) while (true) {
                requestSignal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
                sourceBytes += next.value.byteLength;
                if (sourceBytes > options.maximumPayloadBytes) throw new Error("price_source_bytes_exceeded");
                chunks.push(next.value);
              }
            } catch (error) { await reader?.cancel().catch(() => undefined); throw error; }
            finally { reader?.releaseLock(); }
            return new Response(response.body === null ? null : Buffer.concat(chunks),
              { status: response.status, statusText: response.statusText, headers: response.headers });
          };
          // A fresh client avoids calling a process-local cached response newly collected provider coverage.
          const client = createGeckoTerminalClient({ fetch, baseUrl: options.baseUrl, timeoutMs: options.timeoutMs,
            minimumRequestIntervalMs: options.minimumRequestIntervalMs, rateLimitCooldownMs: options.rateLimitCooldownMs, now: options.now });
          const pool = await client.topPool(mapping.chain, mapping.tokenAddress, controller.signal);
          const same = (left: string, right: string) => mapping.chain === "solana" ? left === right : left.toLowerCase() === right.toLowerCase();
          if (!pool || !same(pool.tokenAddress, mapping.tokenAddress) || !same(pool.poolAddress, mapping.poolAddress)
            || pool.tokenSide !== mapping.tokenSide || pool.network !== mapping.network) return deferred("actual_pool_token_mapping_mismatch");
          const observations = await client.ohlcv(mapping.chain, mapping.poolAddress, { timeframe: options.timeframe,
            aggregate: options.aggregate, tokenSide: mapping.tokenSide, beforeTimestamp: input.until, limit: options.maximumCandles }, controller.signal);
          controller.signal.throwIfAborted();
          if (observations.length > options.maximumCandles) return deferred("price_candle_budget_exceeded");
          const distinct = new Map<number, GeckoTerminalOhlcvCandle>();
          for (const candle of observations) {
            if (!validTime(candle.timestamp) || !Number.isSafeInteger(candle.timestamp + candleMs)
              || ![candle.open, candle.high, candle.low, candle.close, candle.volumeUsd].every(Number.isFinite)
              || candle.low <= 0 || candle.volumeUsd < 0 || candle.high < Math.max(candle.open, candle.close)
              || candle.low > Math.min(candle.open, candle.close)) return deferred("malformed_actual_candle");
            if (candle.timestamp < input.boughtAt || candle.timestamp + candleMs > input.until) continue;
            const previous = distinct.get(candle.timestamp);
            if (previous && JSON.stringify(previous) !== JSON.stringify(candle)) return deferred("conflicting_candle_observation");
            distinct.set(candle.timestamp, candle);
          }
          if (!distinct.size) return deferred("no_closed_post_purchase_candles");
          const candles = [...distinct.values()].sort((a, b) => a.timestamp - b.timestamp);
          const knownAt = options.now();
          if (!validTime(knownAt) || knownAt < asOf) return deferred("price_clock_regressed");
          const semantic = { generationId: options.generationId, sampleId: input.sampleId, executionFingerprint: input.executionFingerprint,
            providerId: options.providerId, boughtAt: input.boughtAt, until: input.until, mapping, candles };
          return { status: "acquired" as const, candidate: { ...semantic, knownAt,
            contentFingerprint: createHash("sha256").update(JSON.stringify(semantic)).digest("hex"), coverage: "bounded_observations_only" as const } };
        };
        return await Promise.race([acquire(), stopped]);
      } catch { return deferred("price_acquisition_unavailable"); }
      finally { controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort); busy = false; }
    },
  });
}

export interface PostgresReportedMarketCapReport {
  readonly marketCapUsd: string;
  readonly fdvUsd: string | null;
  readonly reportedAt: number;
  readonly quoteAddress: string;
  readonly quality: 'reported';
  readonly independence: 'unverified';
  readonly conflictState: 'unassessed';
  readonly sourceProtocol: 'ave_token_market_cap_v1';
  readonly sourceEvidence: AveTokenCandidate;
}
export interface PostgresReportedMarketCapCandidate {
  readonly kind: 'reported_market_cap';
  readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
  readonly providerId: string; readonly sourceApprovalRef: string;
  readonly boughtAt: number; readonly until: number; readonly knownAt: number;
  readonly mapping: PostgresPricePoolMapping;
  readonly report: PostgresReportedMarketCapReport;
  readonly contentFingerprint: string;
  readonly coverage: 'reported_snapshot_only';
}
export type PostgresPriceCandidate = PostgresGeckoTerminalPriceCandidate | PostgresReportedMarketCapCandidate;
export interface PostgresReportedMarketCapClient {
  tokenDetail(identity: AveIdentity, signal?: AbortSignal): Promise<AveTokenCandidate | AveDeferred>;
}
export interface PostgresReportedMarketCapProducerOptions {
  readonly generationId: string; readonly activatedAt: number; readonly providerId: string; readonly sourceApprovalRef: string;
  readonly identity: AveIdentity;
  /** Trusted composition supplies the already budget/lease-bound client, never candidate-controlled transport. */
  readonly client: PostgresReportedMarketCapClient;
  readonly maximumRunMs: number; readonly maximumPayloadBytes: number; readonly maximumWindowMs: number;
  readonly maximumMappingAgeMs: number; readonly now: () => number;
}
function sameReportedAddress(left: string, right: string, chain: string): boolean {
  return chain === 'solana' ? left === right : left.toLowerCase() === right.toLowerCase();
}
/** Pure candidate normalization. Does not grant source authority or circulating-supply verification. */
export function normalizeAveReportedMarketCap(raw: AveTokenCandidate, expected: AveIdentity): PostgresReportedMarketCapReport {
  if (raw.status !== 'candidate' || raw.verified !== false || raw.independence !== 'unverified'
    || raw.circulatingMarketCapVerified !== false || raw.identity.chain !== expected.chain
    || !['eth', 'bsc', 'base', 'solana'].includes(expected.chain)
    || ![raw.identity.token, raw.identity.pool, raw.identity.quote].every((value, index) => typeof value === 'string'
      && sameReportedAddress(value, [expected.token, expected.pool, expected.quote][index]!, expected.chain))
    || typeof raw.reportedMarketCap !== 'number' || !Number.isFinite(raw.reportedMarketCap) || raw.reportedMarketCap <= 0
    || !Number.isSafeInteger(raw.reportedUpdatedAt) || raw.reportedUpdatedAt <= 0
    || !Number.isSafeInteger(raw.reportedUpdatedAt * 1000)) throw new Error('Invalid reported market candidate');
  const optional = (value: number | null): string | null => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid reported market number');
    return forwardDecimal(String(value));
  };
  const marketCapUsd = forwardDecimal(String(raw.reportedMarketCap)), fdvUsd = optional(raw.reportedFdv);
  optional(raw.reportedTvl);
  const identity = { ...expected };
  const sourceEvidence: AveTokenCandidate = { status: 'candidate', verified: false, independence: 'unverified', identity,
    reportedMarketCap: raw.reportedMarketCap, reportedFdv: raw.reportedFdv, reportedTvl: raw.reportedTvl,
    reportedUpdatedAt: raw.reportedUpdatedAt, circulatingMarketCapVerified: false,
    amm: typeof raw.amm === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.amm) ? raw.amm : null };
  return { marketCapUsd, fdvUsd, reportedAt: raw.reportedUpdatedAt * 1000, quoteAddress: expected.quote,
    quality: 'reported', independence: 'unverified', conflictState: 'unassessed', sourceProtocol: 'ave_token_market_cap_v1', sourceEvidence };
}
export function reportedMarketCapCandidateFingerprint(candidate: PostgresReportedMarketCapCandidate): string {
  return createHash('sha256').update(JSON.stringify({ kind: candidate.kind, generationId: candidate.generationId,
    sampleId: candidate.sampleId, executionFingerprint: candidate.executionFingerprint, providerId: candidate.providerId,
    sourceApprovalRef: candidate.sourceApprovalRef, boughtAt: candidate.boughtAt, until: candidate.until,
    mapping: candidate.mapping, report: candidate.report, coverage: candidate.coverage })).digest('hex');
}
export function createPostgresReportedMarketCapProducer(inputOptions: PostgresReportedMarketCapProducerOptions) {
  const options = { ...inputOptions, identity: structuredClone(inputOptions.identity),
    client: { tokenDetail: inputOptions.client.tokenDetail.bind(inputOptions.client) } };
  const identifier = (value: string) => typeof value === 'string' && !!value.trim() && value.length <= 512 && !value.includes('://');
  const time = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (![options.generationId, options.providerId, options.sourceApprovalRef].every(identifier) || !time(options.activatedAt)
    || !['solana', 'eth', 'bsc', 'base'].includes(options.identity.chain) || typeof options.now !== 'function'
    || ![options.maximumRunMs, options.maximumPayloadBytes, options.maximumWindowMs, options.maximumMappingAgeMs].every(value => Number.isSafeInteger(value) && value > 0)
    || options.maximumRunMs > 2_147_483_647 || options.maximumPayloadBytes > 10_000_000) throw new Error('Explicit bounded reported market source required');
  let active = false, outstanding = false;
  return Object.freeze({
    async acquire(request: { readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string;
      readonly boughtAt: number; readonly until: number; readonly mapping: PostgresPricePoolMapping; readonly signal: AbortSignal }): Promise<
        { readonly status: 'acquired'; readonly candidate: PostgresReportedMarketCapCandidate } | { readonly status: 'deferred'; readonly reasonCode: string }> {
      const defer = (reasonCode: string) => ({ status: 'deferred' as const, reasonCode });
      if (active || outstanding) return defer('reported_market_producer_busy');
      if (request.signal.aborted) return defer('reported_market_aborted_or_timed_out');
      const { signal: parent, ...value } = request;
      const input = structuredClone(value), started = options.now(), map = input.mapping;
      if (input.generationId !== options.generationId || !identifier(input.sampleId) || !/^[a-f0-9]{64}$/.test(input.executionFingerprint)
        || ![started, input.boughtAt, input.until, map.knownAt].every(time) || input.boughtAt < options.activatedAt
        || input.until <= input.boughtAt || input.until > started || input.until - input.boughtAt > options.maximumWindowMs
        || map.knownAt > started || started - map.knownAt > options.maximumMappingAgeMs || !identifier(map.evidenceRef)
        || map.chain !== options.identity.chain || !sameReportedAddress(map.tokenAddress, options.identity.token, map.chain)
        || !sameReportedAddress(map.poolAddress, options.identity.pool, map.chain)) return defer('reported_market_mapping_or_range_unavailable');
      active = true;
      const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
      let onAbort: () => void = () => {};
      const stopped = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('reported_market_deadline')); signal.addEventListener('abort', onAbort, { once: true }); });
      const timer = setTimeout(() => controller.abort(), options.maximumRunMs);
      try {
        outstanding = true;
        let source: Promise<AveTokenCandidate | AveDeferred>;
        try { source = options.client.tokenDetail({ ...options.identity }, signal).finally(() => { outstanding = false; }); }
        catch (error) { outstanding = false; throw error; }
        const raw = await Promise.race([source, stopped]); signal.throwIfAborted();
        if (raw.status !== 'candidate') return defer('reported_market_source_unavailable');
        const report = normalizeAveReportedMarketCap(raw, options.identity), knownAt = options.now();
        if (!time(knownAt) || knownAt < started || knownAt - started >= options.maximumRunMs
          || report.reportedAt < input.boughtAt || report.reportedAt > input.until) return defer('reported_market_snapshot_time_unavailable');
        const semantic: PostgresReportedMarketCapCandidate = { kind: 'reported_market_cap', generationId: options.generationId,
          sampleId: input.sampleId, executionFingerprint: input.executionFingerprint, providerId: options.providerId,
          sourceApprovalRef: options.sourceApprovalRef, boughtAt: input.boughtAt, until: input.until, knownAt,
          mapping: map, report, coverage: 'reported_snapshot_only', contentFingerprint: '' };
        const candidate = { ...semantic, contentFingerprint: reportedMarketCapCandidateFingerprint(semantic) };
        if (Buffer.byteLength(JSON.stringify(candidate)) > options.maximumPayloadBytes) return defer('reported_market_payload_budget');
        return { status: 'acquired', candidate };
      } catch { return defer(signal.aborted ? 'reported_market_aborted_or_timed_out' : 'reported_market_source_unavailable'); }
      finally { clearTimeout(timer); controller.abort(); signal.removeEventListener('abort', onAbort); active = false; }
    },
  });
}
