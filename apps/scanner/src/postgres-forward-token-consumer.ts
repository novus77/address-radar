import {
  createPostgresConsumerWorkRepository, createPostgresForwardTokenWatchRepository,
  type CaptureConsumerLease, type PostgresTransaction,
} from "@address-radar/database";

export const FORWARD_TOKEN_CONSUMER = { consumerName: "forward_token_discovery", consumerVersion: "forward-token-v1" } as const;

export async function consumePostgresForwardToken(
  transaction: PostgresTransaction,
  lease: CaptureConsumerLease,
  input: { generationId: string; now: number; retryAt: number },
): Promise<void> {
  const work = createPostgresConsumerWorkRepository(transaction, FORWARD_TOKEN_CONSUMER);
  if (lease.requiresReview) {
    if (!await work.defer(lease, { now: input.now, retryAt: input.retryAt, reasonCode: "source_revision_review" })) {
      throw new Error("Forward token consumer lease was lost");
    }
    return;
  }
  const result = await createPostgresForwardTokenWatchRepository(transaction).discover({
    generationId: input.generationId, sourceJobId: lease.jobId, discoveredAt: input.now,
  });
  const outcome = result.status === "watch_ready"
    ? { outcome: "produced" as const, resultKey: JSON.stringify(["forward-token", result.watch.generationId, result.watch.chain, result.watch.tokenAddress]) }
    : { outcome: "no_output" as const, reasonCode: "non_trade_event" as const };
  if (!await work.complete(lease, outcome, input.now)) throw new Error("Forward token consumer lease was lost");
}
