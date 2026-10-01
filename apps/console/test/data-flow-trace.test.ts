import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readDataFlowTrace } from "../src/data-flow-trace.js";

it("uses bound identities, preserves case and never initializes missing schemas", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE candidate_evidence_v3(evidence_id TEXT,trader_id TEXT,token_id TEXT,evidence_at INTEGER)");
    database.prepare("INSERT INTO candidate_evidence_v3 VALUES (?,?,?,?)").run("e", "owner", "solana:MiNt", 1);
    const before = database.prepare("SELECT total_changes() AS changes").get();
    const trace = readDataFlowTrace(database, { kind: "token", id: "solana:MiNt" });
    expect(trace.sections.evidence.rows).toHaveLength(1);
    expect(trace.sections.inventory?.available).toBe(false);
    expect(readDataFlowTrace(database, { kind: "token", id: "solana:mint" }).sections.evidence.rows).toHaveLength(0);
    expect(readDataFlowTrace(database, { kind: "token", id: "' OR 1=1 --" }).sections.evidence.rows).toHaveLength(0);
    expect(database.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
  } finally { database.close(); }
});
