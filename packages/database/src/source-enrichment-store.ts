import type { DatabaseSync } from "node:sqlite";

import { withAddressRadarWriteTransaction } from "./connection.js";

export interface SourceObservationEnrichment {
  readonly observationId: string;
  readonly revision: number;
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly collectedAt: number;
  readonly provenance: unknown;
  readonly qualityScore: number;
  readonly createdAt: number;
}

const decode = (row: Record<string, unknown>): SourceObservationEnrichment => Object.freeze({
  observationId: String(row.observation_id),
  revision: Number(row.revision),
  amountUsd: row.amount_usd as number | null,
  priceUsd: row.price_usd as number | null,
  collectedAt: Number(row.collected_at),
  provenance: row.provenance_json === null ? null : JSON.parse(String(row.provenance_json)),
  qualityScore: Number(row.quality_score),
  createdAt: Number(row.created_at),
});

export function initializeSourceEnrichmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_observation_enrichments (
      observation_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      amount_usd REAL,
      price_usd REAL,
      collected_at INTEGER NOT NULL,
      provenance_json TEXT,
      quality_score REAL NOT NULL CHECK(quality_score >= 0 AND quality_score <= 1),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(observation_id, revision)
    );
    CREATE INDEX IF NOT EXISTS source_observation_enrichments_latest
      ON source_observation_enrichments(observation_id, revision DESC);
  `);
}

export function createSourceEnrichmentStore(database: DatabaseSync) {
  const latest = (observationId: string): SourceObservationEnrichment | null => {
    const row = database.prepare(`
      SELECT * FROM source_observation_enrichments
      WHERE observation_id=? ORDER BY revision DESC LIMIT 1
    `).get(observationId) as Record<string, unknown> | undefined;
    return row ? decode(row) : null;
  };

  return Object.freeze({
    latest,
    append(input: Omit<SourceObservationEnrichment, "revision">): SourceObservationEnrichment {
      if (!Number.isFinite(input.qualityScore) || input.qualityScore < 0 || input.qualityScore > 1) {
        throw new Error("qualityScore must be between zero and one");
      }
      return withAddressRadarWriteTransaction(database, () => {
        const current = latest(input.observationId);
        const revision = (current?.revision ?? 0) + 1;
        database.prepare(`
          INSERT INTO source_observation_enrichments(
            observation_id, revision, amount_usd, price_usd, collected_at,
            provenance_json, quality_score, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.observationId, revision, input.amountUsd, input.priceUsd, input.collectedAt,
          input.provenance === undefined ? null : JSON.stringify(input.provenance),
          input.qualityScore, input.createdAt,
        );
        return latest(input.observationId)!;
      });
    },
  });
}
