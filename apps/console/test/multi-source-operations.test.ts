import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(app.handle("GET", "/api/v2/discovery/fact-coverage")).toMatchObject({ status: 200, body: { unresolvedDependencies: 0, unresolvedConflicts: 0 } });
    expect(app.handle("GET", "/api/v2/automation/overview")).toMatchObject({ status: 200, body: { funnel: expect.objectContaining({ observedFomoHandles: 0, canonicalTraders: 0, walletResolvedTraders: 0, monitoringEligibleTraders: 0 }) } });
    expect(app.handle("GET", "/api/v2/projections/quality")).toMatchObject({
      status: 200,
      body: {
        canonicalEventCount: 0,
        completedCount: 0,
        retryableCount: 0,
        activeCount: 0,
        missingSignalProjectionCount: 0,
      },
    });
    app.close();
  });

  it("reports Fomo verification queue correlation and timeout quality", () => {
    const { path, app } = setup();
    const database = openAddressRadarDatabase(path);
    const insertToken = database.prepare(`
      INSERT INTO historical_tokens(
        token_id, chain, token_address, symbol, image_url, first_trade_at,
        first_reached_1m_at, peak_market_cap_usd, source, source_query_id, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertToken.run("base:0xqueued", "base", "0xqueued", null, null, 1_000, 1_000, 1_000_000, "test", null, "{}");
    insertToken.run("solana:deferred", "solana", "deferred", null, null, 1_000, 1_000, 1_000_000, "test", null, "{}");
    insertToken.run("bsc:0xconfirmed", "bsc", "0xconfirmed", null, null, 1_000, 1_000, 1_000_000, "test", null, "{}");
    const updateVerification = database.prepare(`
      UPDATE historical_token_verifications
      SET status = ?, last_lookup_id = ?, queued_at = ?, result_received_at = ?,
        next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE token_id = ?
    `);
    updateVerification.run("queued", "lookup-active", 1_000, null, 10_000, null, 1_000, "base:0xqueued");
    updateVerification.run("deferred", null, null, null, 20_000, "fomo_result_timeout", 2_000, "solana:deferred");
    updateVerification.run("confirmed", "lookup-complete", 3_000, 4_000, 0, null, 4_000, "bsc:0xconfirmed");
    database.close();
    const transferDirectory = join(path, "..", "fomo");
    mkdirSync(transferDirectory, { recursive: true });
    writeFileSync(join(transferDirectory, "fomo-sync-status.json"), JSON.stringify({
      generatedAt: 5_000,
      requestSourceSize: 900,
      requestBytesCopied: 120,
      resultSourceSize: 700,
      resultBytesCopied: 80,
    }));

    const response = app.handle("GET", "/api/v2/fomo-verification/quality");
    expect(response).toMatchObject({
      status: 200,
      body: {
        total: 3,
        activeLookupCount: 1,
        timedOutCount: 1,
        correlatedResultCount: 1,
        oldestQueuedAt: 1_000,
        lastResultReceivedAt: 4_000,
        transfer: {
          generatedAt: 5_000,
          requestBytesCopied: 120,
          resultBytesCopied: 80,
        },
      },
    });
    const statuses = (response.body as { statuses: unknown[] }).statuses;
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "queued", count: 1, diagnosticZh: "等待 Fomo 查询结果" }),
      expect.objectContaining({ status: "deferred", count: 1, diagnosticZh: "查询超时，已按退避计划重排" }),
      expect.objectContaining({ status: "confirmed", count: 1, diagnosticZh: "Fomo 已确认并返回历史数据" }),
    ]));
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
