import { createHash } from "node:crypto";
import { readOnlyPurchaseDependencyBundle, type PreservedSqliteValue, type RowProtectionReadLimits } from "./full-data-row-protection.js";
import { inspectDeclaredThirtyDayPriceCoverage, type DeclaredPriceCoverageClaim, type PriceCoveragePreflight } from "./legacy-purchase-coverage-preflight.js";

export interface PurchaseDependencyCoverageInput {
  source: string;
  eventId: string;
  asOf: number;
  claims?: readonly DeclaredPriceCoverageClaim[];
}

export interface PurchaseDependencyCoverageReport {
  scope: "bounded_purchase_dependencies_not_global_guard_export";
  status: "dependencies_available" | "blocked";
  sourceEventFingerprint: string;
  dependencyFingerprint: string;
  capturedAtMs: number;
  rowCount: number;
  tableCounts: Readonly<Record<string, number>>;
  issues: readonly { code: string; table: string }[];
  declaredPurchaseDependenciesComplete: boolean;
  globalDeliveryAndBudgetGuardsComplete: false;
  sameSnapshotGlobalGuardsVerified: false;
  independentlyVerifiedPurchase: false;
  priceCoverage: PriceCoveragePreflight | null;
  newPurchaseSamplesCreated: 0;
  newEligibilityGranted: false;
  productionMigrationReady: false;
}

export function readOnlyPurchaseDependencyCoveragePreflight(
  databasePath: string, input: PurchaseDependencyCoverageInput, limits: RowProtectionReadLimits = {},
): PurchaseDependencyCoverageReport {
  if (!input || typeof input.source !== "string" || !input.source.trim() ||
      typeof input.eventId !== "string" || !input.eventId.trim() ||
      !Number.isSafeInteger(input.asOf) || input.asOf < 0 || (input.claims !== undefined && !Array.isArray(input.claims))) {
    throw new Error("invalid_purchase_dependency_input");
  }
  const sourceEventFingerprint = createHash("sha256").update(JSON.stringify([input.source, input.eventId])).digest("hex");
  const bundle = readOnlyPurchaseDependencyBundle(databasePath, { roots: [{
    reference: sourceEventFingerprint, reason: "trade_evidence",
    row: { table: "wallet_monitor_observations", key: { source: input.source, event_id: input.eventId } },
  }] }, limits);
  const issues = bundle.issues.map(({ code, table }) => ({ code, table }));
  const observation = bundle.rows.filter(row => row.table === "wallet_monitor_observations" &&
    text(row.values.source) === input.source && text(row.values.event_id) === input.eventId);
  let priceCoverage: PriceCoveragePreflight | null = null;
  if (observation.length !== 1) {
    issues.push({ code: "missing_or_ambiguous_purchase_observation", table: "wallet_monitor_observations" });
  } else {
    const values = observation[0]!.values;
    const boughtAt = clock(values.occurred_at);
    const collectedAt = clock(values.collected_at);
    const chain = text(values.chain);
    const tokenAddress = text(values.token_address);
    if (text(values.side) !== "buy" || boughtAt === null || collectedAt === null ||
        !chain?.trim() || !tokenAddress?.trim() || !Number.isSafeInteger(boughtAt + 30 * 86_400_000)) {
      issues.push({ code: "invalid_purchase_observation_window", table: "wallet_monitor_observations" });
    } else if (boughtAt > input.asOf || collectedAt > input.asOf) {
      issues.push({ code: "purchase_observation_not_known_as_of", table: "wallet_monitor_observations" });
    } else {
      priceCoverage = inspectDeclaredThirtyDayPriceCoverage({ chain, tokenAddress, boughtAt, asOf: input.asOf, claims: input.claims ?? [] });
    }
  }
  const tableCounts: Record<string, number> = {};
  for (const row of bundle.rows) tableCounts[row.table] = (tableCounts[row.table] ?? 0) + 1;
  const complete = bundle.declaredDependenciesComplete && issues.length === 0;
  return {
    scope: "bounded_purchase_dependencies_not_global_guard_export",
    status: complete ? "dependencies_available" : "blocked", sourceEventFingerprint,
    dependencyFingerprint: bundle.fingerprint, capturedAtMs: bundle.capturedAtMs,
    rowCount: bundle.rows.length, tableCounts, issues,
    declaredPurchaseDependenciesComplete: complete, globalDeliveryAndBudgetGuardsComplete: false,
    sameSnapshotGlobalGuardsVerified: false, independentlyVerifiedPurchase: false,
    priceCoverage, newPurchaseSamplesCreated: 0, newEligibilityGranted: false, productionMigrationReady: false,
  };
}

function text(value: PreservedSqliteValue | undefined): string | null {
  return value?.storage === "text" ? value.value : null;
}

function clock(value: PreservedSqliteValue | undefined): number | null {
  if (!value || (value.storage !== "integer" && value.storage !== "real")) return null;
  const parsed = Number(value.value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
