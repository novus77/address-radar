import type { DatabaseSync } from "node:sqlite";

import type {
  TraderAutomationState,
  TraderAutomationTier,
  TraderCoverageState,
  TraderMonitoringPolicy,
} from "@address-radar/domain";

export interface TraderAutomationStateInput extends TraderAutomationState {
  readonly updatedAt: number;
}

export interface TraderCoverageUpdate {
  readonly coverageState: TraderCoverageState;
  readonly lastCoveredAt: number | null;
  readonly nextEvaluationAt: number;
  readonly strategyVersion: string;
  readonly updatedAt: number;
}

export interface TraderAutomationWallet {
  readonly chainFamily: "solana" | "evm";
  readonly address: string;
}

export interface TraderAutomationSubject extends TraderAutomationState {
  readonly accountIds: readonly string[];
  readonly wallets: readonly TraderAutomationWallet[];
}

export interface TraderAutomationStore {
  state(traderId: string): TraderAutomationState | null;
  subjects(): readonly TraderAutomationSubject[];
  saveState(input: TraderAutomationStateInput): void;
  updateCoverage(traderId: string, update: TraderCoverageUpdate): void;
  setMonitoringPolicy(traderId: string, policy: TraderMonitoringPolicy, updatedAt: number): void;
  setTier(traderId: string, tier: TraderAutomationTier, updatedAt: number): void;
}

const toState = (row: Record<string, unknown>): TraderAutomationState => Object.freeze({
  traderId: String(row.trader_id),
  tier: row.tier as TraderAutomationTier,
  coverageState: row.coverage_state as TraderCoverageState,
  monitoringPolicy: row.policy as TraderMonitoringPolicy,
  lastCoveredAt: row.last_covered_at as number | null,
  nextEvaluationAt: Number(row.next_evaluation_at),
  strategyVersion: String(row.strategy_version),
});

export function createTraderAutomationStore(database: DatabaseSync): TraderAutomationStore {
  const state = (traderId: string): TraderAutomationState | null => {
    const row = database.prepare(`
      SELECT coverage.*, monitoring.policy
      FROM trader_coverage_state coverage
      JOIN trader_monitoring_policy monitoring
        ON monitoring.trader_id = coverage.trader_id
      WHERE coverage.trader_id = ?
    `).get(traderId) as Record<string, unknown> | undefined;
    return row ? toState(row) : null;
  };

  return Object.freeze<TraderAutomationStore>({
    state,
    subjects() {
      const states = database.prepare(`
        SELECT coverage.*, monitoring.policy
        FROM trader_coverage_state coverage
        JOIN trader_monitoring_policy monitoring
          ON monitoring.trader_id = coverage.trader_id
        ORDER BY coverage.tier, coverage.next_evaluation_at, coverage.trader_id
      `).all() as Record<string, unknown>[];
      const accounts = database.prepare(`
        SELECT entity_id, account_id FROM entity_accounts ORDER BY entity_id, account_id
      `).all() as Array<{ entity_id: string; account_id: string }>;
      const walletRows = database.prepare(`
        SELECT entity_id, chain_family, address FROM entity_wallet_identities
        UNION ALL
        SELECT ea.entity_id, w.chain_family, w.address
        FROM entity_accounts ea
        JOIN wallet_identities w ON w.account_id = ea.account_id
        ORDER BY entity_id, chain_family, address
      `).all() as Array<{ entity_id: string; chain_family: "solana" | "evm"; address: string }>;
      return Object.freeze(states.map((row) => {
        const traderId = String(row.trader_id);
        const walletKeys = new Set<string>();
        const wallets = walletRows
          .filter((wallet) => wallet.entity_id === traderId)
          .filter((wallet) => {
            const normalized = wallet.chain_family === "evm" ? wallet.address.toLowerCase() : wallet.address;
            const key = `${wallet.chain_family}:${normalized}`;
            if (walletKeys.has(key)) return false;
            walletKeys.add(key);
            return true;
          })
          .map((wallet) => Object.freeze({
            chainFamily: wallet.chain_family,
            address: wallet.chain_family === "evm" ? wallet.address.toLowerCase() : wallet.address,
          }));
        return Object.freeze({
          ...toState(row),
          accountIds: Object.freeze(accounts
            .filter((account) => account.entity_id === traderId)
            .map((account) => account.account_id)),
          wallets: Object.freeze(wallets),
        });
      }));
    },
    saveState(input) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT INTO trader_coverage_state(
            trader_id, tier, coverage_state, last_covered_at,
            next_evaluation_at, strategy_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trader_id) DO UPDATE SET
            tier = excluded.tier,
            coverage_state = excluded.coverage_state,
            last_covered_at = excluded.last_covered_at,
            next_evaluation_at = excluded.next_evaluation_at,
            strategy_version = excluded.strategy_version,
            updated_at = excluded.updated_at
        `).run(
          input.traderId,
          input.tier,
          input.coverageState,
          input.lastCoveredAt,
          input.nextEvaluationAt,
          input.strategyVersion,
          input.updatedAt,
        );
        database.prepare(`
          INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(trader_id) DO UPDATE SET
            policy = excluded.policy,
            updated_at = excluded.updated_at
        `).run(input.traderId, input.monitoringPolicy, input.updatedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    updateCoverage(traderId, update) {
      const result = database.prepare(`
        UPDATE trader_coverage_state
        SET coverage_state = ?, last_covered_at = ?, next_evaluation_at = ?,
          strategy_version = ?, updated_at = ?
        WHERE trader_id = ?
      `).run(
        update.coverageState,
        update.lastCoveredAt,
        update.nextEvaluationAt,
        update.strategyVersion,
        update.updatedAt,
        traderId,
      );
      if (result.changes !== 1) throw new Error(`Unknown trader automation state: ${traderId}`);
    },
    setMonitoringPolicy(traderId, policy, updatedAt) {
      const result = database.prepare(`
        UPDATE trader_monitoring_policy SET policy = ?, updated_at = ? WHERE trader_id = ?
      `).run(policy, updatedAt, traderId);
      if (result.changes !== 1) throw new Error(`Unknown trader monitoring policy: ${traderId}`);
    },
    setTier(traderId, tier, updatedAt) {
      const result = database.prepare(`
        UPDATE trader_coverage_state SET tier = ?, updated_at = ? WHERE trader_id = ?
      `).run(tier, updatedAt, traderId);
      if (result.changes !== 1) throw new Error(`Unknown trader automation state: ${traderId}`);
    },
  });
}
