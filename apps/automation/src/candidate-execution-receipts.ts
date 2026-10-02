import type { DatabaseSync } from "node:sqlite";

interface ExecutionInput {
  readonly source: string;
  readonly eventId: string;
  readonly revision: number;
  readonly traderId: string;
  readonly side: string;
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly occurredAt: number;
  readonly canonicalEventId: string | null;
  readonly canonicalAmountUsd: number | null;
  readonly canonicalTraderId: string | null;
  readonly canonicalOccurredAt: number | null;
  readonly canonicalSide: string | null;
}

export function candidateExecutionInputs(database: DatabaseSync, tokenId: string, traderId?: string): readonly ExecutionInput[] {
  const separator = tokenId.indexOf(":");
  const chain = tokenId.slice(0, separator).toLowerCase();
  const address = tokenId.slice(separator + 1);
  return database.prepare(`SELECT h.source,h.event_id AS eventId,h.revision,h.entity_id AS traderId,
    e.side,e.amount_usd AS amountUsd,e.price_usd AS priceUsd,e.occurred_at AS occurredAt,
    c.canonical_event_id AS canonicalEventId,c.amount_usd AS canonicalAmountUsd,
    c.entity_id AS canonicalTraderId,c.occurred_at AS canonicalOccurredAt,c.side AS canonicalSide
    FROM trader_execution_heads h JOIN trader_events e ON e.event_id=h.event_id
    LEFT JOIN canonical_trader_event_observations l ON l.observation_id='observation:onchain:' || h.event_id
    LEFT JOIN canonical_trader_events c ON c.canonical_event_id=l.canonical_event_id
    WHERE h.projection_state='applied' AND h.revision>0 AND LOWER(h.chain)=?
      AND CASE WHEN LOWER(h.chain)='solana' THEN h.token_address=? ELSE LOWER(h.token_address)=LOWER(?) END
      AND (? IS NULL OR h.entity_id=?) ORDER BY h.source,h.event_id,c.canonical_event_id`)
    .all(chain,address,address,traderId ?? null,traderId ?? null) as unknown as readonly ExecutionInput[];
}

export function candidateExecutionBasisValid(inputs: readonly ExecutionInput[]): boolean {
  const seen = new Set<string>();
  return inputs.every(input => {
    const key = JSON.stringify([input.source,input.eventId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return input.canonicalEventId !== null && input.traderId === input.canonicalTraderId
      && input.side === input.canonicalSide && input.amountUsd === input.canonicalAmountUsd
      && input.occurredAt === input.canonicalOccurredAt
      && (input.side !== "buy" || (input.priceUsd !== null && Number.isFinite(input.priceUsd) && input.priceUsd > 0));
  });
}

export function candidateExecutionPrices(inputs: readonly ExecutionInput[]): ReadonlyMap<string, number> {
  const prices = new Map<string,number>();
  for (const input of inputs) {
    if (input.side !== "buy" || input.canonicalEventId === null || input.priceUsd === null) continue;
    const prior = prices.get(input.canonicalEventId);
    if (prior !== undefined && prior !== input.priceUsd) throw new Error("candidate_execution_price_conflict");
    prices.set(input.canonicalEventId,input.priceUsd);
  }
  return prices;
}

export function acknowledgeCandidateExecution(database: DatabaseSync, inputs: readonly ExecutionInput[], tokenId: string,
  outcome: "produced" | "no_output", completedAt: number): void {
  const update = database.prepare(`UPDATE execution_revision_requests SET applied_revision=desired_revision,
    dispatched_revision=MAX(dispatched_revision,desired_revision),applied_at=?,last_outcome=?
    WHERE source=? AND event_id=? AND token_id=? AND consumer_type='candidate_evidence'
      AND desired_revision=? AND applied_revision<desired_revision
      AND EXISTS(SELECT 1 FROM trader_execution_heads h WHERE h.source=execution_revision_requests.source
        AND h.event_id=execution_revision_requests.event_id AND h.revision=execution_revision_requests.desired_revision
        AND h.projection_state='applied')`);
  for (const input of inputs) update.run(completedAt, input.side === "buy" ? `candidate_${outcome}` : "candidate_not_applicable",
    input.source,input.eventId,tokenId,input.revision);
}
