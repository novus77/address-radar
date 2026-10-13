import { projectAddressOnlySeed, type AddressOnlySourcePin, type AddressOnlyReview } from "./postgres-address-only-plan.js";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { canonicalForwardTargetChannelFact, forwardTargetIdentityTrusted, forwardTargetSubjectKey,
  type ForwardTargetChannelFact } from "../../../packages/domain/src/forward-target-authorization.js";
import type { TraderLifecycle, IdentityConfidence } from "../../../packages/domain/src/model.js";
import type { MigrationProjectionCrosswalk, MigrationProjectionRowLocation,
  MigrationProjectionTrustedSource } from "../../../packages/database/src/migration-projection-crosswalk.js";
import type { FullDataPreservationCell } from "../../../packages/database/src/postgres-full-data-import.js";
import type { PostgresBusinessIdentity } from "../../../packages/database/src/postgres-business-driver.js";
import type { PostgresTransaction, PostgresResult } from "../../../packages/database/src/postgres-unit-of-work.js";
import { createPostgresForwardTargetAuthorizationRepository } from "../../../packages/database/src/forward-target-authorization-store.js";
import type { PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";

export interface PostgresCohortSourcePin extends MigrationProjectionTrustedSource {
  readonly crosswalkSha256: string;
  readonly databaseEncoding: "UTF-8" | "UTF-16le" | "UTF-16be";
}
export interface PostgresCohortAllowlistEntry {
  readonly entityId: string; readonly family: "evm" | "solana"; readonly address: string; readonly accountId: string;
  readonly associationRow: MigrationProjectionRowLocation;
  readonly walletRow: MigrationProjectionRowLocation;
  /** Actual externally reviewed registry references, not generated execution evidence. */
  readonly identityEvidenceRef: string | null; readonly ownershipEvidenceRef: string | null;
  readonly effectiveAt: number; readonly knownAt: number;
}
export interface PostgresCohortReview {
  readonly version: 1; readonly importId: string; readonly approvalRef: string;
  readonly actorId: string; readonly actorAuthorizationRef: string;
  readonly source: PostgresCohortSourcePin; readonly generationId: string;
  readonly sourceWatermark: number; readonly importedAt: number;
  readonly allowlist: readonly PostgresCohortAllowlistEntry[];
}
export interface PostgresCohortProjection {
  readonly subjectKey: string; readonly versionId: string; readonly entityId: string;
  readonly profile: PostgresWalletProfile; readonly profilePayload: string;
  readonly flags: Readonly<Record<"monitoring_enabled" | "fomo_monitoring_enabled" | "onchain_monitoring_enabled", boolean>>;
  readonly effectiveAt: number; readonly knownAt: number; readonly observedAt: number;
}
export interface PostgresCohortImportPlan {
  readonly kind: "cohort_projection"; readonly planSha256: string; readonly reviewedSha256: string;
  readonly importId: string; readonly approvalRef: string; readonly generationId: string; readonly importedAt: number;
  readonly actorId: string; readonly actorAuthorizationRef: string;
  readonly source: PostgresCohortSourcePin | AddressOnlySourcePin; readonly sourceWatermark: number;
  readonly profiles: readonly PostgresCohortProjection[];
  readonly quarantine: readonly { readonly entry: PostgresCohortAllowlistEntry; readonly reason: string }[];
  readonly unsupportedProjections: readonly ["token_projection", "fresh_chain_facts", "stable_qualification"];
  readonly completion: { readonly tokenProjection: false; readonly freshChainFacts: false; readonly allSixServices: false };
  readonly grantsBusinessEligibility: false;
}
export interface PostgresCohortPlanLimits {
  readonly maximumBytes: number; readonly maximumSourceRows: number; readonly maximumCohorts: number; readonly maximumProfiles: number;
}
export const postgresCohortPlanLimits: Readonly<PostgresCohortPlanLimits> = Object.freeze({
  maximumBytes: 64 * 1024 * 1024, maximumSourceRows: 100_000, maximumCohorts: 10_000, maximumProfiles: 10_000,
});
const plans = new WeakSet<object>();
const fail = (reason: string): never => { throw new Error("postgres_cohort_import_" + reason); };
function assert(condition: unknown, reason: string): asserts condition { if (!condition) fail(reason); }
function id(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f]/.test(value);
}
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
/** Canonical bounded JSON; rejects lossy values, cycles, sparse arrays and non-plain objects. */
function serialize(value: unknown, maximumBytes = postgresCohortPlanLimits.maximumBytes): string {
  let bytes = 0, nodes = 0; const parts: string[] = [], active = new Set<object>();
  const add = (part: string) => { bytes += Buffer.byteLength(part); assert(bytes <= maximumBytes, "serialization_budget"); parts.push(part); };
  function visit(item: unknown, depth: number): void {
    assert(depth <= 32 && ++nodes <= 4_000_000, "serialization_budget");
    if (item === null || typeof item === "boolean" || typeof item === "string") { add(JSON.stringify(item)); return; }
    if (typeof item === "number") { assert(Number.isSafeInteger(item), "lossy_number"); add(JSON.stringify(item)); return; }
    assert(item !== null && typeof item === "object" && !active.has(item), "invalid_json_value");
    assert(Object.getOwnPropertySymbols(item).length === 0, "invalid_json_value"); active.add(item);
    if (Array.isArray(item)) {
      assert(Object.keys(item).length === item.length, "invalid_array"); add("[");
      item.forEach((child, index) => { if (index) add(","); visit(child, depth + 1); }); add("]");
    } else {
      assert(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "invalid_json_value");
      add("{"); Object.keys(item).sort().forEach((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        assert(Object.hasOwn(descriptor, "value"), "invalid_json_value");
        if (index) add(","); add(JSON.stringify(key)); add(":"); visit(descriptor.value, depth + 1);
      }); add("}");
    }
    active.delete(item);
  }
  visit(value, 0); return parts.join("");
}
/** The expected digest must be independently pinned by the parent review/gate. Hashing input is not authorization. */
export function postgresCohortImportFingerprint(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}
function finish<T extends object>(content: T): T & { readonly planSha256: string } {
  const plan = freeze({ ...content, planSha256: postgresCohortImportFingerprint(content) }); plans.add(plan); return plan;
}
function limits(input?: Partial<PostgresCohortPlanLimits>): PostgresCohortPlanLimits {
  const result = { ...postgresCohortPlanLimits, ...input };
  for (const [key, value] of Object.entries(result)) assert(Object.hasOwn(postgresCohortPlanLimits, key) &&
    Number.isSafeInteger(value) && value > 0 && value <= postgresCohortPlanLimits[key as keyof PostgresCohortPlanLimits], "plan_budget");
  return result;
}
function decoded(cell: FullDataPreservationCell | undefined, encoding: PostgresCohortSourcePin["databaseEncoding"]): string | null {
  if (cell?.storage !== "text" || cell.encoding !== "base64" || typeof cell.value !== "string") return null;
  try {
    const bytes = Buffer.from(cell.value, "base64"); if (bytes.toString("base64") !== cell.value) return null;
    return new TextDecoder(encoding.toLowerCase(), { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { return null; }
}
const locationKey = (location: MigrationProjectionRowLocation) => JSON.stringify([location.table, location.rowOrdinal]);

/** Pure projection of an independently reviewed, exactly allowlisted diagnostic crosswalk.
 * Crosswalk/manifest authenticity and evidence-reference authority remain parent review duties.
 * Source monitoring values and clocks are never upgraded to fresh chain facts or eligibility.
 */
export function createReviewedPostgresCohortImportPlan(input: {
  readonly crosswalk: MigrationProjectionCrosswalk; readonly review: PostgresCohortReview;
  readonly trustedReviewSha256: string; readonly limits?: Partial<PostgresCohortPlanLimits>;
}): PostgresCohortImportPlan {
  const budget = limits(input.limits);
  const reviewBody = serialize(input.review, budget.maximumBytes), crosswalkBody = serialize(input.crosswalk, budget.maximumBytes);
  assert(Buffer.byteLength(reviewBody) + Buffer.byteLength(crosswalkBody) <= budget.maximumBytes, "plan_budget");
  assert(hex(input.trustedReviewSha256) && createHash("sha256").update(reviewBody).digest("hex") === input.trustedReviewSha256, "review_pin_mismatch");
  const review = JSON.parse(reviewBody) as PostgresCohortReview, crosswalk = JSON.parse(crosswalkBody) as MigrationProjectionCrosswalk;
  assert(review.version === 1 && [review.importId, review.approvalRef, review.actorId, review.actorAuthorizationRef, review.generationId].every(id), "review_shape");
  assert(time(review.sourceWatermark) && time(review.importedAt) && review.importedAt >= review.sourceWatermark, "review_clock");
  const source = review.source;
  assert(id(source.operationId) && [source.snapshotSha256, source.catalogFingerprint, source.manifestSha256,
    source.reviewedRoutingSha256, source.crosswalkSha256].every(hex) && typeof source.databaseEncoding === "string" &&
    ["UTF-8", "UTF-16le", "UTF-16be"].includes(source.databaseEncoding), "source_pin_shape");
  assert(source.operationId === crosswalk.operationId && source.snapshotSha256 === crosswalk.snapshotSha256 &&
    source.catalogFingerprint === crosswalk.catalogFingerprint && source.reviewedRoutingSha256 === crosswalk.reviewedRoutingSha256 &&
    source.crosswalkSha256 === createHash("sha256").update(crosswalkBody).digest("hex"), "source_pin_mismatch");
  assert(crosswalk.historicalOnly === true && crosswalk.grantsBusinessEligibility === false && crosswalk.sourceWrites === false &&
    crosswalk.databaseWrites === false && Array.isArray(crosswalk.rows) && crosswalk.rows.length <= budget.maximumSourceRows &&
    Array.isArray(crosswalk.identityCohorts) && crosswalk.identityCohorts.length <= budget.maximumCohorts &&
    Array.isArray(review.allowlist) && review.allowlist.length > 0 && review.allowlist.length <= budget.maximumProfiles, "plan_budget_or_crosswalk_shape");
  const rows = new Map<string, MigrationProjectionCrosswalk["rows"][number]>();
  for (const row of crosswalk.rows) {
    assert(id(row.table) && time(row.rowOrdinal) && hex(row.rowBodySha256) && !rows.has(locationKey(row)), "duplicate_source_row");
    rows.set(locationKey(row), row);
  }
  const subjects = new Set<string>();
  for (const entry of review.allowlist) {
    assert([entry.entityId, entry.address, entry.accountId].every(id) && (entry.family === "evm" || entry.family === "solana") &&
      time(entry.effectiveAt) && time(entry.knownAt) && entry.effectiveAt <= entry.knownAt && entry.knownAt <= review.sourceWatermark &&
      time(entry.associationRow.rowOrdinal) && time(entry.walletRow.rowOrdinal), "review_allowlist_shape");
    const key = forwardTargetSubjectKey({ channel: "wallet", subjectId: entry.address, walletFamily: entry.family });
    assert(!subjects.has(key), "duplicate_allowlist_subject"); subjects.add(key);
  }
  const profiles: PostgresCohortProjection[] = [], quarantine: PostgresCohortImportPlan["quarantine"][number][] = [];
  const text = (cell: FullDataPreservationCell | undefined) => decoded(cell, source.databaseEncoding);
  for (const entry of review.allowlist) {
    function project(): PostgresCohortProjection {
      const candidates = crosswalk.identityCohorts.filter(cohort => cohort.entityId === entry.entityId);
      assert(candidates.length === 1 && candidates[0]!.status === "historical_coherent", "quarantined_or_multiple_owner");
      const cohort = candidates[0]!;
      assert(cohort.grantsBusinessEligibility === false && typeof cohort.suspended === "boolean" && typeof cohort.manual === "boolean" &&
        typeof cohort.locked === "boolean" && cohort.accounts.some(account => text(account) === entry.accountId), "unknown_profile_or_account");
      const flags = cohort.profileFlags;
      assert(["monitoring_enabled", "fomo_monitoring_enabled", "onchain_monitoring_enabled"].every(key => typeof flags[key] === "boolean"), "unknown_profile_flags");
      const sourceProfiles = crosswalk.rows.filter(row => row.table === "trader_profiles" && text(row.values.entity_id) === entry.entityId);
      assert(sourceProfiles.length === 1 && sourceProfiles[0]!.status === "historical" && sourceProfiles[0]!.targetRoute === "identity_review", "unproven_source_profile");
      for (const field of ["monitoring_enabled", "fomo_monitoring_enabled", "onchain_monitoring_enabled"]) {
        const cell = sourceProfiles[0]!.values[field];
        assert(cell?.storage === "integer" && (cell.value === "0" || cell.value === "1") && flags[field] === (cell.value === "1"), "source_profile_boolean_mismatch");
      }
      assert(typeof cohort.lifecycle === "string" && ["candidate", "probation", "active", "elite", "degraded", "suspended"].includes(cohort.lifecycle) &&
        cohort.suspended === (cohort.lifecycle === "suspended"), "unknown_lifecycle");
      const association = rows.get(locationKey(entry.associationRow)), wallet = rows.get(locationKey(entry.walletRow));
      assert(entry.associationRow.table === "entity_accounts" && association?.status === "historical" &&
        association.targetRoute === "identity_review" && text(association.values.entity_id) === entry.entityId &&
        text(association.values.account_id) === entry.accountId, "unproven_account_linkage");
      assert((entry.walletRow.table === "wallet_identities" || entry.walletRow.table === "entity_wallet_identities") && wallet?.status === "historical" &&
        wallet.targetRoute === "identity_review" && text(wallet.values.chain_family) === entry.family && text(wallet.values.address) === entry.address &&
        (entry.walletRow.table === "wallet_identities" ? text(wallet.values.account_id) === entry.accountId : text(wallet.values.entity_id) === entry.entityId), "unproven_wallet_linkage");
      const comparison = entry.family === "evm" ? entry.address.toLowerCase() : entry.address;
      const claims = cohort.wallets.filter(claim => claim.family === entry.family && claim.comparisonAddress === comparison);
      assert(claims.length === 1 && claims[0]!.sourceAddresses.includes(entry.address) && claims[0]!.confidenceEvidence.some(evidence =>
        locationKey(evidence.source) === locationKey(entry.walletRow) && evidence.recognized === text(wallet.values.confidence) &&
        text(evidence.value) === text(wallet.values.confidence)), "unproven_wallet_cohort");
      assert(!crosswalk.identityCohorts.some(other => other.entityId !== entry.entityId && other.wallets.some(claim =>
        claim.family === entry.family && claim.comparisonAddress === comparison)), "multiple_owner");
      const associationSource = text(association.values.source), walletSource = text(wallet.values.source);
      const associationConfidence = text(association.values.confidence), walletConfidence = text(wallet.values.confidence);
      assert(id(associationSource) && id(walletSource) && typeof associationConfidence === "string" && typeof walletConfidence === "string" &&
        ["low", "medium", "high", "confirmed"].includes(associationConfidence) && ["low", "medium", "high", "confirmed"].includes(walletConfidence), "unknown_source_confidence");
      assert(id(entry.identityEvidenceRef) && id(entry.ownershipEvidenceRef), "missing_reviewed_registry_reference");
      const fact: ForwardTargetChannelFact = canonicalForwardTargetChannelFact({ entityId: entry.entityId, channel: "wallet", subjectId: entry.address,
        walletFamily: entry.family, associationConfidence: associationConfidence as IdentityConfidence, associationSource, ownerCount: 1,
        walletConfidence: walletConfidence as IdentityConfidence, walletSource, identityEvidenceRef: entry.identityEvidenceRef,
        ownershipEvidenceRef: entry.ownershipEvidenceRef, monitoringEnabled: flags.onchain_monitoring_enabled as boolean, suspended: cohort.suspended });
      assert(forwardTargetIdentityTrusted(fact), "legacy_confidence_not_owner_authority");
      const subjectKey = forwardTargetSubjectKey(fact), versionId = "cohort:" + postgresCohortImportFingerprint([input.trustedReviewSha256, subjectKey]);
      const profile: PostgresWalletProfile = { wallet: { address: entry.address, accountId: entry.accountId, entityId: entry.entityId,
        lifecycle: cohort.lifecycle as TraderLifecycle }, fact, profileEnabled: flags.monitoring_enabled as boolean,
        profileSuspended: cohort.suspended, bindingState: "owned", versionId };
      const preservedFlags = { monitoring_enabled: flags.monitoring_enabled as boolean, fomo_monitoring_enabled: flags.fomo_monitoring_enabled as boolean,
        onchain_monitoring_enabled: flags.onchain_monitoring_enabled as boolean };
      const profilePayload = JSON.stringify({ ...profile, provenanceScope: "legacy_registry_linkage", provenance: { source,
        sourceWatermark: review.sourceWatermark, associationRow: entry.associationRow, associationRowSha256: association.rowBodySha256,
        walletRow: entry.walletRow, walletRowSha256: wallet.rowBodySha256, profileFlags: preservedFlags, manual: cohort.manual, locked: cohort.locked } });
      return { subjectKey, versionId, entityId: entry.entityId, profile, profilePayload, flags: preservedFlags,
        effectiveAt: entry.effectiveAt, knownAt: entry.knownAt, observedAt: review.sourceWatermark };
    }
    try { profiles.push(project()); } catch (error) {
      if (!(error instanceof Error)) throw error;
      quarantine.push({ entry, reason: error.message });
    }
  }
  profiles.sort((a, b) => a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0);
  return finish({ kind: "cohort_projection" as const, reviewedSha256: input.trustedReviewSha256, importId: review.importId,
    approvalRef: review.approvalRef, actorId: review.actorId, actorAuthorizationRef: review.actorAuthorizationRef,
    generationId: review.generationId, source, sourceWatermark: review.sourceWatermark, importedAt: review.importedAt,
    profiles, quarantine, unsupportedProjections: ["token_projection", "fresh_chain_facts", "stable_qualification"] as const,
    completion: { tokenProjection: false as const, freshChainFacts: false as const, allSixServices: false as const }, grantsBusinessEligibility: false as const });
}

/** Reduced-scope source review; execution still requires the existing native cutover authority. */
export function createReviewedPostgresAddressOnlyImportPlan(input: {
  readonly rawSeed: string; readonly review: AddressOnlyReview; readonly trustedReviewSha256: string;
}): PostgresCohortImportPlan {
  const body = serialize(input.review, 1024 * 1024);
  assert(hex(input.trustedReviewSha256) && createHash("sha256").update(body).digest("hex") === input.trustedReviewSha256, "review_pin_mismatch");
  const review = JSON.parse(body) as AddressOnlyReview;
  const projected = projectAddressOnlySeed(input.rawSeed, review);
  return finish({ kind: "cohort_projection" as const, reviewedSha256: input.trustedReviewSha256,
    importId: review.importId, approvalRef: review.approvalRef, actorId: review.actorId, actorAuthorizationRef: review.actorAuthorizationRef,
    generationId: review.generationId, source: projected.source, sourceWatermark: projected.source.capturedAt, importedAt: review.importedAt,
    profiles: projected.profiles, quarantine: [], unsupportedProjections: ["token_projection", "fresh_chain_facts", "stable_qualification"] as const,
    completion: { tokenProjection: false as const, freshChainFacts: false as const, allSixServices: false as const }, grantsBusinessEligibility: false as const });
}

export interface PostgresProviderBudgetSeed {
  readonly providerId: string; readonly origin: string; readonly windowStartedAt: number; readonly windowMs: number;
  readonly maximumRequests: number; readonly requestsUsed: number; readonly maximumConcurrency: number;
  /** Exact nonnegative signed-bigint legacy cooldown, including the manual-review pause sentinel. No default. */
  readonly cooldownUntil: string;
}
export interface PostgresProviderBudgetReview {
  readonly version: 1; readonly importId: string; readonly approvalRef: string; readonly generationId: string;
  readonly importedAt: number; readonly contractRef: string; readonly budgets: readonly PostgresProviderBudgetSeed[];
}
export interface PostgresProviderBudgetSeedPlan {
  readonly kind: "provider_budget_seed"; readonly planSha256: string; readonly reviewedSha256: string;
  readonly importId: string; readonly approvalRef: string; readonly generationId: string; readonly importedAt: number;
  readonly contractRef: string; readonly budgets: readonly PostgresProviderBudgetSeed[];
}
/** Provider allowances are separately approved facts. There are no guessed provider defaults or price/validator seeds. */
export function createReviewedPostgresProviderBudgetSeedPlan(input: {
  readonly review: PostgresProviderBudgetReview; readonly trustedReviewSha256: string;
}): PostgresProviderBudgetSeedPlan {
  const body = serialize(input.review, 1024 * 1024);
  assert(hex(input.trustedReviewSha256) && createHash("sha256").update(body).digest("hex") === input.trustedReviewSha256, "provider_review_pin");
  const review = JSON.parse(body) as PostgresProviderBudgetReview;
  assert(review.version === 1 && [review.importId, review.approvalRef, review.generationId, review.contractRef].every(id) &&
    time(review.importedAt) && Array.isArray(review.budgets) && review.budgets.length > 0 && review.budgets.length <= 1000, "provider_review_shape");
  const providers = new Set<string>(), origins = new Set<string>();
  for (const seed of review.budgets) {
    assert(id(seed.providerId) && typeof seed.origin === "string" && seed.origin.length <= 512, "provider_seed_shape");
    const url = new URL(seed.origin);
    assert(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.origin === seed.origin, "provider_origin");
    assert(!providers.has(seed.providerId) && !origins.has(seed.origin), "duplicate_provider_seed"); providers.add(seed.providerId); origins.add(seed.origin);
    assert(time(seed.windowStartedAt) && seed.windowStartedAt <= review.importedAt && time(seed.requestsUsed) && seed.requestsUsed <= seed.maximumRequests &&
      [seed.windowMs, seed.maximumRequests, seed.maximumConcurrency].every(value => time(value) && value > 0 && value <= 2_147_483_647), "provider_explicit_budget");
    assert(typeof seed.cooldownUntil === "string" && /^(0|[1-9][0-9]{0,18})$/.test(seed.cooldownUntil) &&
      BigInt(seed.cooldownUntil) <= 9223372036854775807n, "provider_unknown_cooldown");
  }
  return finish({ kind: "provider_budget_seed" as const, reviewedSha256: input.trustedReviewSha256, importId: review.importId,
    approvalRef: review.approvalRef, generationId: review.generationId, importedAt: review.importedAt, contractRef: review.contractRef, budgets: review.budgets });
}

interface SchemaForeignKey { readonly columns: readonly string[]; readonly table: string; readonly targetColumns: readonly string[] }
interface SchemaContract { readonly columns: Readonly<Record<string, string>>; readonly nullable: readonly string[];
  readonly primaryKey: readonly string[]; readonly foreignKeys: readonly SchemaForeignKey[]; readonly unique: readonly (readonly string[])[]; readonly checks: readonly string[] }
const fk = (columns: string[], table: string, targetColumns = columns): SchemaForeignKey => ({ columns, table, targetColumns });
const contract = (columns: Record<string, string>, primaryKey: string[], extras: Partial<Omit<SchemaContract, "columns" | "primaryKey">> = {}): SchemaContract =>
  ({ columns, primaryKey, nullable: [], foreignKeys: [], unique: [], checks: [], ...extras });
/** Required live schema shape only. No DDL is executed or exported by this importer. */
export const postgresCohortImportSchemaContract: Readonly<Record<string, SchemaContract>> = freeze({
  forward_strategy_generations: contract({ generation_id: "text" }, ["generation_id"]),
  wallet_service_import_ledger: contract({ import_id: "text", generation_id: "text", approval_ref: "text", source_fingerprint: "text",
    proof_scope: "text", imported_at: "bigint", revoked_at: "bigint" }, ["import_id"], { nullable: ["revoked_at"],
    foreignKeys: [fk(["generation_id"], "forward_strategy_generations")], unique: [["generation_id", "import_id"]] }),
  wallet_service_profile_cohort: contract({ generation_id: "text", subject_key: "text", entity_id: "text", wallet_family: "text",
    profile_payload: "text", import_id: "text", observed_at: "bigint" }, ["generation_id", "subject_key"],
    { foreignKeys: [fk(["generation_id", "import_id"], "wallet_service_import_ledger")] }),
  wallet_service_profile_versions: contract({ generation_id: "text", subject_key: "text", version_id: "text", enabled: "boolean", suspended: "boolean",
    effective_at: "bigint", known_at: "bigint", import_id: "text" }, ["generation_id", "subject_key", "version_id"], {
    foreignKeys: [fk(["generation_id", "subject_key"], "wallet_service_profile_cohort"), fk(["generation_id", "import_id"], "wallet_service_import_ledger")],
    checks: ["CHECK(known_at>=effective_at)"] }),
  forward_target_control_locks: contract({ entity_id: "text" }, ["entity_id"]),
  forward_target_channel_versions: contract({ version_id: "text", entity_id: "text", channel: "text", subject_key: "text", fingerprint: "text",
    effective_at: "bigint", known_at: "bigint", actor_id: "text", actor_authorization_ref: "text", payload: "text" }, ["version_id"], { checks: ["CHECK(known_at>=effective_at)"] }),
  forward_target_channel_heads: contract({ entity_id: "text", channel: "text", subject_key: "text", version_id: "text", head_generation: "bigint" },
    ["entity_id", "channel", "subject_key"], { foreignKeys: [fk(["version_id"], "forward_target_channel_versions")] }),
  forward_target_identity_bindings: contract({ channel: "text", subject_key: "text", owner_entity_id: "text", created_at: "bigint", created_by_version: "text",
    conflict_at: "bigint", conflict_by_version: "text" }, ["channel", "subject_key"], { nullable: ["conflict_at", "conflict_by_version"],
    foreignKeys: [fk(["created_by_version"], "forward_target_channel_versions", ["version_id"]), fk(["conflict_by_version"], "forward_target_channel_versions", ["version_id"])] }),
  forward_target_authorization_intents: contract({ intent_key: "text", entity_id: "text", kind: "text", event_id: "text", created_at: "bigint", status: "text" }, ["intent_key"]),
  wallet_service_provider_budgets: contract({ generation_id: "text", provider_id: "text", origin: "text", import_id: "text", window_started_at: "bigint",
    window_ms: "integer", maximum_requests: "integer", requests_used: "integer", maximum_concurrency: "integer", cooldown_until: "bigint" }, ["generation_id", "provider_id"], {
    foreignKeys: [fk(["generation_id", "import_id"], "wallet_service_import_ledger")], unique: [["generation_id", "origin"]],
    checks: ["CHECK(window_ms>0)", "CHECK(maximum_requests>0)", "CHECK(requests_used>=0)", "CHECK(maximum_concurrency>0)", "CHECK(cooldown_until>=0)"] }),
});
const cohortTables = Object.keys(postgresCohortImportSchemaContract).filter(name => name !== "wallet_service_provider_budgets");
const seedTables = ["forward_strategy_generations", "wallet_service_import_ledger", "wallet_service_provider_budgets"];
const schemaProbeSql = `/* cohort-import-schema */ SELECT c.relname table_name,c.relkind,c.relpersistence,
  to_regclass(c.relname)::oid=c.oid resolved,
  has_table_privilege(c.oid,'SELECT') can_select,has_table_privilege(c.oid,'INSERT') can_insert,has_table_privilege(c.oid,'UPDATE') can_update,
  (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) ORDER BY a.attnum)
    FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('type',k.contype,'validated',k.convalidated,
    'columns',(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num),
    'foreign_schema',fn.nspname,'foreign_table',fc.relname,
    'foreign_columns',(SELECT jsonb_agg(a.attname ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num),
    'definition',pg_get_constraintdef(k.oid))) FROM pg_constraint k LEFT JOIN pg_class fc ON fc.oid=k.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid=fc.relnamespace WHERE k.conrelid=c.oid),'[]'::jsonb) constraints
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`;
type Row = Record<string, unknown>;
const same = (left: unknown, right: unknown) => serialize(left) === serialize(right);
function verifySchema(rows: readonly Row[], names: readonly string[], schema: string): void {
  assert(rows.length === names.length && new Set(rows.map(row => row.table_name)).size === names.length, "schema_table_accounting");
  for (const name of names) {
    const spec = postgresCohortImportSchemaContract[name]!, row = rows.find(item => item.table_name === name);
    assert(row?.relkind === "r" && row.relpersistence === "p" && row.resolved === true && Array.isArray(row.columns) && Array.isArray(row.constraints), "schema_relation_kind");
    assert(row.can_select === true && (name === "forward_strategy_generations" || row.can_insert === true) &&
      (!["wallet_service_import_ledger", "wallet_service_provider_budgets", "forward_target_identity_bindings", "forward_target_channel_heads", "forward_target_control_locks"].includes(name) || row.can_update === true), "schema_migration_role_privileges");
    const columns = row.columns as Row[], constraints = row.constraints as Row[];
    for (const [column, type] of Object.entries(spec.columns)) assert(columns.some(item => item.name === column && item.type === type &&
      item.not_null === !spec.nullable.includes(column)), "schema_column");
    assert(constraints.some(item => item.type === "p" && same(item.columns, spec.primaryKey)), "schema_primary_key");
    for (const key of spec.unique) assert(constraints.some(item => item.type === "u" && same(item.columns, key)), "schema_unique_key");
    for (const key of spec.foreignKeys) assert(constraints.some(item => item.type === "f" && item.validated !== false && same(item.columns, key.columns) &&
      item.foreign_schema === schema && item.foreign_table === key.table && same(item.foreign_columns, key.targetColumns)), "schema_foreign_key");
    const normalized = (value: unknown) => typeof value === "string" ? value.replace(/[\s()]/g, "").toLowerCase() : "";
    for (const check of spec.checks) assert(constraints.some(item => item.type === "c" && item.validated !== false && normalized(item.definition) === normalized(check)), "schema_check");
  }
}

export interface PostgresCohortRuntime {
  /** Dedicated migration-role adapter, not the owner-rejecting service BusinessRuntime factory.
   * Isolated batches only; invoke outside every coordinator/first-write transaction.
   * Must be a top-level, commit-awaiting UOW; nested joined scopes are not independent commits.
   */
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  probe(): Promise<PostgresBusinessIdentity>;
}
export interface PostgresCohortApplyCapability {
  readonly kind: "isolated" | "approved_cutover";
  readonly purpose: "cohort_projection" | "provider_budget_seed";
  readonly authorizationRef: string; readonly target: PostgresBusinessIdentity;
  readonly planSha256: string; readonly expiresAtMs: number;
}
export interface PostgresCohortApplyBudget {
  readonly deadlineAtMs: number; readonly maximumTransactionMs: number;
  readonly maximumQueriesPerTransaction: number; readonly maximumTotalQueries: number;
  readonly maximumTransactions: number; readonly recordsPerTransaction: number; readonly maximumImportLagMs: number;
}
export interface PostgresCohortApplyOptions {
  readonly runtime: PostgresCohortRuntime; readonly capability: PostgresCohortApplyCapability;
  /** Parent formal gate must authenticate the capability and migration-role authority; throwing denies all writes. */
  readonly assertAuthorized: (request: { readonly capability: PostgresCohortApplyCapability;
    readonly planSha256: string; readonly generationId: string; readonly approvalRef: string }) => Promise<void>;
  readonly budget: PostgresCohortApplyBudget;
}
export interface PostgresCohortTransactionApplyOptions extends Omit<PostgresCohortApplyOptions, "runtime"> {
  /** Parent's actual first-write transaction, including its cutover marker in the same commit.
   * No independent runtime/UOW is accepted. Propagate any failure to the parent's UOW.
   */
  readonly transaction: PostgresTransaction;
}
type ExecutionOptions = PostgresCohortApplyOptions | PostgresCohortTransactionApplyOptions;
const nativeTransaction = (options: ExecutionOptions): options is PostgresCohortTransactionApplyOptions => "transaction" in options;
type AnyPlan = PostgresCohortImportPlan | PostgresProviderBudgetSeedPlan;
function execution(plan: AnyPlan, options: ExecutionOptions) {
  assert(plans.has(plan), "untrusted_plan_object");
  const capability = freeze(JSON.parse(serialize(options.capability)) as PostgresCohortApplyCapability);
  const budget = freeze(JSON.parse(serialize(options.budget)) as PostgresCohortApplyBudget);
  const maxima: Record<keyof PostgresCohortApplyBudget, number> = { deadlineAtMs: Number.MAX_SAFE_INTEGER, maximumTransactionMs: 60_000,
    maximumQueriesPerTransaction: 100_000, maximumTotalQueries: 10_000_000, maximumTransactions: 10_000,
    recordsPerTransaction: nativeTransaction(options) ? 1000 : 25, maximumImportLagMs: 86_400_000 };
  assert(Object.keys(budget).length === Object.keys(maxima).length, "execution_budget");
  for (const [key, maximum] of Object.entries(maxima)) assert(time(budget[key as keyof PostgresCohortApplyBudget]) &&
    budget[key as keyof PostgresCohortApplyBudget] > 0 && budget[key as keyof PostgresCohortApplyBudget] <= maximum, "execution_budget");
  const target = capability.target, identifier = /^[a-z_][a-z0-9_]{0,62}$/;
  assert(target && [target.database, target.username, target.schema].every(value => typeof value === "string" && identifier.test(value)) &&
    !target.schema.startsWith("pg_") && !["public", "information_schema", "pg_catalog"].includes(target.schema) &&
    [target.generation, target.service, target.serverAddress].every(id) && time(target.serverPort) && target.serverPort > 0 && target.serverPort <= 65535 &&
    time(target.schemaVersion) && target.schemaVersion > 0 && hex(target.schemaFingerprint), "target_shape");
  assert(capability.kind === "isolated" || capability.kind === "approved_cutover", "capability_kind");
  assert(nativeTransaction(options) || capability.kind === "isolated", "cutover_requires_parent_transaction");
  if (capability.kind === "isolated") {
    const rehearsal = /^radar_rehearsal_([0-9a-f]{16})(?:_[a-z][a-z0-9]{0,15})?$/;
    const databaseNonce = rehearsal.exec(target.database)?.[1], schemaNonce = rehearsal.exec(target.schema)?.[1];
    assert(databaseNonce !== undefined && databaseNonce === schemaNonce, "isolated_target_required");
  }
  assert(capability.purpose === plan.kind && capability.authorizationRef === plan.approvalRef && capability.planSha256 === plan.planSha256 &&
    target.generation === plan.generationId && time(capability.expiresAtMs) && typeof options.assertAuthorized === "function" &&
    (nativeTransaction(options) ? typeof options.transaction?.query === "function" : typeof options.runtime?.run === "function" && typeof options.runtime.probe === "function"), "capability_binding");
  let totalQueries = 0, transactions = 0;
  function check(): void {
    const at = Date.now(); assert(at < budget.deadlineAtMs, "deadline_exceeded"); assert(at < capability.expiresAtMs, "capability_expired");
    assert(plan.importedAt <= at && at - plan.importedAt <= budget.maximumImportLagMs, "import_clock_or_lag");
  }
  check();
  return { budget, target, queries: () => totalQueries, transactions: () => transactions,
    async batch<T>(names: readonly string[], callback: (tx: PostgresTransaction) => Promise<T>): Promise<T> {
      check(); assert(++transactions <= budget.maximumTransactions, "transaction_budget");
      await options.assertAuthorized({ capability, planSha256: plan.planSha256, generationId: plan.generationId, approvalRef: plan.approvalRef });
      check();
      if (!nativeTransaction(options)) {
        const identity = await options.runtime.probe();
        assert(Object.keys(target).every(key => identity[key as keyof PostgresBusinessIdentity] === target[key as keyof PostgresBusinessIdentity]), "target_probe_mismatch");
      }
      check();
      const perform = async (transaction: PostgresTransaction) => {
        const started = Date.now(); let queries = 0;
        const tx: PostgresTransaction = { async query(sql, values = []): Promise<PostgresResult> {
          check(); const remaining = Math.min(budget.maximumTransactionMs - (Date.now() - started), budget.deadlineAtMs - Date.now(), capability.expiresAtMs - Date.now());
          assert(remaining > 0, "transaction_deadline");
          assert(queries + 2 <= budget.maximumQueriesPerTransaction && totalQueries + 2 <= budget.maximumTotalQueries, "query_budget_exceeded");
          queries += 2; totalQueries += 2;
          await transaction.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(remaining)]);
          const result = await transaction.query(sql, values); check(); assert(Date.now() - started < budget.maximumTransactionMs, "transaction_deadline"); return result;
        } };
        const actual = (await tx.query(`/* cohort-import-target */ SELECT current_database() database,current_user username,
          host(inet_server_addr()) server_address,inet_server_port() server_port`)).rows[0];
        assert(actual?.database === target.database && actual.username === target.username && actual.server_address === target.serverAddress &&
          actual.server_port === target.serverPort, "target_connection_mismatch");
        // Put pg_temp last explicitly; unqualified repository SQL must never resolve to a shadow temp table.
        await tx.query("SELECT set_config('search_path',$1,true)", ['pg_catalog,"' + target.schema + '",pg_temp']);
        verifySchema((await tx.query(schemaProbeSql, [target.schema, names])).rows, names, target.schema);
        const generation = (await tx.query("/* cohort-import-generation */ SELECT generation_id FROM forward_strategy_generations WHERE generation_id=$1 FOR SHARE", [plan.generationId])).rows;
        assert(generation.length === 1 && generation[0]!.generation_id === plan.generationId, "generation_not_registered");
        // Explicit isolated/cutover import only. Short bounded locks exclude non-cooperating registry writers during collision checks.
        const locked = names.filter(name => name !== "forward_strategy_generations");
        await tx.query("LOCK TABLE " + locked.map(name => '"' + target.schema + '"."' + name + '"').join(",") + " IN SHARE ROW EXCLUSIVE MODE");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([target.schema, plan.generationId, plan.importId])]);
        const result = await callback(tx); check(); assert(Date.now() - started < budget.maximumTransactionMs, "transaction_deadline"); return result;
      };
      return nativeTransaction(options) ? await perform(options.transaction) : await options.runtime.run(perform);
    },
  };
}
function matches(actual: Row | undefined, expected: Row): boolean {
  return !!actual && Object.entries(expected).every(([key, value]) => {
    const stored = actual[key];
    return typeof value === "number" ? stored === value || (typeof stored === "string" && stored === String(value)) : stored === value;
  });
}
async function ledger(tx: PostgresTransaction, plan: AnyPlan): Promise<void> {
  const scope = plan.kind === "cohort_projection" ? ("kind" in plan.source && plan.source.kind === "address_only_registry" ? "address_only_registry" : "legacy_registry_linkage") : "provider_contract";
  await tx.query(`INSERT INTO wallet_service_import_ledger(import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [plan.importId, plan.generationId, plan.approvalRef, plan.planSha256, scope, plan.importedAt]);
  const rows = (await tx.query("SELECT * FROM wallet_service_import_ledger WHERE import_id=$1 FOR UPDATE", [plan.importId])).rows;
  assert(rows.length === 1 && matches(rows[0], { import_id: plan.importId, generation_id: plan.generationId, approval_ref: plan.approvalRef,
    source_fingerprint: plan.planSha256, proof_scope: scope, imported_at: plan.importedAt, revoked_at: null }), "ledger_collision");
}
async function readProfile(tx: PostgresTransaction, plan: PostgresCohortImportPlan, item: PostgresCohortProjection) {
  const cohort = (await tx.query("SELECT * FROM wallet_service_profile_cohort WHERE generation_id=$1 AND subject_key=$2", [plan.generationId, item.subjectKey])).rows;
  const profiles = (await tx.query("SELECT * FROM wallet_service_profile_versions WHERE generation_id=$1 AND subject_key=$2 LIMIT 2", [plan.generationId, item.subjectKey])).rows;
  const channels = (await tx.query("SELECT * FROM forward_target_channel_versions WHERE channel='wallet' AND subject_key=$1 LIMIT 2", [item.subjectKey])).rows;
  const bindings = (await tx.query("SELECT * FROM forward_target_identity_bindings WHERE channel='wallet' AND subject_key=$1 FOR UPDATE", [item.subjectKey])).rows;
  const heads = (await tx.query("SELECT * FROM forward_target_channel_heads WHERE channel='wallet' AND subject_key=$1 LIMIT 2", [item.subjectKey])).rows;
  return { cohort, profiles, channels, bindings, heads };
}
function verifyProfile(stored: Awaited<ReturnType<typeof readProfile>>, plan: PostgresCohortImportPlan, item: PostgresCohortProjection): void {
  assert(Object.values(stored).every(rows => rows.length === 1), "profile_receipt_collision");
  assert(matches(stored.cohort[0], { generation_id: plan.generationId, subject_key: item.subjectKey, entity_id: item.entityId,
    wallet_family: item.profile.fact.walletFamily, profile_payload: item.profilePayload, import_id: plan.importId, observed_at: item.observedAt }) &&
    matches(stored.profiles[0], { generation_id: plan.generationId, subject_key: item.subjectKey, version_id: item.versionId,
      enabled: item.profile.profileEnabled, suspended: item.profile.profileSuspended, effective_at: item.effectiveAt, known_at: item.knownAt, import_id: plan.importId }) &&
    matches(stored.channels[0], { version_id: item.versionId, entity_id: item.entityId, channel: "wallet", subject_key: item.subjectKey,
      fingerprint: createHash("sha256").update(JSON.stringify([item.profile.fact, item.effectiveAt, plan.actorId])).digest("hex"),
      payload: JSON.stringify(item.profile.fact), effective_at: item.effectiveAt, known_at: item.knownAt,
      actor_id: plan.actorId, actor_authorization_ref: plan.actorAuthorizationRef }) &&
    matches(stored.bindings[0], { channel: "wallet", subject_key: item.subjectKey, owner_entity_id: item.entityId, created_at: item.knownAt,
      created_by_version: item.versionId, conflict_at: null, conflict_by_version: null }) &&
    matches(stored.heads[0], { entity_id: item.entityId, channel: "wallet", subject_key: item.subjectKey, version_id: item.versionId, head_generation: 1 }), "profile_or_owner_collision");
}
export interface PostgresCohortImportResult {
  readonly planSha256: string; readonly appliedProfiles: number; readonly resumedProfiles: number; readonly quarantinedProfiles: number;
  readonly transactions: number; readonly queries: number;
  readonly tokenProjection: "unsupported"; readonly freshChainFacts: "not_imported";
  readonly grantsBusinessEligibility: false; readonly allSixServicesComplete: false;
}
/** No connection creation, schema changes, source deletion, production auto-call or qualification writes.
 * Each batch physically commits through the supplied top-level UOW before it is acknowledged.
 * Deadline/query checks and statement/lock timeouts bound work; driver connection/commit transport timeouts remain required.
 * Changed live flags/owners/versions cause a collision, never repair or overwrite on replay.
 */
async function applyCohortPlan(plan: PostgresCohortImportPlan, options: ExecutionOptions): Promise<PostgresCohortImportResult> {
  const work = execution(plan, options); assert(plan.kind === "cohort_projection" && plan.profiles.length > 0, "no_applicable_cohort");
  assert(!nativeTransaction(options) || plan.profiles.length <= work.budget.recordsPerTransaction, "native_transaction_record_budget");
  assert(Math.ceil(plan.profiles.length / work.budget.recordsPerTransaction) <= work.budget.maximumTransactions, "transaction_budget");
  let appliedProfiles = 0, resumedProfiles = 0;
  for (let start = 0; start < plan.profiles.length; start += work.budget.recordsPerTransaction) {
    const items = plan.profiles.slice(start, start + work.budget.recordsPerTransaction);
    const committed = await work.batch(cohortTables, async tx => {
      await ledger(tx, plan); let applied = 0, resumed = 0;
      for (const item of items) {
        const stored = await readProfile(tx, plan, item);
        if (Object.values(stored).some(rows => rows.length > 0)) { verifyProfile(stored, plan, item); resumed++; continue; }
        const repository = createPostgresForwardTargetAuthorizationRepository(tx, { actorId: plan.actorId,
          authorizationEvidenceRef: plan.actorAuthorizationRef, permissions: ["target_registry_write"] });
        const result = await repository.recordChannel({ ...item.profile.fact, versionId: item.versionId, effectiveAt: item.effectiveAt, knownAt: item.knownAt });
        assert(result.status === "applied", "target_repository_collision");
        await tx.query(`INSERT INTO wallet_service_profile_cohort(generation_id,subject_key,entity_id,wallet_family,profile_payload,import_id,observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [plan.generationId, item.subjectKey, item.entityId, item.profile.fact.walletFamily,
          item.profilePayload, plan.importId, item.observedAt]);
        await tx.query(`INSERT INTO wallet_service_profile_versions(generation_id,subject_key,version_id,enabled,suspended,effective_at,known_at,import_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [plan.generationId, item.subjectKey, item.versionId, item.profile.profileEnabled,
          item.profile.profileSuspended, item.effectiveAt, item.knownAt, plan.importId]);
        verifyProfile(await readProfile(tx, plan, item), plan, item); applied++;
      }
      return { applied, resumed };
    });
    appliedProfiles += committed.applied; resumedProfiles += committed.resumed;
  }
  return freeze({ planSha256: plan.planSha256, appliedProfiles, resumedProfiles, quarantinedProfiles: plan.quarantine.length,
    transactions: work.transactions(), queries: work.queries(), tokenProjection: "unsupported" as const, freshChainFacts: "not_imported" as const,
    grantsBusinessEligibility: false as const, allSixServicesComplete: false as const });
}
async function applyProviderSeedPlan(plan: PostgresProviderBudgetSeedPlan, options: ExecutionOptions): Promise<{
  readonly planSha256: string; readonly appliedBudgets: number; readonly resumedBudgets: number; readonly transactions: number; readonly queries: number;
}> {
  const work = execution(plan, options); assert(plan.kind === "provider_budget_seed" && plan.budgets.length > 0, "no_applicable_provider_seed");
  assert(!nativeTransaction(options) || plan.budgets.length <= work.budget.recordsPerTransaction, "native_transaction_record_budget");
  assert(Math.ceil(plan.budgets.length / work.budget.recordsPerTransaction) <= work.budget.maximumTransactions, "transaction_budget");
  let appliedBudgets = 0, resumedBudgets = 0;
  for (let start = 0; start < plan.budgets.length; start += work.budget.recordsPerTransaction) {
    const committed = await work.batch(seedTables, async tx => {
      await ledger(tx, plan); let applied = 0, resumed = 0;
      for (const seed of plan.budgets.slice(start, start + work.budget.recordsPerTransaction)) {
        const existing = (await tx.query("SELECT * FROM wallet_service_provider_budgets WHERE generation_id=$1 AND provider_id=$2 FOR UPDATE", [plan.generationId, seed.providerId])).rows;
        const expected = { generation_id: plan.generationId, provider_id: seed.providerId, origin: seed.origin, import_id: plan.importId,
          window_started_at: seed.windowStartedAt, window_ms: seed.windowMs, maximum_requests: seed.maximumRequests,
          requests_used: seed.requestsUsed, maximum_concurrency: seed.maximumConcurrency, cooldown_until: seed.cooldownUntil };
        if (existing.length) { assert(existing.length === 1 && matches(existing[0], expected), "provider_seed_collision"); resumed++; continue; }
        const origins = (await tx.query("SELECT * FROM wallet_service_provider_budgets WHERE generation_id=$1 AND origin=$2", [plan.generationId, seed.origin])).rows;
        assert(origins.length === 0, "provider_origin_collision");
        await tx.query(`INSERT INTO wallet_service_provider_budgets(generation_id,provider_id,origin,import_id,window_started_at,window_ms,maximum_requests,requests_used,maximum_concurrency,cooldown_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, Object.values(expected));
        const stored = (await tx.query("SELECT * FROM wallet_service_provider_budgets WHERE generation_id=$1 AND provider_id=$2", [plan.generationId, seed.providerId])).rows;
        assert(stored.length === 1 && matches(stored[0], expected), "provider_seed_collision"); applied++;
      }
      return { applied, resumed };
    });
    appliedBudgets += committed.applied; resumedBudgets += committed.resumed;
  }
  return freeze({ planSha256: plan.planSha256, appliedBudgets, resumedBudgets, transactions: work.transactions(), queries: work.queries() });
}

