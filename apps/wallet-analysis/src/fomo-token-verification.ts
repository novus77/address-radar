import type { DatabaseSync } from "node:sqlite";

import type {
  DiscoveryChain,
  FomoTokenLookupProducer,
  FomoTokenLookupResult,
  FomoTokenLookupResultConsumer,
} from "@address-radar/collectors";
import { withAddressRadarWriteTransaction, type TokenFactStore } from "@address-radar/database";
import { addressRadarTokenId } from "@address-radar/domain";

export const FOMO_HISTORICAL_CHAINS = Object.freeze(["solana", "eth", "bsc", "robinhood", "base"] as const);

const retryDelayMs = (attemptCount: number): number => {
  if (attemptCount <= 0) return 30 * 60_000;
  if (attemptCount === 1) return 2 * 60 * 60_000;
  return 12 * 60 * 60_000;
};

const canonicalChain = (value: string): string => {
  const chain = value.trim().toLowerCase();
  if (chain === "ethereum") return "eth";
  if (chain === "bnb" || chain === "binance") return "bsc";
  return chain;
};

const canonicalAddress = (chain: string, value: string): string => canonicalChain(chain) === "solana" ? value.trim() : value.trim().toLowerCase();

interface VerificationRow {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly attemptCount: number;
}

function inferredStatus(result: FomoTokenLookupResult): NonNullable<FomoTokenLookupResult["verificationStatus"]> {
  if (result.verificationStatus) return result.verificationStatus;
  return result.holderCount > 0 || result.queriedTraderCount > 0 || result.observationCount > 0 ? "confirmed" : "deferred";
}

