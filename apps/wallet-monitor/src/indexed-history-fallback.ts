import type { FetchLike } from "@address-radar/collectors";

export function createIndexedHistoryFetch(input: {
  readonly fetch: FetchLike;
  readonly fallbackEndpoint?: string;
  readonly now?: () => number;
}): FetchLike {
  const now = input.now ?? Date.now;
  const fallback = input.fallbackEndpoint ? new URL(input.fallbackEndpoint) : null;
  if (fallback && !["https:", "http:"].includes(fallback.protocol)) throw new Error("Invalid indexed history fallback endpoint");
  let primaryMissingUntil = 0;
  return async (url, options) => {
    let primary: Awaited<ReturnType<FetchLike>> | null = null;
    if (now() >= primaryMissingUntil) {
      primary = await input.fetch(url, options);
      if (primary.status === 404) primaryMissingUntil = now() + 30 * 60_000;
      if (primary.ok || ![404, 408, 429, 500, 502, 503, 504].includes(primary.status)) return primary;
    }
    if (!fallback) return primary ?? new Response(null, { status: 404 });
    if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
    const requested = new URL(String(url));
    const target = new URL(requested.pathname + requested.search, fallback);
    return input.fetch(target, options);
  };
}
