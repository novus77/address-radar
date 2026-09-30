import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createCandidateHistoryStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { createAddressConsoleApplication, type AddressConsoleApplication } from "../src/application.js";

function seededDatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "address-radar-funnel-")), "radar.db");
  const database = new DatabaseSync(path);
  migrateAddressRadarDatabase(database);
  const store = createCandidateHistoryStore(database);
  store.saveHistoricalToken({
    tokenId: "solana:token-a", chain: "solana", tokenAddress: "token-a", symbol: "AAA",
    imageUrl: null, firstTradeAt: 1, firstReached1mAt: 2, peakMarketCapUsd: 1_500_000,
    source: "dune", sourceQueryId: "query-1", provenance: {},
  });
  store.saveMilestoneCrossing({
    milestoneId: "solana:token-a:500000", tokenId: "solana:token-a", marketCapUsd: 500_000,
    crossedAt: 3, precision: "exact", source: "dune", sourceEventIds: ["tx-1"], strategyVersion: "v3",
  });
  store.saveEvidence({
    evidenceId: "evidence-1", traderId: "wallet:unresolved", tokenId: "solana:token-a",
    milestoneId: "solana:token-a:500000", evidenceType: "market_cap_500k_10x", admissionClass: "strong",
    cumulativeBuyUsd: 50, weightedEntryMarketCapUsd: 40_000, theoreticalOpportunity: 12.5,
    capturableMultiple: null, realizedMultiple: null, evidenceAt: 4, sourceEventIds: ["tx-1"], strategyVersion: "v3",
  });
  store.saveAdmissionSnapshot({
    snapshotId: "snapshot-1", traderId: "wallet:unresolved", windowStart: 0, windowEnd: 5,
    earlyDistinctTokenCount: 0, strongDistinctTokenCount: 1, historicalDistinctTokenCount: 1,
    currentAdmission: true, historicalCapability: true, status: "current_admitted",
    reasonCodes: ["strong_evidence_in_30d"], strategyVersion: "v3", evaluatedAt: 5,
  });
  database.close();
  return path;
}

describe("candidate funnel API", () => {
  let application: AddressConsoleApplication | undefined;
  afterEach(() => application?.close());

  it("quantifies every populated upstream candidate stage", () => {
    application = createAddressConsoleApplication(seededDatabase());

    const response = application.handle("GET", "/api/v2/candidate-funnel");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      historicalTokenCount: 1,
      milestoneReconstructedTokenCount: 1,
      evidenceCount: 1,
      evidenceTraderCount: 1,
      identityUnresolvedCount: 1,
      currentAdmittedCount: 1,
    });
  });

  it("returns admitted evidence even without a trader lifecycle record", () => {
    application = createAddressConsoleApplication(seededDatabase());

    const response = application.handle("GET", "/api/v2/candidates");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        traderId: "wallet:unresolved",
        currentAdmission: 1,
        strongestEvidenceType: "market_cap_500k_10x",
        identityState: "unresolved",
      })],
    });
  });
});
