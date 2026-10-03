import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalForwardTargetChannelFact, forwardTargetIdentityTrusted, normalizeWalletAddress,
  type ChainFamily, type ForwardTargetChannel, type ForwardTargetChannelFact, type IdentityConfidence } from "@address-radar/domain";
import { TRUSTED_ACCOUNT_WALLET_SQL } from "./identity-trust.js";

export interface LegacyForwardTargetLookup {
  readonly entityId: string;
  readonly channel: ForwardTargetChannel;
  readonly subjectId: string;
  readonly walletFamily: ChainFamily | null;
  readonly capturedAt: number;
}
export interface LegacyForwardTargetSnapshot {
  readonly fact: ForwardTargetChannelFact;
  readonly sourceObservedAt: number;
  readonly capturedAt: number;
  readonly sourceFingerprint: string;
  readonly proofScope: "legacy_registry_linkage";
}
type SourceRow = { associationConfidence: IdentityConfidence; associationSource: string;
  walletConfidence: IdentityConfidence | null; walletSource: string | null;
  associationAt: number; walletAt: number; entityAt: number; profileAt: number;
  monitoringEnabled: number; channelEnabled: number; lifecycle: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid legacy identity source clock"); return value; };

export const createLegacyForwardTargetSnapshotReader = (databasePath: string) => {
  if (!databasePath.trim() || databasePath === ":memory:") throw new Error("A persisted identity source is required");
  return { read(input: LegacyForwardTargetLookup): LegacyForwardTargetSnapshot | null {
    timestamp(input.capturedAt);
    if (!input.entityId.trim() || !input.subjectId.trim()) throw new Error("Identity subject is required");
    if (input.channel !== "fomo" && input.channel !== "wallet") throw new Error("Invalid identity channel");
    if (input.channel === "fomo" ? input.walletFamily !== null : !["evm", "solana"].includes(input.walletFamily ?? "")) throw new Error("Invalid identity family");
    const subjectId = input.channel === "wallet" ? normalizeWalletAddress(input.walletFamily!, input.subjectId) : input.subjectId.trim();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("BEGIN");
      let candidates: SourceRow[];
      let owners: Array<{ entityId: string }>;
      let pendingConflict = false;
      if (input.channel === "fomo") {
        const association = database.prepare(`SELECT ea.confidence AS associationConfidence, ea.source AS associationSource,
          NULL AS walletConfidence, NULL AS walletSource, ea.last_observed_at AS associationAt, 0 AS walletAt,
          e.updated_at AS entityAt, COALESCE(p.updated_at,0) AS profileAt,
          COALESCE(p.monitoring_enabled,0) AS monitoringEnabled, COALESCE(p.fomo_monitoring_enabled,0) AS channelEnabled, e.lifecycle
          FROM entity_accounts ea JOIN fomo_accounts f ON f.account_id=ea.account_id JOIN trader_entities e ON e.entity_id=ea.entity_id
          LEFT JOIN trader_profiles p ON p.entity_id=e.entity_id WHERE ea.entity_id=? AND ea.account_id=?`).get(input.entityId, subjectId) as SourceRow | undefined;
        if (!association) return null;
        const wallet = database.prepare(`SELECT w.confidence AS confidence,w.source,w.last_observed_at AS observedAt
          FROM entity_accounts ea JOIN wallet_identities w ON w.account_id=ea.account_id
          WHERE ea.entity_id=? AND ea.account_id=? AND ${TRUSTED_ACCOUNT_WALLET_SQL}
          ORDER BY w.confidence='confirmed' DESC,w.chain_family,w.address LIMIT 1`).get(input.entityId, subjectId) as { confidence: IdentityConfidence; source: string; observedAt: number } | undefined;
        candidates = [{ ...association, walletConfidence: wallet?.confidence ?? null, walletSource: wallet?.source ?? null, walletAt: wallet?.observedAt ?? 0 }];
        owners = database.prepare("SELECT DISTINCT entity_id AS entityId FROM entity_accounts WHERE account_id=? ORDER BY entity_id LIMIT 1001").all(subjectId) as Array<{ entityId: string }>;
      } else {
        candidates = database.prepare(`SELECT ea.confidence AS associationConfidence,ea.source AS associationSource,
          w.confidence AS walletConfidence,w.source AS walletSource,ea.last_observed_at AS associationAt,w.last_observed_at AS walletAt,
          e.updated_at AS entityAt,COALESCE(p.updated_at,0) AS profileAt,COALESCE(p.monitoring_enabled,0) AS monitoringEnabled,
          COALESCE(p.onchain_monitoring_enabled,0) AS channelEnabled,e.lifecycle
          FROM entity_accounts ea JOIN wallet_identities w ON w.account_id=ea.account_id JOIN trader_entities e ON e.entity_id=ea.entity_id
          LEFT JOIN trader_profiles p ON p.entity_id=e.entity_id WHERE ea.entity_id=? AND w.chain_family=? AND w.address=?
          UNION ALL SELECT ew.confidence,ew.source,ew.confidence,ew.source,ew.last_observed_at,ew.last_observed_at,
          e.updated_at,COALESCE(p.updated_at,0),COALESCE(p.monitoring_enabled,0),COALESCE(p.onchain_monitoring_enabled,0),e.lifecycle
          FROM entity_wallet_identities ew JOIN trader_entities e ON e.entity_id=ew.entity_id LEFT JOIN trader_profiles p ON p.entity_id=e.entity_id
          WHERE ew.entity_id=? AND ew.chain_family=? AND ew.address=? LIMIT 1001`).all(input.entityId, input.walletFamily, subjectId, input.entityId, input.walletFamily, subjectId) as SourceRow[];
        if (!candidates.length) return null;
        owners = database.prepare(`SELECT DISTINCT entityId FROM (
          SELECT ea.entity_id AS entityId FROM entity_accounts ea JOIN wallet_identities w ON w.account_id=ea.account_id WHERE w.chain_family=? AND w.address=?
          UNION SELECT entity_id FROM entity_wallet_identities WHERE chain_family=? AND address=?
          ) ORDER BY entityId LIMIT 1001`).all(input.walletFamily, subjectId, input.walletFamily, subjectId) as Array<{ entityId: string }>;
        pendingConflict = Boolean(database.prepare("SELECT 1 FROM wallet_identity_conflicts WHERE chain_family=? AND address=? AND status='pending' LIMIT 1").get(input.walletFamily, subjectId));
      }
      if (candidates.length > 1000 || owners.length > 1000) throw new Error("Legacy identity proof budget exceeded");
      const factFor = (row: SourceRow, identityEvidenceRef: string | null, ownershipEvidenceRef: string | null) => canonicalForwardTargetChannelFact({
        entityId: input.entityId, channel: input.channel, subjectId, walletFamily: input.walletFamily,
        associationConfidence: row.associationConfidence, associationSource: row.associationSource, ownerCount: owners.length,
        walletConfidence: row.walletConfidence, walletSource: row.walletSource, identityEvidenceRef, ownershipEvidenceRef,
        monitoringEnabled: row.monitoringEnabled === 1 && row.channelEnabled === 1, suspended: row.lifecycle === "suspended",
      });
      candidates.sort((a,b) => Number(forwardTargetIdentityTrusted(factFor(b,"snapshot","snapshot"))) - Number(forwardTargetIdentityTrusted(factFor(a,"snapshot","snapshot")))
        || JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const row = candidates[0]!;
      const sourceObservedAt = Math.max(...[row.associationAt,row.walletAt,row.entityAt,row.profileAt].map(timestamp));
      if (sourceObservedAt > input.capturedAt) throw new Error("Legacy identity source clock is in the future");
      const sourceFingerprint = digest({ entityId: input.entityId, channel: input.channel, subjectId, walletFamily: input.walletFamily, row, owners, pendingConflict });
      const fact = factFor(row, pendingConflict ? null : `legacy-identity:${sourceFingerprint}`, pendingConflict ? null : `legacy-ownership:${sourceFingerprint}`);
      return { fact, sourceObservedAt, capturedAt: input.capturedAt, sourceFingerprint, proofScope: "legacy_registry_linkage" };
    } finally {
      try { database.exec("ROLLBACK"); } finally { database.close(); }
    }
  } };
};
