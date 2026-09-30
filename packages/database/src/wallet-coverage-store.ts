import type { DatabaseSync } from "node:sqlite";

export type WalletCoverageStatus = "pending" | "running" | "healthy" | "degraded" | "blocked" | "complete" | "unsupported";

export interface WalletChainCoverage {
  readonly identityId: string;
  readonly chain: string;
  readonly provider: string;
  readonly status: WalletCoverageStatus;
  readonly cursor: string | null;
  readonly coverageStartAt: number | null;
  readonly coverageEndAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly diagnostic: unknown;
  readonly updatedAt: number;
}

const decode = (row: Record<string, unknown>): WalletChainCoverage => Object.freeze({
  identityId: String(row.identity_id),
  chain: String(row.chain),
  provider: String(row.provider),
  status: row.status as WalletCoverageStatus,
  cursor: row.cursor as string | null,
  coverageStartAt: row.coverage_start_at as number | null,
  coverageEndAt: row.coverage_end_at as number | null,
  lastSuccessAt: row.last_success_at as number | null,
  diagnostic: row.diagnostic_json === null ? null : JSON.parse(String(row.diagnostic_json)),
  updatedAt: Number(row.updated_at),
});

export function initializeWalletCoverageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS wallet_chain_coverage (
      identity_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','healthy','degraded','blocked','complete','unsupported')),
      cursor TEXT,
      coverage_start_at INTEGER,
      coverage_end_at INTEGER,
      last_success_at INTEGER,
      diagnostic_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(identity_id, chain, provider),
      CHECK(coverage_start_at IS NULL OR coverage_end_at IS NULL OR coverage_start_at <= coverage_end_at)
    );
    CREATE INDEX IF NOT EXISTS wallet_chain_coverage_status
      ON wallet_chain_coverage(chain, status, updated_at);
    CREATE INDEX IF NOT EXISTS wallet_chain_coverage_stale
      ON wallet_chain_coverage(status, last_success_at, updated_at);
  `);
}

export function createWalletCoverageStore(database: DatabaseSync) {
  const get = (identityId: string, chain: string, provider: string): WalletChainCoverage | null => {
    const row = database.prepare(`
      SELECT * FROM wallet_chain_coverage WHERE identity_id=? AND chain=? AND provider=?
    `).get(identityId, chain, provider) as Record<string, unknown> | undefined;
    return row ? decode(row) : null;
  };

  return Object.freeze({
    get,
    upsert(input: Omit<WalletChainCoverage, "diagnostic"> & { readonly diagnostic?: unknown }): WalletChainCoverage {
      if (input.coverageStartAt !== null && input.coverageEndAt !== null && input.coverageStartAt > input.coverageEndAt) {
        throw new Error("Wallet coverage start cannot be after coverage end");
      }
      database.prepare(`
        INSERT INTO wallet_chain_coverage(
          identity_id, chain, provider, status, cursor, coverage_start_at,
          coverage_end_at, last_success_at, diagnostic_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity_id, chain, provider) DO UPDATE SET
          status=excluded.status,
          cursor=excluded.cursor,
          coverage_start_at=excluded.coverage_start_at,
          coverage_end_at=excluded.coverage_end_at,
          last_success_at=excluded.last_success_at,
          diagnostic_json=excluded.diagnostic_json,
          updated_at=excluded.updated_at
      `).run(
        input.identityId, input.chain, input.provider, input.status, input.cursor,
        input.coverageStartAt, input.coverageEndAt, input.lastSuccessAt,
        input.diagnostic === undefined ? null : JSON.stringify(input.diagnostic), input.updatedAt,
      );
      return get(input.identityId, input.chain, input.provider)!;
    },
  });
}
