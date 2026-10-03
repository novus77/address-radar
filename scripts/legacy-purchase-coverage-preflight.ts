import { readFileSync, statSync } from "node:fs";
import { readOnlyRowProtectionBundle, summarizeRowProtectionBundle } from "../packages/database/src/full-data-row-protection.js";
import {
  reconstructLegacyWalletPurchase, inspectDeclaredThirtyDayPriceCoverage, type DeclaredPriceCoverageClaim,
} from "../packages/database/src/legacy-purchase-coverage-preflight.js";

const args = process.argv.slice(2);
if ((args.length !== 6 && args.length !== 8) || args[0] !== "--database" || args[2] !== "--source" ||
    args[4] !== "--event" || (args.length === 8 && args[6] !== "--coverage")) {
  process.stderr.write("Usage: tsx scripts/legacy-purchase-coverage-preflight.ts --database /path/to/source.sqlite --source provider --event event-id [--coverage /path/to/claims.json]\n");
  process.exitCode = 2;
} else {
  try {
    const bundle = readOnlyRowProtectionBundle(args[1]!, {
      roots: [{ reference: "operator-requested-trade", reason: "trade_evidence",
        row: { table: "wallet_monitor_observations", key: { source: args[3]!, event_id: args[5]! } } }],
    });
    const result = reconstructLegacyWalletPurchase(bundle, { source: args[3]!, eventId: args[5]!, asOf: bundle.capturedAtMs });
    let claims: readonly DeclaredPriceCoverageClaim[] = [];
    if (args[7]) {
      if (statSync(args[7]).size > 256 * 1024) throw new Error("coverage_request_too_large");
      claims = JSON.parse(readFileSync(args[7], "utf8")) as readonly DeclaredPriceCoverageClaim[];
      if (!Array.isArray(claims)) throw new Error("invalid_coverage_claims");
    }
    const coverage = result.draft ? inspectDeclaredThirtyDayPriceCoverage({
      chain: result.draft.chain, tokenAddress: result.draft.tokenAddress, boughtAt: result.draft.boughtAt,
      asOf: bundle.capturedAtMs, claims,
    }) : null;
    process.stdout.write(JSON.stringify({
      preservation: summarizeRowProtectionBundle(bundle),
      reconstruction: {
        status: result.status, reasonCodes: result.reasonCodes, sourceEventFingerprint: result.sourceEventFingerprint,
        sourcePrecision: result.draft?.sourcePrecision ?? null, externalChecks: result.externalChecks,
        newSampleCreated: false, newEligibilityGranted: false, productionMigrationReady: false,
      }, coverage,
    }, null, 2) + "\n");
    process.exitCode = result.status === "candidate_for_external_validation" ? 0 : 1;
  } catch {
    process.stderr.write("Read-only purchase/coverage preflight failed. No business import or eligibility change was performed.\n");
    process.exitCode = 2;
  }
}
