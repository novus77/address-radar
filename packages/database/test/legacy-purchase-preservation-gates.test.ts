import { describe, expect, it } from "vitest";
import type { RowProtectionBundle } from "../src/full-data-row-protection.js";
import { reconstructLegacyWalletPurchase } from "../src/legacy-purchase-coverage-preflight.js";

function incompleteBundle(dependenciesComplete: boolean, guardsComplete: boolean): RowProtectionBundle {
  return {
    version: 1,
    capturedAtMs: 2000,
    scope: "declared_legacy_rows_and_preservation_dependencies",
    rows: [],
    edges: [],
    roots: [],
    issues: [{ code: "preservation_limit_reached", table: "provider_budget_usage", reference: "bounded_probe" }],
    declaredDependenciesComplete: dependenciesComplete,
    globalDeliveryAndBudgetGuardsComplete: guardsComplete,
    fingerprint: "incomplete_fixture",
    sourceBytesIncluded: 0,
    newPurchaseSamplesCreated: 0,
    newEligibilityGranted: false,
    productionMigrationReady: false,
    unresolvedGates: [],
  };
}

describe("legacy purchase preservation gates", () => {
  it.each([[false, false], [false, true], [true, false]])(
    "does not infer source absence from an incomplete slice (%s, %s)",
    (dependenciesComplete, guardsComplete) => {
      const result = reconstructLegacyWalletPurchase(
        incompleteBundle(dependenciesComplete, guardsComplete),
        { source: "rpc", eventId: "bounded_event", asOf: 2000 },
      );
      expect(result.status).toBe("deferred");
      expect(result.reasonCodes).toEqual(["preservation_dependency_scope_incomplete"]);
      expect(result.draft).toBeNull();
      expect(result.newSampleCreated).toBe(false);
      expect(result.newEligibilityGranted).toBe(false);
    },
  );
});
