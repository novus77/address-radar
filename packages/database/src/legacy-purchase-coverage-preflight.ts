import { createHash } from "node:crypto";
import {
  FORWARD_OPPORTUNITY_WINDOW_MS, forwardDecimal, forwardQualifyingBuyAmount,
  normalizeAddressRadarTokenAddress,
} from "@address-radar/domain";
import type { ProtectedSourceRow, RowProtectionBundle } from "./full-data-row-protection.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const supportedChains = new Set(["solana", "eth", "bsc", "base", "robinhood"]);
const externalChecks = [
  "verify_original_swap_and_quote_contract",
  "verify_canonical_economic_execution_key_across_providers",
  "revalidate_identity_and_ownership_without_automatic_merge",
  "recover_original_decimal_quantities_before_business_numeric_import",
  "review_pre_generation_fact_eligibility_separately",
] as const;
const text = (row: ProtectedSourceRow, column: string): string | null => {
  const value = row.values[column]; return value?.storage === "text" ? value.value : null;
};
const number = (row: ProtectedSourceRow, column: string): number | null => {
  const value = row.values[column];
  if (value?.storage !== "integer" && value?.storage !== "real") return null;
  const decoded = Number(value.value);
  return Number.isFinite(decoded) && (value.storage !== "integer" || Number.isSafeInteger(decoded)) ? decoded : null;
};
const clock = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const token = (chain: string, address: string): string => normalizeAddressRadarTokenAddress(chain, address);
const sameSourceEvent = (row: ProtectedSourceRow, source: string, eventId: string): boolean =>
  text(row, "source") === source && text(row, "event_id") === eventId;

/** Expand a finite source REAL without claiming precision beyond its original digits. */
export function legacyRealDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_legacy_real");
  const raw = value.toString();
  if (!raw.includes("e")) return forwardDecimal(raw);
  const [mantissa, exponent] = raw.split("e");
  const point = mantissa!.indexOf(".");
  const digits = mantissa!.replace(".", "");
  const position = (point < 0 ? digits.length : point) + Number(exponent);
  const expanded = position <= 0 ? "0." + "0".repeat(-position) + digits :
    position >= digits.length ? digits + "0".repeat(position - digits.length) :
      digits.slice(0, position) + "." + digits.slice(position);
  return forwardDecimal(expanded);
}

export interface LegacyPurchaseDraft {
  proposalId: string;
  sourceEventFingerprint: string;
  executionFingerprint: string;
  chain: string;
  tokenAddress: string;
  entityId: string;
  boughtAt: number;
  expiresAt: number;
  amountUsd: string;
  entryPriceUsd: string;
  tokenQuantity: string;
  quoteQuantity: string;
  quoteAsset: string;
  amountEstimated: true;
  amountBasis: "stablecoin_nominal";
  sourcePrecision: "legacy_sqlite_numeric_not_original_decimal";
  executionEvidenceRef: string;
  generationEligibility: "unreviewed_legacy_fact";
}
export interface LegacyPurchaseReconstruction {
  status: "candidate_for_external_validation" | "deferred" | "not_qualifying_buy";
  sourceEventFingerprint: string;
  reasonCodes: readonly string[];
  draft: LegacyPurchaseDraft | null;
  externalChecks: readonly string[];
  originalRowsRetained: true;
  newSampleCreated: false;
  newEligibilityGranted: false;
  productionMigrationReady: false;
}

