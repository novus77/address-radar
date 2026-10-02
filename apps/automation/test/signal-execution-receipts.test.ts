import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationJobStore, openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";
import { createSignalProjectionReconciler, createSignalProjectionWorker } from "../src/signal-projection-worker.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup(stage: "older_7d_plus" | "unknown" = "older_7d_plus") {
  const dir = mkdtempSync(join(tmpdir(), "radar-signal-receipt-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "radar.db");
  const repository = openAddressRadarRepository(path); cleanups.push(() => repository.close());
  repository.upsertFomoAccount({ accountId: "account", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId: "entity", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.insertTraderEvent({ eventId: "event", accountId: "account", entityId: "entity", chain: "solana", tokenAddress: "TokenCase", side: "buy", amountUsd: 90, priceUsd: 0.9, marketCapUsd: null, tokenAgeMs: null, occurredAt: 100, collectedAt: 100, source: "onchain_wallet" });
  repository.saveAddressSignalEvidence("solana", "TokenCase", { eventId: "event", entityId: "entity", contribution: 0.9, occurredAt: 100, source: "onchain", side: "buy", amountUsd: 90, lifecycleStage: stage });
  const database = openAddressRadarDatabase(path); cleanups.push(() => database.close());
  database.prepare(`INSERT INTO trader_execution_heads(source,event_id,entity_id,chain,token_address,revision,fingerprint,last_observed_at,projection_state)
    VALUES('solana','event','entity','solana','TokenCase',1,'execution-one',100,'applied')`).run();
  for (const consumer of ["event_projection", "token_aggregation", "signal_projection"]) {
    database.prepare(`INSERT INTO execution_revision_requests(source,event_id,consumer_type,subject_key,entity_id,token_id,desired_revision,applied_revision,requested_at,last_outcome)
      VALUES('solana','event',?,'solana:TokenCase','entity','solana:TokenCase',1,?,100,?)`)
      .run(consumer, consumer === "event_projection" ? 1 : 0, consumer === "event_projection" ? "projection_recomputed" : "pending");
  }
  const jobs = createAutomationJobStore(database);
  createSignalProjectionReconciler({ database, jobs, now: () => 1_000 }).runOnce();
  const job = jobs.activeJobForSubject("signal_projection", "solana:TokenCase")!;
  const eligibleRepository = { ...repository, traderSignalProfile: () => ({ entityId: "entity", lifecycle: "active" as const, mapped: true, monitoringEnabled: true, fomoMonitoringEnabled: false, onchainMonitoringEnabled: true }) };
  const applied = () => database.prepare("SELECT consumer_type,applied_revision FROM execution_revision_requests WHERE consumer_type<>'event_projection' ORDER BY consumer_type").all();
  return { database, repository: eligibleRepository, job, applied };
}

describe("signal and aggregation execution revision receipts", () => {
  it("acknowledges both consumers after a real below-threshold evaluation, without broadcasting", async () => {
    const fixture = setup();
    const worker = createSignalProjectionWorker({ ...fixture, threshold: 0.8, minimumTotalBuyUsd: 100, now: () => 1_000 });
    expect(await worker.execute(fixture.job, new AbortController().signal)).toMatchObject({ status: "completed" });
    expect(fixture.applied()).toEqual([{ consumer_type: "signal_projection", applied_revision: 1 }, { consumer_type: "token_aggregation", applied_revision: 1 }]);
    expect(fixture.database.prepare("SELECT count(*) n FROM signal_projection_execution_receipts").get()).toEqual({ n: 2 });
    await worker.execute(fixture.job, new AbortController().signal);
    expect(fixture.database.prepare("SELECT count(*) n FROM signal_projection_execution_receipts").get()).toEqual({ n: 2 });
  });

  it("defers missing lifecycle data without confirming either consumer", async () => {
    const fixture = setup("unknown");
    const worker = createSignalProjectionWorker({ ...fixture, threshold: 0.8, minimumTotalBuyUsd: 100, now: () => 1_000 });
    expect(await worker.execute(fixture.job, new AbortController().signal)).toMatchObject({ status: "waiting_source" });
    expect(fixture.applied()).toEqual([{ consumer_type: "signal_projection", applied_revision: 0 }, { consumer_type: "token_aggregation", applied_revision: 0 }]);
  });

  it("does not confirm an execution revision whose event projection is unverified", async () => {
    const fixture = setup();
    fixture.database.prepare("UPDATE execution_revision_requests SET applied_revision=0 WHERE consumer_type='event_projection'").run();
    const worker = createSignalProjectionWorker({ ...fixture, threshold: 0.8, minimumTotalBuyUsd: 100, now: () => 1_000 });
    expect(await worker.execute(fixture.job, new AbortController().signal)).toMatchObject({ status: "waiting_source" });
    expect(fixture.applied()).toEqual([{ consumer_type: "signal_projection", applied_revision: 0 }, { consumer_type: "token_aggregation", applied_revision: 0 }]);
  });

  it("leaves a newer execution revision pending if it arrives during evaluation", async () => {
    const fixture = setup();
    const repository = { ...fixture.repository, saveTokenEvaluation(input: Parameters<typeof fixture.repository.saveTokenEvaluation>[0]) {
      fixture.repository.saveTokenEvaluation(input);
      fixture.database.prepare("UPDATE trader_execution_heads SET revision=2,fingerprint='execution-two' WHERE event_id='event'").run();
      fixture.database.prepare("UPDATE execution_revision_requests SET desired_revision=2 WHERE event_id='event'").run();
    } };
    const worker = createSignalProjectionWorker({ database: fixture.database, repository, threshold: 0.8, minimumTotalBuyUsd: 100, now: () => 1_000 });
    await worker.execute(fixture.job, new AbortController().signal);
    expect(fixture.applied()).toEqual([{ consumer_type: "signal_projection", applied_revision: 0 }, { consumer_type: "token_aggregation", applied_revision: 0 }]);
  });
});

it("requests a new signal projection when a verified event projection completes again", () => {
  const fixture = setup();
  fixture.database.prepare(`INSERT INTO event_projections(event_id,projection_type,source_revision,status,attempt_count,next_attempt_at,created_at,updated_at,completed_at)
    VALUES('event','address_signal_evidence_v1','test','completed',1,1,1,1000,1000)`).run();
  const jobs = createAutomationJobStore(fixture.database);
  const reconciler = createSignalProjectionReconciler({ database: fixture.database, jobs, now: () => 2_000 });
  expect(reconciler.runOnce()).toMatchObject({ changed: 1 });
  fixture.database.prepare("UPDATE event_projections SET completed_at=1001,updated_at=1001 WHERE event_id='event'").run();
  expect(reconciler.runOnce()).toMatchObject({ changed: 1 });
  expect(reconciler.runOnce()).toMatchObject({ changed: 0 });
});
