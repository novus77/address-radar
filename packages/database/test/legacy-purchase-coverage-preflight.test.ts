import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FORWARD_OPPORTUNITY_WINDOW_MS } from "@address-radar/domain";
import {
  inspectDeclaredThirtyDayPriceCoverage, legacyRealDecimal, reconstructLegacyWalletPurchase,
  type DeclaredPriceCoverageClaim,
} from "../src/legacy-purchase-coverage-preflight.js";
import type { PreservedSqliteValue, ProtectedSourceRow, RowProtectionBundle } from "../src/full-data-row-protection.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const t = (value: string): PreservedSqliteValue => ({ storage: "text", value });
const i = (value: number): PreservedSqliteValue => ({ storage: "integer", value: String(value) });
const r = (value: number): PreservedSqliteValue => ({ storage: "real", value: String(value) });
const n: PreservedSqliteValue = { storage: "null" };
const row = (table: string, values: Record<string, PreservedSqliteValue>): ProtectedSourceRow => ({
  table, key: {}, values, rowId: hash([table, values]), contentFingerprint: hash(values),
});
const fixture = (): RowProtectionBundle => {
  const basis = { status: "estimated", reason: "nominal_stablecoin_usd", amountBasis: "nominal_stablecoin",
    tokenAddress: "token", side: "buy", tokenQuantity: 100, quoteAsset: "usdc", quoteQuantity: 50, amountUsd: 50, priceUsd: 0.5 };
  const key = { source: t("rpc"), event_id: t("trade") };
  return {
    version: 1, capturedAtMs: 10000, scope: "declared_legacy_rows_and_preservation_dependencies",
    rows: [
      row("wallet_monitor_observations", { ...key, chain: t("solana"), token_address: t("token"), entity_id: t("entity"),
        account_id: t("account"), wallet_address: t("wallet"), source_reference: t("transaction"),
        side: t("buy"), amount_usd: r(50), price_usd: r(0.5), occurred_at: i(1000), collected_at: i(1001), orphaned_at: n }),
      row("wallet_monitor_execution_bases", { ...key, basis_json: t(JSON.stringify(basis)), updated_at: i(1002) }),
      row("trader_execution_heads", { ...key, entity_id: t("entity"), chain: t("solana"), token_address: t("token"),
        projection_state: t("applied"), revision: i(1), fingerprint: t("execution-v1"), last_observed_at: i(1002) }),
      row("trader_execution_revisions", { ...key, revision: i(0), fingerprint: t("execution-v0"), recorded_at: i(1001), payload: t("original") }),
      row("trader_execution_revisions", { ...key, revision: i(1), fingerprint: t("execution-v1"), recorded_at: i(1002), payload: t("revised") }),
    ],
    edges: [], roots: [], issues: [], declaredDependenciesComplete: true, globalDeliveryAndBudgetGuardsComplete: true,
    fingerprint: "fixture-only", sourceBytesIncluded: 0, newPurchaseSamplesCreated: 0, newEligibilityGranted: false,
    productionMigrationReady: false, unresolvedGates: ["synthetic_fixture_not_business_evidence"],
  };
};
const reconstruct = (bundle: RowProtectionBundle) => reconstructLegacyWalletPurchase(bundle, { source: "rpc", eventId: "trade", asOf: 2000 });
const change = (bundle: RowProtectionBundle, table: string, field: string, value: PreservedSqliteValue): RowProtectionBundle => ({
  ...bundle, rows: bundle.rows.map((item) => item.table === table ? row(item.table, { ...item.values, [field]: value }) : item),
});
const claim = (overrides: Partial<DeclaredPriceCoverageClaim> = {}): DeclaredPriceCoverageClaim => ({
  claimId: "range", provider: "provider", chain: "solana", tokenAddress: "token", purpose: "price_history",
  claimType: "complete_range", state: "verified", from: 1000, to: 2000, knownAt: 2000, evidenceRefs: ["receipt"], ...overrides,
});
const coverage = (claims: readonly DeclaredPriceCoverageClaim[], asOf = 2000) =>
  inspectDeclaredThirtyDayPriceCoverage({ chain: "solana", tokenAddress: "token", boughtAt: 1000, asOf, claims });

