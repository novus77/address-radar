import { createHash } from "node:crypto";
import { canonicalForwardTargetChannelFact, forwardTargetIdentityTrusted, forwardTargetSubjectKey } from "../../../packages/domain/src/forward-target-authorization.js";
import type { IdentityConfidence } from "../../../packages/domain/src/model.js";
import type { PostgresCohortProjection } from "./postgres-cohort-import.js";

export interface AddressOnlySourcePin {
  readonly kind: "address_only_registry";
  readonly seedSha256: string;
  readonly capturedAt: number;
}
export interface AddressOnlyReview {
  readonly importId: string; readonly approvalRef: string; readonly actorId: string;
  readonly actorAuthorizationRef: string; readonly generationId: string; readonly importedAt: number;
  readonly seedSha256: string;
}
const demand: (condition: unknown, reason: string) => asserts condition = (condition, reason) => {
  if (!condition) throw new Error("address_only_" + reason);
};
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f]/.test(value);
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  demand(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_object");
  return value as Row;
}
function index(rows: readonly Row[], field: string): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const key = row[field]; demand(identifier(key) && !result.has(key), "duplicate_or_invalid_" + field);
    result.set(key, row);
  }
  return result;
}
/** Pure seed projection. Review authorization and final source fencing remain parent gate duties. */
export function projectAddressOnlySeed(raw: string, review: AddressOnlyReview): {
  source: AddressOnlySourcePin; profiles: readonly PostgresCohortProjection[];
} {
  demand(Buffer.byteLength(raw) <= 4 * 1024 * 1024, "seed_budget");
  demand(/^[0-9a-f]{64}$/.test(review.seedSha256) && hash(raw) === review.seedSha256, "seed_digest_mismatch");
  demand([review.importId, review.approvalRef, review.actorId, review.actorAuthorizationRef, review.generationId].every(identifier), "review_identifiers");
  const seed = object(JSON.parse(raw));
  demand(seed.format === "address-only-seed-v1", "seed_format");
  const rules = object(seed.rules);
  const expectedRules: Row = { historicalEvidenceImported: false, historicalJobsImported: false,
    legacyLifecycleIsNotNewCapabilityProof: true, gatewayDeliveryEnabled: false, activationAuthorizedByExport: false };
  demand(Object.keys(rules).length === Object.keys(expectedRules).length && Object.entries(expectedRules).every(([key, value]) => rules[key] === value), "seed_authority");
  const capturedAt = typeof seed.capturedAt === "string" ? Date.parse(seed.capturedAt) : NaN;
  demand(Number.isSafeInteger(capturedAt) && capturedAt >= 0 && Number.isSafeInteger(review.importedAt) && review.importedAt >= capturedAt, "source_clock");
  const tables = object(seed.tables);
  const names = ["fomo_accounts", "wallet_identities", "entity_accounts", "trader_entities", "trader_profiles", "trader_monitoring_policy"];
  demand(Object.keys(tables).length === names.length && names.every(name => Array.isArray(tables[name]) && (tables[name] as unknown[]).length <= 10000), "table_allowlist");
  const rows = (name: string): Row[] => (tables[name] as unknown[]).map(object);
  const accounts = index(rows("fomo_accounts"), "account_id"), entities = index(rows("trader_entities"), "entity_id");
  const settings = index(rows("trader_profiles"), "entity_id"), policies = index(rows("trader_monitoring_policy"), "trader_id");
  demand(entities.size === settings.size && entities.size === policies.size && [...entities.keys()].every(key => settings.has(key) && policies.has(key)), "incomplete_settings");
  const links = index(rows("entity_accounts"), "account_id");
  demand(links.size === accounts.size && [...links].every(([account, link]) => accounts.has(account) && identifier(link.entity_id) && entities.has(link.entity_id) &&
    ["high", "confirmed"].includes(String(link.confidence)) && identifier(link.source)), "unverified_or_ambiguous_link");
  const source: AddressOnlySourcePin = { kind: "address_only_registry", seedSha256: review.seedSha256, capturedAt };
  const subjects = new Set<string>(), usedAccounts = new Set<string>(), usedEntities = new Set<string>();
  const profiles = rows("wallet_identities").map((wallet, ordinal): PostgresCohortProjection => {
    demand(identifier(wallet.account_id) && links.has(wallet.account_id), "orphan_wallet");
    demand((wallet.confidence === "confirmed" && wallet.source === "manual") || (wallet.confidence === "high" && wallet.source === "fomolens_manual"), "unverified_wallet");
    demand(wallet.chain_family === "evm" || wallet.chain_family === "solana", "wallet_family");
    demand(identifier(wallet.address), "wallet_address");
    const link = links.get(wallet.account_id)!, entityId = link.entity_id as string;
    const entity = entities.get(entityId)!, setting = settings.get(entityId)!, policy = policies.get(entityId)!;
    demand(["candidate", "probation", "active", "elite", "degraded", "suspended"].includes(String(entity.lifecycle)), "lifecycle");
    demand(["realtime", "periodic", "lightweight", "off"].includes(String(policy.policy)), "monitoring_policy");
    const flagNames = ["monitoring_enabled", "fomo_monitoring_enabled", "onchain_monitoring_enabled"] as const;
    demand(flagNames.every(key => setting[key] === 0 || setting[key] === 1), "channel_flags");
    const flags = { monitoring_enabled: setting.monitoring_enabled === 1, fomo_monitoring_enabled: setting.fomo_monitoring_enabled === 1,
      onchain_monitoring_enabled: setting.onchain_monitoring_enabled === 1 };
    const suspended = entity.lifecycle === "suspended";
    const rowRef = (table: string, row: Row) => "address-seed:" + review.seedSha256 + ":" + table + ":" + hash(JSON.stringify(row));
    const fact = canonicalForwardTargetChannelFact({ entityId, channel: "wallet", subjectId: wallet.address, walletFamily: wallet.chain_family,
      associationConfidence: link.confidence as IdentityConfidence, associationSource: link.source as string, ownerCount: 1,
      walletConfidence: wallet.confidence, walletSource: wallet.source, identityEvidenceRef: rowRef("entity_accounts", link),
      ownershipEvidenceRef: rowRef("wallet_identities", wallet), monitoringEnabled: flags.onchain_monitoring_enabled, suspended });
    demand(forwardTargetIdentityTrusted(fact), "identity_not_trusted");
    const subjectKey = forwardTargetSubjectKey(fact);
    demand(!subjects.has(subjectKey), "duplicate_or_conflicting_wallet"); subjects.add(subjectKey);
    usedAccounts.add(wallet.account_id); usedEntities.add(entityId);
    const versionId = "address-only:" + hash(JSON.stringify([review, subjectKey]));
    const profile = { wallet: { address: fact.subjectId, accountId: wallet.account_id, entityId,
      lifecycle: suspended ? "suspended" as const : "candidate" as const }, fact, profileEnabled: flags.monitoring_enabled,
      profileSuspended: suspended, monitoringPolicy: policy.policy as "realtime" | "periodic" | "lightweight" | "off",
      bindingState: "owned" as const, versionId };
    const profilePayload = JSON.stringify({ ...profile, provenanceScope: "address_only_registry", provenance: { source, walletOrdinal: ordinal,
      account: accounts.get(wallet.account_id), association: link, wallet, entity, settings: setting, monitoringPolicy: policy,
      grantsBusinessEligibility: false, historicalJobsImported: false } });
    return { subjectKey, versionId, entityId, profile, profilePayload, flags, effectiveAt: capturedAt, knownAt: capturedAt, observedAt: capturedAt };
  });
  demand(profiles.length > 0 && usedAccounts.size === accounts.size && usedEntities.size === entities.size, "orphan_or_empty_registry");
  profiles.sort((a, b) => a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0);
  return { source, profiles };
}
