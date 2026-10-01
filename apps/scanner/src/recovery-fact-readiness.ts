import type { DatabaseSync } from "node:sqlite";
import type { TokenFactStore, TokenFactType } from "@address-radar/database";
import { normalizeAddressRadarTokenAddress } from "@address-radar/domain";
import type { RecoveryPostcondition } from "./recovery-postcondition.js";
import { hasHistoricalPriceCoverage, type HistoricalPriceRange } from "./price-recovery-coverage.js";

export function verifyRecoveryFactReadiness(input: {
  readonly database: DatabaseSync;
  readonly facts: TokenFactStore;
  readonly factType: TokenFactType;
  readonly tokenId: string;
  readonly asOf: number;
  readonly priceRange?: HistoricalPriceRange | null;
}): ReturnType<RecoveryPostcondition["verify"]> {
  if (!validTime(input.asOf)) throw new Error("Recovery asOf must be a non-negative safe integer");
  const deferred = (reasonCode: string): ReturnType<RecoveryPostcondition["verify"]> => {
    const fact = input.facts.fact(input.tokenId, input.factType);
    return fact?.status === "terminal_unavailable"
      ? { status: "terminal", reasonCode: fact.terminalReason ?? "fact_terminal_unavailable" }
      : { status: "deferred", reasonCode };
  };
  const satisfied = (): ReturnType<RecoveryPostcondition["verify"]> => ({ status: "satisfied", producedCount: 1 });
  if (input.factType === "trader_attribution") {
    const wallet = input.database.prepare("SELECT 1 FROM entity_wallet_identities WHERE entity_id=? OR address=? LIMIT 1")
      .get(input.tokenId, input.tokenId);
    return wallet ? satisfied() : deferred("wallet_mapping_not_ready");
  }
  const separator = input.tokenId.indexOf(":");
  if (separator <= 0 || separator === input.tokenId.length - 1) return deferred("invalid_token_id");
  const chain = input.tokenId.slice(0, separator).toLowerCase();
  const address = normalizeAddressRadarTokenAddress(chain, input.tokenId.slice(separator + 1));
  if (input.factType === "price_history") {
    const range = input.priceRange;
    if (!range || !validTime(range.fromAt) || !validTime(range.toAt)
      || range.fromAt > range.toAt || range.toAt > input.asOf) return deferred("historical_market_range_unavailable");
    const rows = input.database.prepare(`SELECT observed_at AS observedAt,price_usd AS priceUsd
      FROM market_observations WHERE chain=? AND token_address=? AND price_usd>0
        AND observed_at BETWEEN ? AND ? ORDER BY observed_at,source`)
      .all(chain, address, Math.max(0, range.fromAt - 3_600_000), range.toAt) as Array<{ observedAt: number; priceUsd: number }>;
    return hasHistoricalPriceCoverage(rows.filter(row => validTime(row.observedAt)).map(row => [row.observedAt, row.priceUsd] as const), range)
      ? satisfied() : deferred("historical_market_coverage_unavailable");
  }
  if (input.factType === "milestone_crossings") {
    const crossing = input.database.prepare(`SELECT 1 FROM token_milestone_crossings
      WHERE token_id=? AND precision!='unavailable' AND typeof(crossed_at)='integer'
        AND crossed_at BETWEEN 0 AND ? AND market_cap_usd>0 AND length(trim(source))>0 LIMIT 1`)
      .get(input.tokenId, input.asOf);
    return crossing ? satisfied() : deferred("historical_milestone_crossing_unavailable");
  }
  if (input.factType === "early_trades") {
    const buy = input.database.prepare(`SELECT 1 FROM canonical_trader_events
      WHERE chain=? AND token_address=? AND side='buy' AND typeof(occurred_at)='integer'
        AND occurred_at BETWEEN 0 AND (
          SELECT MIN(crossed_at) FROM token_milestone_crossings
          WHERE token_id=? AND precision!='unavailable' AND typeof(crossed_at)='integer'
            AND crossed_at BETWEEN 0 AND ? AND market_cap_usd>0 AND length(trim(source))>0
        ) LIMIT 1`).get(chain, address, input.tokenId, input.asOf);
    return buy ? satisfied() : deferred("early_trade_before_milestone_missing");
  }
  if (input.factType === "market_identity") {
    const rows = input.database.prepare(`SELECT price_usd AS priceUsd FROM token_market_snapshots
      WHERE token_id=? AND typeof(observed_at)='integer' AND observed_at BETWEEN 0 AND ?
        AND price_usd>0 ORDER BY observed_at DESC LIMIT 10`).all(input.tokenId, input.asOf) as Array<{ priceUsd: number }>;
    return rows.some(row => Number.isFinite(row.priceUsd)) ? satisfied() : deferred("market_price_unavailable");
  }
  return deferred(`fact_not_ready:${input.factType}`);
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
