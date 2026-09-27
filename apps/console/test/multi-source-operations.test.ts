import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSourceLedgerStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";
import { createAddressConsoleApplication } from "../src/application.js";

const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "address-radar-console-"));
  directories.push(directory);
  const path = join(directory, "radar.sqlite");
  const database = openAddressRadarDatabase(path);
  migrateAddressRadarDatabase(database);
  const store = createSourceLedgerStore(database);
  store.advanceCursor({ source: "rpc_evm", chain: "base", cursor: "120", position: 120, updatedAt: 1_000 });
  store.saveSourceHealth({ source: "rpc_evm", chain: "base", state: "healthy", lastAttemptAt: 1_000, lastSuccessAt: 1_000, lastEventAt: 950, consecutiveFailures: 0, latencyMs: 25, rateLimitResetAt: null, cursor: "120", lastErrorCode: null });
  store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_000, identityStatus: "resolved", marketStatus: "resolved", fomoStatus: "confirmed", milestoneStatus: "observed", evidenceStatus: "qualified" });
  store.enqueueRecoveryJob({ jobId: "job-1", jobType: "market_enrichment", chain: "base", subjectKey: "base:0xabc", priority: 20, cursor: null, nextAttemptAt: 1_000, createdAt: 1_000 });
  store.failRecoveryJob("job-1", "provider_timeout", 2_000);
  database.close();
  return { path, app: createAddressConsoleApplication(path) };
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("multi-source operator APIs", () => {
  it("returns provider health and durable cursors with Chinese diagnostics", () => {
    const { app } = setup();
    expect(app.handle("GET", "/api/v2/sources/health")).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ source: "rpc_evm", chain: "base", state: "healthy", diagnosticZh: "运行正常" })] } });
    expect(app.handle("GET", "/api/v2/sources/cursors")).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ source: "rpc_evm", chain: "base", position: 120 })] } });
    app.close();
  });

  it("reports orthogonal token and trader funnels", () => {
    const { app } = setup();
    expect(app.handle("GET", "/api/v2/discovery/token-funnel")).toMatchObject({ status: 200, body: { raw: 1, identityResolved: 1, marketResolved: 1, fomoConfirmed: 1, milestoneObserved: 1, candidateEvidence: expect.any(Number), aggregation: expect.any(Number), qualifiedSignal: expect.any(Number) } });
    expect(app.handle("GET", "/api/v2/discovery/trader-funnel")).toMatchObject({ status: 200, body: expect.objectContaining({ observed: expect.any(Number), candidateEvidence: expect.any(Number), currentAdmitted: expect.any(Number) }) });
    expect(app.handle("GET", "/api/v2/automation/overview")).toMatchObject({ status: 200, body: { funnel: expect.objectContaining({ observedFomoHandles: 0, canonicalTraders: 0, walletResolvedTraders: 0, monitoringEligibleTraders: 0 }) } });
    app.close();
  });

  it("lists, retries, and re-evaluates durable recovery work", () => {
    const { app } = setup();
    expect(app.handle("GET", "/api/v2/recovery/jobs")).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ jobId: "job-1", status: "failed" })] } });
    expect(app.handle("POST", "/api/v2/recovery/jobs/job-1/retry")).toMatchObject({ status: 200, body: { jobId: "job-1", status: "pending" } });
    expect(app.handle("POST", "/api/v2/tokens/base%3A0xabc/re-evaluate")).toMatchObject({ status: 202, body: { tokenId: "base:0xabc", queued: expect.any(Array) } });
    app.close();
  });
});