describe("read-only legacy purchase reconstruction", () => {
  it("creates only a nominal-USD external-validation draft and a 30-day window", () => {
    const result = reconstruct(fixture());
    expect(result.status).toBe("candidate_for_external_validation");
    expect(result.draft).toMatchObject({
      amountUsd: "50", entryPriceUsd: "0.5", tokenQuantity: "100", amountEstimated: true,
      boughtAt: 1000, expiresAt: 1000 + FORWARD_OPPORTUNITY_WINDOW_MS,
      sourcePrecision: "legacy_sqlite_numeric_not_original_decimal", generationEligibility: "unreviewed_legacy_fact",
    });
    expect(result.newSampleCreated).toBe(false); expect(result.newEligibilityGranted).toBe(false);
    expect(result.externalChecks).toContain("verify_original_swap_and_quote_contract");
  });

  it("does not use weighted aggregate entry prices as a fallback", () => {
    const bundle = fixture();
    const missing = { ...bundle, rows: bundle.rows.filter((item) => item.table !== "wallet_monitor_execution_bases")
      .concat(row("trader_token_samples", { weighted_entry_price_usd: r(0.5), total_buy_usd: r(500) })) };
    expect(reconstruct(missing).reasonCodes).toContain("missing_or_ambiguous_execution_basis");
    expect(reconstruct(missing).draft).toBeNull();
  });

  it("keeps source/provider composite identity separate", () => {
    const bundle = fixture();
    const otherBasis = change(bundle, "wallet_monitor_execution_bases", "source", t("other-rpc"));
    expect(reconstruct(otherBasis).status).toBe("deferred");
    expect(reconstruct(otherBasis).reasonCodes).toContain("missing_or_ambiguous_execution_basis");
  });

  it("does not consider sells, orphaned observations or inconsistent amount bases eligible", () => {
    expect(reconstruct(change(fixture(), "wallet_monitor_observations", "side", t("sell"))).reasonCodes).toContain("not_a_buy");
    expect(reconstruct(change(fixture(), "wallet_monitor_observations", "orphaned_at", i(1500))).status).toBe("deferred");
    expect(reconstruct(change(fixture(), "wallet_monitor_observations", "amount_usd", r(51))).reasonCodes)
      .toContain("execution_basis_value_or_identity_requires_review");
  });

  it("does not use future revisions or incomplete preservation as verified evidence", () => {
    expect(reconstruct(change(fixture(), "trader_execution_revisions", "recorded_at", i(3000))).status).toBe("deferred");
    expect(reconstruct({ ...fixture(), declaredDependenciesComplete: false }).reasonCodes).toContain("preservation_dependency_scope_incomplete");
    expect(reconstruct({ ...fixture(), globalDeliveryAndBudgetGuardsComplete: false }).status).toBe("deferred");
  });

  it("requires revision zero and every intermediate revision", () => {
    const bundle = fixture();
    expect(reconstruct({ ...bundle, rows: bundle.rows.filter((item) => item.table !== "trader_execution_revisions" ||
      item.values.revision?.storage !== "integer" || item.values.revision.value !== "0") }).reasonCodes)
      .toContain("execution_revision_history_gap");
  });

  it("does not change proposal identity when unrelated source ledger fingerprints change", () => {
    const bundle = fixture();
    expect(reconstruct({ ...bundle, fingerprint: "unrelated-ledger-update" }).draft?.proposalId).toBe(reconstruct(bundle).draft?.proposalId);
  });

  it("expands scientific notation while preserving the approximation warning", () => {
    expect(legacyRealDecimal(5e-9)).toBe("0.000000005");
    expect(legacyRealDecimal(1e21)).toBe("1000000000000000000000");
    expect(() => legacyRealDecimal(Infinity)).toThrow("invalid_legacy_real");
    expect(() => legacyRealDecimal(-1)).toThrow("invalid_legacy_real");
  });

  it("rejects future analysis clocks rather than inventing a snapshot", () => {
    expect(() => reconstructLegacyWalletPurchase(fixture(), { source: "rpc", eventId: "trade", asOf: 10001 }))
      .toThrow("invalid_reconstruction_input");
  });
});

describe("declared 30-day price ranges", () => {
  it("separates an open observation window from a closed full-range declaration", () => {
    expect(coverage([claim()]).status).toBe("observing_range_declared");
    const end = 1000 + FORWARD_OPPORTUNITY_WINDOW_MS;
    const result = coverage([claim({ to: end, knownAt: end })], end);
    expect(result.status).toBe("full_window_range_declared");
    expect(result.independentProviderCoverageVerified).toBe(false);
    expect(result.noHitOrLossEstablished).toBe(false);
    expect(result.newEligibilityGranted).toBe(false);
  });

  it("does not count wallet coverage, positive hits or status flags without interval bounds", () => {
    const result = coverage([
      claim({ claimId: "wallet", purpose: "wallet_history" }),
      claim({ claimId: "hit", claimType: "positive_hit" }),
      claim({ claimId: "bounds", from: null, to: null }),
    ]);
    expect(result.gaps).toEqual([{ from: 1000, to: 2000 }]);
    expect(result.acceptedClaimFingerprints).toHaveLength(0);
  });

  it("reports exact gaps while merging only closed, contiguous integer-millisecond ranges", () => {
    const result = coverage([
      claim({ claimId: "one", from: 1000, to: 1200, knownAt: 1200 }),
      claim({ claimId: "two", from: 1201, to: 1500, knownAt: 1500 }),
      claim({ claimId: "three", from: 1700, to: 2000 }),
    ]);
    expect(result.gaps).toEqual([{ from: 1501, to: 1699 }]);
  });

  it("rejects future knowledge, mismatched chains, pending review and missing provenance", () => {
    const result = coverage([
      claim({ claimId: "future", knownAt: 2001 }),
      claim({ claimId: "chain", chain: "bsc" }),
      claim({ claimId: "pending", state: "pending_review" }),
      claim({ claimId: "no-proof", evidenceRefs: [] }),
    ]);
    expect(result.acceptedClaimFingerprints).toHaveLength(0);
    expect(result.rejectedClaims).toHaveLength(4);
  });

  it("deduplicates unchanged immutable claims but rejects contradictory copies", () => {
    expect(coverage([claim(), claim()]).acceptedClaimFingerprints).toHaveLength(1);
    const result = coverage([claim(), claim({ to: 1900 })]);
    expect(result.rejectedClaims[0]?.reasonCode).toBe("conflicting_immutable_claim");
    expect(result.gaps).toEqual([{ from: 1000, to: 2000 }]);
  });

  it("labels missing historical coverage as missing data, never a failed opportunity", () => {
    const result = coverage([], 1000 + FORWARD_OPPORTUNITY_WINDOW_MS + 1);
    expect(result.status).toBe("historical_price_gaps");
    expect(result.noHitOrLossEstablished).toBe(false);
    expect(() => coverage([], 999)).toThrow("invalid_price_coverage_request");
  });
});
