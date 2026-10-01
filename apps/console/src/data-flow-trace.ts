import type { DatabaseSync } from "node:sqlite";

/** Bounded SELECTs only; absent schemas are distinct from empty results. */
export function readDataFlowTrace(database: DatabaseSync, subject: { readonly kind: "token" | "trader"; readonly id: string }) {
  const limit = 100;
  const section = (table: string, where: string, parameters: readonly string[], order: string) => {
    const available = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
    const rows = available ? database.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...parameters, limit + 1) : [];
    return { available, truncated: rows.length > limit, rows: rows.slice(0, limit) };
  };
  const sections = subject.kind === "token" ? {
    inventory: section("historical_tokens", "token_id=?", [subject.id], "token_id"),
    facts: section("token_fact_status", "token_id=?", [subject.id], "fact_type"),
    evidence: section("candidate_evidence_v3", "token_id=?", [subject.id], "evidence_at DESC,evidence_id"),
    recovery: section("recovery_fact_links", "fact_key=?", [subject.id], "updated_at DESC,recovery_job_id"),
    projections: section("signal_projection_requests", "token_id=?", [subject.id], "token_id"),
  } : {
    identity: section("trader_entities", "entity_id=?", [subject.id], "entity_id"),
    evidence: section("candidate_evidence_v3", "trader_id=?", [subject.id], "evidence_at DESC,evidence_id"),
    admissions: section("candidate_admission_snapshots", "trader_id=?", [subject.id], "evaluated_at DESC,snapshot_id"),
    ability: section("trader_repeatable_ability_snapshots", "entity_id=?", [subject.id], "evaluated_at DESC,snapshot_id"),
    purchases: section("trader_events", "entity_id=?", [subject.id], "occurred_at DESC,event_id"),
    monitoring: section("wallet_monitor_observations", "entity_id=? AND orphaned_at IS NULL", [subject.id], "occurred_at DESC,event_id"),
  };
  return { schemaVersion: "data-flow-trace-v1", subject, maximumRowsPerSection: limit, sections,
    limitations: ["Missing ownership, provider or interval evidence must not be inferred from empty sections.",
      "Trace sections are independently read and may change during concurrent ingestion.",
      "Recovery links use exact fact keys; absent links do not prove no recovery request exists."] };
}