export function reconstructLegacyWalletPurchase(
  bundle: RowProtectionBundle, input: { source: string; eventId: string; asOf: number },
): LegacyPurchaseReconstruction {
  if (!input.source.trim() || !input.eventId.trim() || !clock(input.asOf) || input.asOf > bundle.capturedAtMs) {
    throw new Error("invalid_reconstruction_input");
  }
  const sourceEventFingerprint = hash([input.source, input.eventId]);
  const result = (
    status: LegacyPurchaseReconstruction["status"], reasonCodes: readonly string[], draft: LegacyPurchaseDraft | null = null,
  ): LegacyPurchaseReconstruction => ({
    status, sourceEventFingerprint, reasonCodes, draft, externalChecks,
    originalRowsRetained: true, newSampleCreated: false, newEligibilityGranted: false, productionMigrationReady: false,
  });
  // An omitted row in a truncated slice is not evidence that the source row is absent.
  if (!bundle.declaredDependenciesComplete || !bundle.globalDeliveryAndBudgetGuardsComplete) {
    return result("deferred", ["preservation_dependency_scope_incomplete"]);
  }
  const observations = bundle.rows.filter((row) => row.table === "wallet_monitor_observations" && sameSourceEvent(row, input.source, input.eventId));
  if (observations.length !== 1) return result("deferred", ["missing_or_ambiguous_wallet_observation"]);
  const observation = observations[0]!;
  if (observation.values.orphaned_at?.storage !== "null") return result("deferred", ["orphaned_or_unverified_chain_observation"]);
  if (text(observation, "side") !== "buy") return result("not_qualifying_buy", ["not_a_buy"]);
  const chain = text(observation, "chain")?.trim().toLowerCase() ?? "";
  const address = text(observation, "token_address");
  const entityId = text(observation, "entity_id");
  const accountId = text(observation, "account_id");
  const wallet = text(observation, "wallet_address");
  const reference = text(observation, "source_reference");
  const boughtAt = number(observation, "occurred_at"), collectedAt = number(observation, "collected_at");
  if (!supportedChains.has(chain) || !address?.trim() || !entityId?.trim() || !accountId?.trim() || !wallet?.trim() || !reference?.trim()) {
    return result("deferred", ["missing_or_unsupported_trade_identity"]);
  }
  if (boughtAt === null || collectedAt === null || !clock(boughtAt) || !clock(collectedAt) ||
      boughtAt > collectedAt || collectedAt > input.asOf || !clock(boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS)) {
    return result("deferred", ["invalid_or_future_trade_clock"]);
  }
  const bases = bundle.rows.filter((row) => row.table === "wallet_monitor_execution_bases" && sameSourceEvent(row, input.source, input.eventId));
  if (bases.length !== 1) return result("deferred", ["missing_or_ambiguous_execution_basis"]);
  const basisRow = bases[0]!;
  if (number(basisRow, "updated_at") === null || number(basisRow, "updated_at")! > input.asOf) {
    return result("deferred", ["execution_basis_not_known_as_of"]);
  }
  let basis: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text(basisRow, "basis_json") ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_basis");
    basis = value as Record<string, unknown>;
  } catch { return result("deferred", ["invalid_execution_basis_payload"]); }
  if (basis.status !== "estimated" || basis.reason !== "nominal_stablecoin_usd" || basis.amountBasis !== "nominal_stablecoin") {
    return result("deferred", ["missing_verified_nominal_execution_basis"]);
  }
  const amount = basis.amountUsd, price = basis.priceUsd, quantity = basis.tokenQuantity, quoteQuantity = basis.quoteQuantity;
  if (![amount, price, quantity, quoteQuantity].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0) ||
      typeof basis.tokenAddress !== "string" || typeof basis.quoteAsset !== "string" || !basis.quoteAsset.trim() ||
      basis.side !== "buy" || token(chain, basis.tokenAddress) !== token(chain, address) ||
      token(chain, basis.quoteAsset) === token(chain, address) || amount !== quoteQuantity ||
      number(observation, "amount_usd") !== amount || number(observation, "price_usd") !== price ||
      price !== (amount as number) / (quantity as number)) {
    return result("deferred", ["execution_basis_value_or_identity_requires_review"]);
  }
  if (!forwardQualifyingBuyAmount(legacyRealDecimal(amount as number))) return result("not_qualifying_buy", ["below_confirmed_50_usd_threshold"]);

  const heads = bundle.rows.filter((row) => row.table === "trader_execution_heads" && sameSourceEvent(row, input.source, input.eventId));
  if (heads.length !== 1 || text(heads[0]!, "projection_state") !== "applied") {
    return result("deferred", ["execution_projection_not_confirmed"]);
  }
  const head = heads[0]!, revision = number(head, "revision"), headKnownAt = number(head, "last_observed_at");
  if (revision === null || !Number.isSafeInteger(revision) || revision < 1 || headKnownAt === null || headKnownAt > input.asOf ||
      text(head, "entity_id") !== entityId || text(head, "chain") !== chain ||
      text(head, "token_address") === null || token(chain, text(head, "token_address")!) !== token(chain, address)) {
    return result("deferred", ["execution_revision_head_requires_review"]);
  }
  const revisions = bundle.rows.filter((row) => row.table === "trader_execution_revisions" && sameSourceEvent(row, input.source, input.eventId))
    .sort((a, b) => (number(a, "revision") ?? -1) - (number(b, "revision") ?? -1));
  if (revisions.length !== revision + 1 || revisions.some((row, index) => number(row, "revision") !== index)) {
    return result("deferred", ["execution_revision_history_gap"]);
  }
  const current = revisions[revision]!;
  if (!text(head, "fingerprint") || text(current, "fingerprint") !== text(head, "fingerprint") ||
      number(current, "recorded_at") === null || number(current, "recorded_at")! > input.asOf) {
    return result("deferred", ["execution_revision_not_known_or_matching"]);
  }
  const executionFingerprint = text(head, "fingerprint")!;
  return result("candidate_for_external_validation", ["legacy_real_precision_and_external_proof_review_required"], {
    proposalId: hash([input.source, input.eventId, executionFingerprint, observation.contentFingerprint, basisRow.contentFingerprint]),
    sourceEventFingerprint, executionFingerprint, chain, tokenAddress: token(chain, address), entityId,
    boughtAt, expiresAt: boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS,
    amountUsd: legacyRealDecimal(amount as number), entryPriceUsd: legacyRealDecimal(price as number),
    tokenQuantity: legacyRealDecimal(quantity as number), quoteQuantity: legacyRealDecimal(quoteQuantity as number),
    quoteAsset: token(chain, basis.quoteAsset), amountEstimated: true, amountBasis: "stablecoin_nominal",
    sourcePrecision: "legacy_sqlite_numeric_not_original_decimal",
    executionEvidenceRef: observation.rowId + ":" + basisRow.rowId, generationEligibility: "unreviewed_legacy_fact",
  });
}

