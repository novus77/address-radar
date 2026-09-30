import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv.find((value, index) => index > 1 && !value.startsWith("--"))
  ?? process.env.ADDRESS_RADAR_DATABASE_PATH;
const strict = process.argv.includes("--strict");
if (!databasePath) throw new Error("Database path is required as an argument or ADDRESS_RADAR_DATABASE_PATH");

const database = new DatabaseSync(databasePath, { readOnly: true });
const requiredTables = [
  "entity_wallet_identities",
  "wallet_monitor_observations",
  "wallet_analysis_jobs",
  "wallet_analysis_positions",
  "trader_token_samples",
  "trader_token_outcomes",
  "trader_repeatable_ability_snapshots",
  "token_fact_status",
  "token_fact_attempts",
  "candidate_evidence_v3",
  "token_evaluation_state",
  "broadcast_records",
] as const;

const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
const missingTables = requiredTables.filter((table) => !tables.has(table));
const count = (sql: string): number => Number((database.prepare(sql).get() as { count: number | null }).count ?? 0);
const optionalCount = (table: string, sql: string): number | null => tables.has(table) ? count(sql) : null;

const report = {
  auditedAt: Date.now(),
  databasePath,
  deliveryEnabled: process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED === "true",
  structure: {
    requiredTableCount: requiredTables.length,
    missingTables,
  },
  identity: {
    monitoredWallets: optionalCount("entity_wallet_identities", "SELECT COUNT(*) AS count FROM entity_wallet_identities"),
    monitoredTraders: optionalCount("entity_wallet_identities", "SELECT COUNT(DISTINCT entity_id) AS count FROM entity_wallet_identities"),
  },
  collection: {
    walletObservations: optionalCount("wallet_monitor_observations", "SELECT COUNT(*) AS count FROM wallet_monitor_observations WHERE orphaned_at IS NULL"),
    observedWallets: optionalCount("wallet_monitor_observations", "SELECT COUNT(DISTINCT wallet_address) AS count FROM wallet_monitor_observations WHERE orphaned_at IS NULL"),
    canonicalEvents: optionalCount("canonical_trader_events", "SELECT COUNT(*) AS count FROM canonical_trader_events"),
  },
  facts: {
    available: optionalCount("token_fact_status", "SELECT COUNT(*) AS count FROM token_fact_status WHERE status = 'available'"),
    partial: optionalCount("token_fact_status", "SELECT COUNT(*) AS count FROM token_fact_status WHERE status = 'partial'"),
    unresolvedDependencies: optionalCount("token_fact_dependencies", `
      SELECT COUNT(*) AS count
      FROM token_fact_dependencies d
      JOIN token_fact_status dependency
        ON dependency.token_id = d.token_id
       AND dependency.fact_type = d.depends_on_fact_type
      WHERE dependency.status NOT IN ('available', 'partial', 'degraded')
    `),
    unresolvedConflicts: optionalCount("token_fact_conflicts", "SELECT COUNT(*) AS count FROM token_fact_conflicts WHERE status = 'open'"),
  },
  analysis: {
    completedWalletAnalyses: optionalCount("wallet_analysis_jobs", "SELECT COUNT(*) AS count FROM wallet_analysis_jobs WHERE status IN ('review_required', 'accepted', 'insufficient_data')"),
    walletPositions: optionalCount("wallet_analysis_positions", "SELECT COUNT(*) AS count FROM wallet_analysis_positions"),
    traderSamples: optionalCount("trader_token_samples", "SELECT COUNT(*) AS count FROM trader_token_samples WHERE sample_status = 'included'"),
    completeOutcomes: optionalCount("trader_token_outcomes", "SELECT COUNT(*) AS count FROM trader_token_outcomes WHERE coverage_status = 'complete'"),
    repeatableAbilities: optionalCount("trader_repeatable_ability_snapshots", "SELECT COUNT(DISTINCT entity_id) AS count FROM trader_repeatable_ability_snapshots WHERE window = '30d'"),
    stableAbilities: optionalCount("trader_repeatable_ability_snapshots", "SELECT COUNT(DISTINCT entity_id) AS count FROM trader_repeatable_ability_snapshots WHERE window = '30d' AND ability_stage = 'stable'"),
  },
  signal: {
    candidateEvidence: optionalCount("candidate_evidence_v3", "SELECT COUNT(*) AS count FROM candidate_evidence_v3"),
    evaluatedTokens: optionalCount("token_evaluation_state", "SELECT COUNT(*) AS count FROM token_evaluation_state"),
    localQualifiedSignals: optionalCount("broadcast_records", "SELECT COUNT(*) AS count FROM broadcast_records"),
    deliveredSignals: optionalCount("signal_outbox", "SELECT COUNT(*) AS count FROM signal_outbox WHERE status = 'delivered'"),
  },
};

const hardFailures = [
  ...(report.structure.missingTables.length ? [`missing_tables:${report.structure.missingTables.join(",")}`] : []),
  ...(report.deliveryEnabled ? ["gateway_delivery_must_remain_disabled"] : []),
];
const readinessWarnings = [
  ...(report.identity.monitoredWallets === 0 ? ["no_monitored_wallets"] : []),
  ...(report.collection.walletObservations === 0 ? ["no_wallet_observations"] : []),
  ...(report.analysis.walletPositions === 0 ? ["no_wallet_history_positions"] : []),
  ...(report.analysis.traderSamples === 0 ? ["no_trader_samples"] : []),
  ...(report.analysis.completeOutcomes === 0 ? ["no_complete_outcomes"] : []),
  ...(report.analysis.repeatableAbilities === 0 ? ["no_repeatable_ability_snapshots"] : []),
  ...(report.signal.evaluatedTokens === 0 ? ["no_token_evaluations"] : []),
];

console.log(JSON.stringify({
  status: hardFailures.length ? "structural_failure" : readinessWarnings.length ? "waiting_for_data" : "ready_for_shadow_acceptance",
  hardFailures,
  readinessWarnings,
  report,
}, null, 2));
database.close();
if (hardFailures.length || (strict && readinessWarnings.length)) process.exitCode = 1;
