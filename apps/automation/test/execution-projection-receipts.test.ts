import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationJobStore, openAddressRadarRepository } from "@address-radar/database";
import { reconcileExecutionRevisionRequests } from "../src/execution-revision-consumers.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "radar-projection-receipt-")); directories.push(directory);
  const path = join(directory, "radar.db");
  const repository = openAddressRadarRepository(path);
  repository.upsertFomoAccount({ accountId: "account", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId: "entity", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId: "account", entityId: "entity", confidence: "confirmed", source: "test", observedAt: 1 });
  const executionInput = { eventId: "sig:1", accountId: "account", entityId: "entity", chain: "solana", tokenAddress: "TokenCase",
    amountUsd: 60, priceUsd: 0.6, marketCapUsd: null, tokenAgeMs: null, occurredAt: 100, collectedAt: 200, source: "onchain_wallet" as const, side: "buy" as const };
  repository.insertTraderEvent(executionInput);
  const database = new DatabaseSync(path);
  database.prepare(`INSERT INTO trader_execution_heads(source,event_id,entity_id,chain,token_address,revision,fingerprint,last_observed_at,projection_state)
    VALUES('solana','sig:1','entity','solana','TokenCase',1,'revision-1',200,'applied')`).run();
  database.prepare(`INSERT INTO execution_revision_requests(source,event_id,consumer_type,subject_key,entity_id,token_id,desired_revision,requested_at)
    VALUES('solana','sig:1','event_projection','sig:1','entity','solana:TokenCase',1,200)`).run();
  const key = { eventId: "sig:1", projectionType: "address_signal_evidence_v1", sourceRevision: "test-strategy" };
  return { repository, database, key, executionInput, close() { database.close(); repository.close(); } };
}

describe("version-bound event projection receipts", () => {
  it("does not dispatch a request without a matching projection record", () => {
    const fixture = setup();
    try {
      const result = reconcileExecutionRevisionRequests({ database: fixture.database, jobs: createAutomationJobStore(fixture.database), now: () => 300 });
      expect(result.dispatched).toBe(0);
      expect(fixture.database.prepare("SELECT dispatched_revision,applied_revision FROM execution_revision_requests").get()).toEqual({ dispatched_revision: 0, applied_revision: 0 });
    } finally { fixture.close(); }
  });
  it("acknowledges the execution version consumed under the projection lease", () => {
    const fixture = setup();
    try {
      expect(fixture.repository.claimEventProjection({ ...fixture.key, executionInput: fixture.executionInput, owner: "worker", now: 300, leaseMs: 100 })).toBe("claimed");
      expect(fixture.repository.completeEventProjection({ ...fixture.key, owner: "worker", resultKey: "sig:1", completedAt: 350 })).toBe(true);
      expect(fixture.database.prepare("SELECT applied_revision,last_outcome FROM execution_revision_requests").get()).toEqual({ applied_revision: 1, last_outcome: "projection_recomputed" });
    } finally { fixture.close(); }
  });
  it("rejects completion after execution inputs change", () => {
    const fixture = setup();
    try {
      fixture.repository.claimEventProjection({ ...fixture.key, executionInput: fixture.executionInput, owner: "worker", now: 300, leaseMs: 100 });
      fixture.database.prepare("UPDATE trader_execution_heads SET revision=2,fingerprint='revision-2'").run();
      fixture.database.prepare("UPDATE trader_events SET amount_usd=90,price_usd=0.9 WHERE event_id='sig:1'").run();
      fixture.database.prepare("UPDATE execution_revision_requests SET desired_revision=2").run();
      expect(fixture.repository.completeEventProjection({ ...fixture.key, owner: "worker", resultKey: "sig:1", completedAt: 350 })).toBe(false);
      expect(fixture.database.prepare("SELECT applied_revision FROM execution_revision_requests").get()).toEqual({ applied_revision: 0 });
    } finally { fixture.close(); }
  });
  it("does not acknowledge a lost lease", () => {
    const fixture = setup();
    try {
      fixture.repository.claimEventProjection({ ...fixture.key, executionInput: fixture.executionInput, owner: "worker", now: 300, leaseMs: 100 });
      expect(fixture.repository.completeEventProjection({ ...fixture.key, owner: "other-worker", resultKey: "sig:1", completedAt: 350 })).toBe(false);
      expect(fixture.database.prepare("SELECT applied_revision FROM execution_revision_requests").get()).toEqual({ applied_revision: 0 });
    } finally { fixture.close(); }
  });
  it("records a filtered receipt without claiming produced evidence", () => {
    const fixture = setup();
    try {
      fixture.repository.claimEventProjection({ ...fixture.key, executionInput: fixture.executionInput, owner: "worker", now: 300, leaseMs: 100 });
      expect(fixture.repository.completeEventProjection({ ...fixture.key, owner: "worker", resultKey: "filtered:sig:1", completedAt: 350 })).toBe(true);
      expect(fixture.database.prepare("SELECT applied_revision,last_outcome FROM execution_revision_requests").get()).toEqual({ applied_revision: 1, last_outcome: "projection_filtered" });
    } finally { fixture.close(); }
  });

  it("rejects a cached consumer event that differs from the authoritative execution", () => {
    const fixture = setup();
    try {
      fixture.database.prepare("UPDATE trader_events SET amount_usd=90,price_usd=0.9 WHERE event_id='sig:1'").run();
      const executionInput = { eventId: "sig:1", accountId: "account", entityId: "entity", chain: "solana", tokenAddress: "TokenCase",
        side: "buy" as const, amountUsd: 60, priceUsd: 0.6, marketCapUsd: null, tokenAgeMs: null,
        occurredAt: 100, collectedAt: 200, source: "onchain_wallet" as const };
      const claim = fixture.repository.claimEventProjection(Object.assign({ ...fixture.key, executionInput: fixture.executionInput, owner: "worker", now: 300, leaseMs: 100 }, { executionInput }));
      expect(claim).toBe("busy");
      expect(fixture.database.prepare("SELECT applied_revision FROM execution_revision_requests").get()).toEqual({ applied_revision: 0 });
    } finally { fixture.close(); }
  });
it("allows a legacy consumer to finish without acknowledging an unverified execution", () => {
  const fixture = setup();
  try {
    expect(fixture.repository.claimEventProjection({ ...fixture.key, owner: "legacy", now: 300, leaseMs: 100 })).toBe("claimed");
    expect(fixture.repository.completeEventProjection({ ...fixture.key, owner: "legacy", resultKey: "sig:1", completedAt: 350 })).toBe(true);
    expect(fixture.database.prepare("SELECT applied_revision FROM execution_revision_requests").get()).toEqual({ applied_revision: 0 });
  } finally { fixture.close(); }
});

});