export function createFomoHistoricalVerificationService(input: {
  readonly database: DatabaseSync;
  readonly producer: FomoTokenLookupProducer;
  readonly consumer: FomoTokenLookupResultConsumer;
  readonly maximumActiveLookups?: number;
  readonly facts?: TokenFactStore;
  readonly onFactUpdated?: (tokenId: string) => void;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const maximumActiveLookups = input.maximumActiveLookups ?? 100;
  if (!Number.isSafeInteger(maximumActiveLookups) || maximumActiveLookups <= 0) throw new Error("maximumActiveLookups must be a positive integer");
  const write = <T>(operation: () => T): T => withAddressRadarWriteTransaction(input.database, operation);

  const applyResult = (result: FomoTokenLookupResult): boolean => {
    const chain = canonicalChain(result.chainId) as DiscoveryChain;
    const tokenAddress = canonicalAddress(chain, result.tokenAddress);
    const tokenId = addressRadarTokenId(chain, tokenAddress);
    if (result.purpose === "milestone_backfill") {
      const completedAt = result.completedAt;
      input.facts?.ensure(tokenId, "early_trades", "token-facts-v1", completedAt);
      const current = input.facts?.fact(tokenId, "early_trades") ?? null;
      if ((result.eventIds?.length ?? 0) > 0 || result.observationCount > 0) {
        if (current?.status === "terminal_unavailable") input.facts?.transition({ tokenId, factType: "early_trades", status: "scheduled", reopenTerminal: true, terminalReason: null, nextAttemptAt: completedAt, strategyVersion: "token-facts-v1", updatedAt: completedAt });
        input.facts?.transition({ tokenId, factType: "early_trades", status: "available", precision: "exact", primarySource: "fomo_lookup", coverageStartAt: null, coverageEndAt: result.beforeAt ?? completedAt, observedAt: completedAt, knownAt: completedAt, nextAttemptAt: null, terminalReason: null, strategyVersion: "token-facts-v1", updatedAt: completedAt });
        input.onFactUpdated?.(tokenId);
      } else if (current && current.status !== "available" && current.status !== "terminal_unavailable") {
        const nextAttemptAt = completedAt + retryDelayMs(current.attemptCount);
        const target = current.status === "missing" ? "scheduled" : "retry_scheduled";
        input.facts?.transition({ tokenId, factType: "early_trades", status: target, nextAttemptAt, strategyVersion: "token-facts-v1", updatedAt: completedAt });
      }
      return true;
    }
    const row = input.database.prepare(`
      SELECT h.token_id AS tokenId, h.chain, h.token_address AS tokenAddress
      FROM historical_tokens h
      WHERE (CASE LOWER(h.chain) WHEN 'ethereum' THEN 'eth' WHEN 'bnb' THEN 'bsc' WHEN 'binance' THEN 'bsc' ELSE LOWER(h.chain) END) = ?
        AND (CASE WHEN LOWER(h.chain) = 'solana' THEN h.token_address ELSE LOWER(h.token_address) END) = ?
      LIMIT 1
    `).get(chain, tokenAddress) as VerificationRow | undefined;
    if (!row) return false;

    const completedAt = result.completedAt;
    const status = inferredStatus(result);
    const exactAddressMatch = result.exactAddressMatch ?? status === "confirmed";
    if (status === "confirmed" && !exactAddressMatch) {
      write(() => input.database.prepare(`
        UPDATE historical_token_verifications
        SET status = 'mismatch', exact_ca_match = 0, history_available = 0,
          provider_token_id = ?, provider_url = ?, last_error = 'fomo_ca_mismatch',
          last_checked_at = ?, next_retry_at = 0, updated_at = ?
        WHERE token_id = ?
      `).run(result.providerTokenId ?? null, result.providerUrl ?? null, completedAt, completedAt, row.tokenId));
      return true;
    }

    if (status === "not_found") {
      const current = input.database.prepare("SELECT consecutive_not_found AS count FROM historical_token_verifications WHERE token_id = ?").get(row.tokenId) as { count: number } | undefined;
      const misses = Number(current?.count ?? 0) + 1;
      write(() => input.database.prepare(`
        UPDATE historical_token_verifications
        SET status = ?, consecutive_not_found = ?, exact_ca_match = 0,
          history_available = 0, last_error = 'fomo_token_not_found', last_checked_at = ?,
          next_retry_at = ?, updated_at = ?
        WHERE token_id = ?
      `).run(misses >= 2 ? "not_found" : "pending", misses, completedAt, misses >= 2 ? 0 : completedAt + retryDelayMs(misses - 1), completedAt, row.tokenId));
      return true;
    }

    if (status === "deferred") {
      write(() => input.database.prepare(`
        UPDATE historical_token_verifications
        SET status = 'deferred', last_error = ?, last_checked_at = ?, next_retry_at = ?, updated_at = ?
        WHERE token_id = ?
      `).run(result.errorCode ?? "fomo_lookup_deferred", completedAt, completedAt + retryDelayMs(1), completedAt, row.tokenId));
      return true;
    }

    if (status === "mismatch") {
      write(() => input.database.prepare(`
        UPDATE historical_token_verifications
        SET status = 'mismatch', exact_ca_match = 0, history_available = 0,
          provider_token_id = ?, provider_url = ?, last_error = ?, last_checked_at = ?,
          next_retry_at = 0, updated_at = ?
        WHERE token_id = ?
      `).run(result.providerTokenId ?? null, result.providerUrl ?? null, result.errorCode ?? "fomo_ca_mismatch", completedAt, completedAt, row.tokenId));
      return true;
    }

    const historyAvailable = result.historyAvailable ?? result.observationCount > 0;
    write(() => input.database.prepare(`
      UPDATE historical_token_verifications
      SET status = 'confirmed', consecutive_not_found = 0, exact_ca_match = 1,
        history_available = ?, provider_token_id = ?, provider_url = ?, last_error = ?,
        last_checked_at = ?, next_retry_at = 0, updated_at = ?
      WHERE token_id = ?
    `).run(historyAvailable ? 1 : 0, result.providerTokenId ?? null, result.providerUrl ?? null,
      historyAvailable ? null : "fomo_history_unavailable", completedAt, completedAt, row.tokenId));
    return true;
  };

  return Object.freeze({
    async runOnce(): Promise<{ readonly processed: boolean; readonly action: "result" | "queued" | "idle" }> {
      const lease = await input.consumer.next();
      if (lease) {
        applyResult(lease.result);
        await input.consumer.complete(lease);
        return Object.freeze({ processed: true, action: "result" as const });
      }

      const timestamp = now();
      const active = input.database.prepare("SELECT COUNT(*) AS count FROM historical_token_verifications WHERE status = 'queued' AND next_retry_at > ?").get(timestamp) as { count: number };
      if (Number(active.count) >= maximumActiveLookups) return Object.freeze({ processed: false, action: "idle" as const });
      const row = input.database.prepare(`
        SELECT h.token_id AS tokenId, h.chain, h.token_address AS tokenAddress, v.attempt_count AS attemptCount
        FROM historical_token_verifications v
        JOIN historical_tokens h ON h.token_id = v.token_id
        WHERE (v.status IN ('pending', 'deferred')
          OR (v.status = 'confirmed' AND COALESCE(v.history_available, 0) = 0)
          OR (v.status = 'queued' AND v.next_retry_at <= ?))
          AND v.next_retry_at <= ?
        ORDER BY h.first_reached_1m_at DESC, v.updated_at, h.token_id
        LIMIT 1
      `).get(timestamp, timestamp) as VerificationRow | undefined;
      if (!row) return Object.freeze({ processed: false, action: "idle" as const });

      await input.producer.enqueue({ chainId: canonicalChain(row.chain), tokenAddress: row.tokenAddress, requestedAt: timestamp });
      write(() => input.database.prepare(`
        UPDATE historical_token_verifications
        SET status = 'queued', attempt_count = attempt_count + 1,
          next_retry_at = ?, updated_at = ?
        WHERE token_id = ?
      `).run(timestamp + retryDelayMs(row.attemptCount), timestamp, row.tokenId));
      return Object.freeze({ processed: true, action: "queued" as const });
    },

    resolveEligibleAddresses(chain: string, addresses: readonly string[]): { readonly pending: number; readonly eligible: readonly string[] } {
      if (!addresses.length) return Object.freeze({ pending: 0, eligible: Object.freeze([]) });
      const rows = input.database.prepare(`
        SELECT h.token_address AS tokenAddress, v.status, v.history_available AS historyAvailable
        FROM historical_tokens h
        JOIN historical_token_verifications v ON v.token_id = h.token_id
        WHERE h.chain = ? AND h.token_address IN (${addresses.map(() => "?").join(",")})
      `).all(chain, ...addresses) as { tokenAddress: string; status: string; historyAvailable: number | null }[];
      const byAddress = new Map(rows.map(row => [canonicalAddress(chain, row.tokenAddress), row]));
      let pending = 0;
      const eligible: string[] = [];
      for (const address of addresses) {
        const row = byAddress.get(canonicalAddress(chain, address));
        if (!row || new Set(["pending", "queued", "deferred"]).has(row.status)) pending += 1;
        else if (row.status === "confirmed" && row.historyAvailable === 1) eligible.push(address);
      }
      return Object.freeze({ pending, eligible: Object.freeze(eligible) });
    },
  });
}
