import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readDataFlowProgress } from "../src/data-flow-progress.js";

function fixture(operation: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE automation_jobs(job_type TEXT, status TEXT, next_attempt_at INTEGER)");
  const insert = database.prepare("INSERT INTO automation_jobs VALUES ('candidate_evidence',?,?)");
  for (const [status, nextAt] of [["pending", 100], ["retry_scheduled", 100], ["retry_scheduled", 201],
    ["waiting_source", 100], ["blocked_source", 100], ["running", 100], ["completed", 100]] as const) insert.run(status, nextAt);
  try { operation(database); } finally { database.close(); }
}

describe("data-flow queue accounting", () => {
  it("counts due retries under their scheduler status", () => fixture(database => {
    const result = readDataFlowProgress(database, 200);
    expect(result.queue.rows.find(row => row.status === "retry_scheduled")?.dueTasks).toBe(1);
  }));
  it("does not present source waits as runnable", () => fixture(database => {
    const result = readDataFlowProgress(database, 200);
    expect(result.queue.rows.find(row => row.status === "waiting_source")?.dueTasks).toBe(0);
  }));
  it("separates due, scheduled, executing and source-blocked work", () => fixture(database => {
    expect(readDataFlowProgress(database, 200).queue).toMatchObject({
      runnable: 2, scheduled: 1, running: 1, waitingSource: 1, blockedSource: 1,
    });
  }));
});

it("preserves unavailable metrics instead of reporting a successful empty queue", () => {
  const database = new DatabaseSync(":memory:");
  try {
    expect(readDataFlowProgress(database, 200).queue).toMatchObject({
      available: false, runnable: null, scheduled: null, running: null, waitingSource: null, blockedSource: null,
    });
  } finally { database.close(); }
});