/** Isolated standalone preparation only. Never invoke inside a coordinator's first-write callback. */
export async function applyReviewedPostgresCohortImportPlan(plan: PostgresCohortImportPlan, options: PostgresCohortApplyOptions): Promise<PostgresCohortImportResult> {
  return await applyCohortPlan(plan, options);
}
/** Isolated standalone preparation only. Approved cutover must use the native transaction port. */
export async function applyReviewedPostgresProviderBudgetSeedPlan(plan: PostgresProviderBudgetSeedPlan, options: PostgresCohortApplyOptions) {
  return await applyProviderSeedPlan(plan, options);
}
export interface PostgresCohortTransactionApplyResult {
  readonly planSha256: string; readonly stagedProfiles: number; readonly checkedExistingProfiles: number;
  readonly quarantinedProfiles: number; readonly queries: number; readonly commitState: "pending_parent_commit";
  readonly tokenProjection: "unsupported"; readonly freshChainFacts: "not_imported";
  readonly grantsBusinessEligibility: false; readonly allSixServicesComplete: false;
}
/** All writes remain inside the supplied transaction. Parent must write its first-write marker there,
 * propagate errors, and await its own UOW commit before acknowledging or activating the cohort.
 * Schema version/fingerprint and formal cutover authority are independently checked by the parent gate;
 * this port verifies actual connection identity, schema shape and migration-role privileges, not a self-issued permission boolean.
 */
export async function applyReviewedPostgresCohortImportPlanInTransaction(plan: PostgresCohortImportPlan,
  options: PostgresCohortTransactionApplyOptions): Promise<PostgresCohortTransactionApplyResult> {
  const result = await applyCohortPlan(plan, options);
  return freeze({ planSha256: result.planSha256, stagedProfiles: result.appliedProfiles, checkedExistingProfiles: result.resumedProfiles,
    quarantinedProfiles: result.quarantinedProfiles, queries: result.queries, commitState: "pending_parent_commit" as const,
    tokenProjection: result.tokenProjection, freshChainFacts: result.freshChainFacts, grantsBusinessEligibility: false as const, allSixServicesComplete: false as const });
}
/** Native parent transaction counterpart for the independent provider-contract seed. */
export async function applyReviewedPostgresProviderBudgetSeedPlanInTransaction(plan: PostgresProviderBudgetSeedPlan,
  options: PostgresCohortTransactionApplyOptions) {
  const result = await applyProviderSeedPlan(plan, options);
  return freeze({ planSha256: result.planSha256, stagedBudgets: result.appliedBudgets, checkedExistingBudgets: result.resumedBudgets,
    queries: result.queries, commitState: "pending_parent_commit" as const });
}
