import { createPostgresForwardTargetAuthorizationRepository, refreshPostgresForwardTargetIdentity, type ForwardTargetDecisionReader,
  type ForwardTargetRefreshKey, type ForwardTargetSourceCheck, type LegacyForwardTargetLookup, type LegacyForwardTargetSnapshot, type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetPrincipal } from "@address-radar/domain";
interface Cursor { readonly entityId: string; readonly subjectKey: string; }
interface RefreshWorkerOptions {
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly source: { read(input: LegacyForwardTargetLookup): LegacyForwardTargetSnapshot | null };
  readonly generationId: string; readonly principal: ForwardTargetPrincipal;
  readonly readAuthorization: ForwardTargetDecisionReader; readonly now: () => number;
  readonly perChannelLimit: number;
}
export function createForwardTargetIdentityRefreshWorker(options: RefreshWorkerOptions) {
  if (!Number.isSafeInteger(options.perChannelLimit) || options.perChannelLimit < 1 || options.perChannelLimit > 1000) throw new Error("Explicit bounded per-channel identity budget required");
  const refresh = async (key: ForwardTargetRefreshKey, asOf: number) => {
    let source: ForwardTargetSourceCheck;
    try { const snapshot = options.source.read({ ...key, capturedAt: asOf }); source = snapshot ? { status: "available", snapshot } : { status: "missing" }; }
    catch { source = { status: "unavailable" }; }
    return options.run(transaction => refreshPostgresForwardTargetIdentity(transaction, { query: { ...key, generationId: options.generationId, asOf },
      source, principal: options.principal, readAuthorization: options.readAuthorization }));
  };
  return Object.freeze({ refresh, async tick(cursors: { readonly fomo: Cursor | null; readonly wallet: Cursor | null }) {
    const asOf = options.now();
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error("Invalid identity refresh worker clock");
    const pages = await options.run(async transaction => {
      const repository = createPostgresForwardTargetAuthorizationRepository(transaction);
      return { fomo: await repository.page({ channel: "fomo", asOf, limit: options.perChannelLimit, after: cursors.fomo }),
        wallet: await repository.page({ channel: "wallet", asOf, limit: options.perChannelLimit, after: cursors.wallet }) };
    });
    const results: Awaited<ReturnType<typeof refresh>>[] = [];
    for (let index = 0; index < Math.max(pages.fomo.facts.length,pages.wallet.facts.length); index += 1) {
      for (const page of [pages.fomo,pages.wallet]) {
        const fact = page.facts[index]; if (fact) results.push(await refresh(fact, asOf));
      }
    }
    return { checkedAt: asOf, processed: results.length, verified: results.filter(result => result.status === "verified").length,
      sourceMissing: results.filter(result => result.status === "source_missing").length,
      sourceUnavailable: results.filter(result => result.status === "source_unavailable").length,
      nextCursors: { fomo: pages.fomo.nextCursor, wallet: pages.wallet.nextCursor }, results };
  } });
}
