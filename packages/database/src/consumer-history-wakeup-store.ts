import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function initializeConsumerHistoryWakeupSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS consumer_history_wakeup_receipts (
    consumer_id TEXT NOT NULL, token_id TEXT NOT NULL,
    observed_fingerprint TEXT, dispatched_fingerprint TEXT,
    checked_at INTEGER NOT NULL, dispatched_at INTEGER,
    PRIMARY KEY(consumer_id,token_id)
  ); CREATE INDEX IF NOT EXISTS consumer_history_wakeup_checked
    ON consumer_history_wakeup_receipts(checked_at,consumer_id,token_id);`);
}

export function consumerHistoryFingerprint(database: DatabaseSync, tokenId: string, fromAt: number, toAt: number): string | null {
  const separator = tokenId.indexOf(":");
  const chain = tokenId.slice(0,separator);
  const address = tokenId.slice(separator+1);
  const rows = database.prepare(`SELECT observed_at observedAt,price_usd priceUsd,source
    FROM market_observations WHERE chain=? AND ${chain === "solana" ? "token_address" : "LOWER(token_address)"}=?
      AND observed_at >= ? AND observed_at <= ? AND price_usd>0 AND source IS NOT NULL AND length(trim(source))>0
    ORDER BY observed_at,source,price_usd`).all(chain,address,fromAt,toAt)
    .filter(row => Number.isSafeInteger(row.observedAt) && Number.isFinite(row.priceUsd));
  if (!rows.length) return null;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function recordConsumerHistoryObservation(database: DatabaseSync, consumerId: string, tokenId: string, fingerprint: string | null, at: number): void {
  database.prepare(`INSERT INTO consumer_history_wakeup_receipts(consumer_id,token_id,observed_fingerprint,checked_at)
    VALUES(?,?,?,?) ON CONFLICT(consumer_id,token_id) DO UPDATE SET
      observed_fingerprint=excluded.observed_fingerprint,checked_at=excluded.checked_at`)
    .run(consumerId,tokenId,fingerprint,at);
}

export function recordConsumerHistoryDispatch(database: DatabaseSync, consumerId: string, tokenId: string, fingerprint: string, at: number): void {
  database.prepare(`UPDATE consumer_history_wakeup_receipts SET dispatched_fingerprint=?,dispatched_at=?
    WHERE consumer_id=? AND token_id=?`).run(fingerprint,at,consumerId,tokenId);
}