export interface DeclaredPriceCoverageClaim {
  claimId: string;
  provider: string;
  chain: string;
  tokenAddress: string;
  purpose: "price_history" | "wallet_history";
  claimType: "complete_range" | "positive_hit";
  state: "verified" | "partial" | "pending_review";
  from: number | null;
  to: number | null;
  knownAt: number;
  evidenceRefs: readonly string[];
}
export interface PriceCoveragePreflight {
  scope: "declared_price_range_claims_not_independent_provider_verification";
  status: "observing_range_declared" | "observing_with_coverage_gaps" | "full_window_range_declared" | "historical_price_gaps";
  boughtAt: number;
  expiresAt: number;
  requiredUntil: number;
  windowClosed: boolean;
  gaps: readonly { from: number; to: number }[];
  acceptedClaimFingerprints: readonly string[];
  rejectedClaims: readonly { claimFingerprint: string; reasonCode: string }[];
  independentProviderCoverageVerified: false;
  noHitOrLossEstablished: false;
  newEligibilityGranted: false;
}

/** Closed integer-millisecond ranges; declared receipts are not independently verified here. */
export function inspectDeclaredThirtyDayPriceCoverage(input: {
  chain: string; tokenAddress: string; boughtAt: number; asOf: number; claims: readonly DeclaredPriceCoverageClaim[];
}): PriceCoveragePreflight {
  if (!supportedChains.has(input.chain) || !input.tokenAddress.trim() || !clock(input.boughtAt) || !clock(input.asOf) ||
      input.asOf < input.boughtAt || !clock(input.boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS) ||
      !Array.isArray(input.claims) || input.claims.length > 1000) throw new Error("invalid_price_coverage_request");
  const expiresAt = input.boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS;
  const requiredUntil = Math.min(expiresAt, input.asOf);
  const groups = new Map<string, DeclaredPriceCoverageClaim[]>();
  const rejectedClaims: { claimFingerprint: string; reasonCode: string }[] = [];
  for (const claim of input.claims) {
    const id = hash([claim?.provider, claim?.claimId]);
    if (!claim || typeof claim.provider !== "string" || !claim.provider.trim() ||
        typeof claim.claimId !== "string" || !claim.claimId.trim()) {
      rejectedClaims.push({ claimFingerprint: id, reasonCode: "invalid_claim_identity" }); continue;
    }
    const group = groups.get(id) ?? []; group.push(claim); groups.set(id, group);
  }
  const ranges: { from: number; to: number; fingerprint: string }[] = [];
  for (const [id, group] of groups) {
    const claim = group[0]!;
    let reason: string | null = null;
    if (group.some((value) => hash(value) !== hash(claim))) reason = "conflicting_immutable_claim";
    else if (claim.purpose !== "price_history" || claim.claimType !== "complete_range") reason = "not_full_price_range_evidence";
    else if (claim.state !== "verified") reason = "price_range_not_verified";
    else if (claim.chain !== input.chain || typeof claim.tokenAddress !== "string" ||
      token(input.chain, claim.tokenAddress) !== token(input.chain, input.tokenAddress)) reason = "different_chain_or_token";
    else if (claim.from === null || claim.to === null || !clock(claim.from) || !clock(claim.to) || claim.from > claim.to ||
      !clock(claim.knownAt) || claim.knownAt < claim.to || claim.knownAt > input.asOf) reason = "missing_invalid_or_future_coverage_bounds";
    else if (!Array.isArray(claim.evidenceRefs) || !claim.evidenceRefs.length ||
      claim.evidenceRefs.some((reference) => typeof reference !== "string" || !reference.trim())) reason = "missing_price_range_provenance";
    if (reason) { rejectedClaims.push({ claimFingerprint: id, reasonCode: reason }); continue; }
    if (claim.to! < input.boughtAt || claim.from! > requiredUntil) {
      rejectedClaims.push({ claimFingerprint: id, reasonCode: "outside_purchase_window" }); continue;
    }
    ranges.push({ from: Math.max(claim.from!, input.boughtAt), to: Math.min(claim.to!, requiredUntil), fingerprint: id });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const gaps: { from: number; to: number }[] = [];
  let cursor = input.boughtAt;
  for (const range of ranges) {
    if (range.from > cursor) gaps.push({ from: cursor, to: range.from - 1 });
    cursor = Math.max(cursor, range.to + 1);
  }
  if (cursor <= requiredUntil) gaps.push({ from: cursor, to: requiredUntil });
  const windowClosed = input.asOf >= expiresAt;
  return {
    scope: "declared_price_range_claims_not_independent_provider_verification",
    status: gaps.length ? windowClosed ? "historical_price_gaps" : "observing_with_coverage_gaps" :
      windowClosed ? "full_window_range_declared" : "observing_range_declared",
    boughtAt: input.boughtAt, expiresAt, requiredUntil, windowClosed, gaps,
    acceptedClaimFingerprints: ranges.map((range) => range.fingerprint), rejectedClaims,
    independentProviderCoverageVerified: false, noHitOrLossEstablished: false, newEligibilityGranted: false,
  };
}
